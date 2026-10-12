import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EphemeralPairingHandoff } from "../src/pairing/handoff.js";
import { sanitizeExecutionOutput } from "../src/execution/sanitize.js";
import { Logger } from "../src/logger/index.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const binding = {
  workspaceId: "workspace-c",
  connectorName: "Codex with ChatGPT · workspace-c",
  origin: "https://c2c-workspace-c.example",
  scopes: ["git.read", "workspace.read", "offline_access"],
};

describe("ephemeral pairing handoff", () => {
  it("consumes one exact binding and never exposes the value in diagnostics", () => {
    const handoff = new EphemeralPairingHandoff(30_000);
    const issue = handoff.issue(binding, "runtime-only-code", 1_000);
    expect(issue.expiresAt).toBe(31_000);
    expect(JSON.stringify(handoff.inspect(1_001))).not.toContain("runtime-only-code");
    expect(handoff.consume({ ...binding, now: 1_002 })).toEqual({ ok: true, pairingCode: "runtime-only-code" });
    expect(handoff.consume({ ...binding, now: 1_003 })).toEqual({ ok: false, reason: "not_found" });
  });

  it.each([
    ["workspaceId", { workspaceId: "other" }, "workspace_mismatch"],
    ["connectorName", { connectorName: "other" }, "connector_mismatch"],
    ["origin", { origin: "https://wrong.example" }, "origin_mismatch"],
    ["scopes", { scopes: ["workspace.read"] }, "scope_mismatch"],
  ])("rejects a %s mismatch without consuming the handoff", (_label, override, reason) => {
    const handoff = new EphemeralPairingHandoff();
    handoff.issue(binding, "runtime-only-code", 2_000);
    expect(handoff.consume({ ...binding, ...override, now: 2_001 })).toEqual({ ok: false, reason });
    expect(handoff.consume({ ...binding, now: 2_002 })).toEqual({ ok: true, pairingCode: "runtime-only-code" });
  });

  it("rejects non-HTTPS origins and expires deterministically", () => {
    const handoff = new EphemeralPairingHandoff(10);
    expect(() => handoff.issue({ ...binding, origin: "http://not-official.example" }, "runtime-only-code", 3_000)).toThrow(/official HTTPS/);
    handoff.issue(binding, "runtime-only-code", 3_000);
    expect(handoff.consume({ ...binding, now: 3_011 })).toEqual({ ok: false, reason: "not_found" });
  });

  it("binds consumption to the exact OAuth request", () => {
    const handoff = new EphemeralPairingHandoff();
    handoff.issue(binding, "runtime-only-code", 4_000);
    const authorization = { requestId: "request-1", clientId: "client-1", redirectUri: "https://chatgpt.com/connector/oauth/callback-1" };
    expect(handoff.claim({ ...binding, authorization, now: 4_001 })).toEqual({ ok: true });
    expect(handoff.consume({ ...binding, authorization: { ...authorization, clientId: "attacker-client" }, now: 4_002 }))
      .toEqual({ ok: false, reason: "authorization_mismatch" });
    expect(handoff.consume({ ...binding, authorization, now: 4_003 })).toEqual({ ok: true, pairingCode: "runtime-only-code" });
  });

  it("keeps synthetic pairing material in memory and redacts it from logs and output", () => {
    const stateDir = isolateStateDir();
    try {
      const pairingCode = "ABCD-EFGH";
      const handoff = new EphemeralPairingHandoff(10);
      const issued = handoff.issue(binding, pairingCode, 5_000);
      expect(JSON.stringify({ issued, inspected: handoff.inspect(5_001) })).not.toContain(pairingCode);
      expect(fs.readdirSync(stateDir)).toEqual([]);
      expect(new EphemeralPairingHandoff().consume({ ...binding, now: 5_002 })).toEqual({ ok: false, reason: "not_found" });

      const internalValues = ["c2c_at_syntheticaccess", "c2c_rt_syntheticrefresh", "syntheticdevicecode0000", "syntheticcookie00000000"];
      const message = `${pairingCode} ${internalValues[0]} ${internalValues[1]} device_code=${internalValues[2]} token=${internalValues[3]}`;
      const logFile = path.join(stateDir, "synthetic.log");
      new Logger({ file: logFile, console: false }).info(message);
      const output = sanitizeExecutionOutput(message);
      expect(output.allowed).toBe(true);
      for (const value of [pairingCode, ...internalValues]) {
        expect(fs.readFileSync(logFile, "utf8")).not.toContain(value);
        expect(JSON.stringify(output)).not.toContain(value);
      }
      expect(handoff.consume({ ...binding, now: 5_011 })).toEqual({ ok: false, reason: "not_found" });
    } finally {
      cleanup(stateDir);
      delete process.env.C2C_STATE_DIR;
    }
  });
});
