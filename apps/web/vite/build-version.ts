import { readFileSync } from "node:fs";
import path from "node:path";

const devPlaceholderPattern = /^(?:0\.0\.0-dev|\d+\.\d+\.\d+-dev)$/;
const releaseVersionPattern = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;
const branchBuildVersionPattern = /^\d+\.\d+\.\d+-dev\+[0-9a-f]{7,40}$/i;

interface PackageVersionFile {
  version?: unknown;
}

export function resolveClientBuildVersion(repoRoot: string, loadedEnv: Record<string, string | undefined> = process.env): string {
  const packageVersion = readPackageVersion(repoRoot);
  // Worker 部署元数据由 RENEWLET_VERSION 注入 Worker；客户端只接受显式 VITE 覆盖，避免把部署 SHA 带进 Static Assets 的压缩预算。
  const rawVersion = loadedEnv["VITE_RENEWLET_VERSION"];
  return normalizeClientBuildVersion(rawVersion, packageVersion);
}

function readPackageVersion(repoRoot: string): string {
  const rawPackageJson = readFileSync(path.resolve(repoRoot, "package.json"), "utf8");
  const packageJson: unknown = JSON.parse(rawPackageJson);
  if (!isPackageVersionFile(packageJson)) return "0.0.0-dev";
  return normalizeClientBuildVersion(packageJson.version, "0.0.0-dev");
}

function isPackageVersionFile(value: unknown): value is PackageVersionFile {
  return typeof value === "object" && value !== null && "version" in value;
}

function normalizeClientBuildVersion(rawVersion: unknown, fallbackVersion: string): string {
  const version = typeof rawVersion === "string" ? rawVersion.trim() : "";
  if (!version || devPlaceholderPattern.test(version)) return fallbackVersion;
  if (releaseVersionPattern.test(version) || branchBuildVersionPattern.test(version)) return version;
  return fallbackVersion;
}
