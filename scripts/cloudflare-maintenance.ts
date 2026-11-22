import { validateBookmark } from "./cloudflare-d1-checkpoint";
import { isJsonObject } from "./cloudflare-wrangler-config";

export interface MaintenanceCheckpoint {
  workerVersion: string;
  bookmark?: string;
}

export async function workerControlRequest(account: string, token: string, worker: string, path: string, init?: RequestInit) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(worker)}/${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000),
  });
  const envelope: unknown = await response.json();
  if (!response.ok || !isJsonObject(envelope) || envelope["success"] !== true) {
    throw new Error(`Cloudflare Worker control request failed (HTTP ${response.status})`);
  }
  return envelope["result"];
}

// 从当前 100% 流量版本的不可变 binding 恢复上下文。旧维护版本没有可信恢复点时须使用原部署记录人工恢复。
export function maintenanceCheckpoint(version: unknown): MaintenanceCheckpoint | undefined {
  if (!isJsonObject(version) || !isJsonObject(version["resources"]) || !Array.isArray(version["resources"]["bindings"])) {
    throw new Error("Worker version bindings unavailable");
  }
  const variables = new Map<string, unknown>();
  for (const binding of version["resources"]["bindings"]) {
    if (isJsonObject(binding) && binding["type"] === "plain_text" && typeof binding["name"] === "string") {
      variables.set(binding["name"], binding["text"]);
    }
  }
  if (variables.get("RENEWLET_MAINTENANCE_MODE") !== "true") return undefined;
  const workerVersion = variables.get("RENEWLET_RECOVERY_WORKER");
  if (typeof workerVersion !== "string" || !/^[A-Za-z0-9-]{10,128}$/.test(workerVersion)) {
    throw new Error("Maintenance Worker lacks a recovery version. Use the original deployment checkpoint.");
  }
  const bookmark = variables.get("RENEWLET_RECOVERY_BOOKMARK");
  return bookmark === undefined ? { workerVersion } : { workerVersion, bookmark: validateBookmark(bookmark) };
}

export function assertWorkerCrons(actual: unknown, expected: readonly string[]) {
  if (!isJsonObject(actual) || !Array.isArray(actual["schedules"])) throw new Error("Invalid Worker Cron response");
  const schedules = actual["schedules"].map((schedule) => {
    if (!isJsonObject(schedule) || typeof schedule["cron"] !== "string") throw new Error("Invalid Worker Cron schedule");
    return schedule["cron"];
  });
  if (JSON.stringify(schedules.sort()) !== JSON.stringify([...expected].sort())) throw new Error("Worker Cron schedules differ from configuration");
}
