import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as core from "@actions/core";

/** Must stay identical to the backend's ARCSYNC_OIDC_AUDIENCE — a token minted
 * for a different audience is rejected there, by design. */
const ARCSYNC_OIDC_AUDIENCE = "https://api.arcsync.dev";

import * as github from "@actions/github";

const COMMENT_MARKER = "<!-- arcsync-diagram -->";

interface IngestArtifact {
  filename: string;
  content: string;
}

interface DeltaNode {
  id: string;
  type: string;
  name: string;
  resourceType: string;
}

/** Mirrors `DeltaEnvelope` in @auto-arch-diagram/core/graphDelta. Declared
 * here because the Action is a thin uploader with no core dependency. */
type DeltaEnvelope =
  | { status: "no-base"; baseRef: string }
  | {
      status: "ok";
      tier: "free";
      base: { ref: string; sha: string; exact: boolean };
      counts: { resources: number; edgesAdded: number; edgesRemoved: number };
    }
  | {
      status: "ok";
      tier: "pro";
      base: { ref: string; sha: string; exact: boolean };
      counts: { resources: number; edgesAdded: number; edgesRemoved: number };
      summary: string;
      nodes: { added: DeltaNode[]; removed: DeltaNode[]; changed: DeltaNode[] };
    };

interface IngestResponse {
  graphId: string;
  graphUrl: string;
  mermaid?: string;
  delta?: DeltaEnvelope;
}

