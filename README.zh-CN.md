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

Renewlet 是一个会在续费前提醒你的自托管订阅账本。把订阅和其他周期支出记进去，就能看到每月花多少、下一笔什么时候扣。

可以用 Docker 单容器运行，也可以部署到 Cloudflare Workers。

## 在线演示

<https://demo.renewlet.cc/>

使用 `demo@renewlet.local` / `renewlet-demo` 登录。数据会定期重置，请勿填写真实信息或凭据。

<p align="center">
  <img src="./docs/screenshots/renewlet-dashboard-zh.png" alt="Renewlet 中文仪表盘，展示月度支出、近期续费和支出分布" width="100%">
</p>

## 功能

- 记录订阅：价格、扣费周期、续费日、付款方式和备注都放在一处。
- 查看支出：按月或按年汇总费用，跟踪预算并换算不同币种。
- 续费提醒：按你的时区提前发送，渠道包括 Telegram、Notifyx、Webhook、企业微信、钉钉、邮件、Bark、Server酱、Discord 和 PushPlus。
- 录入和迁移：从截图、备忘录或表格生成可编辑草稿，确认后再导入；也可以导入导出 Renewlet 数据或迁入 Wallos 文件。
- 日历和分享：把全部或单个订阅加入日历，或生成可隐藏金额的公开状态页。
- 账号安全：使用身份验证器、恢复码或通行密钥，也可以为密码登录开启 Cloudflare Turnstile。
- 自动化：通过只读 [Public API](docs/public-api.md) 接入 CLI、Shortcuts 和其他工具。

## 快速部署

需要 Docker 和 Docker Compose v2。

```bash
mkdir -p renewlet && cd renewlet
curl -fsSL https://raw.githubusercontent.com/zhiyingzzhou/renewlet/main/deploy/docker-deploy.sh | bash
docker compose up -d
```

启动后打开：

```text
http://localhost:3000/setup
```

创建第一个管理员。部署脚本会生成 `docker-compose.yml`、`.env` 和 `data/`，并写入 `PB_ENCRYPTION_KEY` 与 `CRON_SECRET`。

正式使用时建议固定版本：

```bash
sed -i.bak 's#RENEWLET_IMAGE=.*#RENEWLET_IMAGE="zhiyingzzhou/renewlet:0.3.26"#' .env
docker compose pull
docker compose up -d
```

如果 Docker Hub 拉取不可用，改用 GHCR：

```env
RENEWLET_IMAGE="ghcr.io/zhiyingzzhou/renewlet:0.3.26"
```

## Cloudflare Workers

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/zhiyingzzhou/renewlet"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>

点击上方按钮直接部署。需要自己管理 Cloudflare 资源时，请按 [Cloudflare Workers 部署](docs/cloudflare-workers-deploy.zh-CN.md) 操作。

升级已有实例时不要再次点击部署按钮，按部署文档同步现有仓库即可。

## 升级

升级前先备份数据和配置：

```bash
tar -czf renewlet-backup-$(date +%F).tgz .env docker-compose.yml data
```

更新 Docker 镜像：

```bash
sed -i.bak 's#RENEWLET_IMAGE=.*#RENEWLET_IMAGE="zhiyingzzhou/renewlet:0.3.26"#' .env
docker compose pull
docker compose up -d
docker compose logs -f
```

也可以点击页面顶部的版本号，在“系统更新”中完成更新。

## 常用命令

```bash
docker compose ps
docker compose logs -f
docker compose down
```

常用 `.env` 配置：

| 变量 | 用途 |
| --- | --- |
| `PORT` | 对外端口，默认 `3000`。 |
| `RENEWLET_IMAGE` | Docker 镜像，默认 `zhiyingzzhou/renewlet:latest`。 |
| `TZ` | 日志时区；提醒使用每个用户设置的时区。 |
| `PB_ENCRYPTION_KEY` | 敏感设置加密密钥，部署后不要更换。 |
| `CRON_SECRET` | 外部 Cron 请求使用的 Bearer 密钥。 |
| `RENEWLET_DEMO_MODE` | 是否开启演示模式，默认 `false`。 |
| `RENEWLET_CUSTOM_HEAD_HTML` | 可选的自定义 `<head>` 内容，默认留空。 |
| `NOTIFICATION_SCHEDULER_ENABLED` | 是否启用内置通知调度器，默认 `true`。 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Docker 服务端发出 HTTP(S) 请求时推荐使用的代理变量。 |

