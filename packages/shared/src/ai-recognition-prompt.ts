/**
 * AI 识别提示词构造器是 Docker Go 与 Cloudflare Worker 的共同事实源。
 *
 * prompt JSON 记录可审阅的系统规则、字段规则和示例；运行时代码只注入用户上下文，
 * 避免两个后端各自维护一份不可对齐的提示词。
 */
import { z } from "zod";
import promptSpecJson from "../data/ai-recognition-prompt.json";

const promptExampleSchema = z.object({
  input: z.string(),
  output: z.unknown(),
}).strict();

const promptSpecSchema = z.object({
  version: z.string().min(1),
  schemaName: z.string().min(1),
  system: z.array(z.string().min(1)).min(1),
  outputContract: z.array(z.string().min(1)).min(1),
  fieldRules: z.array(z.string().min(1)).min(1),
  outputLanguages: z.record(z.string().min(1), z.object({
    label: z.string().min(1),
    nativeInstruction: z.string().min(1),
  }).strict()).refine((languages) => Boolean(languages["en-US"])),
  examples: z.array(promptExampleSchema).min(1),
}).strict();

export const aiRecognitionPromptSpec = promptSpecSchema.parse(promptSpecJson);
export const AI_RECOGNITION_PROMPT_VERSION = aiRecognitionPromptSpec.version;
export const AI_RECOGNITION_SCHEMA_NAME = aiRecognitionPromptSpec.schemaName;

/** 配置选项同时保留 value 与双语标签，让模型能优先复用用户已存在的分类/支付方式。 */
export interface AIRecognitionPromptConfigOption {
  value: string;
  label: string;
  zhCN: string;
  enUS: string;
}

/** 动态上下文只提供偏好与候选，不构成识别证据；模型不能凭这些选项虚构订阅。 */
export interface AIRecognitionPromptConfigContext {
  categories: readonly AIRecognitionPromptConfigOption[];
  paymentMethods: readonly AIRecognitionPromptConfigOption[];
  tags: readonly string[];
}

function aiRecognitionOutputLanguage(locale: string): { label: string; nativeInstruction: string } {
  return aiRecognitionPromptSpec.outputLanguages[locale] ?? aiRecognitionPromptSpec.outputLanguages["en-US"]!;
}

function aiRecognitionOutputLanguageRules(locale: string): string[] {
  const language = aiRecognitionOutputLanguage(locale);
  return [
    "Output language (authoritative):",
    `- Generated user-facing metadata must use ${language.label}.`,
    `- ${language.nativeInstruction}`,
  ];
}

/** 系统 prompt 固定来自版本化 JSON，便于 Go/Worker diagnostics 回显同一个 promptVersion。 */
export function buildAIRecognitionSystemPrompt(locale = "en-US"): string {
  const examples = aiRecognitionPromptSpec.examples.map((example, index) => [
    `Example ${index + 1} input:`,
    example.input,
    `Example ${index + 1} JSON output:`,
    JSON.stringify(example.output),
  ].join("\n")).join("\n\n");
  return [
    ...aiRecognitionPromptSpec.system,
    ...aiRecognitionOutputLanguageRules(locale),
    "Output contract:",
    ...aiRecognitionPromptSpec.outputContract.map((rule) => `- ${rule}`),
    "Field rules:",
    ...aiRecognitionPromptSpec.fieldRules.map((rule) => `- ${rule}`),
    "Examples:",
    examples,
  ].join("\n");
}

/**
 * 构造单次识别 user prompt。
 *
 * 日期、时区和现有配置都随请求注入；它们帮助模型解释输入，但不能绕过最终 schema/normalize。
 */
