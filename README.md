# ArcSync GitHub Action

Generate interactive architecture diagrams from your infrastructure-as-code build
output. This action takes the output of a `cdk synth`, `terraform plan` or
`pulumi preview` step, uploads it to [ArcSync](https://arcsync.dev), and posts a
diagram as a pull-request comment.

For AWS CDK and Pulumi this is also the cheaper path: those are the two engines
ArcSync otherwise synthesizes on its own servers, metered against your monthly
server-synth quota. Building them in your own CI does not consume it.

ArcSync never sees your source code and never clones your repository — it receives
only the synthesized infrastructure description.

> This repository is a one-way mirror of the ArcSync monorepo. See **Contributing**
> below.

## Setup

Install the [ArcSync GitHub App](https://arcsync.dev/settings) on the repository,
then add the workflow. There is no secret to create, copy, or rotate — the
workflow's own GitHub OIDC token proves which repository the run belongs to, and
the App install is what links that repository to your ArcSync account.

```yaml
jobs:
  diagram:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      # ...your usual build steps, so that `path` below exists —
      # e.g. `npx cdk synth` to produce cdk.out.
      - uses: VanLandinghamLabs/arcsync-action@v3
```

`id-token: write` is required — see [Repository permissions](#repository-permissions).

### Without the App: client credentials

For repositories where an org admin will not approve an App install, and for CI
that is not GitHub Actions (GitLab, Jenkins, CircleCI, Buildkite — none of which
can mint a GitHub OIDC token), authenticate with a client credential instead:

1. Sign in at [arcsync.dev](https://arcsync.dev) and open **Settings → GitHub Action credentials**.
2. Enter a label (e.g. your repo name) and click **Create credential**.
3. Copy the **Client ID** and **Client Secret** shown once, and add them to your
   repo under **Settings → Secrets and variables → Actions** as
   `ARCSYNC_CLIENT_ID` and `ARCSYNC_CLIENT_SECRET`.
4. Reference them in your workflow:

```yaml
      - uses: VanLandinghamLabs/arcsync-action@v3
        with:
          api-client-id: ${{ secrets.ARCSYNC_CLIENT_ID }}
          api-client-secret: ${{ secrets.ARCSYNC_CLIENT_SECRET }}
          path: cdk.out   # or a `terraform show -json` / `pulumi preview --save-plan` file
```

Supply both or neither. Exactly one is refused with a message naming the missing
half, rather than silently falling back to the OIDC path.

### Repository permissions

`id-token: write` is **required**. The action reads your repo's metadata —
visibility, description, topics — with the workflow's own token, which
`github-token` defaults to. Set at least:

```yaml
permissions:
  contents: read        # repo metadata
  id-token: write       # REQUIRED — proves which repo this upload is for
  pull-requests: write  # only if you leave `comment: true`
```

`id-token: write` lets the action request a short-lived OIDC token from GitHub.
Its `repository` claim is signed by GitHub for the workflow that is actually
running, and it is the only part of the upload the backend can trust to say
which repo you are — everything else in the request is self-asserted.

With it, your uploads are bound to your repository: a request carrying a token
for a different repo is refused, and your CI no longer needs the repo in
anyone's ArcSync library to be allowed to write.

Without it the action fails before uploading. Unverified uploads used to be
accepted, which meant anyone signed in could name your repository and take the
canonical diagram for it — so the fallback was removed rather than kept behind
a warning. If your run stops with *"Could not mint a GitHub OIDC token"*, add
the permission line above to that job.

Without a usable token the backend cannot tell a public repo from a private
one. It assumes private and keeps the diagram out of the public gallery, which
is not reversible after the fact — so grant the read rather than fixing it later.

## Usage

### AWS CDK

```yaml
- run: npx cdk synth
- uses: VanLandinghamLabs/arcsync-action@v3
  # `path` defaults to cdk.out
```

### Terraform

```yaml
- run: |
    terraform plan -out=tfplan
    terraform show -json tfplan > plan.json
- uses: VanLandinghamLabs/arcsync-action@v3
  with:
    path: plan.json
```

### Pulumi

The preview runs against a throwaway **local** stack, so it needs no
`PULUMI_ACCESS_TOKEN` and never touches your deployed state — ArcSync only needs
the resource graph the preview resolves.

```yaml
- run: npm install --no-audit --no-fund # or your runtime's install step
- uses: pulumi/setup-pulumi@v2
- run: |
    pulumi login --local
    pulumi stack init arcsync-preview --non-interactive
    pulumi config set aws:skipCredentialsValidation true
    pulumi config set aws:skipMetadataApiCheck true
    pulumi config set aws:skipRequestingAccountId true
    pulumi preview --save-plan=plan.json --non-interactive
  env:
    PULUMI_CONFIG_PASSPHRASE: ''
    AWS_REGION: us-east-1
    AWS_ACCESS_KEY_ID: arcsync-stub
    AWS_SECRET_ACCESS_KEY: arcsync-stub
- uses: VanLandinghamLabs/arcsync-action@v3
  with:
    path: plan.json
```

## Inputs

| Input               | Required | Default                   | Description                                                      |
| ------------------- | -------- | ------------------------- | ---------------------------------------------------------------- |
| `path`              | no       | `cdk.out`                 | A `cdk synth` output directory, or a single plan file from `terraform show -json` or `pulumi preview --save-plan`. |
| `api-url`           | no       | `https://api.arcsync.dev` | ArcSync API endpoint.                                            |
| `api-client-id`     | no       |                           | ArcSync API client ID. Omit to authenticate with GitHub OIDC.    |
| `api-client-secret` | no       |                           | ArcSync API client secret. Required with `api-client-id`.        |
| `comment`           | no       | `true`                    | Post/update a PR comment with the diagram.                       |
| `output`            | no       |                           | Optional local file to write the returned Mermaid markdown.      |

## Outputs

| Output      | Description                                       |
| ----------- | ------------------------------------------------- |
| `mermaid`   | Mermaid markdown returned by the API.             |
| `graph-id`  | ArcSync graph ID.                                 |
| `graph-url` | URL to the interactive diagram on arcsync.dev.    |

## Contributing

This repository is published automatically from the private ArcSync monorepo.
Pull requests opened here are **overwritten on the next release** — please
[open an issue](https://github.com/VanLandinghamLabs/arcsync-action/issues)
instead and we will address it upstream.

## License

MIT — see [LICENSE](./LICENSE).
