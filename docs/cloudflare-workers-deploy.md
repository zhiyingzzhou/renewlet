# Cloudflare Workers Deploy

## Recommended: One-Click Deploy

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/zhiyingzzhou/renewlet"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>

1. Click the button.
2. Sign in to Cloudflare or authorize access.
3. Finish the Cloudflare wizard.
4. Open:

```text
https://<worker-name>.<workers-dev-subdomain>.workers.dev/setup
```

Keep the generated deploy command as `pnpm deploy`. Renewlet prepares the required deployment resources and publishes the Worker automatically, so you do not need to replace it with hand-written Wrangler steps.

### Failed To Get Repository Contents

If the Cloudflare page says `Failed to get repository contents`, the deploy wizard is usually hitting a temporary rate limit or network-egress issue while reading the public GitHub repository. This does not mean the Renewlet server or Worker code failed to deploy.

If you are using a proxy/VPN node, a corporate or school network, or another shared network egress, the current egress IP may also be temporarily rate-limited by GitHub or Cloudflare. Avoid repeated retries; try again later, switch to a more reliable proxy node or network egress; if it still fails, use the manual deploy flow below.

### Upgrade

One-click deploy creates and connects a repository in your GitHub account. To upgrade Renewlet later, update that generated repository. Do not click the one-click deploy button again; that can create a new Worker/D1/R2 instead of updating your existing instance.

Open the Renewlet Worker in the Cloudflare dashboard, go to `Settings` -> `Builds`, and find the generated repository connected by Cloudflare Builds. This generated repository is not a standard GitHub fork, so it will not have GitHub's native `Sync fork` button.

Open the generated repository, then:

1. Go to `Actions`.
2. Select `Sync Renewlet Upstream`.
3. Click `Run workflow`.
4. Wait for the workflow to finish.

This workflow runs only when you click it; it does not update on a schedule. It updates the generated repository to the latest Renewlet files while preserving the existing Cloudflare resource configuration and vars in `wrangler.jsonc`. After the workflow commits the update, Cloudflare Builds redeploys automatically.

If GitHub says Actions are disabled, open the generated repository's `Settings` -> `Actions` -> `General`, enable Actions, and allow `Read and write permissions` under `Workflow permissions`.

### Existing One-Click Deploy Users

Older GitHub generated repositories might not have `Sync Renewlet Upstream`. Do not click the one-click deploy button again; keep using the original Worker, D1, R2, and generated repository.

If you do not see this workflow in `Actions`, add this file once in the original generated repository:

```text
.github/workflows/sync-renewlet-upstream.yml
```