export function buildAIRecognitionUserPrompt({
  text,
  timezone,
  currentDate,
  imageCount,
  locale,
  configContext = { categories: [], paymentMethods: [], tags: [] },
}: {
  text: string;
  timezone: string;
  currentDate: string;
  imageCount: number;
  locale: string;
  configContext?: AIRecognitionPromptConfigContext;
}): string {
  const userInput = text.trim() || "(no text input; use attached images)";

  return [
    "Runtime context:",
    `- Current date in user's timezone: ${currentDate}`,
    `- User timezone: ${timezone}`,
    `- User locale: ${locale}`,
    `- Attached image count: ${imageCount}`,
    "",
    ...aiRecognitionOutputLanguageRules(locale),
    "- Keep service names, URLs, explicit source=input text, existing labels, and existing tags in their original form; do not translate evidence.",
    "",
    "User context:",
    "Existing user tags:",
    ...formatTagsForPrompt(configContext.tags),
    "",
    "Available Renewlet configuration options:",
    "Categories:",
    ...formatConfigOptionsForPrompt(configContext.categories),
    "Payment methods:",
    ...formatConfigOptionsForPrompt(configContext.paymentMethods),
    "",
    "Task:",
    "- Extract subscriptions from the delimited user input below and any attached images.",
    "- Treat the dynamic user context as preferences and available options, not as subscription evidence.",
    "",
    "User input:",
    "<<<renewlet-user-input",
    userInput,
    ">>>",
  ].join("\n");
}

/**
 * 对可识别但缺少长期备注的草稿执行一次受限补全。
 *
 * 补全仍由当前 provider 完成；运行面只合并返回的 notes，不会用标签、套餐、规格或地区拼接本地文案。
 */
export function buildAIRecognitionRepairUserPrompt({
  originalUserPrompt,
  previousObject,
  missingNoteNames,
  locale,
}: {
  originalUserPrompt: string;
  previousObject: unknown;
  missingNoteNames: readonly string[];
  locale: string;
}): string {
  return [
    "Repair task:",
    "- The previous JSON object is structurally valid, but some recognizable subscriptions have missing or unusable notes.",
    "- Regenerate the complete JSON object with the same output contract and preserve every existing billing fact exactly.",
    "- Only fill notes for the listed subscriptions; do not change price, currency, cycle, dates, status, category, payment method, website, tags, or warnings.",
    "- For each listed subscription, notes.value must be a concise neutral description of the official service, site, or product. Use source=suggested for that description.",
    ...aiRecognitionOutputLanguageRules(locale),
    "- Keep service names, URLs, explicit source=input text, existing labels, and existing tags in their original form; do not translate evidence.",
    "- Use the original input/images, one official web search when the provider supports it, high-confidence public knowledge, and the existing service name/website.",
    "- Do not use a hardcoded service table, local fallback, plan, price, region, route, specification, date, duration, promotion, import advice, confirmation reminder, or AI process text.",
    ...missingNoteNames.map((name) => `  - ${name}`),
    "",
    "Original recognition prompt:",
    "<<<renewlet-original-prompt",
    originalUserPrompt,
    ">>>",
    "",
    "Previous JSON object:",
    "<<<renewlet-previous-json",
    JSON.stringify(previousObject),
    ">>>",
  ].join("\n");
}

function formatTagsForPrompt(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const value = sanitizePromptContextText(tag);
    // 与 Go 运行面的配置匹配保持同一 Unicode/标点折叠，避免两端把同一标签送进不同的 prompt 上下文。
    const key = promptContextMatchKey(value);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(`- ${value}`);
    if (out.length >= 50) break;
  }
  return out.length === 0 ? ["- (none)"] : out;
}

function promptContextMatchKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-—–/\\|&+，,、.。:：()（）[\]【】]+/g, "");
}

function formatConfigOptionsForPrompt(options: readonly AIRecognitionPromptConfigOption[]): string[] {
  if (options.length === 0) return ["- (none)"];
  return options.slice(0, 50).map((option) => {
    const parts = [
      `value=${sanitizePromptContextText(option.value)}`,
      `label=${sanitizePromptContextText(option.label)}`,
      `zh-CN=${sanitizePromptContextText(option.zhCN)}`,
      `en-US=${sanitizePromptContextText(option.enUS)}`,
    ];
    return `- ${parts.join(" | ")}`;
  });
}

function sanitizePromptContextText(value: string): string {
  // 配置标签和历史标签是用户可写数据；压平成单行，避免换行把不可信文本伪装成新的 prompt 指令。
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 160).join("");
}
