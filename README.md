# Renewlet

<p align="center">
  <img src="./apps/web/public/logo.svg" alt="Renewlet" width="320">
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> · <a href="README.md">English</a>
</p>

<p align="center">
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-0f172a?style=flat-square">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-ready-2496ed?style=flat-square">
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare%20Workers-ready-f38020?style=flat-square">
  <img alt="Memory 20-30MiB" src="https://img.shields.io/badge/memory-20--30MiB-10b981?style=flat-square">
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111827?style=flat-square">
</p>

Renewlet is a self-hosted subscription ledger for recurring expenses. See what you spend, what is due next, and get a reminder before renewal.

Run it in a single Docker container or deploy it to Cloudflare Workers.

## Demo

<https://demo.renewlet.cc/>

Sign in with `demo@renewlet.local` / `renewlet-demo`. Data resets regularly; do not enter real information or credentials.

<p align="center">
  <img src="./docs/screenshots/renewlet-dashboard-en.png" alt="Renewlet dashboard showing monthly spend, upcoming renewals, and spending distribution" width="100%">
</p>

## Features

- Keep prices, billing cycles, renewal dates, payment methods, and notes in one place.
- Review monthly or yearly spending, track a budget, and convert between currencies.
- Send reminders in your timezone through Telegram, Notifyx, Webhook, WeCom, DingTalk, email, Bark, ServerChan, Discord, or PushPlus.
- Turn screenshots, notes, or tables into editable drafts, then review them before import. You can also import or export Renewlet data, or migrate from Wallos.
- Add all or individual subscriptions to a calendar, or share a public status page with prices hidden when needed.
- Secure the account with an authenticator, recovery codes, or passkeys, and optionally protect password login with Cloudflare Turnstile.
- Connect CLI tools, Shortcuts, and other automation through the read-only [Public API](docs/public-api.md).

## Docker Quick Start

Requirements: Docker and Docker Compose v2.

```bash
mkdir -p renewlet && cd renewlet
curl -fsSL https://raw.githubusercontent.com/zhiyingzzhou/renewlet/main/deploy/docker-deploy.sh | bash
docker compose up -d
```

After it starts, open:

```text
http://localhost:3000/setup
```

Create the first administrator. The deploy script creates `docker-compose.yml`, `.env`, and `data/`, then writes `PB_ENCRYPTION_KEY` and `CRON_SECRET`.

For production, pin a stable image tag:

```bash
sed -i.bak 's#RENEWLET_IMAGE=.*#RENEWLET_IMAGE="zhiyingzzhou/renewlet:0.3.26"#' .env
docker compose pull
docker compose up -d
```

If Docker Hub is unavailable, use GHCR:

```env
RENEWLET_IMAGE="ghcr.io/zhiyingzzhou/renewlet:0.3.26"
```

## Cloudflare Workers

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/zhiyingzzhou/renewlet"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>

Click the button to deploy. To manage the Cloudflare resources yourself, follow the [Cloudflare Workers deployment guide](docs/cloudflare-workers-deploy.md).

For upgrades, update the existing repository as described in the guide instead of clicking the deploy button again.

## Upgrade

Back up your data and configuration first:

```bash
tar -czf renewlet-backup-$(date +%F).tgz .env docker-compose.yml data
```

Update the Docker image:

```bash
sed -i.bak 's#RENEWLET_IMAGE=.*#RENEWLET_IMAGE="zhiyingzzhou/renewlet:0.3.26"#' .env
docker compose pull
docker compose up -d
docker compose logs -f
```

You can also update in the app by clicking the version number at the top of Renewlet and opening System Update.

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
| `TZ` | Time zone for logs; reminders use each user's time zone. |
| `PB_ENCRYPTION_KEY` | Encryption key for sensitive settings. Do not change it after deployment. |
| `CRON_SECRET` | Bearer secret for external Cron requests. |
| `RENEWLET_DEMO_MODE` | Enables demo mode. `false` by default. |
| `RENEWLET_CUSTOM_HEAD_HTML` | Optional custom `<head>` content. Empty by default. |
| `NOTIFICATION_SCHEDULER_ENABLED` | Enables the built-in notification scheduler. `true` by default. |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Recommended proxy variables for outbound HTTP(S) requests from the Docker server. |

The full Docker environment template is in `.env.example`.

### Upstream Proxy

To proxy HTTP(S) requests made by the Docker server, set these values in `.env`:

```env
HTTP_PROXY="http://host.docker.internal:7890"
HTTPS_PROXY="http://host.docker.internal:7890"
NO_PROXY="localhost,127.0.0.1,.local"
```

Use the uppercase names by default. The lowercase alternatives are `http_proxy`, `https_proxy`, and `no_proxy`. Do not set both forms; when both are present, Go uses the uppercase value.

If the proxy runs on the host, use an address the container can reach instead of `localhost` or `127.0.0.1`. Recreate the container after a change:

```bash
docker compose up -d --force-recreate
```

### Custom Head HTML

To add a third-party service such as [Microsoft Clarity](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup), copy the provider's `<head>` code into `RENEWLET_CUSTOM_HEAD_HTML` unchanged. Wrap multiline values in single quotes when using a Docker `.env` file.

Only add code you trust; it can access data on Renewlet pages. Restart the Docker container after a change, or rebuild and redeploy Cloudflare.

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

## License

Renewlet is open-sourced under the [MIT License](LICENSE).
