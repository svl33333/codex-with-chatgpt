import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { CloudflaredNamedTunnel } from "../src/tunnel/cloudflared-named.js";

function fixture(tunnelId?: string) {
  const child = Object.assign(new EventEmitter(), {
    pid: 50000, exitCode: null as number | null, signalCode: null as string | null,
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
  const spawn = vi.fn(() => child as unknown as ChildProcess);
  const tunnel = new CloudflaredNamedTunnel({
    tunnelName: "legacy-name", tunnelId, hostname: "fixture.example.invalid",
    binaryOverride: "synthetic-cloudflared", spawnImpl: spawn, stopTimeoutMs: 10,
  });
  const start = async () => {
    const started = tunnel.start(32171);
    child.stderr.write("Registered tunnel connection\n");
    await started;
  };
  const exit = () => { child.exitCode = 0; child.emit("exit", 0); };
  return { child, spawn, tunnel, start, exit };
}

describe("named provider restart ownership", () => {
  it.each([undefined, "11111111-1111-4111-8111-111111111111"])("uses the verified UUID, or retains legacy name behavior: %s", async (id) => {
    const { spawn, tunnel, start, exit } = fixture(id);
    await start();
    const args = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(args[1].slice(-2)).toEqual(["run", id ?? "legacy-name"]);
    expect(args[1]).not.toContain("create");
    expect(args[1]).not.toContain("route");
    exit();
    await tunnel.stop();
  });

  it("waits for actual child exit after kill was requested", async () => {
    const { child, tunnel, start, exit } = fixture();
    await start();
    let finished = false;
    const stopping = tunnel.stop().then(() => { finished = true; });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(finished).toBe(false);
    exit(); await stopping;
    expect(finished).toBe(true);
    expect(tunnel.status().running).toBe(false);
  });

  it("retains an owned child after kill errors until exit is observed", async () => {
    const { child, tunnel, start, exit } = fixture();
    await start();
    child.kill.mockImplementation(() => {
      child.emit("error", new Error("synthetic permission failure"));
      return false;
    });
    await expect(tunnel.stop()).rejects.toThrow("NAMED_TUNNEL_STOP_TIMEOUT");
    await expect(tunnel.stop()).rejects.toThrow("NAMED_TUNNEL_STOP_TIMEOUT");
    expect(child.kill).toHaveBeenCalledTimes(2);
    await expect(tunnel.start(32171)).rejects.toThrow("NAMED_TUNNEL_BUSY");
    exit(); await tunnel.stop();
  });
});
