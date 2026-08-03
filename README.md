# ArcSync GitHub Action

Generate interactive architecture diagrams from your infrastructure-as-code build
output. This action takes the output of a `cdk synth` or `terraform plan` step,
uploads it to [ArcSync](https://arcsync.dev), and posts a diagram as a pull-request
comment.

ArcSync never sees your source code and never clones your repository — it receives
only the synthesized infrastructure description.

> This repository is a one-way mirror of the ArcSync monorepo. See **Contributing**
> below.

## Setup

1. Sign in at [arcsync.dev](https://arcsync.dev) and open **Settings → GitHub Action credentials**.
2. Enter a label (e.g. your repo name) and click **Create credential**.
3. Copy the **Client ID** and **Client Secret** shown once, and add them to your
   repo under **Settings → Secrets and variables → Actions** as
   `ARCSYNC_CLIENT_ID` and `ARCSYNC_CLIENT_SECRET`.
4. Reference them in your workflow:

```yaml
- uses: VanLandinghamLabs/arcsync-action@v2
  with:
    api-client-id: ${{ secrets.ARCSYNC_CLIENT_ID }}
    api-client-secret: ${{ secrets.ARCSYNC_CLIENT_SECRET }}
    path: cdk.out   # or a `terraform show -json` file
```

### Repository permissions

The action reads your repo's metadata — visibility, description, topics — with
the workflow's own token, which `github-token` defaults to. Most workflows need
no change. If your workflow narrows `permissions`, keep at least:

```yaml
permissions:
  contents: read        # repo metadata
  id-token: write       # proves which repo this upload is for
  pull-requests: write  # only if you leave `comment: true`
```

`id-token: write` lets the action request a short-lived OIDC token from GitHub.
Its `repository` claim is signed by GitHub for the workflow that is actually
running, and it is the only part of the upload the backend can trust to say
which repo you are — everything else in the request is self-asserted.

With it, your uploads are bound to your repository: a request carrying a token
for a different repo is refused, and your CI no longer needs the repo in
anyone's ArcSync library to be allowed to write.

Without it the upload still succeeds, just unverified. That fallback exists so
existing workflows keep working while adoption catches up, and it will be
removed — until then it is what a request that simply omits the token relies
on, so granting the permission is what makes the binding meaningful.

Without a usable token the backend cannot tell a public repo from a private
one. It assumes private and keeps the diagram out of the public gallery, which
is not reversible after the fact — so grant the read rather than fixing it later.

## Usage

### AWS CDK

```yaml
- run: npx cdk synth
- uses: VanLandinghamLabs/arcsync-action@v2
  with:
    path: cdk.out
    api-client-id: ${{ secrets.ARCSYNC_CLIENT_ID }}
    api-client-secret: ${{ secrets.ARCSYNC_CLIENT_SECRET }}
```

### Terraform

```yaml
- run: |
    terraform plan -out=tfplan
    terraform show -json tfplan > plan.json
- uses: VanLandinghamLabs/arcsync-action@v2
  with:
    path: plan.json
    api-client-id: ${{ secrets.ARCSYNC_CLIENT_ID }}
    api-client-secret: ${{ secrets.ARCSYNC_CLIENT_SECRET }}
```

## Inputs

| Input               | Required | Default                   | Description                                                      |
| ------------------- | -------- | ------------------------- | ---------------------------------------------------------------- |
| `path`              | no       | `cdk.out`                 | A `cdk synth` output directory, or a `terraform show -json` file. |
| `api-url`           | no       | `https://api.arcsync.dev` | ArcSync API endpoint.                                            |
| `api-client-id`     | yes      |                           | ArcSync API client ID.                                           |
| `api-client-secret` | yes      |                           | ArcSync API client secret.                                       |
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
