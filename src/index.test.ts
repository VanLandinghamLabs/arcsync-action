import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetInput = vi.fn();
const mockGetIDToken = vi.fn();
const mockSetOutput = vi.fn();
const mockSetFailed = vi.fn();
const mockInfo = vi.fn();
const mockWarning = vi.fn();
const mockSetSecret = vi.fn();

vi.mock("@actions/core", () => ({
  getInput: (...args: unknown[]) => mockGetInput(...args),
  getIDToken: (...args: unknown[]) => mockGetIDToken(...args),
  setOutput: (...args: unknown[]) => mockSetOutput(...args),
  setFailed: (...args: unknown[]) => mockSetFailed(...args),
  info: (...args: unknown[]) => mockInfo(...args),
  warning: (...args: unknown[]) => mockWarning(...args),
  setSecret: (...args: unknown[]) => mockSetSecret(...args),
}));

const mockCreateComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
const mockUpdateComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
const mockListComments = vi.fn().mockResolvedValue({ data: [] });
const mockReposGet = vi.fn().mockResolvedValue({ data: { description: "default-repo" } });

const mockGithubContext = {
  payload: {} as Record<string, unknown>,
  repo: { owner: "test-owner", repo: "test-repo" },
};

vi.mock("@actions/github", () => ({
  context: mockGithubContext,
  getOctokit: () => ({
    rest: {
      issues: {
        createComment: (...args: unknown[]) => mockCreateComment(...args),
        updateComment: (...args: unknown[]) => mockUpdateComment(...args),
        listComments: (...args: unknown[]) => mockListComments(...args),
      },
      repos: {
        get: (...args: unknown[]) => mockReposGet(...args),
      },
    },
  }),
}));

const mockReadFileSync = vi.fn().mockReturnValue('{"Resources":{}}');
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn().mockReturnValue(true);
const mockReaddirSync = vi.fn().mockReturnValue(["App.template.json"]);
const mockStatSync = vi.fn().mockReturnValue({ isDirectory: () => true });

vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const AUTH_INPUTS = {
  "api-url": "https://api.arcsync.dev",
  "api-client-id": "client-id",
  "api-client-secret": "client-secret",
};

function setInputs(inputs: Record<string, string>): void {
  mockGetInput.mockImplementation((name: string) => inputs[name] ?? "");
}

function mockHappyFetch(ingestBody: Record<string, unknown> = {}): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ accessToken: "minted-jwt" }),
  });
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () =>
      Promise.resolve({
        graphId: "graph-123",
        graphUrl: "https://arcsync.dev/canvas/graph-123",
        mermaid: "graph TD\n  n1[S3]",
        ...ingestBody,
      }),
  });
}

async function runAction(): Promise<void> {
  vi.resetModules();
  const mod = (await import("./index.js")) as { actionRun?: Promise<void> };
  // Await the action's own promise rather than racing a fixed timeout — the
  // module kicks off run() on import and exports the resulting promise.
  await mod.actionRun;
}

