import type { MessageKey } from "@/i18n/messages";
import type {
  AiRecognitionProviderType,
  AiRecognitionTransportProtocol,
  AiThinkingControl,
} from "@/lib/api/schemas/ai-recognition";
import { openAIReasoningEffortsForModel } from "@renewlet/shared/schemas/ai-recognition";

export interface AIThinkingOption {
  id: string;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  control: AiThinkingControl | null;
}

// provider-specific UI 选项只描述协议形状；OpenAI effort 代际规则由 shared 事实源提供，避免前端维护模型名特例。
const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const GEMINI_LEVELS = ["minimal", "low", "medium", "high"] as const;
const GEMINI_BUDGETS = [1024, 4096, 8192] as const;
const CLAUDE_BUDGETS = [1024, 4096, 8192] as const;

export function getAIThinkingOptions(
  providerType: AiRecognitionProviderType,
  transportProtocol: AiRecognitionTransportProtocol,
  model: string,
): AIThinkingOption[] {
  const normalizedModel = normalizeAIModelIdForCapability(model);
  if (!normalizedModel) return [];
  // transport protocol 是真实 API 形状边界，同一 provider 在兼容协议下不能复用原生 thinking 参数。
  if (providerType === "openai" && transportProtocol === "openai-responses") return getOpenAIThinkingOptions(normalizedModel);
  if (providerType === "gemini" && transportProtocol === "gemini-generate-content") return getGeminiThinkingOptions(normalizedModel);
  if (providerType === "anthropic" && transportProtocol === "anthropic-messages") return getAnthropicThinkingOptions(normalizedModel);
  return [];
}

