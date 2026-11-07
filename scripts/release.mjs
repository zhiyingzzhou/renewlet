#!/usr/bin/env node
/**
 * 发布辅助脚本。
 *
 * 触发时机：maintainer release workflow、本地准备 release 和 tag publish workflow。
 * 副作用：sync-version 会改 workspace package.json 和 README Docker 固定版本示例；package-docker 会写 tmp/release；其它命令只输出校验结果/正文。
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryOwner = "zhiyingzzhou";
const repositoryName = "renewlet";
const githubRepository = `${repositoryOwner}/${repositoryName}`;
const githubBaseUrl = `https://github.com/${githubRepository}`;
const dockerHubImage = `${repositoryOwner}/${repositoryName}`;
const ghcrImage = `ghcr.io/${githubRepository}`;
const firstStableVersion = "0.1.0";
const latestTag = "latest";
const rcTag = "rc";
const defaultDockerHubImage = `${dockerHubImage}:${latestTag}`;
const defaultGhcrImage = `${ghcrImage}:${latestTag}`;
const versionPattern = /^v?(?<version>\d+\.\d+\.\d+(?:-rc\.(?<rc>\d+))?)$/;
const stablePattern = /^v?\d+\.\d+\.\d+$/;
const packagePaths = [
  "package.json",
  "apps/web/package.json",
  "apps/worker/package.json",
  "apps/docker-server/package.json",
  "packages/shared/package.json",
];
const readmeDockerImagePaths = ["README.md", "README.zh-CN.md"];
const readmeDockerImages = [dockerHubImage, ghcrImage];

function usage() {
  console.log(`Usage:
  node scripts/release.mjs validate-version <version>
  node scripts/release.mjs validate-package-versions <version>
  node scripts/release.mjs validate-next-version <version>
  node scripts/release.mjs sync-version <version>
  node scripts/release.mjs notes --version <version> [--previous <tag>]
  node scripts/release.mjs docker-tags <version>
  node scripts/release.mjs package-docker <version>
  node scripts/release.mjs release-body --version <version> [--previous <tag>]`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    } else {
      args._.push(value);
    }
  }
  return args;
}

function normalizeVersion(rawVersion) {
  const match = versionPattern.exec(rawVersion ?? "");
  if (!match?.groups?.version) {
    fail(`Invalid version "${rawVersion}". Expected ${firstStableVersion} or v${firstStableVersion}, with optional -rc.N.`);
  }
  return match.groups.version;
}

function isStableVersion(version) {
  return stablePattern.test(version);
}

function majorMinor(version) {
  const [major, minor] = version.split(".");
  return `${major}.${minor}`;
}

function versionParts(version) {
  const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10));
  return { major, minor, patch };
}

function runGit(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function escapedRegExp(source) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readmeDockerTagPattern(image) {
  return new RegExp(`(?<![A-Za-z0-9./_-])${escapedRegExp(image)}:(?<version>\\d+\\.\\d+\\.\\d+)`, "g");
}

function latestStableTag() {
  const output = runGit(["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"]);
  return output
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .find((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
}

export function allowedNextVersions(previousVersion) {
  const { major, minor, patch } = versionParts(previousVersion);
  // patch 段同时承担常规补丁和 hotfix 子线：0.2.9 可继续 0.2.10，也可开 0.2.91。
  return [...new Set([
    `${major}.${minor}.${patch + 1}`,
    `${major}.${minor}.${patch * 10 + 1}`,
    `${major}.${minor + 1}.0`,
    `${major + 1}.0.0`,
  ])];
}

function validateNextVersion(rawVersion) {
  const version = normalizeVersion(rawVersion);
  if (!isStableVersion(version)) {
    fail("Release prepare only accepts stable versions. Create RC tags from an existing release branch instead.");
  }

  const latestTag = latestStableTag();
  if (!latestTag) {
    if (version !== firstStableVersion) {
      fail(`First stable release must be ${firstStableVersion}; got ${version}.`);
    }
    console.log(version);
    return version;
  }

  const previousVersion = normalizeVersion(latestTag);
  const allowed = allowedNextVersions(previousVersion);
  if (!allowed.includes(version)) {
    // prepare 只看最新稳定 tag 的下一组合法目标，避免手填 0.5.0 这类合法但会误导升级节奏的跳号版本。
    fail(`Invalid next release ${version}. Latest stable is ${latestTag}; allowed next versions: ${allowed.join(", ")}.`);
  }

  console.log(version);
  return version;
}

function syncVersion(rawVersion) {
  const version = normalizeVersion(rawVersion);
  if (!isStableVersion(version)) {
    // package.json 是稳定线元数据；RC 只靠 tag 表达，避免源码版本在候选版之间来回抖动。
    fail("Package versions must stay on the stable SemVer value. Do not sync an RC suffix into package.json.");
  }

  for (const relativePath of packagePaths) {
    const path = join(repoRoot, relativePath);
    const packageJson = readJson(path);
    packageJson.version = version;
    writeFileSync(path, `${JSON.stringify(packageJson, null, 2)}\n`);
  }

  syncReadmeDockerImageVersions(version);

  console.log(`Synced workspace package versions and README Docker image tags to ${version}.`);
}

function syncReadmeDockerImageVersions(version) {
  for (const relativePath of readmeDockerImagePaths) {
    const path = join(repoRoot, relativePath);
    let content = readFileSync(path, "utf8");

    for (const image of readmeDockerImages) {
      const pattern = readmeDockerTagPattern(image);
      const matches = [...content.matchAll(pattern)];
      if (matches.length === 0) {
        fail(`${relativePath} must include a pinned ${image}:x.y.z Docker image example.`);
      }
      // README 是用户复制固定镜像 tag 的入口；release prepare 负责把示例同步到本次稳定版。
      content = content.replace(pattern, `${image}:${version}`);
    }

    writeFileSync(path, content);
  }
}

function validatePackageVersions(rawVersion) {
  const version = normalizeVersion(rawVersion);
  const packageVersion = version.replace(/-rc\.\d+$/, "");
  const mismatches = [];

  for (const relativePath of packagePaths) {
    const path = join(repoRoot, relativePath);
    const actual = readJson(path).version;
    if (actual !== packageVersion) {
      mismatches.push(`${relativePath}: expected ${packageVersion}, got ${actual}`);
    }
  }
  mismatches.push(...validateReadmeDockerImageVersions(packageVersion));

  if (mismatches.length > 0) {
    fail(`Workspace package versions and README Docker image tags must match the release tag:\n${mismatches.join("\n")}`);
  }

  console.log(packageVersion);
  return packageVersion;
}

function validateReadmeDockerImageVersions(version) {
  const mismatches = [];

  for (const relativePath of readmeDockerImagePaths) {
    const content = readFileSync(join(repoRoot, relativePath), "utf8");

    for (const image of readmeDockerImages) {
      const matches = [...content.matchAll(readmeDockerTagPattern(image))];
      if (matches.length === 0) {
        mismatches.push(`${relativePath}: missing pinned ${image}:x.y.z Docker image example`);
        continue;
      }

      for (const match of matches) {
        const actual = match.groups?.version;
        if (actual !== version) {
          mismatches.push(`${relativePath}: ${image} expected ${version}, got ${actual}`);
        }
      }
    }
  }

  return mismatches;
}

function commitRange(previous) {
  if (previous) {
    return `${previous}..HEAD`;
  }

  try {
    const latestTag = runGit(["describe", "--tags", "--abbrev=0"]);
    return `${latestTag}..HEAD`;
  } catch {
    return "HEAD";
  }
}

function compareLink(previous, version) {
  if (previous) {
    return `${githubBaseUrl}/compare/${previous}...v${version}`;
  }

  try {
    // 首个 release 没有上一个 tag，只能退回 tag 页；后续 release 会生成真实 compare 链接。
    const latestTag = runGit(["describe", "--tags", "--abbrev=0", "HEAD^"]);
    return `${githubBaseUrl}/compare/${latestTag}...v${version}`;
  } catch {
    return `${githubBaseUrl}/releases/tag/v${version}`;
  }
}

function releaseNotesSection(rawVersion, locale) {
  const version = normalizeVersion(rawVersion);
  const stableVersion = version.replace(/-rc\.\d+$/, "");
  const notesPath = join(repoRoot, "docs", "release-notes", `v${stableVersion}-${locale}.md`);
  if (!existsSync(notesPath)) {
    return "";
  }

  const content = readFileSync(notesPath, "utf8").trim();
  return content
    .replace(/^# [^\r\n]+(?:\r?\n+|$)/, "")
    .replace(/^\[(?:English|中文) ->\]\(\.\/v[0-9]+\.[0-9]+\.[0-9]+-(?:en|zh)\.md\)(?:\r?\n+|$)/m, "")
    .trim();
}

function markdownNotes(rawVersion, previous, options = {}) {
  const version = normalizeVersion(rawVersion);
  const stableVersion = version.replace(/-rc\.\d+$/, "");
  const notes = releaseNotesSection(version, "en");
  const includeFullChangelog = options.includeFullChangelog ?? true;
  const lines = [];

  if (!notes) {
    // 英文是发布正文的必需输入；缺失或为空时阻断生成，不能静默退回另一种语言。
    fail(`Missing or empty release notes: docs/release-notes/v${stableVersion}-en.md`);
  }

  if (releaseNotesSection(version, "zh")) {
    // RC 复用稳定版本文件名，但链接必须固定到本次 tag；main 此时可能尚未包含这份说明。
    lines.push(`[简体中文](${githubBaseUrl}/blob/v${version}/docs/release-notes/v${stableVersion}-zh.md)`, "");
  }
  lines.push(notes, "");

  if (includeFullChangelog) {
    lines.push("### Full Changelog", "", `- ${compareLink(previous, version)}`, "");
  }
  return lines.join("\n");
}

function dockerTags(rawVersion) {
  const version = normalizeVersion(rawVersion);
  const tags = [];

  if (isStableVersion(version)) {
    // latest 只随稳定版移动；RC 用户必须显式选择 rc 或具体候选标签。
    tags.push(
      `${dockerHubImage}:${version}`,
      `${dockerHubImage}:${majorMinor(version)}`,
      `${dockerHubImage}:${latestTag}`,
      `${ghcrImage}:${version}`,
      `${ghcrImage}:${majorMinor(version)}`,
      `${ghcrImage}:${latestTag}`,
    );
  } else {
    tags.push(`${dockerHubImage}:${version}`, `${dockerHubImage}:${rcTag}`, `${ghcrImage}:${version}`, `${ghcrImage}:${rcTag}`);
  }

  return tags;
}

function releaseBody(rawVersion, previous) {
  const version = normalizeVersion(rawVersion);
  const tags = dockerTags(version);
  const dockerHubTags = tags.filter((tag) => tag.startsWith(`${dockerHubImage}:`));
  const ghcrTags = tags.filter((tag) => tag.startsWith(`${ghcrImage}:`));
  const notes = markdownNotes(version, previous, { includeFullChangelog: false }).trimEnd();

  return [
    notes,
    "",
    "## Docker Images",
    "",
    "- Docker Hub",
    ...dockerHubTags.map((tag) => `  - \`${tag}\``),
    "- GitHub Container Registry",
    ...ghcrTags.map((tag) => `  - \`${tag}\``),
    "",
    "## Full Changelog",
    "",
    `- ${compareLink(previous, version)}`,
    "",
  ].join("\n");
}

function patchDockerImage(content, version) {
  // Release 附件必须 pin 当前版本，避免用户下载旧 Release 后被 latest 带到未来版本。
  return content
    .replace(new RegExp(escapedRegExp(defaultDockerHubImage), "g"), `${dockerHubImage}:${version}`)
    .replace(new RegExp(escapedRegExp(defaultGhcrImage), "g"), `${ghcrImage}:${version}`);
}

function packageDocker(rawVersion) {
  const version = normalizeVersion(rawVersion);
  const tempDir = mkdtempSync(join(tmpdir(), "renewlet-release-"));
  const packageDir = join(tempDir, `renewlet-docker-v${version}`);
  const outputDir = join(repoRoot, "tmp", "release");
  const zipPath = join(outputDir, `renewlet-docker-v${version}.zip`);

  mkdirSync(packageDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const files = ["docker-compose.yml", "env.example", "docker-deploy.sh"];
  for (const file of files) {
    const source = join(repoRoot, "deploy", file);
    const target = join(packageDir, file);
    const content = readFileSync(source, "utf8");
    // Release 附件必须 pin 当前版本；用户离线保存历史 zip 时不应被 latest 拉到未来版本。
    writeFileSync(target, patchDockerImage(content, version));
    if (file === "docker-deploy.sh") {
      chmodSync(target, 0o755);
    }
  }

  try {
    if (existsSync(zipPath)) {
      rmSync(zipPath);
    }
    // zip 在临时父目录执行，确保附件内只有 renewlet-docker-vX.Y.Z/ 一层，用户解压后不会污染当前目录。
    execFileSync("zip", ["-qr", zipPath, basename(packageDir)], {
      cwd: tempDir,
      stdio: "inherit",
    });
  } finally {
    // release workflow 可重跑；临时目录必须无条件清理，避免历史 compose/env 被下一次打包带走。
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(zipPath);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];

  switch (command) {
    case "validate-version": {
      const version = normalizeVersion(args._[1]);
      console.log(version);
      break;
    }
    case "validate-package-versions":
      validatePackageVersions(args._[1]);
      break;
    case "validate-next-version":
      validateNextVersion(args._[1]);
      break;
    case "sync-version":
      syncVersion(args._[1]);
      break;
    case "notes":
      process.stdout.write(markdownNotes(args.version, args.previous));
      break;
    case "docker-tags":
      process.stdout.write(`${dockerTags(args._[1]).join("\n")}\n`);
      break;
    case "package-docker":
      packageDocker(args._[1]);
      break;
    case "release-body":
      process.stdout.write(releaseBody(args.version, args.previous));
      break;
    default:
      usage();
      process.exit(command ? 1 : 0);
  }
}

function isEntrypoint() {
  const scriptPath = process.argv[1];
  return Boolean(scriptPath) && import.meta.url === pathToFileURL(resolve(scriptPath)).href;
}

if (isEntrypoint()) {
  main();
}