describe("GitHub Action — thin uploader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGithubContext.payload = {};
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockReaddirSync.mockReturnValue(["App.template.json"]);
    mockReadFileSync.mockReturnValue('{"Resources":{}}');
    mockReposGet.mockResolvedValue({ data: { description: "default-repo" } });
    // biome-ignore lint/performance/noDelete: process.env.X = undefined sets the string "undefined"
    delete process.env.GITHUB_TOKEN;
    mockGetIDToken.mockReset().mockRejectedValue(new Error("no id-token permission"));
    // biome-ignore lint/performance/noDelete: same reason
    delete process.env.GITHUB_REPOSITORY;
    // biome-ignore lint/performance/noDelete: same reason
    delete process.env.GITHUB_REF_NAME;
    // biome-ignore lint/performance/noDelete: same reason
    delete process.env.GITHUB_SHA;
    // biome-ignore lint/performance/noDelete: same reason
    delete process.env._ARCSYNC_REPO_META_TIMEOUT_MS;
  });

  describe("Input validation", () => {
    it("fails when required auth inputs are missing", async () => {
      setInputs({ path: "cdk.out" });
      await runAction();
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining("required"));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fails when no artifacts are found in the path", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockReaddirSync.mockReturnValue(["manifest.json", "tree.json"]);
      await runAction();
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining("No artifacts found"));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fails when the path does not exist", async () => {
      setInputs({ ...AUTH_INPUTS, path: "missing" });
      mockExistsSync.mockReturnValue(false);
      await runAction();
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining("No artifacts found"));
    });
  });

  describe("Happy path", () => {
    it("collects templates, mints a token, uploads, and sets outputs", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockReaddirSync.mockReturnValue(["App.template.json", "Db.template.json"]);
      mockHappyFetch();
      await runAction();
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://api.arcsync.dev/action/token",
        expect.objectContaining({ method: "POST" }),
      );
      const brokerBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(brokerBody).toEqual({ clientId: "client-id", clientSecret: "client-secret" });
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://api.arcsync.dev/graphs/ingest",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer minted-jwt" }),
        }),
      );
      const ingestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(ingestBody.artifacts).toHaveLength(2);
      expect(ingestBody.artifacts[0]).toEqual({
        filename: "App.template.json",
        content: '{"Resources":{}}',
      });
      expect(mockSetOutput).toHaveBeenCalledWith("graph-id", "graph-123");
      expect(mockSetOutput).toHaveBeenCalledWith(
        "graph-url",
        "https://arcsync.dev/canvas/graph-123",
      );
      expect(mockSetOutput).toHaveBeenCalledWith("mermaid", "graph TD\n  n1[S3]");
    });

    it("uploads a single file when path points at a file", async () => {
      setInputs({ ...AUTH_INPUTS, path: "plan.json" });
      mockStatSync.mockReturnValue({ isDirectory: () => false });
      mockReadFileSync.mockReturnValue('{"planned_values":{}}');
      mockHappyFetch();
      await runAction();
      const ingestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(ingestBody.artifacts).toEqual([
        { filename: "plan.json", content: '{"planned_values":{}}' },
      ]);
    });

    it("includes repoUrl, branch, and commitSha from GITHUB_* env vars", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      process.env.GITHUB_REPOSITORY = "acme/infra";
      process.env.GITHUB_REF_NAME = "feature-x";
      process.env.GITHUB_SHA = "abc1234";
      mockHappyFetch();
      await runAction();
      const ingestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(ingestBody.repoUrl).toBe("https://github.com/acme/infra");
      expect(ingestBody.branch).toBe("feature-x");
      expect(ingestBody.commitSha).toBe("abc1234");
    });

    it("masks the client secret and the minted token", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockHappyFetch();
      await runAction();
      expect(mockSetSecret).toHaveBeenCalledWith("client-secret");
      expect(mockSetSecret).toHaveBeenCalledWith("minted-jwt");
    });

    it("writes Mermaid to the output file when output is set", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out", output: "diagram.md" });
      mockHappyFetch();
      await runAction();
      expect(mockWriteFileSync).toHaveBeenCalledWith("diagram.md", "graph TD\n  n1[S3]");
    });

    it("omits the mermaid output and never writes a file when the ingest response has no mermaid", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out", output: "diagram.md" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "minted-jwt" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            graphId: "graph-123",
            graphUrl: "https://arcsync.dev/canvas/graph-123",
          }),
      });
      await runAction();
      expect(mockSetFailed).not.toHaveBeenCalled();
      // graph-id / graph-url still set, but mermaid output and file write are skipped.
      expect(mockSetOutput).toHaveBeenCalledWith("graph-id", "graph-123");
      expect(mockSetOutput).not.toHaveBeenCalledWith("mermaid", expect.anything());
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("defaults the artifact path to 'cdk.out' when the path input is empty", async () => {
      // Omit `path` entirely so getInput("path") returns "" → `|| "cdk.out"` default.
      setInputs({ ...AUTH_INPUTS });
      mockReaddirSync.mockReturnValue(["App.template.json"]);
      mockHappyFetch();
      await runAction();
      expect(mockSetFailed).not.toHaveBeenCalled();
      // collectArtifacts probes the defaulted directory, not "".
      expect(mockExistsSync).toHaveBeenCalledWith("cdk.out");
      expect(mockReaddirSync).toHaveBeenCalledWith("cdk.out");
      expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining("from cdk.out"));
    });

    it("includes repoData from repos.get in the ingest POST body", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      process.env.GITHUB_TOKEN = "gh-token";
      mockReposGet.mockResolvedValueOnce({ data: { description: "private" } });
      mockHappyFetch();
      await runAction();
      expect(mockSetFailed).not.toHaveBeenCalled();
      const ingestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(ingestBody.repoData).toBeDefined();
      expect(ingestBody.repoData.description).toBe("private");
    });

    // The gap that shipped #678's regression: every existing repoData test set
    // process.env.GITHUB_TOKEN by hand, but GitHub does not inject it into an
    // action's environment and action.yml declared no input for it — so under
    // the documented workflow repoData was ALWAYS absent, and the backend's
    // fail-closed default would have marked every canon private and emptied
    // the gallery. This pins the contract with no env var in sight.
    it("sends repoData using the github-token input alone, with no GITHUB_TOKEN env", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out", "github-token": "from-input" });
      // Explicitly absent — action.yml's `default: ${{ github.token }}` is what
      // supplies this in a real run.
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
      mockReposGet.mockResolvedValueOnce({ data: { private: false, description: "d" } });
      mockHappyFetch();
      await runAction();
      expect(mockSetFailed).not.toHaveBeenCalled();
      const ingestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(ingestBody.repoData).toBeDefined();
      // The field the backend's visibility decision turns on.
      expect(ingestBody.repoData.private).toBe(false);
    });

    // #679. The `repository` claim GitHub signs into this token is the only
    // part of the ingest body a caller cannot choose, so it is what makes the
    // backend's repoKey binding possible.
    it("sends an OIDC token minted for the ArcSync audience", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockGetIDToken.mockResolvedValueOnce("oidc.jwt.value");
      mockHappyFetch();
      await runAction();
      expect(mockSetFailed).not.toHaveBeenCalled();
      // Audience must match the backend's ARCSYNC_OIDC_AUDIENCE exactly — a
      // token minted for anything else is rejected there.
      expect(mockGetIDToken).toHaveBeenCalledWith("https://api.arcsync.dev");
      const ingestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(ingestBody.oidcToken).toBe("oidc.jwt.value");
    });

    // Un-migrated workflows have no `id-token: write`, so getIDToken throws.
    // The upload must still succeed — unverified, not failed.
    it("continues without an OIDC token when the permission is missing", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockGetIDToken.mockRejectedValueOnce(new Error("Unable to get ACTIONS_ID_TOKEN_REQUEST_URL"));
      mockHappyFetch();
      await runAction();
      expect(mockSetFailed).not.toHaveBeenCalled();
      const ingestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(ingestBody.oidcToken).toBeUndefined();
      expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining("id-token: write"));
    });

    it("omits repoData when repos.get throws (best-effort)", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      process.env.GITHUB_TOKEN = "gh-token";
      mockReposGet.mockRejectedValueOnce(new Error("403 Forbidden"));
      mockHappyFetch();
      await runAction();
      expect(mockSetFailed).not.toHaveBeenCalled();
      const ingestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(ingestBody.repoData).toBeUndefined();
    });

    it("omits repoData when repos.get never resolves (timeout fires)", async () => {
      // Tiny timeout so the race resolves in ~50 ms without waiting 3 s.
      process.env._ARCSYNC_REPO_META_TIMEOUT_MS = "50";
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      process.env.GITHUB_TOKEN = "gh-token";
      // repos.get returns a promise that never settles — simulates a hung API call.
      mockReposGet.mockReturnValueOnce(new Promise(() => {}));
      mockHappyFetch();
      await runAction();
      expect(mockSetFailed).not.toHaveBeenCalled();
      const ingestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(ingestBody.repoData).toBeUndefined();
    });
  });

  describe("Token-broker failures", () => {
    it("fails when the token endpoint returns 4xx", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error":"Invalid client credentials"}'),
      });
      await runAction();
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining("HTTP 401"));
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("fails when the token request throws a network error", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockFetch.mockRejectedValueOnce(new Error("DNS failure"));
      await runAction();
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining("network error"));
    });

    it("fails when the token endpoint returns 200 with no accessToken", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
      await runAction();
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining("no accessToken"));
    });

    it("treats an unreadable error body as empty when the token endpoint is non-OK", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: () => Promise.reject(new Error("stream already consumed")),
      });
      await runAction();
      // The `.catch(() => "")` falls back to an empty detail; HTTP 502 still surfaces.
      expect(mockSetFailed).toHaveBeenCalledWith("ArcSync token request failed (HTTP 502): ");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("fails when the token endpoint returns 200 but the JSON body is unparseable", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
      });
      await runAction();
      // `.catch(() => null)` swallows the parse error; the null body has no accessToken.
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining("no accessToken"));
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("reports a non-Error thrown value from the token request via String(error)", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockFetch.mockRejectedValueOnce("plain string");
      await runAction();
      expect(mockSetFailed).toHaveBeenCalledWith(
        "ArcSync token request network error: plain string",
      );
    });
  });

  describe("Ingest failures", () => {
    it("fails when the ingest API returns a non-2xx status", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "minted-jwt" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"No recognizable artifacts"}'),
      });
      await runAction();
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining("HTTP 400"));
    });

    it("fails when the ingest request throws a network error", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "minted-jwt" }),
      });
      mockFetch.mockRejectedValueOnce(new Error("connection reset"));
      await runAction();
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining("upload failed"));
    });

    it("treats an unreadable error body as empty when the ingest API is non-OK", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "minted-jwt" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: () => Promise.reject(new Error("body already used")),
      });
      await runAction();
      // The `.catch(() => "")` falls back to an empty detail; HTTP 503 still surfaces.
      expect(mockSetFailed).toHaveBeenCalledWith("ArcSync API returned HTTP 503: ");
    });

    it("reports a non-Error thrown value from the ingest request via String(error)", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "minted-jwt" }),
      });
      mockFetch.mockRejectedValueOnce("socket hang up");
      await runAction();
      expect(mockSetFailed).toHaveBeenCalledWith("ArcSync upload failed: socket hang up");
    });
  });

  describe("PR comments", () => {
    it("creates a comment on a pull_request event", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockGithubContext.payload = { pull_request: { number: 42 } };
      process.env.GITHUB_TOKEN = "gh-token";
      mockHappyFetch();
      await runAction();
      expect(mockCreateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 42,
          body: expect.stringContaining("<!-- arcsync-diagram -->"),
        }),
      );
    });

    it("updates an existing comment when the marker is found", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockGithubContext.payload = { pull_request: { number: 42 } };
      process.env.GITHUB_TOKEN = "gh-token";
      mockListComments.mockResolvedValueOnce({
        data: [{ id: 99, body: "<!-- arcsync-diagram -->\nold" }],
      });
      mockHappyFetch();
      await runAction();
      expect(mockUpdateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 99 }));
      expect(mockCreateComment).not.toHaveBeenCalled();
    });

    it("skips the PR comment on a non-PR event", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      process.env.GITHUB_TOKEN = "gh-token";
      mockHappyFetch();
      await runAction();
      expect(mockCreateComment).not.toHaveBeenCalled();
    });

    it("skips the PR comment when comment is false", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out", comment: "false" });
      mockGithubContext.payload = { pull_request: { number: 42 } };
      process.env.GITHUB_TOKEN = "gh-token";
      mockHappyFetch();
      await runAction();
      expect(mockCreateComment).not.toHaveBeenCalled();
    });

    it("warns but does not fail when GITHUB_TOKEN is missing", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockGithubContext.payload = { pull_request: { number: 42 } };
      mockHappyFetch();
      await runAction();
      expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining("GITHUB_TOKEN"));
      expect(mockSetFailed).not.toHaveBeenCalled();
    });

    it("warns but does not fail when posting the PR comment throws", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockGithubContext.payload = { pull_request: { number: 42 } };
      process.env.GITHUB_TOKEN = "gh-token";
      mockListComments.mockRejectedValueOnce(new Error("API rate limit"));
      mockHappyFetch();
      await runAction();
      expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining("PR comment failed"));
      expect(mockSetFailed).not.toHaveBeenCalled();
    });

    it("stringifies a non-Error thrown while posting the PR comment via String(error)", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockGithubContext.payload = { pull_request: { number: 42 } };
      process.env.GITHUB_TOKEN = "gh-token";
      mockListComments.mockRejectedValueOnce("rate limited");
      mockHappyFetch();
      await runAction();
      // postPrComment's catch hits the `: String(error)` arm for a non-Error reject.
      expect(mockWarning).toHaveBeenCalledWith("PR comment failed: rate limited");
      expect(mockSetFailed).not.toHaveBeenCalled();
    });

    it("does nothing on a pull_request event that carries no number", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockGithubContext.payload = { pull_request: {} };
      process.env.GITHUB_TOKEN = "gh-token";
      mockHappyFetch();
      await runAction();
      // `if (!prNumber) return` bails before touching the comments API.
      expect(mockListComments).not.toHaveBeenCalled();
      expect(mockCreateComment).not.toHaveBeenCalled();
      expect(mockUpdateComment).not.toHaveBeenCalled();
      expect(mockSetFailed).not.toHaveBeenCalled();
    });

    it("omits the mermaid code block from the PR comment when there is no mermaid", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockGithubContext.payload = { pull_request: { number: 42 } };
      process.env.GITHUB_TOKEN = "gh-token";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "minted-jwt" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            graphId: "graph-123",
            graphUrl: "https://arcsync.dev/canvas/graph-123",
          }),
      });
      await runAction();
      expect(mockCreateComment).toHaveBeenCalledTimes(1);
      const body = mockCreateComment.mock.calls[0][0].body as string;
      expect(body).not.toContain("```mermaid");
      // The interactive-diagram link is still present even without a mermaid block.
      expect(body).toContain("https://arcsync.dev/canvas/graph-123");
    });
  });

  describe("Unexpected errors", () => {
    it("calls setFailed when reading an artifact throws", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockReadFileSync.mockImplementationOnce(() => {
        throw new Error("EACCES: permission denied");
      });
      await runAction();
      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining("EACCES: permission denied"),
      );
    });

    it("stringifies a non-Error thrown from artifact reading via String(error)", async () => {
      setInputs({ ...AUTH_INPUTS, path: "cdk.out" });
      mockReadFileSync.mockImplementationOnce(() => {
        throw "disk offline";
      });
      await runAction();
      // The top-level catch's `: String(error)` arm surfaces the raw string.
      expect(mockSetFailed).toHaveBeenCalledWith("disk offline");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
