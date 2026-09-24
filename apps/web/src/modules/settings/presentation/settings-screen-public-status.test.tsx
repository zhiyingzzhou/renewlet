import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createControllerState,
  createSettingsReadState,
  createUploadedAssetsManagerState,
  mocks,
  renderSettingsScreen,
} from "./settings-screen.test-utils";

describe("SettingsScreen public status read state", () => {
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
  });

  it("does not report public status as disabled when the first read fails", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const controller = createControllerState();
    controller.publicStatusPage.status = createSettingsReadState<NonNullable<typeof controller.publicStatusPage.status.data>>(
      undefined,
      { error: new Error("status unavailable"), retry },
    );
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    const section = document.getElementById("settings-public-status") as HTMLElement;
    expect(within(section).getByText("状态未知")).toBeInTheDocument();
    expect(within(section).getByText("加载失败")).toBeInTheDocument();
    expect(within(section).queryByText("未启用")).not.toBeInTheDocument();
    expect(within(section).queryByLabelText("公开展示 URL")).not.toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps the cached public URL visible when refresh fails", () => {
    const controller = createControllerState();
    controller.publicStatusPage.status = createSettingsReadState({
      enabled: true,
      pageUrl: "https://example.com/status/cached-secret",
      showPrices: false,
      hideExpired: false,
      hideLifetime: false,
    }, { error: new Error("refresh failed") });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    const section = document.getElementById("settings-public-status") as HTMLElement;
    expect(within(section).getAllByText("未更新")).toHaveLength(2);
    expect(within(section).getByLabelText("公开展示 URL")).toHaveValue("https://example.com/status/cached-secret");
    expect(within(section).queryByText("未启用")).not.toBeInTheDocument();
  });

  it("requests one quick bulk preview and one apply command", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      publicStatusPage: {
        enabled: true,
        pageUrl: "https://example.com/status/cached-secret",
        expiredCount: 3,
        lifetimeCount: 2,
      },
    });
    const bulkPublicVisibility = vi.fn().mockResolvedValue({ matchedCount: 3, changedCount: 3 });
    controller.publicStatusPage.bulkPublicVisibility = bulkPublicVisibility;
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    const section = document.getElementById("settings-public-status") as HTMLElement;
    await user.click(within(section).getByRole("button", { name: "快速批量编辑" }));
    await waitFor(() => expect(bulkPublicVisibility).toHaveBeenCalledTimes(1));
    expect(bulkPublicVisibility).toHaveBeenCalledWith(["expired", "lifetime"], true, true);

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(bulkPublicVisibility).toHaveBeenCalledTimes(2));
    expect(bulkPublicVisibility).toHaveBeenLastCalledWith(["expired", "lifetime"], true);
  });
});
