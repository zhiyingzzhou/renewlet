import { z } from "zod";
import { okPayloadSchema, okResponseSchema } from "./common";
import { apiSuccessResponseSchema } from "./api";
import { upstreamErrorDetailsSchema } from "./upstream";

/** healthResponseSchema 是 Docker healthcheck、Cloudflare Worker 和前端存活探测的共同最小响应。 */
export const healthPayloadSchema = z.object({
  time: z.string().min(1),
}).strict();
export const healthResponseSchema = apiSuccessResponseSchema(healthPayloadSchema);

export const turnstilePublicConfigSchema = z.object({
  enabled: z.boolean(),
  siteKey: z.string(),
}).strict();

/**
 * 认证前应用能力状态。
 *
 * app status 是登录、setup、demo 置灰和 Turnstile 人机验证能力的共同真相源；真正写入仍由后端 route/hook 校验。
 */
export const appStatusPayloadSchema = z.object({
  setupRequired: z.boolean(),
  setupEnabled: z.boolean(),
  demoMode: z.boolean(),
  // 只允许公开 siteKey；Turnstile secret 是后端 Siteverify 凭据，不能进入认证前 status 或前端缓存。
  turnstile: turnstilePublicConfigSchema,
}).strict();
export const appStatusResponseSchema = apiSuccessResponseSchema(appStatusPayloadSchema);

export const loginOptionsPayloadSchema = appStatusPayloadSchema.extend({ passwordReset: z.boolean(), oidc: z.boolean() });
export const loginOptionsSchema = apiSuccessResponseSchema(loginOptionsPayloadSchema);
export type LoginOptions = z.infer<typeof loginOptionsPayloadSchema>;

export const setupStatusPayloadSchema = appStatusPayloadSchema.pick({
  setupRequired: true,
  setupEnabled: true,
}).strict();
export const setupStatusResponseSchema = apiSuccessResponseSchema(setupStatusPayloadSchema);

export const setupCreateResponseSchema = okResponseSchema;

export const passwordResetStatusPayloadSchema = z.object({
  enabled: z.boolean(),
}).strict();
export const passwordResetStatusResponseSchema = apiSuccessResponseSchema(passwordResetStatusPayloadSchema);

/**
 * 系统部署形态与更新模式分开表达。
 *
 * deployment 是实际运行面；updateMode 是管理员版本弹窗该暴露的升级路径，前端不能再从 buildType 猜。
 */
export const systemDeploymentSchema = z.enum(["docker", "cloudflare", "source"]);
export const systemUpdateModeSchema = z.enum(["in-app-binary", "docker-compose", "cloudflare-deploy", "source-manual"]);

/** 构建信息由 CI ldflags 或 Wrangler vars 注入；不能用于权限判断，只用于版本弹窗展示。 */
export const systemBuildInfoSchema = z.object({
  version: z.string().min(1),
  commit: z.string(),
  buildTime: z.string(),
  buildType: z.string().min(1),
}).strict();

/** GitHub Release 资产的前端展示视图；真实下载 URL 不进入浏览器，避免绕过 checksum 校验。 */
export const systemReleaseAssetSchema = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
}).strict();

export const systemReleaseInfoSchema = z.object({
  tagName: z.string().min(1),
  version: z.string().min(1),
  name: z.string(),
  body: z.string(),
  publishedAt: z.string(),
  htmlUrl: z.string().min(1),
  assets: z.array(systemReleaseAssetSchema),
}).strict();

/** systemVersionResponseSchema 描述“检查结果”而不触发更新副作用。 */
export const systemVersionPayloadSchema = z.object({
  currentVersion: z.string().min(1),
  latestVersion: z.string().min(1),
  hasUpdate: z.boolean(),
  checkSucceeded: z.boolean(),
  deployment: systemDeploymentSchema,
  updateMode: systemUpdateModeSchema,
  updateSupported: z.boolean(),
  unsupportedReason: z.string().optional(),
  releaseInfo: systemReleaseInfoSchema.nullable(),
  cached: z.boolean(),
  warning: z.string().optional(),
  errorDetails: upstreamErrorDetailsSchema.optional(),
  build: systemBuildInfoSchema,
}).strict();
export const systemVersionResponseSchema = apiSuccessResponseSchema(systemVersionPayloadSchema);

