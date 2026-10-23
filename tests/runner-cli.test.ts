import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeRunnerFixture, makeWorkflowFixture } from "./runner-fixtures.js";
import { cleanup, isolateStateDir } from "./helpers.js";
import { runnerFiles } from "../src/runner/state.js";
import { runHeadless } from "../src/runner/headless.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(project, "src/cli/index.ts");
describe("opt-in runner command and cooperating child processes", () => {
  let workflow: string;
  let stateDir: string;
  let fixture: ReturnType<typeof makeRunnerFixture>;
  beforeAll(() => { workflow = makeWorkflowFixture(); });
  beforeEach(() => { stateDir = isolateStateDir(); fixture = makeRunnerFixture(workflow); });
  afterEach(() => { cleanup(fixture.root); cleanup(stateDir); });
  afterAll(() => cleanup(workflow));

  function cliRun(extra: string[] = []) {
    return spawnSync(process.execPath, ["--import", "tsx", cli, "runner", "run", "--workspace", fixture.root, "--workstream", fixture.input.workstream, "--goal", fixture.goalPath, "--workflow-root", workflow, ...extra], { cwd: project, env: process.env, encoding: "utf8", timeout: 30_000, windowsHide: true });
  }

  it("requires explicit selection and returns one bounded result without source execution", () => {
    const initial = fs.readFileSync(fixture.stateFile, "utf8");
    const noAction = cliRun();
    expect(noAction.status).toBe(0);
    expect(JSON.parse(noAction.stdout)).toMatchObject({ outcome: "NO_ACTION_AVAILABLE", executed: false });
    const request = path.join(fixture.harness, "request.json");
    fs.writeFileSync(request, JSON.stringify({ kind: "validation" }));
    expect(JSON.parse(cliRun(["--request-file", request]).stdout).outcome).toBe("CAPABILITY_BLOCKED");
    expect(fs.readFileSync(fixture.stateFile, "utf8")).toBe(initial);
  });

  it("rejects arbitrary adapter-module selection without executing module code", () => {
    fixture.state.workflow.status = "HUMAN_WAITING"; fixture.saveState();
    const module = path.join(fixture.harness, "must-not-import.mjs");
    fs.writeFileSync(module, "throw new Error('adapter import is forbidden at a gate');\n");
    const request = path.join(fixture.harness, "request.json");
    fs.writeFileSync(request, JSON.stringify({ kind: "transport", delegation: {} }));
    const rejected = cliRun(["--request-file", request, "--adapter-module", module]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("unknown option");
    expect(rejected.stderr).not.toContain("adapter import is forbidden");
  });

  it("rejects a separate live child holding the same selected workstream lease", async () => {
    const lock = runnerFiles(fixture.root, fixture.input.workstream).lease;
    const module = pathToFileURL(path.join(project, "src/config/lease.ts")).href;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { acquireLease } from ${JSON.stringify(module)};const lease=acquireLease(${JSON.stringify(lock)});console.log('HELD');process.stdin.resume();process.stdin.once('end',()=>{lease.release();process.exit(0)});`], { cwd: project, env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", code => { if (code !== 0) reject(new Error("fixture child failed")); }); });
      expect(await runHeadless(fixture.input)).toMatchObject({ outcome: "CAPABILITY_BLOCKED", reason: "WORKSTREAM_LEASE_HELD" });
    } finally { child.stdin.end(); await new Promise<void>(resolve => child.once("close", () => resolve())); }
  });

  it("rehydrates the same prepared iteration after an actual child process exits", async () => {
    const delegation = fixture.request();
    const module = pathToFileURL(path.join(project, "src/runner/headless.ts")).href;
    const invocation = { ...fixture.input, action: { kind: "transport", delegation } };
    const script = `import {runHeadless} from ${JSON.stringify(module)};await runHeadless({...${JSON.stringify(invocation)},adapter:{sendMessage:async()=>({}),getMessageStatus:async()=>"unknown"},afterPrepared:()=>process.exit(33)});`;
    const crashed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: project, env: process.env, encoding: "utf8", timeout: 30_000, windowsHide: true });
    expect(crashed.status).toBe(33);
    const files = runnerFiles(fixture.root, fixture.input.workstream);
    const abandoned = JSON.parse(fs.readFileSync(files.lease, "utf8"));
    abandoned.acquiredAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(files.lease, JSON.stringify(abandoned));
    expect(await runHeadless({ ...invocation, action: { kind: "transport", delegation }, adapter: { sendMessage: async () => { throw new Error("must not resend"); }, getMessageStatus: async () => "unknown" } })).toMatchObject({ outcome: "CAPABILITY_BLOCKED", executed: false, iteration: 1 });
  });
});
