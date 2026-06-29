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
