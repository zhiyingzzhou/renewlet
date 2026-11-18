# syntax=docker/dockerfile:1.8
# check=error=true

# 构建链路：Node 阶段产出 Vite 静态资源，Go 阶段嵌入静态资源并生成单文件 server，runner 只保留运行依赖。
FROM --platform=$BUILDPLATFORM node:24.19.0-alpine3.24 AS client-deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/docker-server/package.json apps/docker-server/package.json
# workspace 已纳入独立官网；这里只复制 manifest 让 frozen lockfile 可解析，产品镜像仍只构建 web/docker-server。
COPY apps/website/package.json apps/website/package.json
RUN pnpm install --frozen-lockfile

FROM client-deps AS client-builder
# Web 自有的产物守卫随 workspace 整体复制，避免 package build 与 Docker builder 的输入清单再次漂移。
COPY apps/web apps/web
COPY packages/shared packages/shared
RUN pnpm --filter @renewlet/client build
# 预压缩只属于 Go 嵌入式运行面；Cloudflare 构建继续交给平台自动协商，避免上传无用 sidecar。
RUN pnpm --filter @renewlet/client build:docker-sidecars

FROM --platform=$BUILDPLATFORM golang:1.27.4-alpine3.24 AS server-builder

# Release workflow 和 Docker buildx 会注入这些元数据；页面内更新和版本弹窗都依赖 ldflags 中的值。
ARG TARGETOS=linux
ARG TARGETARCH
ARG VERSION=0.0.0-dev
ARG COMMIT=dev
ARG BUILD_TIME=dev

WORKDIR /src/apps/docker-server

COPY apps/docker-server/go.mod apps/docker-server/go.sum ./
RUN go mod download

COPY apps/docker-server ./
RUN mkdir -p internal/static/public \
  && find internal/static/public -mindepth 1 ! -name .gitkeep -delete
COPY --from=client-builder /app/apps/web/dist ./internal/static/public

RUN mkdir -p /out \
  && CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-$(go env GOARCH)} go build -trimpath -ldflags="-s -w -X main.Version=${VERSION} -X main.Commit=${COMMIT} -X main.BuildTime=${BUILD_TIME} -X main.BuildType=release" -o /out/renewlet ./cmd/renewlet \
  && CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-$(go env GOARCH)} go build -trimpath -ldflags="-s -w" -o /out/container-init ./cmd/container-init

FROM gcr.io/distroless/static-debian13@sha256:9197324ba51d9cd071af8505989365c006adf9d6d2067eada25aef00abbb5278 AS runner

ARG VERSION=0.0.0-dev
ARG COMMIT=dev
ARG BUILD_TIME=dev

LABEL org.opencontainers.image.title="Renewlet" \
  org.opencontainers.image.description="Self-hosted subscription ledger and renewal reminders" \
  org.opencontainers.image.source="https://github.com/zhiyingzzhou/renewlet" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${COMMIT}" \
  org.opencontainers.image.created="${BUILD_TIME}" \
  org.opencontainers.image.licenses="MIT"

# GOMEMLIMIT 给小内存 VPS 留余量；自更新变量固定真实二进制和备份目录，不能指向 /renewlet symlink。
ENV GOMEMLIMIT=128MiB \
  RENEWLET_SELF_UPDATE_ENABLED=true \
  RENEWLET_SELF_UPDATE_BINARY=/opt/renewlet/current/renewlet \
  RENEWLET_SELF_UPDATE_BACKUP_DIR=/opt/renewlet/backups

# Distroless static 已提供 CA 与 tzdata；/renewlet 由 container-init 创建，避免 BuildKit COPY 解引用源 symlink。
COPY --from=server-builder --chown=1000:1000 /out/renewlet /opt/renewlet/current/renewlet
COPY --from=server-builder --chown=0:0 /out/container-init /container-init
# 旧官方镜像使用此 OCI Entrypoint；保留同一静态 init 的兼容路径，跳版本升级不依赖 shell 或旧脚本。
COPY --from=server-builder --chown=0:0 /out/container-init /docker-entrypoint.sh

# pb_data 同时保存 PocketBase SQLite、上传文件和迁移状态；升级/重建容器必须持久化这个卷。
VOLUME ["/pb_data"]
EXPOSE 3000

ENTRYPOINT ["/container-init"]
CMD ["serve", "--http=0.0.0.0:3000", "--dir=/pb_data", "--encryptionEnv=PB_ENCRYPTION_KEY"]
