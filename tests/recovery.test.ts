import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeGitRepo, makeTmpDir, cleanup, isolateStateDir } from "./helpers.js";
import {
  canonicalizeRecoveryRoot,
  recoveryCheckpointFile,
  recoveryBindingFile,
  readRecoveryBinding,
  attestRecoveryCapabilities,
  seedRecoveryBinding,
  validateRecoveryBinding,
  writeRecoveryBinding,
} from "../src/recovery/bindings.js";
import { makeConnectionBinding, readConnectionBinding, writeConnectionBinding } from "../src/connection/identity.js";
import { acquireBindingLock, bindingLockFile } from "../src/recovery/locks.js";
import { InMemoryProtectedSecretStore, type ProtectedSecretStore } from "../src/recovery/secret-store.js";
import {
  InProcessTestTunnelAdapter,
  type SecureTunnelAdapter,
  type SecureTunnelObservation,
  type SecureTunnelReconcileRequest,
} from "../src/recovery/tunnel-adapter.js";
import { recoverBinding } from "../src/recovery/reconciler.js";
import { uninstallRecoveryState } from "../src/recovery/lifecycle.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import type { OwnedBridgeObservation } from "../src/recovery/bridge-observation.js";
import { observeOwnedBridge } from "../src/recovery/bridge-observation.js";
import { Workspace } from "../src/workspace/manager.js";
import { setAtomicWriteTestHook, writeSecureAtomicJson } from "../src/config/paths.js";
import {
  installSupervisor,
  statusSupervisor,
  supervisorCreateArgs,
  supervisorDefinitionFile,
  supervisorLogFile,
  supervisorOwnershipMarker,
  supervisorTaskAction,
  supervisorTaskXml,
  uninstallSupervisor,
} from "../src/recovery/supervisor.js";

let stateDir: string | undefined;
let temp: string | undefined;

afterEach(() => {
  setAtomicWriteTestHook(null);
  if (temp) cleanup(temp);
  if (stateDir) cleanup(stateDir);
  delete process.env.C2C_STATE_DIR;
  temp = undefined;
  stateDir = undefined;
});

async function setup(): Promise<{ root: string; bindingId: string }> {
  stateDir = isolateStateDir();
  temp = makeTmpDir("recovery-workspace");
  makeGitRepo(temp);
  const workspace = new Workspace(temp);
  const authoritative = makeConnectionBinding({ workspaceId: workspace.id, workspace: workspace.name, workspaceRoot: temp });
  writeConnectionBinding(authoritative);
  const secretStore = new InMemoryProtectedSecretStore(new Map([[`binding:${workspace.id}:secure-mcp`, "secret"]]));
  const tunnelAdapter = new InProcessTestTunnelAdapter("test-profile");
  const protectedSecretRef = `binding:${workspace.id}:secure-mcp`;
  const capability = await attestRecoveryCapabilities({
    connectionBindingId: workspace.id,
    protectedSecretRef,
    tunnelProfileRef: "test-profile",
    secretStore,
    tunnelAdapter,
  });
  seedRecoveryBinding({
    root: temp,
    binding: authoritative,
    tunnelProfileRef: "test-profile",
    protectedSecretRef: `binding:${workspace.id}:secure-mcp`,
    capability,
  });
  return { root: temp, bindingId: workspace.id };
}

class StaleEndpointTunnelAdapter implements SecureTunnelAdapter {
  // Same provider identity as the attested in-process test client; the test
  // varies only the observed endpoint to exercise reconciliation.
  readonly name = "in-process-test";
  readonly consumption = "in_process" as const;
  reconcileCount = 0;
  private current: SecureTunnelObservation;

  constructor(private readonly profileRef: string, private readonly postReconcileEndpoint: string | null = null) {
    this.current = {
      running: true,
      url: "https://test.invalid/stale",
      profileRef,
      provider: this.name,
      localEndpoint: "http://127.0.0.1:40000/mcp",
    };
  }

  async inspect() {
    return { available: true as const, provider: this.name, clientVersion: "test", mechanism: "in-process handle" };
  }

