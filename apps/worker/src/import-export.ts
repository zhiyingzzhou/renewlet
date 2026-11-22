import { z } from "zod";
import {
  importApplyPayloadSchema,
  importApplyRequestSchema,
  IMPORT_APPLY_SUBSCRIPTION_LIMIT,
  IMPORT_PREVIEW_MAX_BYTES,
  IMPORT_PREVIEW_SUBSCRIPTION_LIMIT,
  importPreviewPayloadSchema,
  importPreviewRequestSchema,
  type ImportConflictMode,
  type ImportPayload,
  type ImportPreviewItem,
  type ImportSummary,
  type ImportSubscription,
} from "@renewlet/shared/schemas/import-export";
import { customConfigSchema } from "@renewlet/shared/schemas/custom-config";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { mergeAppSettingsPatch } from "@renewlet/shared/settings-normalization";
import { getSettings, listSubscriptions, newId, nowIso, parseJsonObject, toApiSubscription } from "./db";
import { requestLocale, readJsonWithLimitAndSize, HttpError, successJson, type AppLocale } from "./http";
import { serverText } from "./server-i18n";
import { requireAuth } from "./auth";
import { buildCostSharingCollectionReminderMirrorStatements, normalizeSubscriptionBodyForStorage, toSubscriptionRow, type SubscriptionBody } from "./subscriptions";
import { subscriptionDerivedBulkMutationPlan, type SubscriptionDerivedMutation } from "./subscription-derived-state";
import {
  buildSubscriptionSchedulerRefreshStatements,
  subscriptionRepeatReminderContribution,
} from "./subscription-scheduler-state";
import { exchangeRateSnapshotUpsertStatement } from "./exchange-rate-snapshots";
import type { Env, SubscriptionRow } from "./types";

const IMPORT_WARNING_LOW_CONFIDENCE_KEY = "IMPORT_WARNING_LOW_CONFIDENCE_KEY";
const IMPORT_WARNING_LOW_CONFIDENCE_NAME_MATCHED = "IMPORT_WARNING_LOW_CONFIDENCE_NAME_MATCHED";

/** 导入预览只做当前用户范围内的冲突判断，不写 D1。 */
export async function previewImport(request: Request, env: Env): Promise<Response> {
  const metrics = { bodyBytes: 0, items: 0 };
  return await withImportResourceLog("preview", metrics, async () => await previewImportRequest(request, env, metrics));
}

async function previewImportRequest(request: Request, env: Env, metrics: { bodyBytes: number; items: number }): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const parsed = await readImportBody(request, importPreviewRequestSchema, locale);
  const body = parsed.data;
  metrics.bodyBytes = parsed.bodyBytes;
  metrics.items = body.payload.subscriptions.length;
  assertPreviewPayloadSize(body.payload.subscriptions.length, locale);
  assertValidSkipIndexes(body.skipIndexes, body.payload.subscriptions.length, locale);
  assertExchangeRateSnapshotSource(body.payload, locale);
  const existing = await listSubscriptions(env, auth.user.id);
  return successJson(importPreviewPayloadSchema.parse(publicPreview(buildPreview(body.payload, body.conflictMode, existing, body.skipIndexes))));
}

/** 应用导入会重新计算 preview，避免客户端篡改 action 结果后直接写库。 */
export async function applyImport(request: Request, env: Env): Promise<Response> {
  const metrics = { bodyBytes: 0, items: 0 };
  return await withImportResourceLog("apply", metrics, async () => await applyImportRequest(request, env, metrics));
}