export function normalizeAIModelIdForCapability(model: string): string {
  return model.trim().toLowerCase().replace(/^models\//, "");
}

export function normalizeAIThinkingControl(
  providerType: AiRecognitionProviderType,
  transportProtocol: AiRecognitionTransportProtocol,
  model: string,
  control: AiThinkingControl | null,
): AiThinkingControl | null {
  // 设置里保存的是上一次模型的 control；切换 provider/model 后必须在读取边界丢弃不兼容值。
  if (!control || !thinkingControlMatchesProvider(providerType, transportProtocol, control)) return null;
  const options = getAIThinkingOptions(providerType, transportProtocol, model);
  return options.some((option) => option.control && thinkingOptionId(option.control) === thinkingOptionId(control))
    ? control
    : null;
}

export function defaultAIThinkingControl(
  providerType: AiRecognitionProviderType,
  transportProtocol: AiRecognitionTransportProtocol,
  model: string,
): AiThinkingControl | null {
  return getAIThinkingOptions(providerType, transportProtocol, model)[0]?.control ?? null;
}

export function aiThinkingDefaultLabelKey(_model: string): "aiRecognition.thinking.modelDefault" {
  return "aiRecognition.thinking.modelDefault";
}

export function thinkingOptionId(control: AiThinkingControl | null): string {
  if (!control) return "off";
  // id 必须编码 provider 维度，防止不同 provider 的 budget/effort 文案选项在 Select 中撞值。
  if (control.provider === "openai") return `openai:${control.effort}`;
  if (control.provider === "gemini") {
    if (control.mode === "budget") return `gemini:budget:${control.budget ?? ""}`;
    if (control.mode === "level") return `gemini:level:${control.level ?? ""}`;
    return `gemini:${control.mode}`;
  }
  if (control.mode === "budget") return `anthropic:budget:${control.budgetTokens ?? ""}`;
  return `anthropic:effort:${control.effort ?? ""}`;
}

export function thinkingControlFromOptionId(options: readonly AIThinkingOption[], id: string): AiThinkingControl | null {
  return options.find((option) => option.id === id)?.control ?? null;
}

function thinkingControlMatchesProvider(
  providerType: AiRecognitionProviderType,
  transportProtocol: AiRecognitionTransportProtocol,
  control: AiThinkingControl,
): boolean {
  if (providerType === "openai" && transportProtocol === "openai-responses") return control.provider === "openai";
  if (providerType === "gemini" && transportProtocol === "gemini-generate-content") return control.provider === "gemini";
  if (providerType === "anthropic" && transportProtocol === "anthropic-messages") return control.provider === "anthropic";
  return false;
}

function getOpenAIThinkingOptions(model: string): AIThinkingOption[] {
  const efforts = openAIReasoningEffortsForModel(model);
  if (!efforts) return [];
  return efforts.map((effort) => ({
    id: `openai:${effort}`,
    labelKey: `aiRecognition.thinking.openai.${effort}` as MessageKey,
    descriptionKey: `aiRecognition.thinking.openai.${effort}.description` as MessageKey,
    control: { provider: "openai", effort },
  }));
}

function getGeminiThinkingOptions(model: string): AIThinkingOption[] {
  if (isGeminiLevelModel(model)) {
    return GEMINI_LEVELS.map((level) => ({
      id: `gemini:level:${level}`,
      labelKey: `aiRecognition.thinking.gemini.level.${level}` as MessageKey,
      descriptionKey: `aiRecognition.thinking.gemini.level.${level}.description` as MessageKey,
      control: { provider: "gemini", mode: "level", level },
    }));
  }
  if (!isGeminiBudgetModel(model)) return [];
  const budgetOptions = GEMINI_BUDGETS.map((budget) => ({
    id: `gemini:budget:${budget}`,
    labelKey: `aiRecognition.thinking.budget.${budget}` as MessageKey,
    descriptionKey: "aiRecognition.thinking.gemini.budget.description" as MessageKey,
    control: { provider: "gemini" as const, mode: "budget" as const, budget },
  }));
  if (!isGeminiBudgetToggleModel(model)) return budgetOptions;
  // Gemini 2.5 flash 系列同时支持关闭/动态/预算，顺序决定设置页默认项和回显稳定性。
  return [
    {
      id: "gemini:off",
      labelKey: "aiRecognition.thinking.off",
      descriptionKey: "aiRecognition.thinking.gemini.off.description",
      control: { provider: "gemini", mode: "off" },
    },
    {
      id: "gemini:dynamic",
      labelKey: "aiRecognition.thinking.gemini.dynamic",
      descriptionKey: "aiRecognition.thinking.gemini.dynamic.description",
      control: { provider: "gemini", mode: "dynamic" },
    },
    ...budgetOptions,
  ];
}

function getAnthropicThinkingOptions(model: string): AIThinkingOption[] {
  const efforts = claudeEffortsForModel(model);
  if (efforts.length > 0) {
    return efforts.map((effort) => ({
      id: `anthropic:effort:${effort}`,
      labelKey: `aiRecognition.thinking.anthropic.${effort}` as MessageKey,
      descriptionKey: `aiRecognition.thinking.anthropic.${effort}.description` as MessageKey,
      control: { provider: "anthropic", mode: "effort", effort },
    }));
  }
  if (!isClaudeBudgetModel(model)) return [];
  return CLAUDE_BUDGETS.map((budgetTokens) => ({
    id: `anthropic:budget:${budgetTokens}`,
    labelKey: `aiRecognition.thinking.budget.${budgetTokens}` as MessageKey,
    descriptionKey: "aiRecognition.thinking.anthropic.budget.description" as MessageKey,
    control: { provider: "anthropic", mode: "budget", budgetTokens },
  }));
}

function isGeminiLevelModel(model: string): boolean {
  return /^gemini-(?:3|3\.1|3\.5)(?:-|$)/.test(model);
}

function isGeminiBudgetModel(model: string): boolean {
  return /^gemini-2\.5(?:-|$)/.test(model);
}

function isGeminiBudgetToggleModel(model: string): boolean {
  return /^gemini-2\.5-(?:flash|flash-lite)(?:-|$)/.test(model);
}

function claudeEffortsForModel(model: string): typeof ANTHROPIC_EFFORTS[number][] {
  const match = /^claude-(opus|sonnet|haiku)-4-(\d+)(?:-|$)/.exec(model);
  if (!match) return [];
  const family = match[1];
  const minor = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(minor) || minor < 6) return [];
  const base: typeof ANTHROPIC_EFFORTS[number][] = ["low", "medium", "high", "max"];
  if (family === "opus" && minor >= 7) {
    // xhigh 目前只对高阶 opus 4.7+ 暴露，避免给其它 Claude 4 模型展示 provider 会拒绝的选项。
    return ["low", "medium", "high", "xhigh", "max"];
  }
  return base;
}

function isClaudeBudgetModel(model: string): boolean {
  return /^claude-3-7/.test(model);
}
