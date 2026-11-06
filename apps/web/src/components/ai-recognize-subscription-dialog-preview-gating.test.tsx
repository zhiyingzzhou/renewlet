import type { ReactNode } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VirtualItem } from "@tanstack/react-virtual";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportPreviewResponse } from "@/lib/api/schemas/import-export";
import type { PreparedImport } from "@/modules/import-export/domain/import-export-model";
import {
  makeDraft,
  makePreview,
  makeResponse,
  renderDialog,
} from "./ai-recognize-subscription-dialog.test-utils";

const mocks = vi.hoisted(() => ({
  recognizeSubscriptionsStream: vi.fn(),
  previewPrepared: vi.fn(),
  resetImportPreview: vi.fn(),
  handleApply: vi.fn(),
  importPreviewPanel: vi.fn(),
  previewState: {
    prepared: null as PreparedImport | null,
    preview: null as ImportPreviewResponse | null,
  },
  nextPreview: null as ImportPreviewResponse | null,
}));

vi.mock("@/services/ai-recognition-service", () => ({
  aiRecognitionService: { recognizeSubscriptionsStream: mocks.recognizeSubscriptionsStream },
}));

vi.mock("@/modules/import-export/application/use-import-preview-apply", () => ({
  useImportPreviewApply: () => ({
    prepared: mocks.previewState.prepared,
    preview: mocks.previewState.preview,
    conflictMode: "skip",
    previewFilter: "all",
    skippedIndexes: new Set<number>(),
    error: null,
    applying: false,
    assetProgress: null,
    applyProgress: null,
    setError: vi.fn(),
    setPreviewFilter: vi.fn(),
    resetImportPreview: mocks.resetImportPreview,
    previewPrepared: mocks.previewPrepared,
    handleConflictModeChange: vi.fn(),
    handleLogoChange: vi.fn(),
    handleSkipChange: vi.fn(),
    handleApply: mocks.handleApply,
  }),
}));

vi.mock("@/components/import-preview-panel", () => ({
  ImportPreviewPanel: (props: { showImportOptions?: boolean }) => {
    mocks.importPreviewPanel(props);
    return <div data-testid="import-preview-panel" />;
  },
}));

vi.mock("@/components/ui/virtualized-list", () => ({
  VirtualizedList: ({ count, renderItem }: {
    count: number;
    renderItem: (index: number, virtualItem: VirtualItem) => ReactNode;
  }) => (
    <div>
      {Array.from({ length: count }, (_, index) => (
        <div key={index}>
          {renderItem(index, { index, key: index, start: 0, size: 112, end: 112, lane: 0 })}
        </div>
      ))}
    </div>
  ),
}));

function previewWith({ warnings = 0, errors = 0 }: { warnings?: number; errors?: number }): ImportPreviewResponse {
  const preview = makePreview();
  preview.summary.warnings = warnings;
  preview.summary.errors = errors;
  preview.items[0] = {
    ...preview.items[0]!,
    action: errors > 0 ? "error" : "create",
    warnings: warnings > 0 ? ["IMPORT_WARNING_LOW_CONFIDENCE_KEY"] : [],
    errors: errors > 0 ? ["IMPORT_SUBSCRIPTION_INVALID"] : [],
  };
  return preview;
}

async function generateDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."),
    "renewlet custom cycle",
  );
  await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));
}