async function applyImportRequest(request: Request, env: Env, metrics: { bodyBytes: number; items: number }): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  // apply 必须重新解析和预览请求体，不能信任浏览器上一轮 preview 的 action 结果。
  const parsed = await readImportBody(request, importApplyRequestSchema, locale);
  const body = parsed.data;
  metrics.bodyBytes = parsed.bodyBytes;
  metrics.items = body.payload.subscriptions.length;
  assertApplyPayloadSize(body.payload.subscriptions.length, locale);
  // 导入只在当前登录用户范围内查重；payload 里的来源用户仅用于 extra.import 幂等键，不能变成 owner。
  assertValidSkipIndexes(body.skipIndexes, body.payload.subscriptions.length, locale);
  assertExchangeRateSnapshotSource(body.payload, locale);
  const existing = await listSubscriptions(env, auth.user.id);
  const preview = buildPreview(body.payload, body.conflictMode, existing, body.skipIndexes);
  if (preview.summary.errors > 0) {
    throw new HttpError(400, serverText(locale, "import.previewFailed"), "IMPORT_PREVIEW_FAILED", publicPreview(preview));
  }

  const timestamp = nowIso();
  const statements: D1PreparedStatement[] = [];
  const subscriptionMutations: SubscriptionDerivedMutation[] = [];
  const existingMatches = buildExistingImportMatches(existing);
  const settingsForRows = await getSettings(env, auth.user.id);
  let finalSettingsForMirrors = settingsForRows;
  let scheduleSettingsChanged = false;
  if (body.payload.settings) {
    finalSettingsForMirrors = mergeAppSettingsPatch(settingsForRows, body.payload.settings);
    scheduleSettingsChanged = importSettingsAffectSchedule(settingsForRows, finalSettingsForMirrors);
    // settings merge 先套默认值和清洗规则，再写 JSON；导入文件不能绕过设置页契约塞入未知字段。
    statements.push(env.DB.prepare(`
      INSERT INTO settings (user_id, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
    `).bind(auth.user.id, JSON.stringify(finalSettingsForMirrors), timestamp, timestamp));
  }
  for (const item of preview.items) {
    if (item.action !== "create" && item.action !== "replace") continue;
    const source = preview.normalizedByIndex.get(item.index);
    if (!source) continue;
    const { row: existingRow } = resolveExistingImportMatch(existingMatches, source.extra.import, source);
    // import preview 已按 shared 写入 schema 收敛；apply 只消费这份 allowlist body，避免预览通过后 D1 写入才暴露字段错误。
    // toSubscriptionRow 会同步 costSharing 收款提醒镜像列；导入不能只写 JSON 而让 cron 索引候选漏行。
    const row = toSubscriptionRow(
      existingRow?.id ?? newId("sub"),
      auth.user.id,
      source,
      existingRow?.created_at ?? timestamp,
      timestamp,
      { settings: finalSettingsForMirrors },
    );
    if (existingRow) {
      subscriptionMutations.push({ before: existingRow, after: row, kind: "update" });
    } else {
      subscriptionMutations.push({ before: null, after: row, kind: "create" });
    }
  }
  if (scheduleSettingsChanged) {
    // 旧行镜像先写，随后 bulk fact 会用最终导入 row 覆盖 replace 项；未出现在导入里的行也能同步新规则。
    statements.push(...await buildCostSharingCollectionReminderMirrorStatements(env, auth.user.id, finalSettingsForMirrors));
  }
  if (subscriptionMutations.length > 0) {
    // 200 条 apply 不能按每条 6+tag 发 D1 query；JSON1 批量计划保持一次事务并把 SQL 数固定为 9。
    const derived = subscriptionDerivedBulkMutationPlan(env, subscriptionMutations, finalSettingsForMirrors);
    statements.push(...derived.beforeFact, derived.fact, ...derived.afterFact);
  }
  if (scheduleSettingsChanged) {
    const finalRows = new Map(existing.map((row) => [row.id, row]));
    for (const mutation of subscriptionMutations) {
      if (mutation.after) finalRows.set(mutation.after.id, mutation.after);
    }
    const rows = [...finalRows.values()];
    statements.push(...await buildSubscriptionSchedulerRefreshStatements(env, auth.user.id, {
      resetAutoRenewCheck: false,
      settings: finalSettingsForMirrors,
      repeatCandidates: rows.filter((row) => subscriptionRepeatReminderContribution(row) > 0).map(toApiSubscription),
      aggregateCounts: {
        autoRenewCount: rows.filter((row) => row.auto_renew === 1).length,
        repeatReminderCount: rows.reduce((count, row) => count + subscriptionRepeatReminderContribution(row), 0),
      },
    }));
  }
  if (body.payload.customConfig) {
    const nextConfig = customConfigSchema.parse(body.payload.customConfig);
    // custom config 是 shared schema 事实源；Worker 不在 D1 层复制字段级兼容逻辑。
    statements.push(env.DB.prepare(`
      INSERT INTO custom_configs (user_id, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
    `).bind(auth.user.id, JSON.stringify(nextConfig), timestamp, timestamp));
  }
  for (const snapshot of body.payload.exchangeRateSnapshots ?? []) {
    // ZIP 恢复是唯一允许写历史汇率月份的路径；只 upsert shared schema 规范化后的快照。
    statements.push(exchangeRateSnapshotUpsertStatement(env, auth.user.id, snapshot, timestamp));
  }

  if (statements.length > 0) {
    // D1 batch 在同一事务里执行；导入要么整体写入，要么让调用方看到明确失败。
    await env.DB.batch(statements);
  }
  return successJson(importApplyPayloadSchema.parse(publicPreview(preview)));
}

function importSettingsAffectSchedule(before: ApiAppSettings, after: ApiAppSettings): boolean {
  return before.timezone !== after.timezone
    || before.notificationTimeLocal !== after.notificationTimeLocal
    || before.notificationReminderDays !== after.notificationReminderDays;
}

