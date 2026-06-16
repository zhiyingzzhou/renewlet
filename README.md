# Renewlet

<p align="center">
  <img src="./packages/client/public/logo.svg" alt="Renewlet" width="320">
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> · <a href="README.md">English</a>
</p>

<p align="center">
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-0f172a?style=flat-square">
  <img alt="React" src="https://img.shields.io/badge/React-19-149eca?style=flat-square">
  <img alt="Go and PocketBase" src="https://img.shields.io/badge/Go%20%2B%20PocketBase-00a884?style=flat-square">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-ready-2496ed?style=flat-square">
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare%20Workers-ready-f38020?style=flat-square">
  <img alt="Mobile web" src="https://img.shields.io/badge/mobile%20web-ready-2563eb?style=flat-square">
  <img alt="Memory 20-30MiB" src="https://img.shields.io/badge/memory-20--30MiB-10b981?style=flat-square">
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111827?style=flat-square">
</p>

Renewlet is a self-hosted subscription ledger for tracking recurring charges and sending renewal reminders.

It records renewal dates, prices, currencies, categories, payment methods, logos, budgets, notes, and notification settings. It can run as a single Docker container, or on Cloudflare Workers with D1, R2, and Cron Triggers.

## Demo

Try the live demo: <https://renewlet-demo.olyq.org/>

Sign in with `demo@renewlet.local` / `renewlet-demo`. The demo resets regularly, so please do not put real personal data or credentials there.

<p align="center">
  <img src="./docs/screenshots/renewlet-dashboard-en.png" alt="Renewlet dashboard showing monthly spend, upcoming renewals, and spending distribution" width="100%">
</p>

## Features

- Subscription records with billing cycles, statuses, tags, websites, notes, logos, categories, and payment methods.
- Reminder jobs based on each user's IANA time zone, local notification time, reminder days, repeat reminders, delivery history, and failed-send retries.
- Notifications through Telegram, Notifyx, Webhook, WeCom Bot, SMTP email, Bark, and ServerChan.
- Monthly and yearly cost normalization, budget usage, category charts, payment-method charts, and inactive-subscription savings.
- AI recognition for bill screenshots, notes, CSV/TSV, and pasted table text; drafts are reviewed before import.
- Global private ICS feed and per-subscription calendar feeds.
- Public subscription status pages with per-subscription visibility and optional price display.
- Import and export for Renewlet data, old Renewlet `subscriptions.json`, and Wallos files.
- Uploaded logos, image URLs, built-in icon sources, and favicon fallback suggestions.
- Docker deployment with React, Go/PocketBase, SQLite, and static assets in one container.
- Cloudflare Workers deployment with React static assets, Worker API, D1, R2, and Cron Triggers.
- Mobile web views for subscriptions, filters, statistics, calendar, and settings.

## Docker Quick Start

Requirements: Docker and Docker Compose v2.

```bash
mkdir -p renewlet && cd renewlet
curl -fsSL https://raw.githubusercontent.com/zhiyingzzhou/renewlet/main/deploy/docker-deploy.sh | bash
docker compose up -d
```

Open:

```text
http://localhost:3000/setup
```

The deploy script creates `docker-compose.yml`, `.env`, and `data/`, then writes `PB_ENCRYPTION_KEY` and `CRON_SECRET`.

For production, pin a stable image tag:

```bash
sed -i.bak 's#RENEWLET_IMAGE=.*#RENEWLET_IMAGE="zhiyingzzhou/renewlet:0.1.0"#' .env
docker compose pull
docker compose up -d
```

If Docker Hub is unavailable, use GHCR:

```env
RENEWLET_IMAGE="ghcr.io/zhiyingzzhou/renewlet:0.1.0"
```

## Cloudflare Workers

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/zhiyingzzhou/renewlet"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>

Use the deploy button for a Cloudflare-managed repository, or follow [Cloudflare Workers deploy](docs/cloudflare-workers-deploy.md) to manage D1, R2, GitHub Actions, and secrets yourself.

Do not click the deploy button again to upgrade. One-click deploy users update the repository connected in Cloudflare Builds; manual deploy users sync their fork and run `Cloudflare Worker`. Cloudflare updates must apply D1 migrations before publishing the Worker.

## Upgrade

Back up data and config before upgrading:

```bash
tar -czf renewlet-backup-$(date +%F).tgz .env docker-compose.yml data
```

If you deployed Renewlet before 2026-06-04, open the old version before upgrading and export `subscriptions.json` from Export subscriptions. After upgrading, import it from Import data. This file is only for subscription migration; keep the backup above as well.

Upgrade with Docker Compose:

