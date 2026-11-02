import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listExecutionOutputs } from "../src/execution/output.js";
import { appendExecutionRecord, readExecutionRecords, latestExecutionRecord, readMaintenanceExecutionHistory, appendMaintenanceProviderObservation, executionRecordSchema, type ExecutionRecord } from "../src/execution/records.js";
import { MAINTENANCE_HANDOFF_PROFILE, type MaintenanceProviderObservation, type MaintenanceTarget } from "../src/conversation/maintenance-handoff.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

describe("provider observations in existing execution history", () => {
  function fixture(workspace: Workspace) {
    const target: MaintenanceTarget = { workspaceId: workspace.id, workspaceRoot: workspace.root, worktreeRoot: workspace.root, repository: "https://github.com/example/runtime", branch: "main", head: "a".repeat(40), workstream: "fixture", goalId: "goal", planRef: "plan:v2", operationId: "op-a", sessionId: "session-a", turnId: "turn-a", projectId: "project", chatId: "chat", replyRef: "reply", mode: "chat", role: "builder", result: { outputId: 1, sha256: "b".repeat(64) } };
    const record: ExecutionRecord = { taskId: "task-a", iteration: 1, changedFiles: 0, tests: "older test", exitStatus: "success", timestamp: "2026-01-01T00:00:00Z", outputId: 1, maintenance: { profile: MAINTENANCE_HANDOFF_PROFILE, goalRef: target.goalId, planRef: target.planRef, operationId: target.operationId, sessionId: target.sessionId, turnId: target.turnId, head: target.head, resultSha256: target.result.sha256 } };
    const observation: MaintenanceProviderObservation = { inputRef: "input-a", status: "completed", hasError: false, completedAt: "2026-01-01T00:00:01Z", finalRef: "final-a", finalSha256: "c".repeat(64), itemsComplete: true, contentOmitted: false, isComplete: true };
    const file = path.join(process.env.C2C_STATE_DIR!, "executions", `${workspace.id}.jsonl`);
    appendExecutionRecord(workspace.id, record);
    return { target, record, observation, file };
  }

  it("does not turn a late observation into another execution or latest test for new and old readers", () => {
    withRecordEnvironment((_root, workspace) => {
      const { target, record, observation, file } = fixture(workspace);
      const latest = { ...record, taskId: "later-task", iteration: 2, tests: "newest actual test", outputId: 2, maintenance: undefined };
      appendExecutionRecord(workspace.id, latest);
      expect(appendMaintenanceProviderObservation(target, observation)).toBe(true);
      expect(readExecutionRecords(workspace.id)).toEqual([record, latest]); expect(latestExecutionRecord(workspace.id)).toEqual(latest);
      const oldMaintenance = executionRecordSchema.shape.maintenance.unwrap().omit({ provider: true }).strict();
      const oldReader = executionRecordSchema.extend({ maintenance: oldMaintenance.optional() });
      const legacy = fs.readFileSync(file, "utf8").trim().split("\n").flatMap(line => { const parsed = oldReader.safeParse(JSON.parse(line)); return parsed.success ? [parsed.data] : []; });
      expect(legacy).toEqual([record, latest]);
      const original = fs.readFileSync(file);
      expect(appendMaintenanceProviderObservation(target, observation)).toBe(false); expect(fs.readFileSync(file)).toEqual(original);
      expect(readMaintenanceExecutionHistory(target).observations).toEqual([observation]);
    });
  });

  it.each(["malformed", "partial", "unknown", "duplicate-key"])("fails closed on a %s history tail without overwriting it", (kind) => {
    withRecordEnvironment((_root, workspace) => {
      const { target, observation, file } = fixture(workspace);
      fs.appendFileSync(file, kind === "malformed" ? "not-json\n" : kind === "partial" ? "{\"taskId\":" : kind === "unknown" ? "{\"schemaVersion\":99}\n" : "{\"taskId\":\"first\",\"taskId\":\"second\"}\n");
      const original = fs.readFileSync(file);
      expect(() => appendMaintenanceProviderObservation(target, observation)).toThrow(); expect(fs.readFileSync(file)).toEqual(original);
    });
  });

  it.each(["inputRef", "finalRef", "finalSha256"] as const)("refuses changed %s and preserves previous evidence", (field) => {
    withRecordEnvironment((_root, workspace) => {
      const { target, observation, file } = fixture(workspace); appendMaintenanceProviderObservation(target, observation);
      const original = fs.readFileSync(file);
      expect(() => appendMaintenanceProviderObservation(target, { ...observation, [field]: field === "finalSha256" ? "d".repeat(64) : "changed" })).toThrow(/conflict/);
      expect(fs.readFileSync(file)).toEqual(original);
    });
  });

  it("does not heal partial append failure or treat it as an absent observation", () => {
    withRecordEnvironment((_root, workspace) => {
      const { target, observation, file } = fixture(workspace), original = fs.readFileSync(file);
      const append = fs.appendFileSync;
      vi.spyOn(fs, "appendFileSync").mockImplementationOnce((destination, payload) => { append(destination, String(payload).slice(0, 27)); throw new Error("fixture disk full"); });
      try { expect(() => appendMaintenanceProviderObservation(target, observation)).toThrow("fixture disk full"); } finally { vi.restoreAllMocks(); }
      const partial = fs.readFileSync(file); expect(partial.subarray(0, original.length)).toEqual(original);
      expect(() => appendMaintenanceProviderObservation(target, observation)).toThrow(); expect(fs.readFileSync(file)).toEqual(partial);
    });
  });

  it("checks the full history beyond the legacy listing limit", () => {
    withRecordEnvironment((_root, workspace) => {
      const { target, record, observation } = fixture(workspace);
      for (let iteration = 2; iteration <= 270; iteration++) appendExecutionRecord(workspace.id, { ...record, taskId: `other-${iteration}`, iteration, outputId: iteration, maintenance: undefined });
      expect(appendMaintenanceProviderObservation(target, observation)).toBe(true);
      expect(readExecutionRecords(workspace.id, 1)[0].iteration).toBe(270);
    });
  });

  it("reads the same references in a fresh process without writing another observation", () => {
    withRecordEnvironment((_root, workspace) => {
      const { target, observation, file } = fixture(workspace); appendMaintenanceProviderObservation(target, observation);
      const original = fs.readFileSync(file);
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
        "import { readMaintenanceExecutionHistory } from './src/execution/records.ts'; console.log(JSON.stringify(readMaintenanceExecutionHistory(JSON.parse(process.argv[1])).observations));", JSON.stringify(target)],
        { cwd: projectRoot, encoding: "utf8", env: process.env });
      expect(child.status, child.stderr).toBe(0); expect(JSON.parse(child.stdout)).toEqual([observation]);
      expect(fs.readFileSync(file)).toEqual(original);
    });
  });

  it("rejects an observation row that changes the original test identity", () => {
    withRecordEnvironment((_root, workspace) => {
      const { target, record, observation, file } = fixture(workspace);
      appendExecutionRecord(workspace.id, { ...record, tests: "forged test", maintenance: { ...record.maintenance!, provider: observation } });
      const original = fs.readFileSync(file);
      expect(() => readMaintenanceExecutionHistory(target)).toThrow(/changed the saved execution/);
      expect(fs.readFileSync(file)).toEqual(original);
    });
  });

  it.each(["execution", "observation"] as const)("rejects same-operation binding corruption in an %s row", (kind) => {
    withRecordEnvironment((_root, workspace) => {
      const { target, record, observation, file } = fixture(workspace);
      for (const field of ["sessionId", "turnId", "outputId", "head", "resultSha256", "planRef"] as const) {
        const initial = fs.readFileSync(file);
        const changed = { ...record, maintenance: { ...record.maintenance!, ...(kind === "observation" ? { provider: observation } : {}) } };
        if (field === "outputId") changed.outputId = 99;
        else changed.maintenance[field] = field === "head" ? "d".repeat(40) : field === "resultSha256" ? "e".repeat(64) : "different-binding";
        appendExecutionRecord(workspace.id, changed);
        const corrupt = fs.readFileSync(file);
        expect(() => readMaintenanceExecutionHistory(target), field).toThrow(/binding/);
        expect(() => appendMaintenanceProviderObservation(target, observation), field).toThrow(/binding/);
        expect(fs.readFileSync(file)).toEqual(corrupt);
        fs.writeFileSync(file, initial);
      }
    });
  });

  it("does not let incomplete candidate references seal the accepted final identity", () => {
    withRecordEnvironment((_root, workspace) => {
      const { target, record, observation, file } = fixture(workspace);
      const candidate = { ...observation, status: "interrupted" as const, isComplete: false, finalRef: "candidate-only", finalSha256: null };
      appendExecutionRecord(workspace.id, { ...record, maintenance: { ...record.maintenance!, provider: candidate } });
      const prior = fs.readFileSync(file);
      expect(appendMaintenanceProviderObservation(target, observation)).toBe(true);
      expect(readMaintenanceExecutionHistory(target).observations).toEqual([candidate, observation]);
      expect(fs.readFileSync(file).subarray(0, prior.length)).toEqual(prior);
      expect(() => appendMaintenanceProviderObservation(target, { ...observation, finalRef: "different-accepted-final" })).toThrow(/conflict/);
    });
  });
});

