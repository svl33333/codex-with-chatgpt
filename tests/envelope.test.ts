import { describe, expect, it } from "vitest";
import { buildC2cEnvelope } from "../src/conversation/envelope.js";

describe("bounded C2C envelopes", () => {
  it("is deterministic, hashed, and never fragments", () => {
    const input = {
      type: "REVIEW" as const,
      taskId: "task-a0",
      iteration: 2,
      checkpoint: "c2c_1234",
      stage: "post_implementation",
      workspaceId: "workspace-a",
      workstreamId: "a0-reliable-c2c-transport-core",
      eventKey: "c2c_1234",
      intent: "Review the implementation and bounded evidence",
      state: "READY",
      counts: { files: 3, tests: 22 },
      evidence: ["Issue #6", "02-plan.md", "04-test-summary.md"],
      bindingHash: "binding-hash",
    };
    const first = buildC2cEnvelope(input);
    const second = buildC2cEnvelope(input);
    expect(first).toEqual(second);
    expect(first.fragmented).toBe(false);
    expect(first.byteLength).toBeLessThanOrEqual(1024);
    expect(first.payloadHash).toHaveLength(32);
    expect(first.text).not.toContain("source");
    expect(first.text).not.toContain("diff");
  });

  it("reduces optional evidence before rejecting an oversized required identity", () => {
    const envelope = buildC2cEnvelope({
      type: "EXECUTED",
      taskId: "task-a0",
      iteration: 1,
      checkpoint: "c2c_5678",
      stage: "post_implementation",
      workspaceId: "workspace-a",
      eventKey: "c2c_5678",
      intent: "x".repeat(220),
      evidence: Array.from({ length: 20 }, (_, index) => `evidence-${index}-${"x".repeat(96)}`),
      counts: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`count-${index}`, index])),
    });
    expect(envelope.reducedFields.length).toBeGreaterThan(0);
    expect(envelope.byteLength).toBeLessThanOrEqual(1024);
  });
});