完整 Docker 环境变量模板见 `.env.example`。

### 上游代理

Docker 服务端发出的 HTTP(S) 请求需要代理时，在 `.env` 中配置：

```env
HTTP_PROXY="http://host.docker.internal:7890"
HTTPS_PROXY="http://host.docker.internal:7890"
NO_PROXY="localhost,127.0.0.1,.local"
```

默认使用大写变量。小写备选名为 `http_proxy`、`https_proxy` 和 `no_proxy`。不要同时配置大小写两组变量；两组同时存在时，Go 优先读取大写值。

代理运行在宿主机时，请填写容器可以访问的地址，不要使用 `localhost` 或 `127.0.0.1`。修改后重新创建容器：

```bash
docker compose up -d --force-recreate
```

### 自定义 Head HTML

需要接入 [Microsoft Clarity](https://learn.microsoft.com/zh-cn/clarity/setup-and-installation/clarity-setup) 等第三方服务时，把服务商提供的 `<head>` 代码原样填入 `RENEWLET_CUSTOM_HEAD_HTML`。Docker `.env` 中的多行代码用单引号包裹。

只添加你信任的代码，它可以访问 Renewlet 页面中的数据。修改后，Docker 部署需重启容器，Cloudflare 部署需重新构建并部署。

## 截图

<table>
  <tr>
    <td width="50%">
      <strong>AI 识别订阅</strong><br>
      <img src="./docs/screenshots/renewlet-ai-recognition-zh.png" alt="Renewlet 中文 AI 识别订阅弹窗，展示从文本内容生成可编辑订阅草稿前的输入态">
    </td>
    <td width="50%">
      <strong>公开订阅状态页</strong><br>
      <img src="./docs/screenshots/renewlet-public-status-zh.png" alt="Renewlet 中文公开订阅状态页，展示公开订阅汇总、价格和订阅卡片">
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>订阅清单</strong><br>
      <img src="./docs/screenshots/renewlet-subscriptions-zh.png" alt="Renewlet 中文订阅清单，展示筛选、标签、状态和服务 Logo">
    </td>
    <td width="50%">
      <strong>统计分析</strong><br>
      <img src="./docs/screenshots/renewlet-statistics-zh.png" alt="Renewlet 中文统计页面，展示预算、分类支出和付款方式图表">
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>续费日历</strong><br>
      <img src="./docs/screenshots/renewlet-calendar-zh.png" alt="Renewlet 中文续费日历，展示月度续费事件和预计支出">
    </td>
    <td width="50%">
      <strong>通知设置</strong><br>
      <img src="./docs/screenshots/renewlet-notifications-zh.png" alt="Renewlet 中文通知设置，展示通知渠道和邮件配置">
    </td>
  </tr>
</table>

### 移动端

<table>
  <tr>
    <td width="50%">
      <strong>移动端订阅列表</strong><br>
      <img src="./docs/screenshots/renewlet-subscriptions-h5-zh.png" alt="Renewlet 中文 H5 订阅列表，展示移动端筛选区、订阅卡片、Logo、价格和标签">
    </td>
    <td width="50%">
      <strong>移动端通知方式</strong><br>
      <img src="./docs/screenshots/renewlet-notifications-h5-zh.png" alt="Renewlet 中文 H5 通知方式，展示邮件通知渠道和 SMTP 邮件配置">
    </td>
  </tr>
</table>

## 贡献

欢迎提交 issue、文档修正、测试或 pull request。较大的变更请先开 issue，说明目标、使用场景和大致方案。

## 许可证

Renewlet 基于 [MIT License](LICENSE) 开源。