function runRecord(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", cliEntry, "record", "--workspace", root, "--task", "c2c_test", ...args],
    { cwd: projectRoot, encoding: "utf8", env: process.env }
  );
}

function withRecordEnvironment(run: (root: string, workspace: Workspace) => void): void {
  const root = makeTmpDir("record-cli-workspace");
  const stateDir = makeTmpDir("record-cli-state");
  const previousStateDir = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;

  try {
    run(root, new Workspace(root));
  } finally {
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    cleanup(root);
    cleanup(stateDir);
  }
}

describe("c2c record", () => {
  it("records valid numeric options and command output", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "2",
        "--changed-files",
        "3",
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
        "--exit-code",
        "1",
      ]);

      expect(result.status).toBe(0);
      expect(readExecutionRecords(workspace.id)).toEqual([
        expect.objectContaining({ taskId: "c2c_test", iteration: 2, changedFiles: 3 }),
      ]);
      expect(listExecutionOutputs(workspace.id)).toEqual([
        expect.objectContaining({ command: "pnpm test", exitCode: 1, iteration: 2 }),
      ]);
    });
  });

  it("rejects a non-integer iteration without recording the execution", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, ["--iteration", "abc"]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });

  it("rejects an unsafe changed-file count before recording command output", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "1",
        "--changed-files",
        "9".repeat(400),
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
      ]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
    });
  });

  it("rejects a negative changed-file count", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, ["--iteration", "1", "--changed-files=-1"]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });

  it("rejects a non-integer exit code before recording command output", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "1",
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
        "--exit-code",
        "abc",
      ]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
    });
  });
});

describe("execution record persistence", () => {
  it("rejects invalid records at the write boundary", () => {
    withRecordEnvironment((_root, workspace) => {
      const invalidRecord: ExecutionRecord = {
        taskId: "c2c_invalid",
        iteration: Number.NaN,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      };

      expect(() => appendExecutionRecord(workspace.id, invalidRecord)).toThrow();
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });
});