function assertApplyPayloadSize(count: number, locale: AppLocale): void {
  if (count > IMPORT_APPLY_SUBSCRIPTION_LIMIT) {
    throw new HttpError(413, serverText(locale, "import.invalid"), "IMPORT_TOO_LARGE");
  }
}

function assertPreviewPayloadSize(count: number, locale: AppLocale): void {
  if (count > IMPORT_PREVIEW_SUBSCRIPTION_LIMIT) {
    throw new HttpError(413, serverText(locale, "import.invalid"), "IMPORT_TOO_LARGE");
  }
}

async function readImportBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  locale: AppLocale,
): Promise<{ data: z.infer<Schema>; bodyBytes: number }> {
  try {
    return await readJsonWithLimitAndSize(request, schema, locale, IMPORT_PREVIEW_MAX_BYTES);
  } catch (error) {
    if (error instanceof HttpError && (
      error.status === 413
      || (error.code === "INVALID_PAYLOAD" && JSON.stringify(error.details).includes("IMPORT_TOO_LARGE"))
    )) {
      throw new HttpError(413, serverText(locale, "import.invalid"), "IMPORT_TOO_LARGE");
    }
    throw error;
  }
}

async function withImportResourceLog<T>(
  operation: "preview" | "apply",
  metrics: { bodyBytes: number; items: number },
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await task();
  } finally {
    console.info("import_resources", {
      event: "import_resources",
      operation,
      bodyBytes: metrics.bodyBytes,
      items: metrics.items,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
  }
}

type PreviewResult = {
  summary: ImportSummary;
  items: ImportPreviewItem[];
  includesSettings: boolean;
  includesCustomConfig: boolean;
  includesExchangeRateSnapshots: boolean;
  exchangeRateSnapshotsCount: number;
  normalizedByIndex: Map<number, NormalizedImportSubscription>;
};

type NormalizedImportSubscription = SubscriptionBody & { extra: ImportSubscription["extra"] };

function publicPreview(preview: PreviewResult): Omit<PreviewResult, "normalizedByIndex"> {
  const { normalizedByIndex: _normalizedByIndex, ...rest } = preview;
  return rest;
}

function buildPreview(payload: ImportPayload, conflictMode: ImportConflictMode, existing: SubscriptionRow[], skipIndexes: number[]): PreviewResult {
  const existingMatches = buildExistingImportMatches(existing);
  const skippedIndexes = new Set(skipIndexes);
  const seenPayloadKeys = new Set<string>();
  const normalizedByIndex = new Map<number, NormalizedImportSubscription>();
  const items = payload.subscriptions.map((subscription, index) => {
    const importKey = subscription.extra.import;
    const warnings: string[] = [];
    const errors: string[] = [];
    if (importKey.confidence === "low") {
      warnings.push(IMPORT_WARNING_LOW_CONFIDENCE_KEY);
    }
    if (skippedIndexes.has(index)) {
      return {
        index,
        name: subscription.name,
        source: importKey.source,
        sourceId: importKey.sourceId,
        action: "skip",
        warnings,
        errors,
      } satisfies ImportPreviewItem;
    }
    const keyString = importKeyString(importKey);
    if (seenPayloadKeys.has(keyString)) {
      // 同一个导入文件内部重复 sourceId 必须先失败；否则 replace 会把两条 payload 写到同一订阅上。
      errors.push("IMPORT_SOURCE_ID_DUPLICATE");
    }
    seenPayloadKeys.add(keyString);
    const normalized = normalizeImportSubscriptionForPreview(subscription);
    if (normalized.ok) {
      normalizedByIndex.set(index, normalized.body);
    } else {
      errors.push(normalized.error);
    }
    const { row: existingRow, fallback } = resolveExistingImportMatch(existingMatches, importKey, subscription);
    if (fallback) {
      // Wallos display:* 是低置信桥接，只给用户 warning；真正写入仍保留原 import key 方便后续精确替换。
      warnings.push(IMPORT_WARNING_LOW_CONFIDENCE_NAME_MATCHED);
    }
    const action = errors.length > 0 ? "error" : existingRow ? (conflictMode === "replace" ? "replace" : "skip") : "create";
    return {
      index,
      name: subscription.name,
      source: importKey.source,
      sourceId: importKey.sourceId,
      ...(existingRow ? { existingId: existingRow.id } : {}),
      action,
      warnings,
      errors,
    } satisfies ImportPreviewItem;
  });
  return {
    summary: summarize(items),
    items,
    includesSettings: Boolean(payload.settings),
    includesCustomConfig: Boolean(payload.customConfig),
    includesExchangeRateSnapshots: Boolean(payload.exchangeRateSnapshots?.length),
    exchangeRateSnapshotsCount: payload.exchangeRateSnapshots?.length ?? 0,
    normalizedByIndex,
  };
}

function normalizeImportSubscriptionForPreview(subscription: ImportSubscription): { ok: true; body: NormalizedImportSubscription } | { ok: false; error: string } {
  try {
    return { ok: true, body: normalizeSubscriptionBodyForStorage(subscription) as NormalizedImportSubscription };
  } catch (error) {
    return { ok: false, error: importValidationErrorCode(error) };
  }
}

function importValidationErrorCode(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `IMPORT_SUBSCRIPTION_INVALID:${error.issues[0]?.path.join(".") || "payload"}`;
  }
  return "IMPORT_SUBSCRIPTION_INVALID";
}

