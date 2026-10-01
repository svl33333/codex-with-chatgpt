import { createHash } from "node:crypto";
import type { DeliveryMessageType } from "./authorization.js";

const MAX_BYTES = 1024;
const MAX_VALUE = 160;

export interface C2cEnvelopeInput {
  type: DeliveryMessageType;
  taskId: string;
  iteration: number;
  checkpoint: string;
  stage: string;
  workspaceId: string;
  workstreamId?: string;
  eventKey: string;
  intent: string;
  state?: string;
  counts?: Record<string, number>;
  evidence?: string[];
  bindingHash?: string;
}

export interface C2cEnvelope {
  text: string;
  payloadHash: string;
  byteLength: number;
  fragmented: false;
  reducedFields: string[];
}

function value(value: string | undefined, limit = MAX_VALUE): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/[\r\n]+/g, " ");
  return normalized ? normalized.slice(0, limit) : undefined;
}

function safeCounts(counts: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!counts) return undefined;
  const entries = Object.entries(counts)
    .filter(([key, count]) => /^[a-zA-Z0-9_.-]{1,32}$/.test(key) && Number.isFinite(count))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 8)
    .map(([key, count]) => [key, Math.max(0, Math.floor(count))] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function render(input: C2cEnvelopeInput, includeOptional: boolean): string {
  const fields: Record<string, unknown> = {
    C2C: input.type,
    TASK: value(input.taskId),
    ITERATION: Math.max(0, Math.floor(input.iteration)),
    CHECKPOINT: value(input.checkpoint),
    STAGE: value(input.stage),
    WORKSPACE: value(input.workspaceId),
    EVENT: value(input.eventKey),
    INTENT: value(input.intent, 220),
  };
  if (includeOptional) {
    const optional: Record<string, unknown> = {
      ...(value(input.workstreamId) ? { WORKSTREAM: value(input.workstreamId) } : {}),
      ...(value(input.state) ? { STATE: value(input.state, 64) } : {}),
      ...(value(input.bindingHash) ? { BINDING: value(input.bindingHash, 96) } : {}),
      ...(safeCounts(input.counts) ? { COUNTS: safeCounts(input.counts) } : {}),
      ...(input.evidence?.length
        ? { EVIDENCE: input.evidence.map((entry) => value(entry, 96)).filter((entry): entry is string => Boolean(entry)).slice(0, 4) }
        : {}),
    };
    Object.assign(fields, optional);
  }
  // Field insertion order is fixed above and nested count keys are sorted by
  // safeCounts, so this serialization is deterministic without a replacer
  // that could accidentally erase nested allowlisted values.
  return `[C2C] ${JSON.stringify(fields)}`;
}

/** Build one deterministic, allowlisted control envelope. It never fragments. */
export function buildC2cEnvelope(input: C2cEnvelopeInput): C2cEnvelope {
  if (!input.taskId || !input.checkpoint || !input.stage || !input.workspaceId || !input.eventKey || !input.intent) {
    throw new Error("C2C envelope is missing a required identity field");
  }
  let text = render(input, true);
  const reducedFields: string[] = [];
  if ((input.evidence?.length ?? 0) > 4) reducedFields.push("evidence");
  if (Object.keys(input.counts ?? {}).length > 8) reducedFields.push("counts");
  if ((input.intent?.length ?? 0) > 220) reducedFields.push("intent");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    text = render({ ...input, evidence: undefined, counts: undefined, bindingHash: undefined }, true);
    for (const field of ["evidence", "counts", "bindingHash"]) if (!reducedFields.includes(field)) reducedFields.push(field);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    text = render({ ...input, workstreamId: undefined, state: undefined }, false);
    for (const field of ["workstreamId", "state"]) if (!reducedFields.includes(field)) reducedFields.push(field);
  }
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAX_BYTES) throw new Error("C2C envelope exceeds 1 KiB after deterministic reduction");
  return {
    text,
    payloadHash: createHash("sha256").update(text).digest("hex").slice(0, 32),
    byteLength,
    fragmented: false,
    reducedFields,
  };
}

export const buildControlEnvelope = buildC2cEnvelope;
