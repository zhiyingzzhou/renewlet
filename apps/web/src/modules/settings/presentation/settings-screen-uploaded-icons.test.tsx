import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedAsset } from "@/lib/api/schemas/media";
import {
  createControllerState,
  createSettingsReadState,
  createUploadedAssetsManagerState,
  mocks,
  renderSettingsScreen,
} from "./settings-screen.test-utils";

// 管理页验证列表与删除结果，私有图片下载不应影响这些交互测试。
vi.mock("@/components/authorized-image", () => ({
  AuthorizedImage: ({ alt, ...props }: ComponentProps<"img">) => <img alt={alt} {...props} />,
}));

describe("SettingsScreen uploaded icon management", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    mocks.useSettingsFormController.mockReturnValue(createControllerState());
    mocks.useUploadedAssetsManager.mockReturnValue(createUploadedAssetsManagerState());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("keeps uploaded icon management behind a compact settings entry", async () => {
    const user = userEvent.setup();
    const deleteAsset = vi.fn().mockResolvedValue(true);
    const loadMore = vi.fn().mockResolvedValue(undefined);
    mocks.useUploadedAssetsManager.mockReturnValue(createUploadedAssetsManagerState({
      logo: {
        readState: createSettingsReadState(Array.from({ length: 4 }, (_, index) => ({
          id: `asset-logo-${index + 1}`,
          url: `/api/app/assets/asset-logo-${index + 1}`,
          kind: "logo" as const,
          originalName: `logo-${index + 1}.png`,
          mimeType: "image/png",
          sizeBytes: 2048 + index,
          updated: "2026-06-15T08:30:00.000Z",
        }))),
        hasMore: true,
        isLoadingMore: false,
        loadMore,
      },
      icon: {
        readState: createSettingsReadState([{
          id: "asset-icon",
          url: "/api/app/assets/asset-icon",
          kind: "icon",
          originalName: "server.svg",
          mimeType: "image/svg+xml",
          sizeBytes: 1024,
          updated: "2026-06-15T09:30:00.000Z",
        }]),
        hasMore: false,
        isLoadingMore: false,
        loadMore: vi.fn().mockResolvedValue(undefined),
      },
      deleteAsset,
    }));

    renderSettingsScreen();

    const section = document.getElementById("settings-uploaded-icons");
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getByText("上传图标")).toBeInTheDocument();
    expect(within(section as HTMLElement).getByText("订阅 Logo 4 · 支付方式 1")).toBeInTheDocument();
    expect(within(section as HTMLElement).queryByRole("button", { name: "刷新" })).not.toBeInTheDocument();
    expect(within(section as HTMLElement).getByRole("button", { name: "管理上传图标" })).toBeInTheDocument();
    expect(within(section as HTMLElement).queryByText("logo-1.png")).not.toBeInTheDocument();
    expect(within(section as HTMLElement).queryByText("logo-2.png")).not.toBeInTheDocument();
    expect(within(section as HTMLElement).queryByText("logo-3.png")).not.toBeInTheDocument();
    expect(within(section as HTMLElement).queryByText("logo-4.png")).not.toBeInTheDocument();
    expect(within(section as HTMLElement).queryByText("server.svg")).not.toBeInTheDocument();
    expect(within(section as HTMLElement).queryByText("还没有上传过订阅 Logo")).not.toBeInTheDocument();
    expect(within(section as HTMLElement).queryByText("还没有上传过支付方式图标")).not.toBeInTheDocument();
    expect(within(section as HTMLElement).queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
    expect(within(section as HTMLElement).queryByRole("button", { name: /^删除/ })).not.toBeInTheDocument();

    await user.click(within(section as HTMLElement).getByRole("button", { name: "管理上传图标" }));
    const manager = await screen.findByRole("dialog", { name: "管理上传图标" });
    expect(manager).toHaveClass("overflow-hidden", "bg-card");
    expect(within(manager).getByRole("tab", { name: "订阅 Logo" })).toHaveAttribute("aria-selected", "true");
    expect(within(manager).getByRole("tab", { name: "支付方式图标" })).toBeInTheDocument();
    expect(within(manager).getByText("logo-1.png")).toBeInTheDocument();
    expect(within(manager).getByText("logo-4.png")).toBeInTheDocument();
    await user.click(within(manager).getByRole("button", { name: "加载更多" }));
    expect(loadMore).toHaveBeenCalled();

    await user.click(within(manager).getByRole("button", { name: "删除 logo-1.png" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除上传图标？" });
    expect(within(dialog).getByText("logo-1.png")).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "删除" });
    expect(confirm).toHaveClass("bg-destructive");
    await user.click(confirm);

    expect(deleteAsset).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-logo-1" }));
  });

  it("keeps the uploaded icon delete dialog open when the icon is still referenced", async () => {
    const user = userEvent.setup();
    const deleteAsset = vi.fn().mockResolvedValue(false);
    mocks.useUploadedAssetsManager.mockReturnValue(createUploadedAssetsManagerState({
      logo: {
        readState: createSettingsReadState([{
          id: "asset-used",
          url: "/api/app/assets/asset-used",
          kind: "logo",
          originalName: "used.png",
        }]),
        hasMore: false,
        isLoadingMore: false,
        loadMore: vi.fn().mockResolvedValue(undefined),
      },
      deleteError: {
        assetId: "asset-used",
        message: "仍被 2 个订阅使用，请先到订阅里换掉 Logo。",
      },
      deleteAsset,
    }));

    renderSettingsScreen();
    const section = document.getElementById("settings-uploaded-icons") as HTMLElement;
    expect(within(section).queryByText("used.png")).not.toBeInTheDocument();
    expect(within(section).queryByText("仍被 2 个订阅使用，请先到订阅里换掉 Logo。")).not.toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "管理上传图标" }));
    const manager = await screen.findByRole("dialog", { name: "管理上传图标" });
    expect(within(manager).getByText("used.png")).toBeInTheDocument();
    expect(within(manager).getByText("仍被 2 个订阅使用，请先到订阅里换掉 Logo。")).toBeInTheDocument();
    await user.click(within(manager).getByRole("button", { name: "删除 used.png" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "删除上传图标？" })).getByRole("button", { name: "删除" }));

    expect(deleteAsset).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-used" }));
    expect(screen.getByRole("alertdialog", { name: "删除上传图标？" })).toBeInTheDocument();
  });

  it("keeps payment method referenced icons in the dialog with a payment-method hint", async () => {
    const user = userEvent.setup();
    const deleteAsset = vi.fn().mockResolvedValue(false);
    mocks.useUploadedAssetsManager.mockReturnValue(createUploadedAssetsManagerState({
      icon: {
        readState: createSettingsReadState([{
          id: "asset-payment",
          url: "/api/app/assets/asset-payment",
          kind: "icon",
          originalName: "card.svg",
        }]),
        hasMore: false,
        isLoadingMore: false,
        loadMore: vi.fn().mockResolvedValue(undefined),
      },
      deleteError: {
        assetId: "asset-payment",
        message: "仍被 1 个支付方式使用，请先到支付方式管理里换掉图标。",
      },
      deleteAsset,
    }));

    renderSettingsScreen();
    const section = document.getElementById("settings-uploaded-icons") as HTMLElement;
    expect(within(section).queryByText("card.svg")).not.toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "管理上传图标" }));
    const manager = await screen.findByRole("dialog", { name: "管理上传图标" });
    await user.click(within(manager).getByRole("tab", { name: "支付方式图标" }));
    expect(within(manager).getByText("card.svg")).toBeInTheDocument();
    expect(within(manager).getByText("仍被 1 个支付方式使用，请先到支付方式管理里换掉图标。")).toBeInTheDocument();
    await user.click(within(manager).getByRole("button", { name: "删除 card.svg" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "删除上传图标？" })).getByRole("button", { name: "删除" }));

    expect(deleteAsset).toHaveBeenCalledWith(expect.objectContaining({ id: "asset-payment" }));
    expect(screen.getByRole("alertdialog", { name: "删除上传图标？" })).toBeInTheDocument();
  });

  it("does not show an empty Logo state when the first asset read fails", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    mocks.useUploadedAssetsManager.mockReturnValue(createUploadedAssetsManagerState({
      logo: {
        readState: createSettingsReadState<UploadedAsset[]>(undefined, {
          error: new Error("asset list unavailable"),
          retry,
        }),
      },
    }));

    renderSettingsScreen();

    const section = document.getElementById("settings-uploaded-icons") as HTMLElement;
    expect(within(section).getByText("状态未知")).toBeInTheDocument();
    expect(within(section).queryByText(/订阅 Logo 0/)).not.toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "管理上传图标" }));
    const manager = await screen.findByRole("dialog", { name: "管理上传图标" });
    expect(within(manager).getByText("加载失败")).toBeInTheDocument();
    expect(within(manager).queryByText("还没有上传过订阅 Logo")).not.toBeInTheDocument();

    await user.click(within(manager).getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps cached uploaded assets visible when refresh fails", async () => {
    const user = userEvent.setup();
    mocks.useUploadedAssetsManager.mockReturnValue(createUploadedAssetsManagerState({
      logo: {
        readState: createSettingsReadState<UploadedAsset[]>([{
          id: "asset-cached",
          url: "/api/app/assets/asset-cached",
          kind: "logo",
          originalName: "cached.png",
        }], { error: new Error("refresh failed") }),
      },
    }));

    renderSettingsScreen();

    const section = document.getElementById("settings-uploaded-icons") as HTMLElement;
    expect(within(section).getByText("订阅 Logo 1 · 支付方式 0 · 未更新")).toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "管理上传图标" }));
    const manager = await screen.findByRole("dialog", { name: "管理上传图标" });
    expect(within(manager).getByText("未更新")).toBeInTheDocument();
    expect(within(manager).getByText("cached.png")).toBeInTheDocument();
    expect(within(manager).queryByText("还没有上传过订阅 Logo")).not.toBeInTheDocument();
  });
});