```bash
sed -i.bak 's#RENEWLET_IMAGE=.*#RENEWLET_IMAGE="zhiyingzzhou/renewlet:0.1.0"#' .env
docker compose pull
docker compose up -d
docker compose logs -f
```

Docker release images with the current binary layout can also update from the version badge at the top of Renewlet. Older images must run `docker compose pull && docker compose up -d` once before in-app updates become available.

## Common Commands

```bash
docker compose ps
docker compose logs -f
docker compose down
```

Common `.env` values:

| Variable | Purpose |
| --- | --- |
| `PORT` | Public port, `3000` by default. |
| `RENEWLET_IMAGE` | Docker image, `zhiyingzzhou/renewlet:latest` by default. |
| `TZ` | Container time zone for logs. Reminder times use each user's time zone. |
| `PB_ENCRYPTION_KEY` | Encryption key for sensitive PocketBase settings. Do not rotate it casually after deployment. |
| `CRON_SECRET` | Bearer secret for external Cron calls to `/api/cron/notifications`. |
| `RENEWLET_DEMO_MODE` | Docker Demo Mode switch, `false` by default. |
| `RENEWLET_CUSTOM_HEAD_SCRIPT` | Optional deployer-provided external `<script>` injection. Empty by default; leave unset to inject no external script. |
| `NOTIFICATION_SCHEDULER_ENABLED` | Built-in notification scheduler switch, `true` by default. |

The full Docker environment template is in `.env.example`.

### Custom Head Script

Renewlet does not inject external scripts by default. When `RENEWLET_CUSTOM_HEAD_SCRIPT` is set, Renewlet injects exactly one deployer-provided external `<script>` tag into the SPA `<head>`:

```env
RENEWLET_CUSTOM_HEAD_SCRIPT='<script defer src="https://cdn.example.com/widget.js" data-host-url="https://api.example.com/widget"></script>'
```

Renewlet accepts only a single external script tag with `src` and no inline content. The script origin is automatically added to `script-src` and `connect-src`; when `data-host-url` is present, its origin is also added to `connect-src`.

Docker/Go deployments inject this at runtime, so changing the environment variable only requires restarting Renewlet. Local `pnpm dev` injects through Vite. Cloudflare Static Assets injects it at build time when the variable is present during `pnpm build:cloudflare`, so changes require rebuilding and redeploying.

## Screenshots

<table>
  <tr>
    <td width="50%">
      <strong>AI recognition</strong><br>
      <img src="./docs/screenshots/renewlet-ai-recognition-en.png" alt="Renewlet AI recognition dialog showing the input state before turning text content into editable subscription drafts">
    </td>
    <td width="50%">
      <strong>Public subscription status page</strong><br>
      <img src="./docs/screenshots/renewlet-public-status-en.png" alt="Renewlet public subscription status page showing public subscription totals, prices, and subscription cards">
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Subscriptions</strong><br>
      <img src="./docs/screenshots/renewlet-subscriptions-en.png" alt="Renewlet subscriptions view with filters, tags, statuses, and service logos">
    </td>
    <td width="50%">
      <strong>Statistics</strong><br>
      <img src="./docs/screenshots/renewlet-statistics-en.png" alt="Renewlet statistics view with budget usage, category spending, and payment method charts">
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Renewal calendar</strong><br>
      <img src="./docs/screenshots/renewlet-calendar-en.png" alt="Renewlet renewal calendar showing monthly renewal events and estimated spend">
    </td>
    <td width="50%">
      <strong>Notifications</strong><br>
      <img src="./docs/screenshots/renewlet-notifications-en.png" alt="Renewlet notification settings showing channels and email configuration">
    </td>
  </tr>
</table>

### Mobile

<table>
  <tr>
    <td width="50%">
      <strong>Mobile subscriptions</strong><br>
      <img src="./docs/screenshots/renewlet-subscriptions-h5-en.png" alt="Renewlet mobile subscriptions view with filters, subscription cards, logos, prices, and tags">
    </td>
    <td width="50%">
      <strong>Mobile notification methods</strong><br>
      <img src="./docs/screenshots/renewlet-notifications-h5-en.png" alt="Renewlet mobile notification methods view showing the email channel and SMTP email configuration">
    </td>
  </tr>
</table>

## Contributing

Issues, documentation fixes, tests, and pull requests are welcome. For larger changes, open an issue first with the goal, use case, and rough approach.

## Acknowledgements

- [LINUX DO](https://linux.do/): Renewlet thanks the LINUX DO community for open-source project discussion.

## License

Renewlet is open-sourced under the [MIT License](LICENSE).
