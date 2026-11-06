import { describe, expect, it } from "vitest";
import {
  getAIThinkingOptions,
  aiThinkingDefaultLabelKey,
  normalizeAIModelIdForCapability,
  normalizeAIThinkingControl,
  thinkingOptionId,
} from "./model-capabilities";

describe("AI thinking capability registry", () => {
  it("exposes OpenAI reasoning efforts only for reasoning models", () => {
    // thinking 能力表直接影响请求参数；非 reasoning 模型不能出现 provider 会拒绝的 effort。
    expect(getAIThinkingOptions("openai", "openai-responses", "gpt-5.1").map((option) => option.id)).toEqual([
      "openai:none",
      "openai:minimal",
      "openai:low",
      "openai:medium",
      "openai:high",
      "openai:xhigh",
    ]);
    expect(getAIThinkingOptions("openai", "openai-responses", "gpt-5.5").map((option) => option.id)).toContain("openai:high");
    expect(getAIThinkingOptions("openai", "openai-responses", "gpt-4.1")).toEqual([]);
    expect(getAIThinkingOptions("openai", "openai-chat", "gpt-5.1")).toEqual([]);
    expect(getAIThinkingOptions("openai", "openai-responses", "gpt-6.1-sol").map((option) => option.id)).toEqual([
      "openai:low",
      "openai:medium",
      "openai:high",
      "openai:xhigh",
      "openai:max",
    ]);
    expect(getAIThinkingOptions("openai", "openai-responses", "gpt-6.1-sol").map((option) => option.id)).not.toContain("openai:none");
    // 同一代模型共享协议能力；新增 gpt-6.x 模型不需要在前端加入模型名特例。
    expect(getAIThinkingOptions("openai", "openai-responses", "gpt-6.1-terra").map((option) => option.id)).toEqual([
      "openai:low",
      "openai:medium",
      "openai:high",
      "openai:xhigh",
      "openai:max",
    ]);
    expect(getAIThinkingOptions("openai", "openai-responses", "models/gpt-6.9-new-model").map((option) => option.id)).toContain("openai:max");
    expect(getAIThinkingOptions("openai", "openai-responses", "vendor-model")).toEqual([]);
    expect(aiThinkingDefaultLabelKey("gpt-6.1-sol")).toBe("aiRecognition.thinking.modelDefault");
    expect(aiThinkingDefaultLabelKey("gpt-6.1-terra")).toBe("aiRecognition.thinking.modelDefault");
  });

  it("uses level controls for Gemini 3 and budget controls for Gemini 2.5", () => {
    // Gemini 模型 id 可能带 models/ 前缀，能力判断必须在标准化后保持同一口径。
    expect(normalizeAIModelIdForCapability(" models/gemini-2.5-pro ")).toBe("gemini-2.5-pro");
    expect(getAIThinkingOptions("gemini", "gemini-generate-content", "gemini-3-flash").map((option) => option.id)).toEqual([
      "gemini:level:minimal",
      "gemini:level:low",
      "gemini:level:medium",
      "gemini:level:high",
    ]);
    expect(getAIThinkingOptions("gemini", "gemini-generate-content", "gemini-3.1-pro").map((option) => option.id)).toEqual([
      "gemini:level:minimal",
      "gemini:level:low",
      "gemini:level:medium",
      "gemini:level:high",
    ]);
    expect(getAIThinkingOptions("gemini", "gemini-generate-content", "models/gemini-2.5-pro").map((option) => option.id)).toEqual([
      "gemini:budget:1024",
      "gemini:budget:4096",
      "gemini:budget:8192",
    ]);
    expect(getAIThinkingOptions("gemini", "gemini-generate-content", "gemini-2.5-flash").map((option) => option.id)).toEqual([
      "gemini:off",
      "gemini:dynamic",
      "gemini:budget:1024",
      "gemini:budget:4096",
      "gemini:budget:8192",
    ]);
  });

  it("keeps Claude effort and legacy budget controls separate", () => {
    expect(getAIThinkingOptions("anthropic", "anthropic-messages", "claude-sonnet-4-6").map((option) => option.id)).toEqual([
      "anthropic:effort:low",
      "anthropic:effort:medium",
      "anthropic:effort:high",
      "anthropic:effort:max",
    ]);
    expect(getAIThinkingOptions("anthropic", "anthropic-messages", "claude-opus-4-8").map((option) => option.id)).toEqual([
      "anthropic:effort:low",
      "anthropic:effort:medium",
      "anthropic:effort:high",
      "anthropic:effort:xhigh",
      "anthropic:effort:max",
    ]);
    expect(getAIThinkingOptions("anthropic", "anthropic-messages", "claude-3-7-sonnet-latest").map((option) => option.id)).toEqual([
      "anthropic:budget:1024",
      "anthropic:budget:4096",
      "anthropic:budget:8192",
    ]);
  });

  it("drops thinking controls that do not match the current provider or model", () => {
    // 设置页保存的是上一次选择，切换 provider/model 后必须丢弃不兼容 control。
    expect(normalizeAIThinkingControl("openai", "openai-responses", "gpt-5.1", { provider: "gemini", mode: "off" })).toBeNull();
    expect(normalizeAIThinkingControl("openai", "openai-responses", "gpt-4.1", { provider: "openai", effort: "high" })).toBeNull();
    expect(normalizeAIThinkingControl("gemini", "gemini-generate-content", "gemini-2.5-pro", { provider: "gemini", mode: "off" })).toBeNull();
    expect(thinkingOptionId(normalizeAIThinkingControl("openai", "openai-responses", "gpt-5.1", { provider: "openai", effort: "high" }))).toBe("openai:high");
    expect(normalizeAIThinkingControl("openai", "openai-chat", "gpt-5.1", { provider: "openai", effort: "high" })).toBeNull();
  });

  it("does not expose thinking controls for OpenAI compatible models", () => {
    expect(getAIThinkingOptions("openai-compatible", "openai-chat", "gpt-5-compatible")).toEqual([]);
    expect(normalizeAIThinkingControl("openai-compatible", "openai-chat", "gpt-5-compatible", { provider: "openai", effort: "high" })).toBeNull();
  });
});
