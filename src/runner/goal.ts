import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { parseStrictJson } from "../config/strict-json.js";
import { confinedFile, readBoundedText, type CanonicalSelection } from "./canonical.js";
import { MAINTENANCE_HANDOFF_PROFILE, type MaintenanceTarget } from "../conversation/maintenance-handoff.js";

export const CONTINUATION_KEYS = ["Use C2C.", "For any GitHub authentication, authorization, device-flow, email-verification, credential-context, or recovery event, resolve and use the current TeamAI github-cli-auth Skill."] as const;
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
export const goalSchema = z.object({
  schemaVersion: z.literal(1), id: identifier, revision: z.number().int().positive(),
  objective: z.string().trim().min(1).max(8192), createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  selection: z.object({ repository: z.string().min(1), workspaceRoot: z.string().min(1), workstream: identifier, branch: z.string().min(1), statePath: z.string().min(1) }).strict(),
  continuationKeys: z.tuple([z.literal(CONTINUATION_KEYS[0]), z.literal(CONTINUATION_KEYS[1])]),
}).strict();
export type DurableGoal = z.infer<typeof goalSchema>;
export const maintenanceGoalSchema = goalSchema.omit({ selection: true }).extend({
  profile: z.literal(MAINTENANCE_HANDOFF_PROFILE), planRef: z.string().min(1), recordRef: z.string().min(1),
  selection: z.object({ repository: z.string().min(1), workspaceId: z.string().min(1), workspaceRoot: z.string().min(1),
    worktreeRoot: z.string().min(1), workstream: identifier, branch: z.string().min(1) }).strict(),
}).strict();
export type MaintenanceGoal = z.infer<typeof maintenanceGoalSchema>;

export function assertMaintenanceGoalIdentity(input: MaintenanceGoal, target: MaintenanceTarget): MaintenanceGoal {
  const goal = maintenanceGoalSchema.parse(input);
  if (goal.id !== target.goalId || goal.planRef !== target.planRef || Object.entries(goal.selection).some(([name, value]) => target[name as keyof MaintenanceTarget] !== value)) throw new Error("maintenance Goal target mismatch");
  return goal;
}

export function assertMaintenanceGoalTarget(input: MaintenanceGoal, target: MaintenanceTarget): MaintenanceGoal {
  const goal = assertMaintenanceGoalIdentity(input, target);
  if (Date.parse(goal.createdAt) > Date.now() || Date.parse(goal.expiresAt) <= Date.now() || Date.parse(goal.createdAt) >= Date.parse(goal.expiresAt)) throw new Error("maintenance Goal is not active");
  return goal;
}
export interface GoalObservation { goal: DurableGoal; digest: string; bytes: number }

export function readDurableGoal(file: string, selection: CanonicalSelection, now = Date.now()): GoalObservation {
  const harness = path.dirname(selection.stateFile);
  const raw = readBoundedText(confinedFile(harness, file), 32 * 1024);
  const goal = goalSchema.parse(parseStrictJson(raw));
  if (Date.parse(goal.createdAt) > now || Date.parse(goal.expiresAt) <= now || Date.parse(goal.expiresAt) <= Date.parse(goal.createdAt)) throw new Error("goal expired or not yet applicable");
  if (goal.selection.repository !== selection.repository || goal.selection.workspaceRoot !== selection.root || goal.selection.workstream !== selection.workstream || goal.selection.branch !== selection.branch || confinedFile(harness, goal.selection.statePath) !== selection.stateFile) throw new Error("goal selection mismatch");
  return { goal, digest: createHash("sha256").update(raw).digest("hex"), bytes: Buffer.byteLength(raw) };
}
