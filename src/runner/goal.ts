import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { parseStrictJson } from "../config/strict-json.js";
import { confinedFile, readBoundedText, type CanonicalSelection } from "./canonical.js";

export const CONTINUATION_KEYS = ["Use C2C.", "For any GitHub authentication, authorization, device-flow, email-verification, credential-context, or recovery event, resolve and use the current TeamAI github-cli-auth Skill."] as const;
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
export const goalSchema = z.object({
  schemaVersion: z.literal(1), id: identifier, revision: z.number().int().positive(),
  objective: z.string().trim().min(1).max(8192), createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  selection: z.object({ repository: z.string().min(1), workspaceRoot: z.string().min(1), workstream: identifier, branch: z.string().min(1), statePath: z.string().min(1) }).strict(),
  continuationKeys: z.tuple([z.literal(CONTINUATION_KEYS[0]), z.literal(CONTINUATION_KEYS[1])]),
}).strict();
export type DurableGoal = z.infer<typeof goalSchema>;
export interface GoalObservation { goal: DurableGoal; digest: string; bytes: number }

export function readDurableGoal(file: string, selection: CanonicalSelection, now = Date.now()): GoalObservation {
  const harness = path.dirname(selection.stateFile);
  const raw = readBoundedText(confinedFile(harness, file), 32 * 1024);
  const goal = goalSchema.parse(parseStrictJson(raw));
  if (Date.parse(goal.createdAt) > now || Date.parse(goal.expiresAt) <= now || Date.parse(goal.expiresAt) <= Date.parse(goal.createdAt)) throw new Error("goal expired or not yet applicable");
  if (goal.selection.repository !== selection.repository || goal.selection.workspaceRoot !== selection.root || goal.selection.workstream !== selection.workstream || goal.selection.branch !== selection.branch || confinedFile(harness, goal.selection.statePath) !== selection.stateFile) throw new Error("goal selection mismatch");
  return { goal, digest: createHash("sha256").update(raw).digest("hex"), bytes: Buffer.byteLength(raw) };
}