export const systemUpdateOperationStatusSchema = z.enum(["running", "succeeded", "failed"]);
export const systemUpdateOperationStageSchema = z.enum([
  "checking",
  "downloading",
  "verifying",
  "installing",
  "restart-pending",
  "completed",
]);

export const systemUpdateOperationErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: upstreamErrorDetailsSchema.optional(),
}).strict();

/** 更新任务是 Docker 自更新唯一事实源；轮询响应不触发磁盘、数据库或上游请求。 */
export const systemUpdateOperationSchema = z.object({
  id: z.string().min(1),
  status: systemUpdateOperationStatusSchema,
  stage: systemUpdateOperationStageSchema,
  currentVersion: z.string().min(1),
  targetVersion: z.string().min(1).nullable(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  needsRestart: z.boolean(),
  error: systemUpdateOperationErrorSchema.nullable(),
}).strict().superRefine((operation, context) => {
  // 这里约束的是 Go、Worker 与 React 共同依赖的组合状态，不只是字段类型；任何运行面都不能产生“成功但仍在下载”等歧义快照。
  const terminal = operation.status !== "running";
  if (terminal !== (operation.finishedAt !== null)) {
    context.addIssue({ code: "custom", message: "finishedAt must match terminal status", path: ["finishedAt"] });
  }
  if ((operation.status === "failed") !== (operation.error !== null)) {
    context.addIssue({ code: "custom", message: "error must match failed status", path: ["error"] });
  }
  if (operation.status === "running" && (operation.stage === "restart-pending" || operation.stage === "completed")) {
    context.addIssue({ code: "custom", message: "running operation has a terminal stage", path: ["stage"] });
  }
  if (operation.status === "succeeded" && operation.stage !== "restart-pending" && operation.stage !== "completed") {
    context.addIssue({ code: "custom", message: "succeeded operation has a nonterminal stage", path: ["stage"] });
  }
  if (operation.status === "failed" && operation.stage === "completed") {
    context.addIssue({ code: "custom", message: "failed operation cannot be completed", path: ["stage"] });
  }
  if (operation.needsRestart && (operation.status !== "succeeded" || operation.stage !== "restart-pending")) {
    context.addIssue({ code: "custom", message: "needsRestart requires restart-pending success", path: ["needsRestart"] });
  }
  if (operation.stage !== "checking" && operation.targetVersion === null) {
    context.addIssue({ code: "custom", message: "targetVersion is required after checking", path: ["targetVersion"] });
  }
});

export const systemUpdateOperationPayloadSchema = z.object({
  operation: systemUpdateOperationSchema.nullable(),
}).strict();
export const systemUpdateOperationResponseSchema = apiSuccessResponseSchema(systemUpdateOperationPayloadSchema);

export const systemRestartResponseSchema = okResponseSchema;

export type AppStatusResponse = z.infer<typeof appStatusPayloadSchema>;
export type SetupStatusResponse = z.infer<typeof setupStatusPayloadSchema>;
export type PasswordResetStatusResponse = z.infer<typeof passwordResetStatusPayloadSchema>;
export type SystemDeployment = z.infer<typeof systemDeploymentSchema>;
export type SystemUpdateMode = z.infer<typeof systemUpdateModeSchema>;
export type SystemVersionResponse = z.infer<typeof systemVersionPayloadSchema>;
export type SystemUpdateOperationStatus = z.infer<typeof systemUpdateOperationStatusSchema>;
export type SystemUpdateOperationStage = z.infer<typeof systemUpdateOperationStageSchema>;
export type SystemUpdateOperation = z.infer<typeof systemUpdateOperationSchema>;
export type SystemUpdateOperationResponse = z.infer<typeof systemUpdateOperationPayloadSchema>;
export type SystemRestartResponse = z.infer<typeof okPayloadSchema>;
