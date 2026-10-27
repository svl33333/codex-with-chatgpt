import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBridge } from "../src/process/daemon.js";
import { findBridgeObservation, findLiveBridge } from "../src/bridge/runtime.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof childProcess>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});
vi.mock("../src/bridge/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../src/bridge/runtime.js")>("../src/bridge/runtime.js");
  return { ...actual, findBridgeObservation: vi.fn(), findLiveBridge: vi.fn() };
});

let root: string, state: string;
let child: ReturnType<typeof fakeChild>;
function fakeChild() {
  const created = Object.assign(new EventEmitter(), {
    pid: 50000, exitCode: null as number | null, signalCode: null as string | null,
    unref: vi.fn(), kill: vi.fn(() => true),
  });
  created.kill.mockImplementation(() => {
    queueMicrotask(() => { created.exitCode = 0; created.emit("exit", 0); });
    return true;
  });
  return created;
}
beforeEach(() => {
  state = isolateStateDir(); root = makeTmpDir("restart-daemon");
  child = fakeChild();
  vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
  vi.mocked(findBridgeObservation).mockResolvedValue({ state: "stopped", runtime: null, reason: "runtime_missing" });
  vi.mocked(findLiveBridge).mockResolvedValue(null);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers(); vi.resetAllMocks();
  delete process.env.C2C_STATE_DIR;
  cleanup(root); cleanup(state);
});
const options = { restart: { tunnelId: "11111111-1111-4111-8111-111111111111", tunnelName: "fixture", hostname: "fixture.example.invalid" } };

describe("unready candidate ownership", () => {
  it.each(["timeout", "probe-error"] as const)("cleans only the spawned child after %s", async (failure) => {
    if (failure === "probe-error") vi.mocked(findLiveBridge).mockRejectedValue(new Error("synthetic probe failure"));
    const starting = ensureBridge(root, options);
    const rejected = expect(starting).rejects.toThrow(failure === "timeout" ? "BRIDGE_START_TIMEOUT" : "synthetic probe failure");
    await vi.advanceTimersByTimeAsync(20_500);
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.exitCode).toBe(0);
    const args = vi.mocked(childProcess.spawn).mock.calls[0][1] as string[];
    expect(args).toContain("--restart-candidate");
    expect(args).toContain(options.restart.tunnelId);
  });

  it.each(["false", "throw"])("reports cleanup failure when signalling returns %s", async (result) => {
    child.kill.mockImplementation(() => { if (result === "throw") throw new Error("synthetic kill failure"); return false; });
    const rejected = expect(ensureBridge(root, options)).rejects.toThrow("RESTART_CANDIDATE_CLEANUP_FAILED");
    await vi.advanceTimersByTimeAsync(40_500);
    await rejected;
    expect(child.exitCode).toBeNull();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