async function run(): Promise<void> {
  try {
    const inputPath = core.getInput("path") || "cdk.out";
    const apiUrl = (core.getInput("api-url") || "https://api.arcsync.dev").replace(/\/+$/, "");
    const apiClientId = core.getInput("api-client-id");
    const apiClientSecret = core.getInput("api-client-secret");
    const shouldComment = core.getInput("comment") !== "false";
    const outputFile = core.getInput("output");

    if (apiClientSecret) core.setSecret(apiClientSecret);

    // Exactly one half is always a mistake — a typo'd secret name, or a secret
    // that never got set — and falling through to the OIDC lane would hide it
    // behind a confusing "no installation" error from the backend.
    if (Boolean(apiClientId) !== Boolean(apiClientSecret)) {
      core.setFailed(
        `Incomplete credentials: ${apiClientId ? "api-client-secret" : "api-client-id"} is missing. ` +
          "Supply both, or neither to authenticate with the repository's GitHub OIDC token alone.",
      );
      return;
    }
    const useOidcOnly = !apiClientId;

    const artifacts = collectArtifacts(inputPath);
    if (artifacts.length === 0) {
      core.setFailed(
        `No artifacts found at '${inputPath}'. Point 'path' at a cdk synth output directory (*.template.json), a 'terraform show -json' plan file, or a 'pulumi preview --save-plan' plan file.`,
      );
      return;
    }
    core.info(`Collected ${artifacts.length} artifact(s) from ${inputPath}`);

    // null means "authenticate with the OIDC token alone" — uploadToArcSync
    // mints one either way, so the OIDC lane needs no extra round trip.
    let token: string | null = null;
    if (!useOidcOnly) {
      token = await fetchAccessToken(apiUrl, apiClientId, apiClientSecret);
      if (!token) return; // fetchAccessToken called setFailed
    }

    const result = await uploadToArcSync(apiUrl, token, artifacts);
    if (!result) return; // uploadToArcSync called setFailed

    core.setOutput("graph-id", result.graphId);
    core.setOutput("graph-url", result.graphUrl);
    // Lets a workflow (and the staging smoke) assert the pr block reached
    // the backend without parsing the comment.
    core.setOutput("delta-status", result.delta?.status ?? "none");
    if (result.mermaid) {
      core.setOutput("mermaid", result.mermaid);
      if (outputFile) {
        writeFileSync(outputFile, result.mermaid);
        core.info(`Wrote Mermaid output to ${outputFile}`);
      }
    }
    core.info(`Diagram ready: ${result.graphUrl}`);

    if (shouldComment && github.context.payload.pull_request) {
      await postPrComment(result);
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Collect IaC build artifacts to upload. A directory yields every
 * `*.template.json` it contains (cdk synth output); a single file is uploaded
 * as-is — a `terraform show -json` plan, or a `pulumi preview --save-plan` plan.
 * The backend recognises the shape from the content, not the filename.
 */
function collectArtifacts(inputPath: string): IngestArtifact[] {
  if (!existsSync(inputPath)) return [];
  if (!statSync(inputPath).isDirectory()) {
    return [{ filename: basename(inputPath), content: readFileSync(inputPath, "utf-8") }];
  }
  return readdirSync(inputPath)
    .filter((name) => name.endsWith(".template.json"))
    .map((name) => ({ filename: name, content: readFileSync(join(inputPath, name), "utf-8") }));
}

/** The `pr` block for a pull_request run. Every field comes from the event
 * payload or GITHUB_BASE_REF; absent any of them, no block is sent and the
 * backend computes no delta. */
function prBlock():
  | { number: number; baseRef: string; baseSha: string; headSha: string }
  | undefined {
  const pr = github.context.payload.pull_request as
    | { number?: number; base?: { sha?: string }; head?: { sha?: string } }
    | undefined;
  const baseRef = process.env.GITHUB_BASE_REF;
  if (!pr?.number || !baseRef || !pr.base?.sha || !pr.head?.sha) return undefined;
  return { number: pr.number, baseRef, baseSha: pr.base.sha, headSha: pr.head.sha };
}

function renderDelta(delta: DeltaEnvelope): string {
  if (delta.status === "no-base") {
    return `*Infra delta needs a diagram of \`${delta.baseRef}\`. It appears once the ArcSync workflow has run on \`${delta.baseRef}\`.*\n\n`;
  }
  const n = delta.counts.resources;
  if (delta.tier === "free") {
    return (
      `**Infra delta:** this PR changes ${n} resource${n === 1 ? "" : "s"}.\n` +
      "Names and the highlighted diagram are a [Pro feature](https://arcsync.dev/pricing).\n\n"
    );
  }
  const ref = delta.base.ref;
  if (n === 0 && delta.counts.edgesAdded === 0 && delta.counts.edgesRemoved === 0) {
    return `No infrastructure changes vs \`${ref}\`.\n\n`;
  }
  if (n === 0) {
    // Edges moved but no resource did — a one-row table of nothing, so say it
    // in a line instead.
    return `Connections only vs \`${ref}\`: +${delta.counts.edgesAdded} / −${delta.counts.edgesRemoved}.\n\n`;
  }
  const how = delta.base.exact ? "exact" : `latest parse of ${ref}`;
  const short = delta.base.sha.slice(0, 7);
  // A `|` in a cell ends the cell and shifts every column after it.
  const cell = (s: string) => s.replaceAll("|", "\\|");
  const rows = [
    ...delta.nodes.added.map((x) => `| ➕ | \`${cell(x.id)}\` | ${cell(x.resourceType)} |`),
    ...delta.nodes.removed.map((x) => `| ➖ | \`${cell(x.id)}\` | ${cell(x.resourceType)} |`),
    ...delta.nodes.changed.map((x) => `| ✏️ | \`${cell(x.id)}\` | ${cell(x.resourceType)} |`),
  ];
  return (
    `**Infra delta vs \`${ref}\`** · compared with ${ref} @ \`${short}\` (${how})\n` +
    `${delta.summary}\n\n` +
    `<details><summary>${n} resource${n === 1 ? "" : "s"} · +${delta.counts.edgesAdded} / −${delta.counts.edgesRemoved} connections</summary>\n\n` +
    "| | Resource | Type |\n|---|---|---|\n" +
    `${rows.join("\n")}\n\n</details>\n\n`
  );
}

/**
 * Exchange client credentials for an ArcSync API access token via the
 * server-side broker (`POST /action/token`). The broker performs the
 * Auth0 client_credentials grant, so the action never talks to Auth0.
 * Calls core.setFailed and returns null on any failure — without a token
 * the action cannot do anything useful.
 */
async function fetchAccessToken(
  apiUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${apiUrl}/action/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      core.setFailed(
        `ArcSync token request failed (HTTP ${response.status}): ${detail.slice(0, 200)}`,
      );
      return null;
    }

    const data = (await response.json().catch(() => null)) as { accessToken?: string } | null;
    if (!data?.accessToken) {
      core.setFailed("ArcSync token request returned no accessToken.");
      return null;
    }
    core.setSecret(data.accessToken);
    return data.accessToken;
  } catch (error) {
    core.setFailed(
      `ArcSync token request network error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** Mirrors the backend fetchRepoMetadata 2.5 s cap; overridable via env for tests. */
const REPO_META_TIMEOUT_MS = 3000;

async function uploadToArcSync(
  apiUrl: string,
  /** ArcSync access token from the client-credential broker, or null to
   * authenticate with the workflow's own GitHub OIDC token (v3 default). */
  token: string | null,
  artifacts: IngestArtifact[],
): Promise<IngestResponse | null> {
  // `Number(...) || DEFAULT` guards both a malformed env (Number("abc") → NaN,
  // and setTimeout(NaN) fires immediately) and an accidental 0 — either falls
  // back to the safe default rather than collapsing the timeout to zero.
  const timeoutMs = Number(process.env._ARCSYNC_REPO_META_TIMEOUT_MS) || REPO_META_TIMEOUT_MS;

  let repoData: unknown;
  try {
    // `github-token` defaults to ${{ github.token }} in action.yml, so this is
    // populated without the workflow doing anything. The env fallback keeps
    // working for anyone who wired GITHUB_TOKEN by hand before that input
    // existed. Without a token the backend gets no `repoData` and must assume
    // private (#678), which keeps the diagram out of the gallery.
    const ghToken = core.getInput("github-token") || process.env.GITHUB_TOKEN;
    if (ghToken) {
      const metaOctokit = github.getOctokit(ghToken);
      const { owner, repo } = github.context.repo;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutRace = new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
      });
      const fetchPromise = metaOctokit.rest.repos.get({ owner, repo });
      fetchPromise.catch(() => {});
      try {
        const result = await Promise.race([fetchPromise, timeoutRace]);
        if (result !== null) {
          repoData = result.data;
        }
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
  } catch {
    /* best-effort: omit repoData, backend falls back to unauth */
  }

  // GitHub signs the `repository` claim in this token for the workflow that is
  // actually running, so it is the only part of the request the backend can
  // trust to say which repo we are. Requires `permissions: id-token: write`;
  // getIDToken throws without it.
  //
  // Hard-failing here rather than uploading unverified (#679): the backend
  // refuses a repo-scoped ingest with no claim, so the request would 403
  // anyway — and this is the only place that still knows the cause is a
  // missing permission line rather than a rejected token.
  let oidcToken: string;
  try {
    oidcToken = await core.getIDToken(ARCSYNC_OIDC_AUDIENCE);
  } catch {
    core.setFailed(
      "Could not mint a GitHub OIDC token. Add `permissions: id-token: write` to " +
        "the job running arcsync-action — ArcSync uses it to prove which repository " +
        "this upload belongs to.",
    );
    return null;
  }

  const pr = prBlock();
  const body = JSON.stringify({
    repoUrl: process.env.GITHUB_REPOSITORY
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}`
      : "unknown",
    // On a pull_request event GITHUB_REF_NAME is `<n>/merge`; the head ref
    // is the branch a reader recognises, and it keeps every push to the PR
    // on one canonical row. Empty on push events, so `||`.
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "main",
    commitSha: process.env.GITHUB_SHA,
    ...(pr ? { pr } : {}),
    artifacts,
    ...(repoData ? { repoData } : {}),
    oidcToken,
  });

  try {
    const response = await fetch(`${apiUrl}/graphs/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Same token either way for the OIDC lane: the backend's authorizer
        // verifies it against GitHub's JWKS and resolves the repository to the
        // accounts that installed the App.
        Authorization: `Bearer ${token ?? oidcToken}`,
      },
      body,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      core.setFailed(`ArcSync API returned HTTP ${response.status}: ${detail.slice(0, 200)}`);
      return null;
    }
    return (await response.json()) as IngestResponse;
  } catch (error) {
    core.setFailed(
      `ArcSync upload failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function postPrComment(result: IngestResponse): Promise<void> {
  try {
    // The input first: `github-token` defaults to ${{ github.token }} in
    // action.yml, and GitHub does not inject GITHUB_TOKEN into an action's
    // environment. Reading only the env skipped every comment on the
    // App-generated workflow.
    const token = core.getInput("github-token") || process.env.GITHUB_TOKEN;
    if (!token) {
      core.warning("No github-token input or GITHUB_TOKEN — skipping PR comment");
      return;
    }

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const prNumber = github.context.payload.pull_request?.number;
    if (!prNumber) return;

    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    let body = `${COMMENT_MARKER}\n## Architecture Diagram\n\n`;
    if (result.delta) body += renderDelta(result.delta);
    if (result.mermaid) {
      body += `\`\`\`mermaid\n${result.mermaid}\n\`\`\`\n\n`;
    }
    body += `[View interactive diagram](${result.graphUrl})\n\n`;
    body += `---\n*Generated by [ArcSync](https://arcsync.dev) | Updated ${timestamp}*`;

    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
    });
    const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));

    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
      core.info("Updated existing PR comment");
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
      core.info("Posted PR comment");
    }
  } catch (error) {
    core.warning(`PR comment failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Kick off the action on import. Exported so tests can await completion
// deterministically instead of racing a fixed timeout.
export const actionRun = run();