  async verifyProfile(profileRef: string): Promise<boolean> {
    return profileRef === this.profileRef;
  }

  async observe(profileRef: string): Promise<SecureTunnelObservation> {
    return {
      ...this.current,
      profileRef,
      ...(this.postReconcileEndpoint && this.reconcileCount > 0 ? { localEndpoint: this.postReconcileEndpoint } : {}),
    };
  }

  async reconcile(request: SecureTunnelReconcileRequest): Promise<SecureTunnelObservation> {
    await request.secret.consume();
    this.reconcileCount += 1;
    this.current = {
      running: true,
      url: "https://test.invalid/reconciled",
      profileRef: request.profileRef,
      provider: this.name,
      localEndpoint: request.localEndpoint,
    };
    return this.current;
  }
}

describe("P0-2 recovery state", () => {
  it("seeds and validates a binding against the authoritative identity", async () => {
    const fixture = await setup();
    const record = readRecoveryBinding(fixture.bindingId);
    expect(record?.connectionBindingId).toBe(fixture.bindingId);
    expect(record?.protectedSecretRef).toBe(`binding:${fixture.bindingId}:secure-mcp`);
    expect(validateRecoveryBinding(record!, fixture.root).canonicalAllowedRoot).toBe(canonicalizeRecoveryRoot(fixture.root));
  });

  it("rejects a recovery record whose canonical root redirects outside the workspace", async () => {
    const fixture = await setup();
    const record = readRecoveryBinding(fixture.bindingId)!;
    expect(() => validateRecoveryBinding({ ...record, canonicalAllowedRoot: path.dirname(fixture.root) }, fixture.root)).toThrow(/root/);
  });

  it("rejects provider-name strings that are not capability attestations", async () => {
    const fixture = await setup();
    expect(() => seedRecoveryBinding({
      root: fixture.root,
      binding: readConnectionBinding(fixture.bindingId),
      tunnelProfileRef: "test-profile",
      protectedSecretRef: `binding:${fixture.bindingId}:secure-mcp`,
      capability: { protectedSecretProvider: "in-process-test", tunnelProvider: "in-process-test" } as never,
    })).toThrow(/verified/);
  });

  it("binds a capability attestation to the exact secret and tunnel resources", async () => {
    const fixture = await setup();
    const record = readRecoveryBinding(fixture.bindingId)!;
    const capability = await attestRecoveryCapabilities({
      connectionBindingId: fixture.bindingId,
      protectedSecretRef: record.protectedSecretRef,
      tunnelProfileRef: record.tunnelProfileRef,
      secretStore: new InMemoryProtectedSecretStore(new Map([[record.protectedSecretRef, "secret"]])),
      tunnelAdapter: new InProcessTestTunnelAdapter(record.tunnelProfileRef),
    });
    expect(() => seedRecoveryBinding({
      root: fixture.root,
      binding: readConnectionBinding(fixture.bindingId),
      tunnelProfileRef: "foreign-profile",
      protectedSecretRef: record.protectedSecretRef,
      capability,
    })).toThrow(/exact recovery resources/);
    expect(() => seedRecoveryBinding({
      root: fixture.root,
      binding: readConnectionBinding(fixture.bindingId),
      tunnelProfileRef: record.tunnelProfileRef,
      protectedSecretRef: `binding:${fixture.bindingId}:foreign-secret`,
      capability,
    })).toThrow(/exact recovery resources/);
  });

  it("serializes competing callers with an exclusive binding lock", async () => {
    stateDir = isolateStateDir();
    const first = await acquireBindingLock("binding-test", { waitMs: 100 });
    await expect(acquireBindingLock("binding-test", { waitMs: 20, pollMs: 10 })).rejects.toMatchObject({ status: "recovery_waiting" });
    expect(fs.existsSync(bindingLockFile("binding-test"))).toBe(true);
    first.release();
    const second = await acquireBindingLock("binding-test", { waitMs: 100 });
    second.release();
  });

  it("waits for a live lock held by a separate process", async () => {
    stateDir = isolateStateDir();
    const bindingId = "cross-process-binding";
    const file = bindingLockFile(bindingId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const childScript = [
      "const fs=require('node:fs');",
      "const file=process.env.C2C_TEST_LOCK_FILE;",
      "const owner={schemaVersion:1,connectionBindingId:process.env.C2C_TEST_LOCK_ID,pid:process.pid,processStartMarker:`${process.pid}:child`,acquiredAt:new Date().toISOString()};",
      "const fd=fs.openSync(file,'wx',0o600); fs.writeFileSync(fd,JSON.stringify(owner)); fs.closeSync(fd);",
      "process.stdout.write('locked'); setTimeout(()=>{fs.rmSync(file,{force:true}); process.exit(0)},700);",
    ].join(" ");
    const child = spawn(process.execPath, ["-e", childScript], {
      cwd: process.cwd(),
      env: { ...process.env, C2C_STATE_DIR: stateDir, C2C_TEST_LOCK_FILE: file, C2C_TEST_LOCK_ID: bindingId },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("child lock owner did not start")), 2_000);
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("locked")) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      await expect(acquireBindingLock(bindingId, { waitMs: 60, pollMs: 10 })).rejects.toMatchObject({ status: "recovery_waiting" });
    } finally {
      if (!child.killed) child.kill();
      if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });

  it("fails closed when lock ownership metadata is malformed", async () => {
    stateDir = isolateStateDir();
    const file = bindingLockFile("malformed-lock");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not-json");
    await expect(acquireBindingLock("malformed-lock", { waitMs: 20 })).rejects.toMatchObject({ status: "ambiguous_ownership" });
  });

  it("reclaims a lock whose recorded owner is dead", async () => {
    stateDir = isolateStateDir();
    const bindingId = "dead-owner-binding";
    const file = bindingLockFile(bindingId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      connectionBindingId: bindingId,
      pid: 2147483647,
      processStartMarker: "dead-owner",
      acquiredAt: new Date().toISOString(),
    }));
    const lock = await acquireBindingLock(bindingId, { waitMs: 100, pollMs: 10 });
    expect(lock.owner.pid).toBe(process.pid);
    lock.release();
  });

  it("does not overwrite a checkpoint when lock acquisition is rejected", async () => {
    const fixture = await setup();
    const checkpoint = recoveryCheckpointFile(fixture.bindingId);
    writeSecureAtomicJson(checkpoint, { sentinel: "competing-recovery" });
    const held = await acquireBindingLock(fixture.bindingId, { waitMs: 100 });
    try {
      const result = await recoverBinding(fixture.root, fixture.bindingId, { lockWaitMs: 20, });
      expect(result.status).toBe("recovery_waiting");
      expect(JSON.parse(fs.readFileSync(checkpoint, "utf8"))).toEqual({ sentinel: "competing-recovery" });
    } finally {
      held.release();
    }
  });

  it("writes recovery state atomically and keeps task actions secret-free", () => {
    stateDir = isolateStateDir();
    const file = path.join(stateDir, "recovery", "checkpoint.json");
    writeSecureAtomicJson(file, { status: "prepared" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ status: "prepared" });
    writeSecureAtomicJson(file, { status: "replaced" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ status: "replaced" });
    setAtomicWriteTestHook({ beforeReplace: () => { throw new Error("injected replacement interruption"); } });
    expect(() => writeSecureAtomicJson(file, { status: "interrupted" })).toThrow(/interruption/);
    setAtomicWriteTestHook(null);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ status: "replaced" });
    writeSecureAtomicJson(file, { status: "after-interruption" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ status: "after-interruption" });
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
    const action = supervisorTaskAction({ bindingId: "binding-test", cliPath: "C:\\Program Files\\c2c\\index.js" });
    expect(action).toContain("-EncodedCommand");
    const encoded = action.split("-EncodedCommand ")[1];
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain("binding-test");
    expect(action).not.toMatch(/token|secret|bearer/i);
    const decodedAction = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decodedAction).toContain("$LASTEXITCODE");
    expect(decodedAction).toContain("exit $recoveryExitCode");
    const options = { bindingId: "binding-test", cliPath: "C:\\c2c\\index.js", startupPolicy: "user_logon" as const };
    expect(supervisorCreateArgs(options)).not.toContain("/F");
    expect(supervisorTaskXml(options)).toContain("<Delay>PT30S</Delay>");
    expect(supervisorTaskXml(options)).toContain("<RestartOnFailure>");
    expect(supervisorTaskXml(options)).toContain("<Hidden>true</Hidden>");
  });

  it("executes the encoded supervisor action on Windows", () => {
    if (process.platform !== "win32") return;
    stateDir = isolateStateDir();
    const options = {
      bindingId: "encoded-action-test",
      cliPath: path.join(process.cwd(), "dist", "cli", "index.js"),
      startupPolicy: "user_logon" as const,
    };
    const action = supervisorTaskAction(options);
    const encoded = action.split("-EncodedCommand ")[1];
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, C2C_STATE_DIR: stateDir },
    });
    expect(result.status).not.toBeNull();
    expect(fs.existsSync(supervisorLogFile(options.bindingId))).toBe(true);
  });

  it("installs, reconciles, and removes only the exact owned supervisor task", async () => {
    const fixture = await setup();
    const options = {
      bindingId: fixture.bindingId,
      cliPath: path.join(process.cwd(), "dist", "cli", "index.js"),
      startupPolicy: "user_logon" as const,
    };
    let installed = false;
    let creates = 0;
    let deletes = 0;
    const runner = (args: string[]) => {
      if (args[0] === "/__QUERY_OWNED__") {
        if (!installed) return { status: 2, stdout: "", stderr: "" };
        const action = supervisorTaskAction(options);
        return {
          status: 0,
          stdout: JSON.stringify({
            Description: supervisorOwnershipMarker(options),
            Actions: [{
              Execute: "powershell.exe",
              Arguments: action.slice("powershell.exe ".length),
              WorkingDirectory: path.dirname(path.resolve(options.cliPath)),
            }],
          }),
          stderr: "",
        };
      }
      if (args[0] === "/Create") {
        creates += 1;
        installed = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "/Delete") {
        deletes += 1;
        installed = false;
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected scheduler operation" };
    };
    const missing = installSupervisor({ ...options, bindingId: "missing-binding" }, runner);
    expect(missing).toMatchObject({ ok: false, status: "ambiguous_ownership" });
    const record = readRecoveryBinding(fixture.bindingId)!;
    writeRecoveryBinding({ ...record, startupPolicy: "manual" });
    expect(installSupervisor(options, runner)).toMatchObject({ ok: false, status: "ambiguous_ownership" });
    writeRecoveryBinding(record);
    expect(installSupervisor(options, runner)).toMatchObject({ ok: true, status: "installed" });
    expect(installSupervisor(options, runner)).toMatchObject({ ok: true, status: "installed" });
    expect(creates).toBe(1);
    const foreign = { ...options, nodePath: "C:\\other\\node.exe" };
    expect(statusSupervisor(foreign, runner)).toMatchObject({ ok: false, status: "ambiguous_ownership" });
    expect(uninstallSupervisor(options, runner)).toMatchObject({ ok: true, status: "absent" });
    expect(deletes).toBe(1);
    if (process.platform === "win32") {
      expect(statusSupervisor(options, () => ({ status: 3, stdout: "", stderr: "scheduler unavailable" }))).toMatchObject({
        ok: false,
        status: "ambiguous_ownership",
      });
    }
  });

  it("recovers a stopped bridge with injected in-process secret and tunnel seams", async () => {
    const fixture = await setup();
    const record = readRecoveryBinding(fixture.bindingId)!;
    let observationCount = 0;
    const healthy: OwnedBridgeObservation = {
      state: "healthy",
      runtime: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: fixture.bindingId,
        workspaceRoot: fixture.root,
        pid: process.pid,
        port: 48765,
        adminToken: "test-only",
        publicUrl: null,
        startedAt: "2026-09-28T00:00:00.000Z",
      },
      info: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: fixture.bindingId,
        workspaceName: record.projectName,
        workspaceRoot: fixture.root,
        port: 48765,
        publicUrl: null,
        tunnel: { running: false, url: null, provider: "in-process-test" },
        tokenCount: 0,
        pairingActive: false,
        pid: process.pid,
        startedAt: "2026-09-28T00:00:00.000Z",
      },
    };
    const stopped: OwnedBridgeObservation = { state: "stopped", runtime: null, reason: "runtime_missing" };
    const adapter = new InProcessTestTunnelAdapter(record.tunnelProfileRef);
    const result = await recoverBinding(fixture.root, fixture.bindingId, {
      secretStore: new InMemoryProtectedSecretStore(new Map([[record.protectedSecretRef, "secret"]])),
      tunnelAdapter: adapter,
      ensureBridge: async () => ({ runtime: healthy.runtime, spawned: true }),
      observeBridge: async () => {
        observationCount += 1;
        return observationCount === 1 ? stopped : healthy;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("started");
    expect(result.tunnel.running).toBe(true);
  });

  it("persists an operation failure while holding the lock, then permits the next recovery", async () => {
    const fixture = await setup();
    const first = await recoverBinding(fixture.root, fixture.bindingId, {
      observeBridge: async () => { throw new Error("injected locked operation failure"); },
    });
    expect(first.status).toBe("recovery_waiting");
    const checkpoint = JSON.parse(fs.readFileSync(recoveryCheckpointFile(fixture.bindingId), "utf8")) as { status: string };
    expect(checkpoint.status).toBe("recovery_waiting");
    const second = await recoverBinding(fixture.root, fixture.bindingId, {
      observeBridge: async () => { throw new Error("second recovery failure"); },
    });
    expect(second.status).toBe("recovery_waiting");
  });

  it("reuses a healthy exact tunnel without resolving an unavailable secret", async () => {
    const fixture = await setup();
    const record = readRecoveryBinding(fixture.bindingId)!;
    const healthy: OwnedBridgeObservation = {
      state: "healthy",
      runtime: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: fixture.bindingId,
        workspaceRoot: fixture.root,
        pid: process.pid,
        port: 48765,
        adminToken: "test-only",
        publicUrl: null,
        startedAt: "2026-09-28T00:00:00.000Z",
      },
      info: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: fixture.bindingId,
        workspaceName: record.projectName,
        workspaceRoot: fixture.root,
        port: 48765,
        publicUrl: null,
        tunnel: { running: true, url: "https://test.invalid/current", provider: record.capability.tunnelProvider },
        tokenCount: 0,
        pairingActive: false,
        pid: process.pid,
        startedAt: "2026-09-28T00:00:00.000Z",
      },
    };
    const unavailableSecret: ProtectedSecretStore = {
      name: record.capability.protectedSecretProvider,
      consumption: "unsupported",
      async inspect() { return { available: false, provider: this.name, mechanism: "none", reason: "test outage" }; },
      async resolve() { throw new Error("secret must not be resolved for exact reuse"); },
      async verifyReference() { return false; },
    };
    const adapter = new InProcessTestTunnelAdapter(
      record.tunnelProfileRef,
      "https://test.invalid/current",
      "http://127.0.0.1:48765/mcp",
    );
    const result = await recoverBinding(fixture.root, fixture.bindingId, {
      secretStore: unavailableSecret,
      tunnelAdapter: adapter,
      observeBridge: async () => healthy,
    });
    expect(result).toMatchObject({ ok: true, status: "reused" });
  });

  it("returns a bounded capability result without mutating an unsupported tunnel", async () => {
    const fixture = await setup();
    const record = readRecoveryBinding(fixture.bindingId)!;
    const healthy: OwnedBridgeObservation = {
      state: "healthy",
      runtime: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: fixture.bindingId,
        workspaceRoot: fixture.root,
        pid: process.pid,
        port: 48765,
        adminToken: "test-only",
        publicUrl: null,
        startedAt: "2026-09-28T00:00:00.000Z",
      },
      info: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: fixture.bindingId,
        workspaceName: record.projectName,
        workspaceRoot: fixture.root,
        port: 48765,
        publicUrl: null,
        tunnel: { running: false, url: null, provider: "unavailable" },
        tokenCount: 0,
        pairingActive: false,
        pid: process.pid,
        startedAt: "2026-09-28T00:00:00.000Z",
      },
    };
    const result = await recoverBinding(fixture.root, fixture.bindingId, {
      observeBridge: async () => healthy,
      // The default unsupported adapter is intentionally exercised here.
      secretStore: new InMemoryProtectedSecretStore(new Map([[record.protectedSecretRef, "secret"]])),
    });
    expect(result.status).toBe("unsupported_tunnel_capability");
    expect(result.ok).toBe(false);
  });

  it("reconciles a running tunnel whose observed local endpoint is stale", async () => {
    const fixture = await setup();
    const record = readRecoveryBinding(fixture.bindingId)!;
    const healthy: OwnedBridgeObservation = {
      state: "healthy",
      runtime: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: fixture.bindingId,
        workspaceRoot: fixture.root,
        pid: process.pid,
        port: 48765,
        adminToken: "test-only",
        publicUrl: null,
        startedAt: "2026-09-28T00:00:00.000Z",
      },
      info: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: fixture.bindingId,
        workspaceName: record.projectName,
        workspaceRoot: fixture.root,
        port: 48765,
        publicUrl: null,
        tunnel: { running: true, url: "https://test.invalid/stale", provider: "stale-endpoint-test" },
        tokenCount: 0,
        pairingActive: false,
        pid: process.pid,
        startedAt: "2026-09-28T00:00:00.000Z",
      },
    };
    const adapter = new StaleEndpointTunnelAdapter(record.tunnelProfileRef);
    const result = await recoverBinding(fixture.root, fixture.bindingId, {
      secretStore: new InMemoryProtectedSecretStore(new Map([[record.protectedSecretRef, "secret"]])),
      tunnelAdapter: adapter,
      observeBridge: async () => healthy,
    });
    expect(result).toMatchObject({ ok: true, status: "tunnel_reconciled" });
    expect(adapter.reconcileCount).toBe(1);
    expect(result.tunnel.url).toBe("https://test.invalid/reconciled");
  });

  it("does not commit when post-reconcile tunnel observation disagrees", async () => {
    const fixture = await setup();
    const record = readRecoveryBinding(fixture.bindingId)!;
    const healthy: OwnedBridgeObservation = {
      state: "healthy",
      runtime: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: fixture.bindingId,
        workspaceRoot: fixture.root,
        pid: process.pid,
        port: 48765,
        adminToken: "test-only",
        publicUrl: null,
        startedAt: "2026-09-28T00:00:00.000Z",
      },
      info: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: fixture.bindingId,
        workspaceName: record.projectName,
        workspaceRoot: fixture.root,
        port: 48765,
        publicUrl: null,
        tunnel: { running: true, url: "https://test.invalid/stale", provider: "stale-endpoint-test" },
        tokenCount: 0,
        pairingActive: false,
        pid: process.pid,
        startedAt: "2026-09-28T00:00:00.000Z",
      },
    };
    const adapter = new StaleEndpointTunnelAdapter(record.tunnelProfileRef, "http://127.0.0.1:48764/mcp");
    const result = await recoverBinding(fixture.root, fixture.bindingId, {
      secretStore: new InMemoryProtectedSecretStore(new Map([[record.protectedSecretRef, "secret"]])),
      tunnelAdapter: adapter,
      observeBridge: async () => healthy,
    });
    expect(result).toMatchObject({ ok: false, status: "recovery_waiting" });
  });

  it("requires an in-process protected-secret transport even when inspection says available", async () => {
    const fixture = await setup();
    const record = readRecoveryBinding(fixture.bindingId)!;
    const healthy: OwnedBridgeObservation = {
      state: "healthy",
      runtime: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: fixture.bindingId,
        workspaceRoot: fixture.root,
        pid: process.pid,
        port: 48765,
        adminToken: "test-only",
        publicUrl: null,
        startedAt: "2026-09-28T00:00:00.000Z",
      },
      info: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: fixture.bindingId,
        workspaceName: record.projectName,
        workspaceRoot: fixture.root,
        port: 48765,
        publicUrl: null,
        tunnel: { running: false, url: null, provider: "test" },
        tokenCount: 0,
        pairingActive: false,
        pid: process.pid,
        startedAt: "2026-09-28T00:00:00.000Z",
      },
    };
    const unsupportedTransport: ProtectedSecretStore = {
      name: "misconfigured-test-store",
      consumption: "unsupported",
      async inspect() { return { available: true, provider: "misconfigured-test-store", mechanism: "external" }; },
      async resolve() { throw new Error("must not resolve"); },
    };
    const result = await recoverBinding(fixture.root, fixture.bindingId, {
      secretStore: unsupportedTransport,
      tunnelAdapter: new InProcessTestTunnelAdapter(record.tunnelProfileRef),
      observeBridge: async () => healthy,
    });
    expect(result.status).toBe("protected_secret_unavailable");
  });

  it("fails closed for owned-secret cleanup and removes only pre-existing state", async () => {
    const fixture = await setup();
    writeSecureAtomicJson(recoveryCheckpointFile(fixture.bindingId), { status: "prepared" });
    fs.mkdirSync(path.dirname(supervisorLogFile(fixture.bindingId)), { recursive: true });
    fs.writeFileSync(supervisorLogFile(fixture.bindingId), "redacted");
    fs.mkdirSync(path.dirname(supervisorDefinitionFile(fixture.bindingId)), { recursive: true });
    fs.writeFileSync(supervisorDefinitionFile(fixture.bindingId), "owned");
    const checkpointDir = path.dirname(recoveryCheckpointFile(fixture.bindingId));
    const ownedTemp = path.join(checkpointDir, `.${fixture.bindingId}.json.123.tmp`);
    const foreignTemp = path.join(checkpointDir, ".other-binding.json.123.tmp");
    fs.writeFileSync(ownedTemp, "owned-temp");
    fs.writeFileSync(foreignTemp, "foreign-temp");
    const removed = await uninstallRecoveryState(fixture.bindingId);
    expect(removed).toMatchObject({ ok: true, status: "removed" });
    expect(readRecoveryBinding(fixture.bindingId)).toBeNull();
    expect(fs.existsSync(recoveryCheckpointFile(fixture.bindingId))).toBe(false);
    expect(fs.existsSync(supervisorLogFile(fixture.bindingId))).toBe(false);
    expect(fs.existsSync(supervisorDefinitionFile(fixture.bindingId))).toBe(false);
    expect(fs.existsSync(ownedTemp)).toBe(false);
    expect(fs.existsSync(foreignTemp)).toBe(true);

    const authoritative = makeConnectionBinding({
      workspaceId: fixture.bindingId,
      workspace: new Workspace(fixture.root).name,
      workspaceRoot: fixture.root,
    });
    writeConnectionBinding(authoritative);
    const ownedSecretStore = new InMemoryProtectedSecretStore(new Map([[`binding:${fixture.bindingId}:owned-secret`, "owned"]]));
    const capability = await attestRecoveryCapabilities({
      connectionBindingId: fixture.bindingId,
      protectedSecretRef: `binding:${fixture.bindingId}:owned-secret`,
      tunnelProfileRef: "owned-profile",
      secretStore: ownedSecretStore,
      tunnelAdapter: new InProcessTestTunnelAdapter("owned-profile"),
    });
    seedRecoveryBinding({
      root: fixture.root,
      binding: authoritative,
      tunnelProfileRef: "owned-profile",
      protectedSecretRef: `binding:${fixture.bindingId}:owned-secret`,
      createdBy: "p0-2",
      capability,
    });
    const blocked = await uninstallRecoveryState(fixture.bindingId);
    expect(blocked).toMatchObject({ ok: false, status: "protected_secret_unavailable" });
    expect(readRecoveryBinding(fixture.bindingId)).not.toBeNull();
    const removedOwned = await uninstallRecoveryState(fixture.bindingId, { secretStore: ownedSecretStore });
    expect(removedOwned).toMatchObject({ ok: true, status: "removed" });
    expect(ownedSecretStore.releasedRefs.has(`binding:${fixture.bindingId}:owned-secret`)).toBe(true);
  });

  it("keeps the binding until subordinate cleanup completes so uninstall can retry", async () => {
    const fixture = await setup();
    writeSecureAtomicJson(recoveryCheckpointFile(fixture.bindingId), { status: "prepared" });
    const bindingFile = recoveryBindingFile(fixture.bindingId);
    const originalRemove = fs.rmSync;
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (typeof target === "string" && path.resolve(target) === path.resolve(bindingFile)) {
        throw new Error("injected binding removal interruption");
      }
      return originalRemove(target, options as never);
    });
    try {
      const interrupted = await uninstallRecoveryState(fixture.bindingId);
      expect(interrupted).toMatchObject({ ok: false, status: "ambiguous_ownership" });
    } finally {
      removeSpy.mockRestore();
    }
    expect(readRecoveryBinding(fixture.bindingId)).not.toBeNull();
    expect(fs.existsSync(recoveryCheckpointFile(fixture.bindingId))).toBe(false);
    const retried = await uninstallRecoveryState(fixture.bindingId);
    expect(retried).toMatchObject({ ok: true, status: "removed" });
    expect(readRecoveryBinding(fixture.bindingId)).toBeNull();
  });

  it("retries owned-secret release after an interrupted cleanup", async () => {
    const fixture = await setup();
    const authoritative = readConnectionBinding(fixture.bindingId)!;
    const protectedSecretRef = `binding:${fixture.bindingId}:owned-retry-secret`;
    const ownedSecretStore = new InMemoryProtectedSecretStore(new Map([[protectedSecretRef, "owned"]]));
    const capability = await attestRecoveryCapabilities({
      connectionBindingId: fixture.bindingId,
      protectedSecretRef,
      tunnelProfileRef: "test-profile",
      secretStore: ownedSecretStore,
      tunnelAdapter: new InProcessTestTunnelAdapter("test-profile"),
    });
    seedRecoveryBinding({
      root: fixture.root,
      binding: authoritative,
      tunnelProfileRef: "test-profile",
      protectedSecretRef,
      createdBy: "p0-2",
      capability,
    });
    const bindingFile = recoveryBindingFile(fixture.bindingId);
    const originalRemove = fs.rmSync;
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (typeof target === "string" && path.resolve(target) === path.resolve(bindingFile)) {
        throw new Error("injected post-release interruption");
      }
      return originalRemove(target, options as never);
    });
    try {
      const interrupted = await uninstallRecoveryState(fixture.bindingId, { secretStore: ownedSecretStore });
      expect(interrupted).toMatchObject({ ok: false, status: "ambiguous_ownership" });
    } finally {
      removeSpy.mockRestore();
    }
    expect(ownedSecretStore.releasedRefs.has(protectedSecretRef)).toBe(true);
    const retried = await uninstallRecoveryState(fixture.bindingId, { secretStore: ownedSecretStore });
    expect(retried).toMatchObject({ ok: true, status: "removed" });
    expect(readRecoveryBinding(fixture.bindingId)).toBeNull();
  });

  it("fails closed on authenticated admin PID reuse", async () => {
    const fixture = await setup();
    const record = readRecoveryBinding(fixture.bindingId)!;
    const runtime = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: fixture.bindingId,
      workspaceRoot: fixture.root,
      pid: process.pid,
      port: 48765,
      adminToken: "test-only",
      publicUrl: null,
      startedAt: "2026-09-28T00:00:00.000Z",
    };
    const admin = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: fixture.bindingId,
      workspaceName: record.projectName,
      workspaceRoot: fixture.root,
      port: runtime.port,
      publicUrl: null,
      tunnel: { running: false, url: null, provider: "test" },
      tokenCount: 0,
      pairingActive: false,
      pid: runtime.pid + 1,
      startedAt: runtime.startedAt,
    };
    const observed = await observeOwnedBridge(fixture.root, record, {
      findBridgeObservation: async () => ({ state: "healthy", runtime }),
      adminFetch: async <T>() => admin as T,
    });
    expect(observed).toMatchObject({ state: "ambiguous" });
  });
});
