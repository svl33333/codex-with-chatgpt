import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createHash } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";
import { readEvidenceGit } from "../workspace/git-evidence.js";
import { readCanonicalSelection } from "../runner/canonical.js";
import { parseStrictJson } from "../config/strict-json.js";
import { maintenanceProviderObservationSchema, type MaintenanceProviderObservation, type MaintenanceTarget } from "../conversation/maintenance-handoff.js";

/**
 * Lightweight execution records written by the Codex harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary` and `test_status` MCP tools.
 */
export const executionRecordSchema = z.object({
  taskId: z.string(),
  iteration: z.number().int().nonnegative(),
  changedFiles: z.union([z.array(z.string()), z.number().int().nonnegative()]),
  tests: z.string().nullable(),
  exitStatus: z.string(),
  timestamp: z.string(),
  notes: z.string().optional(),
  outputId: z.number().int().positive().optional(),
  outputAvailable: z.boolean().optional(),
  maintenance: z.object({
    profile: z.literal("maintenance-v1.2/end-of-turn-browser-v1"), goalRef: z.string().min(1), planRef: z.string().min(1),
    operationId: z.string().min(1), sessionId: z.string().min(1), turnId: z.string().min(1),
    head: z.string().regex(/^[a-f0-9]{40}$/), resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
    provider: maintenanceProviderObservationSchema.optional(),
  }).strict().optional(),
  canonicalReview: z.object({
    workstream: z.string(), workflowCommit: z.string().regex(/^[a-f0-9]{40}$/),
    checkpoint: z.string().min(1), reviewStage: z.literal("post_implementation"),
    cycle: z.number().int().positive(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
});

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

export function captureExecutionInputDigest(workspaceRoot: string): string {
  const workspace = new Workspace(workspaceRoot);
  const listed = readEvidenceGit(workspace.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const files = [...new Set(listed.split("\0").filter(Boolean))].sort().filter(file =>
    !file.startsWith(".harness/") && !workspace.ignoreRules.isSensitive(file) &&
    (!workspace.ignoreRules.isNoise(file) || /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(file)));
  if (!files.length || files.length > 4096) throw new Error("execution input coverage unavailable");
  const digest = createHash("sha256");
  let totalBytes = 0;
  for (const file of files) {
    if (fs.existsSync(path.join(workspace.root, file)) && fs.lstatSync(path.join(workspace.root, file)).isSymbolicLink()) throw new Error("unsupported execution input symlink");
    const resolved = workspace.resolve(file).abs;
    if (!fs.existsSync(resolved)) { digest.update(JSON.stringify([file, "deleted"])); continue; }
    const metadata = fs.lstatSync(resolved);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsupported execution input");
    totalBytes += metadata.size;
    if (totalBytes > 32 * 1024 * 1024) throw new Error("execution inputs exceed bound");
    const bytes = fs.readFileSync(resolved);
    digest.update(JSON.stringify([file, bytes.length, metadata.mode & 0o111])).update(bytes);
  }
  return digest.digest("hex");
}

export function bindExecutionToCanonicalReview(input: {
  workspaceRoot: string; workstream: string; workflowCheckout: string; beforeInputDigest: string;
}): NonNullable<ExecutionRecord["canonicalReview"]> {
  const selection = readCanonicalSelection(input);
  const { workflow, c2c } = selection.state;
  if (workflow.step !== 5 || c2c?.review_stage !== "post_implementation" || !c2c.checkpoint || !Number.isSafeInteger(c2c.cycle) || c2c.cycle < 1) throw new Error("execution canonical review mapping unavailable");
  const inputDigest = captureExecutionInputDigest(selection.root);
  // Recording after execution cannot manufacture the missing before observation.
  if (!/^[a-f0-9]{64}$/.test(input.beforeInputDigest) || input.beforeInputDigest !== inputDigest) throw new Error("execution inputs changed or were not observed before execution");
  return { workstream: selection.workstream, workflowCommit: selection.pin, checkpoint: c2c.checkpoint, reviewStage: c2c.review_stage, cycle: c2c.cycle, inputDigest };
}

function recordsFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  const file = recordsFile(workspaceId);
  fs.appendFileSync(file, JSON.stringify(executionRecordSchema.parse(record)) + "\n", { mode: 0o600 });
}

export function readExecutionRecords(workspaceId: string, limit = 10): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  const requestedLimit = Math.max(1, Math.floor(limit));
  for (let index = lines.length - 1; index >= 0 && records.length < requestedLimit; index--) {
    try {
      const record = executionRecordSchema.safeParse(JSON.parse(lines[index]));
      // Observations are not executions, including a late final for an older iteration.
      if (record.success && !record.data.maintenance?.provider) records.push(record.data);
    } catch {
      // skip corrupt lines
    }
  }
  return records.reverse();
}

export function latestExecutionRecord(workspaceId: string): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1);
  return records[records.length - 1] ?? null;
}

