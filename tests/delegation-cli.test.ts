import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("A1 delegation CLI boundary", () => {
  it("keeps proof evaluation separate from class continuations and provider loading", () => {
    const source = fs.readFileSync(path.resolve("src/cli/index.ts"), "utf8");
    expect(source).toContain('.command("read")');
    expect(source).toContain('.command("reconcile")');
    expect(source).toContain("const activeBinding = deriveActiveCanonicalBinding");
    expect(source).toContain("const evaluation = await resolveDelegationProviderIfRequired(request, evaluateDelegationProof(request)");
    expect(source).toContain('if (request.action === "workspace_read" || request.action === "c2c_transport")');
    expect(source).toContain("if (evaluation.proof.evidencePath !== \"provider_bound\")");
    expect(source.indexOf("resolveDelegationProviderIfRequired(request, evaluateDelegationProof(request)")).toBeGreaterThan(source.indexOf("const delegationCmd"));
    expect(source).toContain("structural TeamAI result");
    expect(source).toContain("structural grants are not accepted");
    expect(source).toContain('.command("grant-revoke")');
    expect(source).toContain('.requiredOption("--input <path>", "strict JSON canonical revocation decision and provenance")');
    expect(source).toContain("assertAuthoritativeRevocation(grant, approval)");
    const delegationStart = source.indexOf("const delegationCmd");
    const readStart = source.indexOf('.command("read")', delegationStart);
    const reconcileStart = source.indexOf('.command("reconcile")', readStart);
    const evaluateStart = source.indexOf('.command("evaluate")', reconcileStart);
    expect(delegationStart).toBeGreaterThan(-1);
    expect(readStart).toBeGreaterThan(-1);
    expect(reconcileStart).toBeGreaterThan(readStart);
    expect(evaluateStart).toBeGreaterThan(reconcileStart);
    expect(source.slice(readStart, reconcileStart)).toContain('.requiredOption("--binding-file <path>"');
    expect(source.slice(reconcileStart, evaluateStart)).toContain('.requiredOption("--binding-file <path>"');
    expect(source.slice(evaluateStart)).toContain('.requiredOption("--binding-file <path>"');
    const builtCli = path.resolve("dist/cli/index.js");
    if (fs.existsSync(builtCli)) {
      const result = spawnSync(process.execPath, [builtCli, "delegation", "--help"], { encoding: "utf8", windowsHide: true });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("read");
      expect(result.stdout).toContain("reconcile");
    }
  });

  it("derives the binding root from the active CLI workspace, never from caller scope", () => {
    const source = fs.readFileSync(path.resolve("src/cli/index.ts"), "utf8");
    expect(source).toContain("function parseDelegationRequestInput(fileName: string, bindingFile: string, workspaceRoot: string)");
    expect(source).toContain("deriveActiveCanonicalBinding({ workspaceRoot, workspaceId: candidate.workspaceId, candidate })");
    expect(source).not.toContain("candidate.workspaceRoot ?? (typeof scope.workspaceRoot === \"string\" ? scope.workspaceRoot : undefined)");
    expect(source).not.toContain("and --binding-file must identify the active workspace root");

    const delegationStart = source.indexOf("const delegationCmd");
    const readStart = source.indexOf('.command("read")', delegationStart);
    const reconcileStart = source.indexOf('.command("reconcile")', readStart);
    const evaluateStart = source.indexOf('.command("evaluate")', reconcileStart);
    for (const slice of [
      source.slice(readStart, reconcileStart),
      source.slice(reconcileStart, evaluateStart),
      source.slice(evaluateStart),
    ]) {
      expect(slice).toContain('.option("-w, --workspace <path>", "active workspace root (defaults to the current directory)")');
      expect(slice).toContain("parseDelegationRequestInput(opts.request, opts.bindingFile, resolveWorkspace(opts.workspace))");
    }
  });
});
