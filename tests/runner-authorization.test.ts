import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir, git } from "./helpers.js";
import { makeRunnerFixture, makeWorkflowFixture } from "./runner-fixtures.js";
import { canonicalMessageType, classifyCanonical, readCanonicalSelection } from "../src/runner/canonical.js";
import { createWorkflowAuthorizationIssuer, deriveActiveCanonicalBinding, deriveCanonical28Binding } from "../src/conversation/authorization.js";
import { readSession, writeSession } from "../src/session/state.js";

describe("A0 canonical2.8 compatibility", () => {
  let workflow: string;
  let stateDir: string;
  let fixture: ReturnType<typeof makeRunnerFixture>;
  beforeAll(() => { workflow = makeWorkflowFixture(); });
  beforeEach(() => { stateDir = isolateStateDir(); fixture = makeRunnerFixture(workflow); });
  afterEach(() => { cleanup(fixture.root); cleanup(stateDir); });
  afterAll(() => cleanup(workflow));

  it("maps the four exact supported review tuples inside the existing A0 owner", () => {
    const events = new Set<string>();
    for (const [step, cycle, verdict, message] of [[3, 1, null, "REVIEW"], [3, 2, "FIX_REQUIRED", "RE_REVIEW"], [5, 1, null, "EXECUTED"], [5, 2, "FIX_REQUIRED", "RE_REVIEW"]] as const) {
      fixture.state.workflow.step = step;
      fixture.state.workflow.stage = step === 3 ? "Implementation Plan + C2C Review" : "Implementation + C2C Review";
      Object.assign(fixture.state.c2c, { cycle, verdict, review_stage: step === 3 ? "pre_implementation" : "post_implementation" });
      fixture.saveState(); fixture.ownerContext();
      const binding = deriveCanonical28Binding(fixture.input);
      const issuer = createWorkflowAuthorizationIssuer({ workflowStep: step, stage: fixture.state.workflow.stage, issuerId: "ignored-caller-label", messageType: message, binding });
      expect(issuer.authorizedMessageType).toBe(message);
      expect(binding.taskId).toBe(fixture.state.c2c.checkpoint);
      events.add(binding.eventKey!);
    }
    expect(events.size).toBe(4);
  });

  it("reads the exact resolver checkout pin without requiring local release tags", () => {
    expect(git(workflow, "tag", "--list").trim()).toBe("");
    expect(readCanonicalSelection(fixture.input).pin).toBe(fixture.state.workflow.spec_commit);
    expect(deriveCanonical28Binding(fixture.input).checkpoint).toBe("fixture-checkpoint");
  });

  it("keeps one logical event across dirty-state, formatting and Goal edits", () => {
    const original = deriveCanonical28Binding(fixture.input);
    fixture.goal.revision += 1; fixture.saveGoal();
    fs.appendFileSync(fixture.stateFile, "\n# formatting only\n");
    fs.writeFileSync(path.join(fixture.root, "hello.txt"), "dirty work product\n");
    fixture.ownerContext();
    const next = deriveCanonical28Binding(fixture.input);
    expect(next.eventKey).toBe(original.eventKey);
    expect(next.taskId).toBe(original.taskId);
  });

  it("blocks every forbidden status and action without a private transport projection", () => {
    for (const status of ["READY", "HUMAN_WAITING", "PUSH_WAITING", "BLOCKED", "DONE", "ABANDONED"]) {
      fixture.state.workflow.status = status; fixture.saveState();
      expect(() => deriveCanonical28Binding(fixture.input)).toThrow();
    }
    fixture.state.workflow.status = "RUNNING";
    for (const last_action of ["REMEDIATE", "VALIDATE", "HUMAN_GATE", "BLOCK", "PROCEED"]) {
      fixture.state.c2c.last_action = last_action; fixture.saveState();
      expect(() => deriveCanonical28Binding(fixture.input)).toThrow();
    }
  });

  it("does not route PASS, human decisions, unavailable evidence or mismatched review stages", () => {
    for (const verdict of ["PASS", "HUMAN_DECISION_REQUIRED", "REQUIRED_CAPABILITY_UNAVAILABLE"]) {
      fixture.state.c2c.verdict = verdict; fixture.saveState();
      expect(() => deriveCanonical28Binding(fixture.input)).toThrow();
    }
    fixture.state.c2c.verdict = null; fixture.state.c2c.review_stage = "pre_implementation"; fixture.saveState();
    expect(() => deriveCanonical28Binding(fixture.input)).toThrow();
    fixture.state.c2c.review_stage = "post_implementation";
    for (const step of [1, 2, 4, 6, 7]) { fixture.state.workflow.step = step; fixture.saveState(); expect(() => deriveCanonical28Binding(fixture.input)).toThrow(); }
  });

  it("preserves actual Step4 approval and owner execution evidence as prerequisites", () => {
    fixture.state.workflow.step4_approval.approved = false; fixture.saveState();
    expect(classifyCanonical(readCanonicalSelection(fixture.input))).toBe("HUMAN_GATE_REQUIRED");
    fixture.state.workflow.step4_approval.approved = true; fixture.saveState();
    fixture.state.c2c.cycle = 2; fixture.state.c2c.verdict = "FIX_REQUIRED"; fixture.saveState();
    expect(() => deriveCanonical28Binding(fixture.input)).toThrow(/execution\/test evidence/);
  });

  it("maps Runtime task/iteration independently and rejects stale source/test bytes", () => {
    const session = readSession(fixture.workspaceId)!;
    expect(session.taskId).not.toBe(fixture.state.c2c.checkpoint);
    expect(session.iteration).not.toBe(fixture.state.c2c.cycle);
    expect(deriveCanonical28Binding(fixture.input).taskId).toBe(fixture.state.c2c.checkpoint);
    fs.appendFileSync(path.join(fixture.root, "src/index.ts"), "\nexport const changed = true;\n");
    expect(() => deriveCanonical28Binding(fixture.input)).toThrow(/execution\/test evidence/);
    fixture.ownerContext();
    fs.mkdirSync(path.join(fixture.root, "tests"));
    fs.writeFileSync(path.join(fixture.root, "tests/new.test.ts"), "// new required test input\n");
    expect(() => deriveCanonical28Binding(fixture.input)).toThrow(/execution\/test evidence/);
  });

  it("rejects missing or wrong actual App, workspace, branch and reviewer session binding", () => {
    const session = readSession(fixture.workspaceId)!;
    for (const patch of [{ mcpAppId: undefined }, { workspaceId: "wrong" }, { branch: "wrong" }, { chatId: "wrong" }]) {
      writeSession(fixture.workspaceId, { ...session, transport: { ...session.transport, ...patch } });
      expect(() => deriveCanonical28Binding(fixture.input)).toThrow();
    }
    writeSession(fixture.workspaceId, session);
    const binding = deriveCanonical28Binding(fixture.input);
    expect(() => deriveActiveCanonicalBinding({ workspaceRoot: fixture.root, workspaceId: fixture.workspaceId, candidate: { ...binding, eventKey: "caller-event" } })).toThrow();
    expect(() => deriveActiveCanonicalBinding({ workspaceRoot: fixture.root, workspaceId: fixture.workspaceId, candidate: JSON.parse(JSON.stringify(binding)) })).toThrow();
  });

  it("rejects duplicate YAML keys, unsafe tags, aliases and conflicting legacy fields", () => {
    const original = fs.readFileSync(fixture.stateFile, "utf8");
    for (const addition of ["workflow: {}\n", "unsafe: !custom value\n", "unsafe: &a { x: 1 }\ncopy: *a\n"]) {
      fs.writeFileSync(fixture.stateFile, original + addition);
      expect(() => readCanonicalSelection(fixture.input)).toThrow();
    }
    fixture.saveState();
    fixture.state.c2c.event_key = "caller-event"; fixture.saveState();
    expect(() => deriveCanonical28Binding(fixture.input)).toThrow(/conflicting legacy/);
  });

  it("supports only non-issuing recovery from C2C_WAITING", () => {
    const running = deriveCanonical28Binding(fixture.input);
    fixture.state.workflow.status = "C2C_WAITING"; fixture.saveState();
    const waiting = deriveCanonical28Binding(fixture.input);
    expect(waiting.eventKey).toBe(running.eventKey);
    expect(canonicalMessageType(readCanonicalSelection(fixture.input))).toBe("EXECUTED");
    expect(() => createWorkflowAuthorizationIssuer({ workflowStep: 5, stage: fixture.state.workflow.stage, issuerId: "caller", messageType: "EXECUTED", binding: waiting })).toThrow(/not running/);
  });

  it("requires one explicit selected path, same repository/Issue, branch and supported pin", () => {
    expect(() => readCanonicalSelection({ ...fixture.input, workstream: "../partial-a2" })).toThrow();
    fixture.state.git.branch = "other"; fixture.saveState(); expect(() => readCanonicalSelection(fixture.input)).toThrow();
    fixture.state.git.branch = "main"; fixture.state.issue.url = "https://github.com/wrong/repo/issues/10"; fixture.saveState(); expect(() => readCanonicalSelection(fixture.input)).toThrow();
    fixture.state.issue.url = fixture.goal.selection.repository + "/issues/10"; fixture.state.workflow.spec_version = "2.9.0"; fixture.saveState(); expect(() => readCanonicalSelection(fixture.input)).toThrow();
    fixture.state.workflow.spec_version = "2.8.0"; fixture.state.workflow.spec_commit = "a".repeat(40); fixture.saveState(); expect(() => readCanonicalSelection(fixture.input)).toThrow();
    expect(git(fixture.root, "status", "--porcelain")).not.toMatch(/^ M src\//m);
  });
});