export function readMaintenanceExecutionHistory(target: MaintenanceTarget): { execution: ExecutionRecord; observations: MaintenanceProviderObservation[] } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(target.workspaceId)) throw new Error("invalid observation workspace");
  const file = path.join(getStateDir(), "executions", `${target.workspaceId}.jsonl`);
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsupported execution history file");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  if (raw && !raw.endsWith("\n")) throw new Error("incomplete execution history tail");
  const records = raw.split("\n").filter((line) => line.trim()).map((line) => executionRecordSchema.strict().parse(parseStrictJson(line)));
  const matches = records.filter((record) => {
    const saved = record.maintenance;
    return saved && saved.goalRef === target.goalId && saved.operationId === target.operationId;
  });
  for (const record of matches) {
    const saved = record.maintenance!;
    if (record.outputId !== target.result.outputId || saved.planRef !== target.planRef || saved.sessionId !== target.sessionId || saved.turnId !== target.turnId || saved.head !== target.head || saved.resultSha256 !== target.result.sha256) {
      throw new Error("same-operation Maintenance binding conflict");
    }
  }
  const executions = matches.filter((record) => !record.maintenance!.provider);
  if (executions.length !== 1) throw new Error("exact Maintenance execution record is missing or ambiguous");
  for (const record of matches) {
    if (record.maintenance!.provider && JSON.stringify({ ...record, maintenance: { ...record.maintenance!, provider: undefined } }) !== JSON.stringify(executions[0])) {
      throw new Error("provider observation changed the saved execution");
    }
  }
  const observations = matches.flatMap((record) => record.maintenance!.provider ? [record.maintenance!.provider] : []);
  const acceptedFinal = observations.find((observation) => observation.isComplete);
  for (const observation of observations) {
    if (observation.inputRef !== observations[0].inputRef) throw new Error("provider input reference conflict");
    if (observation.isComplete && acceptedFinal && (observation.finalRef !== acceptedFinal.finalRef || observation.finalSha256 !== acceptedFinal.finalSha256)) {
      throw new Error("provider final reference or body conflict");
    }
  }
  return { execution: executions[0], observations };
}

export function appendMaintenanceProviderObservation(target: MaintenanceTarget, input: MaintenanceProviderObservation): boolean {
  const observation = maintenanceProviderObservationSchema.parse(input);
  const history = readMaintenanceExecutionHistory(target);
  for (const previous of history.observations) {
    if (previous.inputRef !== observation.inputRef || previous.isComplete && observation.isComplete && (previous.finalRef !== observation.finalRef || previous.finalSha256 !== observation.finalSha256)) {
      throw new Error("provider observation conflicts with saved history");
    }
  }
  if (history.observations.some((previous) => JSON.stringify(previous) === JSON.stringify(observation))) return false;
  appendExecutionRecord(target.workspaceId, { ...history.execution, maintenance: { ...history.execution.maintenance!, provider: observation } });
  return true;
}
