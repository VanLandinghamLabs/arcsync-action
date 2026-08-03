import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";

const COMMENT_MARKER = "<!-- arcsync-diagram -->";

interface IngestArtifact {
  filename: string;
  content: string;
}

interface IngestResponse {
  graphId: string;
  graphUrl: string;
  mermaid?: string;
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

    if (!apiClientId || !apiClientSecret) {
      core.setFailed("Missing required inputs: api-client-id and api-client-secret are required.");
      return;
    }

    const artifacts = collectArtifacts(inputPath);
    if (artifacts.length === 0) {
      core.setFailed(
        `No artifacts found at '${inputPath}'. Point 'path' at a cdk synth output directory (*.template.json) or a 'terraform show -json' file.`,
      );
      return;
    }
    core.info(`Collected ${artifacts.length} artifact(s) from ${inputPath}`);

    const token = await fetchAccessToken(apiUrl, apiClientId, apiClientSecret);
    if (!token) return; // fetchAccessToken called setFailed

    const result = await uploadToArcSync(apiUrl, token, artifacts);
    if (!result) return; // uploadToArcSync called setFailed

    core.setOutput("graph-id", result.graphId);
    core.setOutput("graph-url", result.graphUrl);
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
 * `*.template.json` it contains (cdk synth output); a single file is
 * uploaded as-is (e.g. a `terraform show -json` plan file).
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
  token: string,
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

  const body = JSON.stringify({
    repoUrl: process.env.GITHUB_REPOSITORY
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}`
      : "unknown",
    branch: process.env.GITHUB_REF_NAME ?? "main",
    commitSha: process.env.GITHUB_SHA,
    artifacts,
    ...(repoData ? { repoData } : {}),
  });

  try {
    const response = await fetch(`${apiUrl}/graphs/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
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
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      core.warning("GITHUB_TOKEN not available — skipping PR comment");
      return;
    }

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const prNumber = github.context.payload.pull_request?.number;
    if (!prNumber) return;

    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    let body = `${COMMENT_MARKER}\n## Architecture Diagram\n\n`;
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