describe("AIRecognizeSubscriptionDialog preview gating", () => {
  beforeEach(() => {
    mocks.recognizeSubscriptionsStream.mockReset();
    mocks.previewPrepared.mockReset();
    mocks.resetImportPreview.mockReset();
    mocks.handleApply.mockReset();
    mocks.importPreviewPanel.mockReset();
    mocks.previewState.prepared = null;
    mocks.previewState.preview = null;
    mocks.nextPreview = makePreview();
    mocks.previewPrepared.mockImplementation(async (prepared: PreparedImport) => {
      mocks.previewState.prepared = prepared;
      mocks.previewState.preview = mocks.nextPreview;
    });
  });

  it("修正 AI 的无效自定义周期后按当前 730 天预览并允许确认", async () => {
    const user = userEvent.setup();
    const response = makeResponse([makeDraft({
      billingCycle: "custom",
      customDays: null,
      customCycleUnit: null,
      website: { value: "https://www.apple.com/", source: "input" },
      warnings: ["AI_WARNING_CUSTOM_DAYS_INVALID"],
    })]);
    response.warnings = ["AI_BATCH_REVIEW_WARNING"];
    mocks.recognizeSubscriptionsStream.mockResolvedValue(response);
    renderDialog();

    await generateDraft(user);

    expect((await screen.findAllByText("自定义扣费周期必须是 1 到 3650 之间的整数")).length).toBeGreaterThan(0);
    expect(screen.queryByText("AI_BATCH_REVIEW_WARNING")).not.toBeInTheDocument();
    const previewButton = screen.getByRole("button", { name: "生成导入预览" });
    expect(previewButton).toBeDisabled();

    await user.type(screen.getByLabelText("自定义周期"), "730");
    await waitFor(() => expect(previewButton).toBeEnabled());
    await user.click(previewButton);

    expect(await screen.findByTestId("import-preview-panel")).toBeInTheDocument();
    expect(screen.queryByText("AI_BATCH_REVIEW_WARNING")).not.toBeInTheDocument();
    const prepared = mocks.previewPrepared.mock.calls[0]?.[0] as PreparedImport;
    expect(prepared.payload.subscriptions[0]).toMatchObject({
      billingCycle: "custom",
      customDays: 730,
      customCycleUnit: "day",
    });
    expect(prepared.warnings).toEqual([]);

    const confirmButton = screen.getByRole("button", { name: "确认添加" });
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);
    expect(mocks.handleApply).toHaveBeenCalledTimes(1);
  });

  it("标准预览只有 warning 时仍允许确认", async () => {
    const user = userEvent.setup();
    mocks.nextPreview = previewWith({ warnings: 1 });
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([makeDraft()]));
    renderDialog();

    await generateDraft(user);
    await user.click(await screen.findByRole("button", { name: "生成导入预览" }));

    const confirmButton = await screen.findByRole("button", { name: "确认添加" });
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);
    expect(mocks.handleApply).toHaveBeenCalledTimes(1);
  });

  it("标准预览存在 error 时继续阻止确认", async () => {
    const user = userEvent.setup();
    mocks.nextPreview = previewWith({ errors: 1 });
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([makeDraft()]));
    renderDialog();

    await generateDraft(user);
    await user.click(await screen.findByRole("button", { name: "生成导入预览" }));

    expect(await screen.findByRole("button", { name: "确认添加" })).toBeDisabled();
    expect(mocks.handleApply).not.toHaveBeenCalled();
  });

  it("AI 识别预览隐藏通用导入设置并静默使用 skip 冲突策略", async () => {
    const user = userEvent.setup();
    mocks.recognizeSubscriptionsStream.mockResolvedValue(makeResponse([makeDraft()]));
    renderDialog();

    await user.type(screen.getByPlaceholderText("粘贴记事本、备忘录或从 Excel 复制出的订阅列表..."), "apple 50刀 1年");
    await user.click(screen.getByRole("button", { name: "生成订阅草稿" }));
    await screen.findByText("Apple Music");
    await user.click(screen.getByRole("button", { name: "生成导入预览" }));

    expect(await screen.findByTestId("import-preview-panel")).toBeInTheDocument();
    const previewCall = mocks.previewPrepared.mock.calls[0];
    expect(previewCall?.[1]).toBe("skip");
    expect(previewCall?.[2]).toBeInstanceOf(AbortSignal);
    expect(mocks.importPreviewPanel).toHaveBeenLastCalledWith(expect.objectContaining({ showImportOptions: false }));
  });
});
