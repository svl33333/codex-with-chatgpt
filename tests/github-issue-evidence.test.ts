import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssueEvidenceContext, type IssueEvidenceContext } from "../src/github/repository-evidence.js";
import { fetchPublicIssueEvidence } from "../src/github/issue-evidence.js";
import { cleanup, git, makeGitRepo, makeTmpDir } from "./helpers.js";

let root: string;
let context: IssueEvidenceContext;
const payload = () => ({ number: 21, title: "Evidence", state: "open", body: "untrusted text", updated_at: "2026-10-07T11:59:58Z", repository_url: "https://api.github.com/repos/example/reviewer", html_url: "https://github.com/example/reviewer/issues/21" });
beforeEach(() => {
  root = makeTmpDir("issue-http"); makeGitRepo(root);
  git(root, "remote", "add", "canonical", "https://github.com/example/reviewer.git");
  git(root, "config", "branch.main.remote", "canonical");
  git(root, "config", "branch.main.merge", "refs/heads/main");
  context = createIssueEvidenceContext(root, "fixture-workspace");
});
afterEach(() => cleanup(root));
const mockFetch = (response: Response) => vi.fn(async () => response) as unknown as typeof fetch;

describe("credential-free public Issue evidence", () => {
  it("sends only a fixed public GET and returns validated minimal untrusted fields", async () => {
    const transport = vi.fn(async (_url: unknown, _options: unknown) => Response.json({ ...payload(), credentials: "must-not-return", pull_request: { patch_url: "must-not-follow" } }));
    const result = await fetchPublicIssueEvidence(context, { number: 21 }, { fetch: transport as typeof fetch });
    expect(transport).toHaveBeenCalledOnce();
    const [url, options] = transport.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/example/reviewer/issues/21");
    expect(options).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    const headers = new Headers((options as RequestInit).headers);
    expect(headers.has("authorization")).toBe(false); expect(headers.has("cookie")).toBe(false);
    expect(result).toMatchObject({ number: 21, repository: "https://github.com/example/reviewer", credentialFree: true });
    expect(JSON.stringify(result)).not.toContain("must-not");
  });

  it("accepts null body and public PR-shaped Issue fields without following extra URLs", async () => {
    const result = await fetchPublicIssueEvidence(context, { number: 21 }, { fetch: mockFetch(Response.json({ ...payload(), body: null, html_url: "https://github.com/example/reviewer/pull/21", pull_request: { url: "https://attacker.invalid/secret" } })) });
    expect(result.body).toBeNull(); expect(result.url).toBe("https://github.com/example/reviewer/pull/21");
    expect(JSON.stringify(result)).not.toContain("attacker");
  });

  it.each([
    [401, {}, "ISSUE_RESTRICTED"], [403, {}, "ISSUE_RESTRICTED"], [403, { "x-ratelimit-remaining": "0" }, "ISSUE_RATE_LIMITED"],
    [403, { "retry-after": "1" }, "ISSUE_RATE_LIMITED"], [404, {}, "ISSUE_NOT_FOUND_OR_RESTRICTED"],
    [429, {}, "ISSUE_RATE_LIMITED"], [500, {}, "ISSUE_HTTP_UNAVAILABLE"], [302, { location: "https://attacker.invalid/" }, "ISSUE_REDIRECT_REJECTED"],
  ] as const)("classifies HTTP %s using only permitted evidence", async (status, headers, code) => {
    await expect(fetchPublicIssueEvidence(context, { number: 21 }, { fetch: mockFetch(new Response("SECRET_SENTINEL", { status, headers })) })).rejects.toThrow(code);
  });

  it.each([
    { number: 22 }, { state: ["open"] }, { title: null }, { body: 17 }, { updated_at: "invalid" },
    { repository_url: "https://api.github.com/repos/foreign/reviewer" }, { html_url: "https://github.com/example/reviewer/issues/22" },
  ])("rejects malformed or mismatched Issue fields %j", async (replacement) => {
    await expect(fetchPublicIssueEvidence(context, { number: 21 }, { fetch: mockFetch(Response.json({ ...payload(), ...replacement })) })).rejects.toThrow("MALFORMED_ISSUE_RESPONSE");
  });

  it("rejects oversized declared and streamed bodies without returning a partial Issue", async () => {
    await expect(fetchPublicIssueEvidence(context, { number: 21 }, { fetch: mockFetch(new Response("{}", { headers: { "content-length": "1048577" } })) })).rejects.toThrow("ISSUE_RESPONSE_TOO_LARGE");
    await expect(fetchPublicIssueEvidence(context, { number: 21 }, { fetch: mockFetch(new Response("x".repeat(1048577))) })).rejects.toThrow("ISSUE_RESPONSE_TOO_LARGE");
  });

  it("sanitizes network failures and times out even if a transport never settles", async () => {
    const broken = vi.fn(async () => { throw new Error("SECRET_SENTINEL"); }) as typeof fetch;
    await expect(fetchPublicIssueEvidence(context, { number: 21 }, { fetch: broken })).rejects.toThrow(/^ISSUE_NETWORK_UNAVAILABLE$/);
    await expect(fetchPublicIssueEvidence(context, { number: 21 }, { fetch: (() => new Promise(() => {})) as typeof fetch, timeoutMs: 5 })).rejects.toThrow("ISSUE_TIMEOUT");
  });

  it("rejects unknown input, mismatched audience and repository drift before HTTP", async () => {
    const transport = vi.fn();
    await expect(fetchPublicIssueEvidence(context, { number: 21, url: "https://attacker.invalid" } as { number: number }, { fetch: transport })).rejects.toThrow("INVALID_ISSUE_REQUEST");
    await expect(fetchPublicIssueEvidence(context, { number: 21 }, { workspaceId: "other", fetch: transport })).rejects.toThrow("WORKSPACE_BINDING_MISMATCH");
    git(root, "remote", "set-url", "canonical", "https://github.com/foreign/reviewer.git");
    await expect(fetchPublicIssueEvidence(context, { number: 21 }, { fetch: transport })).rejects.toThrow("REPOSITORY_BINDING_CHANGED");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a repository change while the public request is in flight", async () => {
    const transport = vi.fn(async () => {
      git(root, "remote", "set-url", "canonical", "https://github.com/foreign/reviewer.git");
      return Response.json(payload());
    });
    await expect(fetchPublicIssueEvidence(context, { number: 21 }, { fetch: transport as typeof fetch })).rejects.toThrow("REPOSITORY_BINDING_CHANGED");
  });
});
