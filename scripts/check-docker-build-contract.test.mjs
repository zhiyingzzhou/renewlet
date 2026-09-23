import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkDockerBuildContract } from "./check-docker-build-contract.mjs";

const clientBuild = [
  "tsc --noEmit --project tsconfig.app.json",
  "vite build",
  "node scripts/check-client-csp.mjs",
  "node scripts/check-client-bundle-budget.mjs",
].join(" && ");

const dockerfile = `# syntax=docker/dockerfile:1.8
# check=error=true

FROM node:24.19.0-alpine AS client-deps
FROM client-deps AS client-builder
COPY apps/web apps/web
COPY packages/shared packages/shared
RUN pnpm --filter @renewlet/client build
RUN pnpm --filter @renewlet/client build:docker-sidecars
FROM golang:1.26.6-alpine AS server-builder
COPY --from=client-builder /app/apps/web/dist ./internal/static/public
RUN CGO_ENABLED=0 go build -o /out/renewlet ./cmd/renewlet \\
  && CGO_ENABLED=0 go build -o /out/container-init ./cmd/container-init
FROM gcr.io/distroless/static-debian13@sha256:9197324ba51d9cd071af8505989365c006adf9d6d2067eada25aef00abbb5278 AS runner
COPY --from=server-builder --chown=1000:1000 /out/renewlet /opt/renewlet/current/renewlet
COPY --from=server-builder --chown=0:0 /out/container-init /container-init
COPY --from=server-builder --chown=0:0 /out/container-init /docker-entrypoint.sh
ENTRYPOINT ["/container-init"]
`;

const workflow = `jobs:
  build:
    steps:
      - uses: docker/build-push-action@v7
        with:
          context: .
          file: ./Dockerfile
`;

function writeFixtureFile(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "renewlet-docker-contract-"));
  writeFixtureFile(root, "Dockerfile", dockerfile);
  writeFixtureFile(root, "package.json", JSON.stringify({ scripts: { "test:all": "pnpm check:i18n" } }));
  writeFixtureFile(
    root,
    "apps/web/package.json",
    JSON.stringify({
      scripts: {
        build: clientBuild,
        "build:docker-sidecars": "node scripts/generate-static-sidecars.mjs",
      },
    }),
  );
  writeFixtureFile(root, "apps/web/scripts/check-client-csp.mjs", "export {};\n");
  writeFixtureFile(root, "apps/web/scripts/generate-static-sidecars.mjs", "export {};\n");
  writeFixtureFile(
    root,
    "apps/web/scripts/check-client-bundle-budget.mjs",
    "400000 344000\n",
  );
  writeFixtureFile(root, "apps/web/vite.config.ts", "export default { build: { manifest: true } };\n");
  writeFixtureFile(root, "apps/docker-server/cmd/container-init/main.go", "package main\n");
  writeFixtureFile(
    root,
    ".github/workflows/ci.yml",
    "run: pnpm check:i18n\nrun: pnpm build:all\nrun: pnpm check:route-parity\nrun: pnpm test:perf\n",
  );
  writeFixtureFile(
    root,
    ".github/workflows/build-smoke.yml",
    `${workflow}          load: true
      - run: |
          docker run --rm renewlet:smoke --version
          docker run --rm --entrypoint /docker-entrypoint.sh renewlet:smoke --version
          legacy_id="$(docker run --detach --entrypoint /docker-entrypoint.sh renewlet:smoke serve --http=0.0.0.0:3000 --dir=/pb_data --encryptionEnv=PB_ENCRYPTION_KEY)"
          container_id="$(docker run --detach renewlet:smoke)"
          trap cleanup EXIT
          docker exec "$container_id" /renewlet healthcheck
`,
  );
  writeFixtureFile(
    root,
    ".github/workflows/security-scan.yml",
    `${workflow}  image-scan:\n${workflow}      - uses: anchore/scan-action/download-grype@27805bf3b4e84b4a5c980df22ed233c00390a439\n        with:\n          grype-version: v0.119.0\n      - run: anchore-grype renewlet:security-scan --fail-on high --scope all-layers\n`,
  );
  writeFixtureFile(root, ".github/workflows/release-publish.yml", workflow);
  return root;
}

function withFixture(run) {
  const root = createFixture();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts the workspace-owned client build contract", () => {
  withFixture((root) => assert.doesNotThrow(() => checkDockerBuildContract(root)));
});

