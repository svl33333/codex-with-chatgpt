import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createHash } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";
import { runGit } from "../workspace/git.js";
import { readCanonicalSelection } from "../runner/canonical.js";

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
  const listed = runGit(workspace.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (!listed.ok) throw new Error("execution inputs unavailable");
  const files = [...new Set(listed.stdout.split("\0").filter(Boolean))].sort().filter(file =>
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
      if (record.success) records.push(record.data);
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
