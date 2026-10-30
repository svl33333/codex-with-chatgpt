import fs from "node:fs";
import path from "node:path";
import { parseDocument, visit, isAlias } from "yaml";
import { z } from "zod";
import { readEvidenceGit } from "../workspace/git-evidence.js";
import { Workspace } from "../workspace/manager.js";
import { canonicalRepositoryFor } from "../connection/identity.js";

export const WORKFLOW_REPOSITORY = "https://github.com/svl33333/codex-c2c-workflow";
export const MAX_ARTIFACT_BYTES = 1024 * 1024;
export const workstreamName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);

export function readBoundedText(file: string, limit = MAX_ARTIFACT_BYTES): string {
  const descriptor = fs.openSync(file, "r");
  try {
    if (!fs.fstatSync(descriptor).isFile() || fs.fstatSync(descriptor).size > limit) throw new Error("artifact size/type unavailable");
    const bytes = Buffer.alloc(limit + 1);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > limit) throw new Error("artifact exceeds limit");
    return bytes.subarray(0, count).toString("utf8");
  } finally { fs.closeSync(descriptor); }
}

export function confinedFile(root: string, selected: string): string {
  const base = fs.realpathSync.native(root);
  const file = fs.realpathSync.native(path.resolve(base, selected));
  const relative = path.relative(base, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("artifact escapes selected directory");
  return file;
}

export function parseCanonicalYaml(raw: string): Record<string, any> {
  if (Buffer.byteLength(raw) > MAX_ARTIFACT_BYTES) throw new Error("canonical state exceeds limit");
  const document = parseDocument(raw, { uniqueKeys: true, stringKeys: true, schema: "core", strict: true });
  if (document.errors.length || document.warnings.length) throw new Error("canonical YAML is invalid");
  visit(document, (_key, node) => {
    if (isAlias(node) || node && typeof node === "object" && ("tag" in node && node.tag || "anchor" in node && node.anchor)) throw new Error("canonical YAML tags/aliases are unsupported");
  });
  const state = document.toJS({ maxAliasCount: 0 });
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("canonical state is not a mapping");
  return state;
}

function gitText(root: string, args: string[]): string {
  return readEvidenceGit(root, args, MAX_ARTIFACT_BYTES).trim();
}

export interface CanonicalSelection {
  root: string;
  workstream: string;
  workspaceId: string;
  stateFile: string;
  workflowCheckout: string;
  repository: string;
  branch: string;
  pin: string;
  state: Record<string, any>;
  contract: Record<string, any>;
}

export function readCanonicalSelection(input: { workspaceRoot: string; workstream: string; workflowCheckout: string }): CanonicalSelection {
  const root = fs.realpathSync.native(input.workspaceRoot);
  const workstream = workstreamName.parse(input.workstream);
  const harness = fs.realpathSync.native(path.join(root, ".harness", workstream));
  if (path.relative(root, harness) !== path.join(".harness", workstream)) throw new Error("workstream path escaped workspace");
  const stateFile = confinedFile(harness, "state.yaml");
  const state = parseCanonicalYaml(readBoundedText(stateFile));
  const workflow = z.object({ profile: z.literal("codex-c2c-v2"), spec_repository: z.literal(WORKFLOW_REPOSITORY), spec_version: z.literal("2.8.0"), spec_commit: z.string().regex(/^[a-f0-9]{40}$/), review_contract: z.literal("schema/c2c-review-contract.json"), step: z.number().int().min(1).max(7), stage: z.string().min(1), status: z.string().min(1) }).passthrough().parse(state.workflow);
  if (state.schema_version !== "1.1") throw new Error("canonical schema version unsupported");
  const workflowCheckout = fs.realpathSync.native(input.workflowCheckout);
  if (canonicalRepositoryFor(workflowCheckout) !== WORKFLOW_REPOSITORY || gitText(workflowCheckout, ["rev-parse", "HEAD"]) !== workflow.spec_commit) throw new Error("resolved published workflow pin mismatch");
  const pinned = (file: string) => gitText(workflowCheckout, ["cat-file", "blob", `${workflow.spec_commit}:${file}`]);
  if (pinned("VERSION") !== workflow.spec_version) throw new Error("workflow version mismatch");
  const schema = JSON.parse(pinned("schema/state.schema.json"));
  const contract = JSON.parse(pinned(workflow.review_contract));
  if (!schema.properties.workflow.properties.status.enum.includes(workflow.status)) throw new Error("unknown canonical status");
  for (const key of ["review_stage", "verdict", "last_action"] as const) {
    if (state.c2c?.[key] !== undefined && !schema.properties.c2c.properties[key].enum.includes(state.c2c[key])) throw new Error("unknown canonical review field");
  }
  if (state.c2c?.cycle !== undefined && state.c2c.cycle !== null && (!Number.isSafeInteger(state.c2c.cycle) || state.c2c.cycle < 0)) throw new Error("invalid canonical cycle");
  if (state.c2c?.human_action_queue !== undefined && (!Array.isArray(state.c2c.human_action_queue) || state.c2c.human_action_queue.some((entry: unknown) => typeof entry !== "string" || !entry))) throw new Error("invalid human queue");
  const branch = gitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch || state.git?.branch !== branch || fs.realpathSync.native(gitText(root, ["rev-parse", "--show-toplevel"])) !== root) throw new Error("canonical branch/worktree mismatch");
  const repository = canonicalRepositoryFor(root);
  if (!Number.isSafeInteger(state.issue?.number) || state.issue.number < 1 || state.issue.url !== `${repository}/issues/${state.issue.number}`) throw new Error("canonical Issue/repository mismatch");
  return { root, workstream, workspaceId: new Workspace(root).id, stateFile, workflowCheckout, repository, branch, pin: workflow.spec_commit, state, contract };
}

