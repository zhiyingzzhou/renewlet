import { render } from "@testing-library/react";
import { useCallback, useState } from "react";
import { expect, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useNestedDialogCloseGuard } from "@/hooks/use-nested-dialog-close-guard";
import { cn } from "@/lib/utils";
import type { AiRecognizedSubscriptionDraft, AiRecognizeResponse } from "@/lib/api/schemas/ai-recognition";
import type { ImportPreviewResponse } from "@/lib/api/schemas/import-export";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/subscription";
import {
  AIRecognizeSubscriptionDialogContent,
  type AIRecognizeSubscriptionDialogProps,
} from "./ai-recognize-subscription-dialog";

function AIRecognizeSubscriptionDialog(props: AIRecognizeSubscriptionDialogProps) {
  const isMobile = useMediaQuery("(max-width: 639px)");
  const [workflowExpanded, setWorkflowExpanded] = useState(false);
  const { handleNestedDialogOpenChange, handleParentOpenChange } = useNestedDialogCloseGuard(
    props.open,
    props.onOpenChange,
  );
  const handleRequestClose = useCallback(() => handleParentOpenChange(false), [handleParentOpenChange]);

  return (
    <Dialog open={props.open} onOpenChange={handleParentOpenChange}>
      <DialogContent
        dismissMode="explicit"
        layout="frame"
        closeLabel="关闭"
        className={cn(
          "overflow-hidden border-border bg-card p-0",
          isMobile
            ? "h5-ai-recognition-workbench-frame"
            : cn(
              "h5-import-dialog-panel sm:max-w-6xl",
              workflowExpanded ? "h5-dialog-frame" : "h5-ai-recognition-input-dialog-frame",
            ),
        )}
      >
        <AIRecognizeSubscriptionDialogContent
          open={props.open}
          settings={props.settings}
          apiKeyConfigured={props.apiKeyConfigured}
          config={props.config}
          availableTags={props.availableTags}
          onNestedDialogOpenChange={handleNestedDialogOpenChange}
          onRequestClose={handleRequestClose}
          onWorkflowExpandedChange={setWorkflowExpanded}
        />
      </DialogContent>
    </Dialog>
  );
}

// 测试设置固定为“已配置 provider”，让用例聚焦 AI 弹层状态机而不是设置就绪态。
export function configuredSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    aiRecognition: {
      providerType: "openai",
      transportProtocol: "openai-responses",
      model: "gpt-5-mini",
      modelInputMode: "select",
      baseUrl: "",
      apiKey: "sk-test",
      defaultThinkingControl: null,
    },
  };
}

export function makeDraft(overrides: Partial<AiRecognizedSubscriptionDraft> = {}): AiRecognizedSubscriptionDraft {
  return {
    name: "Apple Music",
    price: "50",
    currency: "USD",
    billingCycle: "annual",
    customDays: null,
    customCycleUnit: null,
    oneTimeTermCount: null,
    oneTimeTermUnit: null,
    category: "music",
    status: "active",
    paymentMethod: "alipay",
    startDate: "2026-01-01",
    nextBillingDate: "2027-01-01",
    autoCalculateNextBillingDate: true,
    trialEndDate: null,
    website: { value: "https://www.apple.com/", source: "suggested" },
    notes: { value: "Apple subscription, service needs user confirmation.", source: "suggested" },
    tags: ["Apple", "Music"],
    reminderDays: null,
    repeatReminderEnabled: null,
    repeatReminderInterval: null,
    repeatReminderWindow: null,
    confidence: "high",
    warnings: [],
    ...overrides,
  };
}

export function makeResponse(subscriptions: AiRecognizedSubscriptionDraft[]): AiRecognizeResponse {
  return {
    providerType: "openai",
    transportProtocol: "openai-responses",
    model: "gpt-5-mini",
    subscriptions,
    warnings: [],
    // diagnostics 在成功响应里只做当前请求排障，测试 fixture 不应被导入 preview/apply 断言消费。
    diagnostics: {
      schemaVersion: "1",
      promptVersion: "test",
      schemaName: "test",
      prompt: {
        system: { value: "", truncated: false },
        user: { value: "", truncated: false },
      },
      output: {
        rawModelText: null,
        rawObjectJson: null,
      },
      request: {
        providerType: "openai",
        transportProtocol: "openai-responses",
        model: "gpt-5-mini",
        thinkingControl: null,
        maxOutputTokens: 4096,
        textCharCount: 0,
        images: [],
      },
      response: {
        usage: null,
        finishReason: null,
        providerMetadata: null,
      },
    },
  };
}

export function makePreview(): ImportPreviewResponse {
  return {
    summary: {
      total: 1,
      creates: 1,
      replaces: 0,
      skips: 0,
      errors: 0,
      warnings: 0,
    },
    items: [
      {
        index: 0,
        name: "Apple Music",
        source: "ai",
        sourceId: "apple-music",
        action: "create",
        warnings: [],
        errors: [],
      },
    ],
    includesSettings: false,
    includesCustomConfig: false,
    includesExchangeRateSnapshots: false,
    exchangeRateSnapshotsCount: 0,
  };
}

export function renderDialog(settings: AppSettings = configuredSettings(), onOpenChange = vi.fn()) {
  return {
    onOpenChange,
    ...render(
      <TooltipProvider delayDuration={0}>
        <AIRecognizeSubscriptionDialog
          open
          onOpenChange={onOpenChange}
          settings={settings}
          config={DEFAULT_CUSTOM_CONFIG}
          availableTags={["Work", "Streaming"]}
        />
      </TooltipProvider>,
    ),
  };
}

export function expectRecognizeStreamCalledWith(
  calls: readonly (readonly unknown[])[],
  input: { text: string; images: File[]; thinkingControl: unknown },
) {
  const call = calls.at(-1);
  expect(call?.[0]).toEqual(input);

  const handlers = call?.[1];
  if (!handlers || typeof handlers !== "object" || !("onEvent" in handlers)) {
    throw new Error("Expected recognition stream handlers");
  }
  expect(handlers.onEvent).toBeTypeOf("function");

  const options = call?.[2];
  if (!options || typeof options !== "object" || !("signal" in options)) {
    throw new Error("Expected recognition stream options");
  }
  expect(options.signal).toBeInstanceOf(AbortSignal);
}

export function mockMobile(matches = true) {
  // AI 弹层在 H5 下换成 workbench 布局，测试通过 matchMedia 明确锁定移动端分支。
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 639px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

export function clipboardDataWithItems(items: Array<{ file: File; kind?: string; type?: string }>): DataTransfer {
  // 粘贴图片走 DataTransferItem.getAsFile；直接 files 数组覆盖不了该浏览器路径。
  return {
    items: items.map(({ file, kind = "file", type = file.type }) => ({
      kind,
      type,
      getAsFile: () => file,
    })),
    files: [],
  } as unknown as DataTransfer;
}

export function clipboardDataWithFiles(files: File[]): DataTransfer {
  return {
    items: [],
    files,
  } as unknown as DataTransfer;
}
