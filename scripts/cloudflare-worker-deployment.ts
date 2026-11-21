import { isJsonObject } from "./cloudflare-wrangler-config";
import type { MaintenanceCheckpoint } from "./cloudflare-maintenance";

export interface ActiveDeployment {
  maintenance?: MaintenanceCheckpoint;
  versionId: string;
}

interface WorkerDeploymentAccess {
  accountId: string;
  apiToken: string;
  workerName: string;
}

const workerNotFoundCode = 10007;
const deploymentReadTimeoutMs = 30_000;

/** 只有结构化的不存在响应允许首次安装；权限、网络和响应损坏必须在首次 D1 写入前阻断部署。 */
export async function readActiveWorkerDeployment(
  access: WorkerDeploymentAccess,
  request: typeof fetch = fetch,
): Promise<ActiveDeployment | undefined> {
  if (!access.accountId || !access.apiToken || !access.workerName) {
    throw new Error("Cloudflare deployment requires an account, API token and Worker name");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(access.accountId)}/workers/scripts/${encodeURIComponent(access.workerName)}/deployments`;
  let response: Response;
  let payload: unknown;
  try {
    response = await request(url, {
      headers: { Authorization: `Bearer ${access.apiToken}` },
      signal: AbortSignal.timeout(deploymentReadTimeoutMs),
    });
    payload = await response.json();
  } catch {
    throw new Error("Unable to read Cloudflare Worker deployment JSON");
  }
  if (!isJsonObject(payload)) throw new Error("Cloudflare Worker deployment returned an invalid envelope");
  const errors = payload["errors"];
  if (response.status === 404 && payload["success"] === false && Array.isArray(errors)
    && errors.length === 1 && isJsonObject(errors[0]) && errors[0]["code"] === workerNotFoundCode) {
    return undefined;
  }
  // 不将第三方错误正文带入部署日志；HTTP 状态足以区分权限/平台失败，不泄漏响应中的账户信息。
  if (!response.ok || payload["success"] !== true || !Array.isArray(errors) || errors.length > 0) {
    throw new Error(`Cloudflare Worker deployment read failed (HTTP ${response.status})`);
  }
  const result = payload["result"];
  if (!isJsonObject(result) || !Array.isArray(result["deployments"])) {
    throw new Error("Cloudflare Worker deployment returned an invalid result");
  }
  // API 与 Wrangler 使用同一倒序列表；空列表是尚未部署，后续历史版本不能覆盖当前流量事实。
  const deployment = result["deployments"][0];
  if (deployment === undefined) return undefined;
  if (!isJsonObject(deployment) || !Array.isArray(deployment["versions"])) {
    throw new Error("Cloudflare Worker deployment returned an invalid version list");
  }
  const versions = deployment["versions"];
  const version = versions[0];
  if (versions.length !== 1 || !isJsonObject(version)
    || typeof version["version_id"] !== "string" || !/^[A-Za-z0-9-]{10,128}$/.test(version["version_id"])
    || version["percentage"] !== 100) {
    throw new Error("Renewlet deployment requires one active Worker version at 100% traffic");
  }
  return { versionId: version["version_id"] };
}