test("rejects client build scripts outside apps/web", () => {
  withFixture((root) => {
    writeFixtureFile(root, "scripts/external.mjs", "export {};\n");
    const packagePath = join(root, "apps/web/package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    packageJson.scripts.build += " && node ../../scripts/external.mjs";
    writeFileSync(packagePath, JSON.stringify(packageJson));
    assert.throws(() => checkDockerBuildContract(root), /must stay inside apps\/web/);
  });
});

test("rejects missing client build scripts", () => {
  withFixture((root) => {
    rmSync(join(root, "apps/web/scripts/check-client-csp.mjs"));
    assert.throws(() => checkDockerBuildContract(root), /does not exist/);
  });
});

test("rejects a missing Docker sidecar package command", () => {
  withFixture((root) => {
    const packagePath = join(root, "apps/web/package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    delete packageJson.scripts["build:docker-sidecars"];
    writeFileSync(packagePath, JSON.stringify(packageJson));
    assert.throws(() => checkDockerBuildContract(root), /must own the Docker static sidecar build command/);
  });
});

test("rejects a full suite that skips the CI i18n gate", () => {
  withFixture((root) => {
    writeFixtureFile(root, "package.json", JSON.stringify({ scripts: { "test:all": "pnpm typecheck:all" } }));
    assert.throws(() => checkDockerBuildContract(root), /same i18n gate as CI/);
  });
});

test("rejects a client-builder that skips Docker sidecar generation", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace(
      "RUN pnpm --filter @renewlet/client build:docker-sidecars\n",
      "",
    );
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /build:docker-sidecars/);
  });
});

test("rejects per-file root script copies", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace(
      "RUN pnpm --filter @renewlet/client build",
      "COPY scripts/check-client-csp.mjs scripts/check-client-csp.mjs\nRUN pnpm --filter @renewlet/client build",
    );
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /apps\/web ownership boundary/);
  });
});

test("rejects a client-builder that does not copy the Web workspace", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace("COPY apps/web apps/web\n", "");
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /COPY apps\/web apps\/web/);
  });
});

test("rejects workflows that build a divergent Dockerfile", () => {
  withFixture((root) => {
    const workflowPath = join(root, ".github/workflows/security-scan.yml");
    const content = readFileSync(workflowPath, "utf8").replaceAll("file: ./Dockerfile", "file: ./Dockerfile.scan");
    writeFileSync(workflowPath, content);
    assert.throws(() => checkDockerBuildContract(root), /shared root Dockerfile/);
  });
});

test("rejects build-time files copied into the runner", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace(
      'ENTRYPOINT ["/container-init"]',
      'COPY --from=client-builder /app/apps/web/scripts /scripts\nENTRYPOINT ["/container-init"]',
    );
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /must not receive build-time files/);
  });
});

test("rejects copying the stable Renewlet path from a builder", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace(
      'ENTRYPOINT ["/container-init"]',
      'COPY --from=server-builder /out/renewlet /renewlet\nENTRYPOINT ["/container-init"]',
    );
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /container-init own the stable \/renewlet symlink/);
  });
});

test("rejects an Alpine runner", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace(
      /FROM gcr\.io\/distroless\/static-debian13@sha256:[a-f0-9]+ AS runner/,
      "FROM alpine:3.24 AS runner",
    );
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /approved distroless runtime/);
  });
});

test("rejects an unpinned distroless runner", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace(
      /gcr\.io\/distroless\/static-debian13@sha256:[a-f0-9]+/,
      "gcr.io/distroless/static-debian13:latest",
    );
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /approved distroless runtime/);
  });
});

test("rejects package installation in the final runner", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace(
      "COPY --from=server-builder --chown=1000:1000 /out/renewlet /opt/renewlet/current/renewlet",
      "RUN apk add --no-cache ca-certificates\nCOPY --from=server-builder --chown=1000:1000 /out/renewlet /opt/renewlet/current/renewlet",
    );
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /must not contain RUN instructions/);
  });
});

test("rejects a shell entrypoint in the final runner", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace(
      'ENTRYPOINT ["/container-init"]',
      'ENTRYPOINT ["/bin/sh", "/docker-entrypoint.sh"]',
    );
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /must not contain shell entrypoints/);
  });
});

test("rejects a missing legacy static init entrypoint", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace(
      "COPY --from=server-builder --chown=0:0 /out/container-init /docker-entrypoint.sh\n",
      "",
    );
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /docker-entrypoint\.sh/);
  });
});

test("rejects a USER override that bypasses volume initialization", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace(
      'ENTRYPOINT ["/container-init"]',
      'USER 1000:1000\nENTRYPOINT ["/container-init"]',
    );
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /bypasses root volume initialization/);
  });
});
