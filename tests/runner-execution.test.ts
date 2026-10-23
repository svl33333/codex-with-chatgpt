import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir } from "./helpers.js";
import { makeRunnerFixture, makeWorkflowFixture } from "./runner-fixtures.js";
import { bindExecutionToCanonicalReview, captureExecutionInputDigest, readExecutionRecords } from "../src/execution/records.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
describe("existing execution logger canonical association", () => {
  let workflow: string;
  let stateDir: string;
  let fixture: ReturnType<typeof makeRunnerFixture>;
  beforeAll(() => { workflow = makeWorkflowFixture(); });
  beforeEach(() => { stateDir = isolateStateDir(); fixture = makeRunnerFixture(workflow); });
  afterEach(() => { cleanup(fixture.root); cleanup(stateDir); });
  afterAll(() => cleanup(workflow));

  it("rejects changed inputs at recording without manufacturing a before observation", () => {
    const beforeInputDigest = captureExecutionInputDigest(fixture.root);
    fs.appendFileSync(path.join(fixture.root, "src/index.ts"), "\nexport const later = 1;\n");
    expect(() => bindExecutionToCanonicalReview({ ...fixture.input, beforeInputDigest })).toThrow(/inputs changed/);
  });

  it("keeps source identity independent of state and review metadata changes", () => {
    const before = captureExecutionInputDigest(fixture.root);
    fixture.state.updated_at = new Date().toISOString(); fixture.saveState();
    fixture.goal.revision++; fixture.saveGoal();
    expect(captureExecutionInputDigest(fixture.root)).toBe(before);
  });

  function record(before: string) {
    return spawnSync(process.execPath, ["--import", "tsx", path.join(project, "src/cli/index.ts"), "record", "-w", fixture.root,
      "--task", "actual-runtime-task", "--iteration", "4", "--tests", "synthetic fixture passed", "--command", "synthetic fixture validation", "--output", "fixture passed", "--exit-code", "0",
      "--workstream", fixture.input.workstream, "--workflow-root", workflow, "--input-digest", before], { cwd: project, env: process.env, encoding: "utf8", timeout: 30_000, windowsHide: true });
  }

  it("retains real Runtime task/iteration and adds canonical association to the same record", () => {
    const before = captureExecutionInputDigest(fixture.root);
    const execution = record(before);
    expect(execution.status).toBe(0);
    expect(readExecutionRecords(fixture.workspaceId).at(-1)).toMatchObject({ taskId: "actual-runtime-task", iteration: 4, canonicalReview: { checkpoint: "fixture-checkpoint", cycle: 1, workstream: fixture.input.workstream, inputDigest: before } });
  });

  it("does not save a successful association when inputs changed before the CLI recorded it", () => {
    const before = captureExecutionInputDigest(fixture.root);
    const count = readExecutionRecords(fixture.workspaceId).length;
    fs.appendFileSync(path.join(fixture.root, "src/index.ts"), "\nexport const afterRun = 2;\n");
    expect(record(before).status).not.toBe(0);
    expect(readExecutionRecords(fixture.workspaceId)).toHaveLength(count);
  });
});