Copy the content from this workflow: [sync-renewlet-upstream.yml](https://raw.githubusercontent.com/zhiyingzzhou/renewlet/main/.github/workflows/sync-renewlet-upstream.yml).

After committing it, future upgrades use the same path as new users: `Actions` -> `Sync Renewlet Upstream` -> `Run workflow`.

If you prefer to create D1/R2, the Cloudflare API Token, and GitHub Secrets yourself, use the manual deploy flow below.

## Manual Deploy (GitHub Actions)

Manual deploy is for users who want to manage Cloudflare resources and GitHub Actions themselves. After preparing the 5 values below, run `Cloudflare Worker` in your fork to complete checks and deploy the Worker.

Workflow:

- Checks Cloudflare Worker and frontend types
- Builds the Cloudflare frontend
- If all 5 GitHub Secrets are configured, generates `wrangler.generated.jsonc` from Secrets
- If all 5 GitHub Secrets are configured, prepares Cloudflare resources and deploys the Worker

If any required secret is missing, the workflow still runs the Cloudflare checks and build, then skips the remote D1 migration and Worker deployment with a GitHub Actions notice.

Add these 5 values to GitHub Secrets to enable remote deployment.

### 1. Fork The Repository

Fork the Renewlet repository to your own account or organization.

Repository name already exists: use the existing fork, or choose another repository name.

### 2. Create Cloudflare Resources

Create a D1 database and an R2 bucket in the Cloudflare dashboard.

D1:

1. In the Cloudflare dashboard, open `Storage & Databases` -> `D1 SQL Database`.
2. Click `Create Database`.

   <img src="./screenshots/cloudflare/en/cloudflare-d1-create.jpg" alt="Create D1 SQL database" width="720">

3. Enter `renewlet` as the database name.

   <img src="./screenshots/cloudflare/en/cloudflare-d1-create-setting.jpg" alt="Create D1 SQL database" width="720">

4. Open the created database and copy the database ID as `D1_DATABASE_ID`.

   <img src="./screenshots/cloudflare/en/cloudflare-d1-id.jpg" alt="Copy database ID" width="720">

R2:

1. In the Cloudflare dashboard, open `Storage & Databases` -> `R2 Object Storage`.

   <img src="./screenshots/cloudflare/en/cloudflare-r2-bucket-create.jpg" alt="Create R2 Object Storage" width="720">

2. Create a bucket named `renewlet-assets`.

   <img src="./screenshots/cloudflare/en/cloudflare-r2-bucket-create-setting.jpg" alt="Create R2 Object Storage" width="720">

3. Copy the bucket name as `R2_BUCKET_NAME`.

   <img src="./screenshots/cloudflare/en/cloudflare-r2-bucket-setting.jpg" alt="Copy bucket name" width="720">

Renewlet's Worker binding names are fixed:

| Binding | Cloudflare product | Purpose |
| --- | --- | --- |
| `DB` | D1 | Users, sessions, subscriptions, settings, notification jobs |
| `ASSETS` | Workers Static Assets | React app and built-in icon seed indexes |
| `ASSETS_BUCKET` | R2 | Private uploaded logos/icons |

Background built-in icon index refresh uses Cloudflare Queues. `pnpm deploy`, the GitHub Actions workflow, and the optional Wrangler CLI flow below create the required Queues automatically, so you usually do not need to manage them in the dashboard.

### 3. Get CLOUDFLARE_ACCOUNT_ID

Direct link: <a href="https://dash.cloudflare.com/?to=/:account/home" target="_blank" rel="noopener noreferrer">https://dash.cloudflare.com/?to=/:account/home</a>

1. Open the Cloudflare Dashboard.
2. Go to `Account home`.
3. Find the account used to deploy Renewlet.
4. Click the menu button on the right side of the account row.
5. Click `Copy account ID`.
6. Save the copied value as `CLOUDFLARE_ACCOUNT_ID`.

<img src="./screenshots/cloudflare/en/cloudflare-account-id.jpg" alt="Copy account ID" width="720">

You can also copy it from the `Workers & Pages` page: open `Workers & Pages`, then click the copy button for `Account ID` in `Account details`.

Direct link: <a href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank" rel="noopener noreferrer">https://dash.cloudflare.com/?to=/:account/workers-and-pages</a>

<img src="./screenshots/cloudflare/en/cloudflare-workers-account-id.jpg" alt="Copy account ID" width="720">

### 4. Create CLOUDFLARE_API_TOKEN

Direct link: <a href="https://dash.cloudflare.com/?to=/:account/api-tokens" target="_blank" rel="noopener noreferrer">https://dash.cloudflare.com/?to=/:account/api-tokens</a>

Permissions: `Edit Cloudflare Workers` + `Account` -> `D1` -> `Edit` + `Queues Edit`. Scope resources to the account that deploys Renewlet; if you bind a custom domain, scope the zone to that domain.

1. Open the Cloudflare Dashboard.
2. Go to the `Account API tokens` page.
3. Click `Create Token`.

   <img src="./screenshots/cloudflare/en/cloudflare-api-token-list.jpg" alt="Account API tokens page" width="720">

4. Set Token name to `renewlet-worker-deploy`.
5. Under `Permission policies`, open the `Custom` dropdown and select `Edit Cloudflare Workers`.

   <img src="./screenshots/cloudflare/en/cloudflare-api-token-template.jpg" alt="Edit Cloudflare Workers" width="720">

6. Add permission rows for `Account` -> `D1` -> `Edit` and `Queues Edit`.

   <img src="./screenshots/cloudflare/en/cloudflare-api-token-permissions-add-d1.jpg" alt="Add D1 Edit" width="720">

   <img src="./screenshots/cloudflare/en/cloudflare-api-token-permissions-d1.jpg" alt="Add D1 Edit" width="720">

7. Scroll down to `Resources`.
8. If the page shows `Account Resources`: select `Include` -> the Cloudflare account used to deploy Renewlet.
9. If the page shows `Zone Resources`: select the domain that will later be bound to a Worker route or custom domain.
10. If the page does not show a resources section, click `Continue to summary`.

    <img src="./screenshots/cloudflare/en/cloudflare-api-token-summary-review.jpg" alt="Review token" width="720">

11. Review Token name, Permission policies, and Resources. Skip Resources if the page does not show them.
12. Click `Create Token`.

    <img src="./screenshots/cloudflare/en/cloudflare-api-token-summary-create.jpg" alt="Create Token" width="720">

13. Copy the generated token and save it as `CLOUDFLARE_API_TOKEN`. **Save it immediately. The token is shown only once.**

    <img src="./screenshots/cloudflare/en/cloudflare-api-token-created.jpg" alt="Copy token" width="720">

    <img src="./screenshots/cloudflare/en/cloudflare-api-token-list-success.jpg" alt="Token list" width="720">

### 5. Configure GitHub Secrets

In your fork repository, open `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`, then add these 5 required repository secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token used by GitHub Actions to deploy the Worker and apply remote D1 migrations |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID used to deploy Renewlet |
| `WORKER_NAME` | Worker name, for example `renewlet` or `renewlet-prod` |
| `D1_DATABASE_ID` | D1 database ID copied from the Cloudflare dashboard |
| `R2_BUCKET_NAME` | R2 bucket name, for example `renewlet-assets` |

<img src="./screenshots/cloudflare/github-actions-secrets.jpg" alt="New repository secret" width="720">

<img src="./screenshots/cloudflare/github-new-secret.jpg" alt="New repository secret" width="720">

<img src="./screenshots/cloudflare/github-secrets-complete.jpg" alt="New repository secret" width="720">

### 6. Run The Deployment

The workflow file is `.github/workflows/cloudflare-worker.yml`.

For the first deployment, run it manually from GitHub Actions. For later upgrades, update your fork to the latest Renewlet version first; if Actions are enabled, the update can redeploy automatically. You can also run it manually at any time:

The workflow needs the 5 required repository secrets above to deploy to Cloudflare. Without them, it only verifies the Cloudflare build path and does not change any remote D1 database or Worker.

1. Open your fork repository.
2. Go to `Actions`.
3. Select `Cloudflare Worker`.
4. Click `Run workflow`.

<img src="./screenshots/cloudflare/github-actions-workflow.jpg" alt="GitHub Actions workflow" width="720">

<img src="./screenshots/cloudflare/github-actions-run.jpg" alt="GitHub Actions run" width="720">

<img src="./screenshots/cloudflare/github-actions-success.jpg" alt="GitHub Actions success" width="720">

### 7. Open Renewlet

The default URL is:

```text
https://<WORKER_NAME>.<workers-dev-subdomain>.workers.dev/setup
```

<img src="./screenshots/cloudflare/en/cloudflare-worker-domain.jpg" alt="Custom domain" width="720">

Custom domain: after deployment, bind a Worker route or custom domain for the Worker in the Cloudflare dashboard.

<img src="./screenshots/cloudflare/en/cloudflare-worker-custom-domain.jpg" alt="Custom domain" width="720">

## Update Version

One-click deploy users: follow the Upgrade steps above and run `Sync Renewlet Upstream` in the generated repository connected by Cloudflare Builds.

Manual deploy users: update your fork to the latest Renewlet version with `Sync fork` / `Update branch`. If deployment does not start automatically, open `Actions` and run `Cloudflare Worker`.

## D1 Upgrade and Recovery

Before a schema upgrade, create a portable SQL export. `pnpm deploy` captures the current Time Travel bookmark and active Worker version before its first D1 write and records both in the GitHub job summary or local output.

```bash
pnpm exec wrangler d1 export DB --remote --config wrangler.generated.jsonc --output renewlet-before-upgrade.sql
```

Normal upgrades stay online. When an unapplied `_exclusive_` migration exists, or the `subscription-derived-state-v5` marker is still pending, the deployment orchestrator first deploys the same Worker bundle in maintenance mode, removes Cron and the Queue consumer, and waits Cloudflare's 15-minute maximum background invocation duration. API, ICS, and webhook requests return `503` with `Retry-After: 900` and `Cache-Control: no-store`; Static Assets continue serving the SPA.

```bash
pnpm deploy -- --config wrangler.generated.jsonc --maintenance-config wrangler.maintenance.generated.jsonc
```

Maintenance explicitly detaches this Worker from its configured queues and dead-letter queues and reads back Cron and consumer state before draining. After the drain, the active maintenance version stores the original normal Worker version and the D1 bookmark. A retry reuses this pair. Databases with a verified v4 marker retain existing eligible reminder occurrences. Older databases rebuild from subscription records. Both paths verify the derived state before recording v5.

The orchestrator then protects calendar Feeds, applies migrations, rebuilds derived state, checks foreign keys plus the complete settings data/trigger definitions, deploys the normal configuration, and verifies the active Worker version. If a failure happens before the first D1 write, it restores the previous Worker, Cron, and Queue consumer automatically. After the first D1 write, any failure keeps or redeploys maintenance mode. Rerun the same deploy command after fixing the cause; a completed migration marker is verified and not executed again.

If you decide to roll back the data contract, review all writes since the recorded checkpoint first. Recovery is destructive and must use the single command below. It redeploys maintenance mode, drains background work, restores D1, and only then rolls back the Worker and restores its triggers. Never run Worker rollback by itself after an exclusive migration.

```bash
pnpm cloudflare:deploy:recover -- --config wrangler.generated.jsonc --maintenance-config wrangler.maintenance.generated.jsonc --bookmark "<bookmark>" --worker-version "<version-id>"
```

Alternatively, create a replacement D1 database from `renewlet-before-upgrade.sql`, review the binding, and use the same maintenance-first recovery procedure. A bookmark captured after a failed migration does not replace the pre-upgrade checkpoint.

Cloud backup snapshots are limited to 16 MiB in both Docker and Cloudflare runtimes. Before upgrading from a version with a larger limit, download or restore every remote snapshot over 16 MiB with the old version.

Imports, browser exports, and cloud backup contents use the stable `renewlet-export` schema v1. The `renewlet-cloud-backup-snapshot` transport wrapper also remains schema v1 and declares `exportSchemaVersion=1` for its inner payload.

## Optional: Wrangler CLI

Most deployments do not need Wrangler CLI. Use these commands only if you want to manage Cloudflare resources from your own machine.

Create resources:

```bash
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler d1 create renewlet
pnpm exec wrangler r2 bucket create renewlet-assets
```

Export the real values and deploy:

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
export WORKER_NAME="renewlet"
export D1_DATABASE_ID="..."
export R2_BUCKET_NAME="renewlet-assets"
export CI_WRANGLER_CONFIG="wrangler.generated.jsonc"
export CI_WRANGLER_MAINTENANCE_CONFIG="wrangler.maintenance.generated.jsonc"
export CLOUDFLARE_OBSERVABILITY_PROFILE="development"

pnpm cloudflare:config:ci
pnpm check:cloudflare
pnpm build:cloudflare
pnpm deploy -- --config wrangler.generated.jsonc --maintenance-config wrangler.maintenance.generated.jsonc
```

## Other Configuration

| Name | Type | Purpose |
| --- | --- | --- |
| `SETUP_ENABLED` | Worker var | `/setup` switch, defaults to `true` |
| `SESSION_TTL_DAYS` | Worker var | Login validity period, defaults to 30 days |
| `VITE_RENEWLET_RUNTIME=cloudflare` | Build variable | Frontend uses the Worker API |

## Common Cases

**What if the Worker name already exists?**

Change `WORKER_NAME` in GitHub Secrets, then rerun the workflow.

**Calendar feed says `no such table: calendar_feeds`?**

This means an older deployment did not complete its remote D1 sequence. Re-run the `Cloudflare Worker` workflow, or run the same deployment orchestrator locally:

```bash
pnpm cloudflare:config:ci
pnpm build:cloudflare
pnpm deploy -- --config wrangler.generated.jsonc --maintenance-config wrangler.maintenance.generated.jsonc
```

**ServerChan test notifications return HTTP 429?**

This is a ServerChan rate-limit response, not a Renewlet notification payload error. The official ServerChan FAQ says `429` means the source IP exceeded the API call limit within 24 hours, and the fix is to stop calling the API and try again after 24 hours.

When Renewlet runs on Cloudflare Workers, the ServerChan request is sent by the Worker. ServerChan counts the source IP that reaches ServerChan from the Worker egress path. The usual cause is that this Cloudflare egress source IP has hit ServerChan's 24-hour limit.

Use these fixes:

- Stop repeated tests immediately, then try again after 24 hours.
- If notifications are urgent, switch to SMTP, Telegram, Bark, or Webhook first.
- Renewlet chooses the endpoint from the SendKey automatically: `sctp...` is sent to the [official ServerChan³ API endpoint](https://doc2.ft07.com/zh/serverchan3/server/api), `https://<uid>.push.ft07.com/send/<sendkey>.send`; `SCT...` is sent to ServerChan Turbo at `https://sctapi.ftqq.com/<sendkey>.send`. If you entered an `sctp...` SendKey, Renewlet is already using the ServerChan³ endpoint instead of [SCT forwarding](https://doc2.ft07.com/zh/serverchan3/compatibility/sct-forward). A continued 429 still means ServerChan has rate-limited the Cloudflare egress source IP for 24 hours.

**Old `pb_data`?**

Use a separate export/import flow.