export type RunnerOutcome = "CONTINUED" | "NO_ACTION_AVAILABLE" | "HUMAN_GATE_REQUIRED" | "CAPABILITY_BLOCKED" | "RECOVERABLE_FAILURE" | "TERMINAL";

export function classifyCanonical(selection: CanonicalSelection): RunnerOutcome | null {
  const { workflow, c2c = {} } = selection.state;
  if (["DONE", "ABANDONED"].includes(workflow.status)) return "TERMINAL";
  if (["HUMAN_WAITING", "PUSH_WAITING"].includes(workflow.status) || c2c.human_action_queue?.length || selection.contract.verdicts[c2c.verdict]?.human_waiting) return "HUMAN_GATE_REQUIRED";
  if (workflow.status === "BLOCKED" || selection.contract.verdicts[c2c.verdict]?.transition === "BLOCK") return "CAPABILITY_BLOCKED";
  if (workflow.step >= 5) {
    const approval = workflow.step4_approval;
    if (approval?.approved !== true || typeof approval.approved_at !== "string" || !approval.approved_at.trim() || !["direct", "visual"].includes(approval.route) || approval.artifact !== (approval.route === "direct" ? "02-plan.md" : "03-explain.html")) return "HUMAN_GATE_REQUIRED";
    confinedFile(path.dirname(selection.stateFile), approval.artifact);
  }
  if (workflow.status === "READY") return "NO_ACTION_AVAILABLE";
  if (!["RUNNING", "C2C_WAITING"].includes(workflow.status) || ![3, 5].includes(workflow.step)) return "NO_ACTION_AVAILABLE";
  if (["REMEDIATE", "VALIDATE"].includes(c2c.last_action)) return "CAPABILITY_BLOCKED";
  return null;
}

export function canonicalMessageType(selection: CanonicalSelection): "REVIEW" | "RE_REVIEW" | "EXECUTED" {
  const { workflow, c2c = {} } = selection.state;
  if (classifyCanonical(selection) || !["RUNNING", "C2C_WAITING"].includes(workflow.status) || c2c.last_action !== "REVIEW" || typeof c2c.checkpoint !== "string" || !c2c.checkpoint.trim() || !Number.isSafeInteger(c2c.cycle) || c2c.cycle < 1) throw new Error("canonical transport is not eligible");
  if (workflow.stage !== (workflow.step === 3 ? "Implementation Plan + C2C Review" : "Implementation + C2C Review") || c2c.review_stage !== (workflow.step === 3 ? "pre_implementation" : "post_implementation")) throw new Error("canonical review stage mismatch");
  if (c2c.cycle === 1 && c2c.verdict == null) return workflow.step === 3 ? "REVIEW" : "EXECUTED";
  if (c2c.cycle > 1 && c2c.verdict === "FIX_REQUIRED") return "RE_REVIEW";
  throw new Error("canonical verdict/cycle does not authorize transport");
}