function summarize(items: ImportPreviewItem[]): ImportSummary {
  return items.reduce<ImportSummary>((summary, item) => ({
    total: summary.total + 1,
    creates: summary.creates + (item.action === "create" ? 1 : 0),
    replaces: summary.replaces + (item.action === "replace" ? 1 : 0),
    skips: summary.skips + (item.action === "skip" ? 1 : 0),
    errors: summary.errors + (item.errors.length > 0 ? 1 : 0),
    warnings: summary.warnings + item.warnings.length,
  }), { total: 0, creates: 0, replaces: 0, skips: 0, errors: 0, warnings: 0 });
}

type ExistingImportMatches = {
  byKey: Map<string, SubscriptionRow>;
  lowConfidenceByName: Map<string, SubscriptionRow | null>;
};

function buildExistingImportMatches(rows: SubscriptionRow[]): ExistingImportMatches {
  const result: ExistingImportMatches = {
    byKey: new Map<string, SubscriptionRow>(),
    lowConfidenceByName: new Map<string, SubscriptionRow | null>(),
  };
  for (const row of rows) {
    // Renewlet 自导入要兼容“已有订阅还没有 extra.import”的当前数据；只在当前用户查询结果内按真实 id 建二级键。
    result.byKey.set(`renewlet:${row.id}`, row);
    const extra = parseJsonObject(row.extra_json);
    const importValue = extra["import"];
    if (!isImportKey(importValue)) continue;
    result.byKey.set(importKeyString(importValue), row);
    if (isLowConfidenceWallosKey(importValue)) {
      addLowConfidenceExisting(result, row);
    }
  }
  return result;
}

function addLowConfidenceExisting(matches: ExistingImportMatches, row: SubscriptionRow): void {
  const nameKey = lowConfidenceImportName(row.name);
  if (!nameKey) return;
  if (matches.lowConfidenceByName.has(nameKey)) {
    // 同名历史订阅不唯一时禁用名称兜底，宁可让用户手动处理，也不要误 replace。
    matches.lowConfidenceByName.set(nameKey, null);
    return;
  }
  matches.lowConfidenceByName.set(nameKey, row);
}

function resolveExistingImportMatch(
  matches: ExistingImportMatches,
  key: ImportSubscription["extra"]["import"],
  subscription: ImportSubscription,
): { row: SubscriptionRow | undefined; fallback: boolean } {
  const exact = matches.byKey.get(importKeyString(key));
  if (exact) return { row: exact, fallback: false };
  if (!isLowConfidenceWallosKey(key)) return { row: undefined, fallback: false };
  const fallback = matches.lowConfidenceByName.get(lowConfidenceImportName(subscription.name));
  return { row: fallback ?? undefined, fallback: Boolean(fallback) };
}

function isImportKey(value: unknown): value is ImportSubscription["extra"]["import"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record["source"] === "renewlet" || record["source"] === "wallos" || record["source"] === "ai")
    && typeof record["sourceId"] === "string"
    && (record["confidence"] === undefined || record["confidence"] === "high" || record["confidence"] === "low");
}

function assertValidSkipIndexes(indexes: number[], subscriptionCount: number, locale: ReturnType<typeof requestLocale>): void {
  if (indexes.some((index) => index < 0 || index >= subscriptionCount)) {
    throw new HttpError(400, serverText(locale, "import.skipIndexInvalid"), "IMPORT_SKIP_INDEX_INVALID");
  }
}

function assertExchangeRateSnapshotSource(payload: ImportPayload, locale: AppLocale): void {
  if ((payload.exchangeRateSnapshots?.length ?? 0) > 0 && payload.source !== "renewlet") {
    throw new HttpError(400, serverText(locale, "import.invalid"), "IMPORT_EXCHANGE_RATE_SNAPSHOTS_SOURCE_INVALID");
  }
}

function isLowConfidenceWallosKey(value: ImportSubscription["extra"]["import"]): boolean {
  return value.source === "wallos" && (value.confidence === "low" || value.sourceId.startsWith("display:"));
}

function lowConfidenceImportName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function importKeyString(value: ImportSubscription["extra"]["import"]): string {
  return `${value.source}:${value.sourceId}`;
}
