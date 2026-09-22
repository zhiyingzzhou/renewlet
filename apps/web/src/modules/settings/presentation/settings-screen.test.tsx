// SettingsScreen 测试保护设置页分区装配、H5 布局契约和 Cloudflare/Docker 差异入口，不验证普通控件细节样式。
import { useState } from "react";
import { render, screen, waitFor, waitForElementToBeRemoved, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import {
  WEBHOOK_HEADERS_PLACEHOLDER,
  WEBHOOK_PAYLOAD_PLACEHOLDER,
} from "@/types/subscription";
import {
  createCalendarFeedControllerState,
  createControllerState,
  createUploadedAssetsManagerState,
  mocks,
  renderSettingsScreen,
  SETTINGS_SECTION_IDS,
  StatefulEmailNotificationPanel,
  useStatefulMonthlyBudgetController,
} from "./settings-screen.test-utils";

function useStatefulPublicStatusController() {
  const [pageUrl, setPageUrl] = useState<string | null>("https://example.com/status/secret");
  const controller = createControllerState({
    publicStatusPage: { enabled: pageUrl !== null, pageUrl, showPrices: true, hideExpired: false, hideLifetime: false, visibleCount: 3, hiddenCount: 1, expiredCount: 0, lifetimeCount: 0 },
  });
  controller.publicStatusPage.revoke = vi.fn(async () => {
    setPageUrl(null);
    return true;
  });
  return controller;
}

describe("SettingsScreen SMTP email settings", () => {
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
    mocks.useCalendarFeedSettingsController.mockReturnValue(createCalendarFeedControllerState());
    mocks.useUploadedAssetsManager.mockReturnValue(createUploadedAssetsManagerState());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("renders SMTP fields instead of Resend fields for email notifications", () => {
    renderSettingsScreen();
    const notificationsSection = document.getElementById("settings-notifications");

    expect(screen.queryByText(/Resend/i)).not.toBeInTheDocument();
    expect(notificationsSection).not.toBeNull();
    expect(within(notificationsSection as HTMLElement).queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(screen.getByLabelText("SMTP 服务器")).toHaveValue("smtp.example.com");
    const smtpPortInput = screen.getByLabelText("SMTP 端口");
    expect(smtpPortInput).toHaveValue("587");
    expect(smtpPortInput).toHaveAttribute("type", "text");
    expect(smtpPortInput).toHaveAttribute("inputmode", "numeric");
    expect(screen.queryByRole("spinbutton", { name: "SMTP 端口" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("SMTP 用户名")).toHaveValue("smtp-user");
    expect(screen.getByLabelText("SMTP 密码")).toHaveValue("smtp-password");
    expect(screen.getByLabelText("发件人")).toHaveValue("Renewlet <noreply@example.com>");
    expect(screen.getByLabelText("回复地址")).toHaveValue("support@example.com");
    expect(screen.getByRole("button", { name: "测试邮件通知" })).toBeInTheDocument();
  });

  it("disables external integration controls in demo mode while keeping ordinary settings editable", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      externalIntegrationsDisabled: true,
      sensitiveAccountActionsDisabled: true,
      sensitiveAccountActionsDemoDisabled: true,
    }));
    renderSettingsScreen();

    expect(screen.getByRole("button", { name: "修改密码" })).toBeDisabled();
    expect(screen.getByText("演示模式仅供浏览，不能修改身份验证器或通行密钥。")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: /身份验证器/ })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "管理通行密钥" })).toBeDisabled();
    expect(screen.getByLabelText("SMTP 服务器")).toBeDisabled();
    expect(screen.getByLabelText("SMTP 端口")).toBeDisabled();
    expect(screen.getByLabelText("收件人邮箱")).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试邮件通知" })).toBeDisabled();
    expect(screen.getByLabelText("第三方 API 测试号码")).toBeDisabled();
    expect(screen.getByLabelText("Base URL")).toBeDisabled();
    expect(screen.getByLabelText("API Key")).toBeDisabled();
    for (const button of screen.getAllByRole("button", { name: "测试连接" })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "立即备份" })).toBeDisabled();
    expect(screen.getByLabelText("月度预算金额")).toBeEnabled();
  });

  it("keeps the SMTP port as a bounded NumericInput string", async () => {
    const user = userEvent.setup();
    render(<StatefulEmailNotificationPanel />);

    const input = screen.getByLabelText("SMTP 端口") as HTMLInputElement;
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(screen.queryByRole("spinbutton", { name: "SMTP 端口" })).not.toBeInTheDocument();

    await user.type(input, "587");
    expect(input).toHaveValue("587");

    await user.clear(input);
    expect(input).toHaveValue("");

    await user.type(input, "0");
    expect(input).toHaveValue("");

    await user.type(input, "65535");
    expect(input).toHaveValue("65535");

    await user.clear(input);
    await user.type(input, "65536");
    expect(input).not.toHaveValue("65536");

    await user.clear(input);
    await user.type(input, "01");
    expect(input).toHaveValue("1");

    await user.clear(input);
    await user.type(input, "-1.5e3");
    expect(input.value).not.toMatch(/[.\-eE]/);
  });

  it("shows admin account links for Docker admins", () => {
    renderSettingsScreen();

    expect(screen.getByRole("link", { name: "管理用户" })).toHaveAttribute("href", "/admin/users");
    const link = screen.getByRole("link", { name: "PocketBase 后台" });
    expect(link).toHaveAttribute("href", "/_/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("uses client routing for account page links", async () => {
    const user = userEvent.setup();
    renderSettingsScreen();

    expect(screen.getByTestId("route-path")).toHaveTextContent("/settings");

    await user.click(screen.getByRole("link", { name: "管理用户" }));
    expect(screen.getByTestId("route-path")).toHaveTextContent("/admin/users");

    await user.click(screen.getByRole("link", { name: "忘记密码？" }));
    expect(screen.getByTestId("route-path")).toHaveTextContent("/forgot-password");
  });

  it("hides admin-only account links for non-admin users", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      canManageUsers: false,
      canAccessPocketBaseAdmin: false,
      authSecurity: { canManage: false },
    }));

    renderSettingsScreen();

    expect(screen.queryByRole("link", { name: "管理用户" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "PocketBase 后台" })).not.toBeInTheDocument();
    expect(document.getElementById("settings-access-security")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Cloudflare Turnstile" })).not.toBeInTheDocument();
  });

  it("keeps Turnstile out of account settings and renders it under access security", () => {
    renderSettingsScreen();

    const accountSection = document.getElementById("settings-account");
    const accessSecuritySection = document.getElementById("settings-access-security");
    expect(accountSection).not.toBeNull();
    expect(accessSecuritySection).not.toBeNull();
    expect(within(accountSection as HTMLElement).queryByRole("heading", { name: "Cloudflare Turnstile" })).not.toBeInTheDocument();
    expect(within(accessSecuritySection as HTMLElement).getByRole("heading", { name: "访问安全" })).toBeInTheDocument();
    expect(within(accessSecuritySection as HTMLElement).getByLabelText("要求邮箱密码登录通过人机验证")).toBeInTheDocument();
  });

  it("keeps user management visible for Cloudflare admins while hiding PocketBase admin", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      canManageUsers: true,
      canAccessPocketBaseAdmin: false,
    }));

    renderSettingsScreen();

    expect(screen.getByRole("link", { name: "管理用户" })).toHaveAttribute("href", "/admin/users");
    expect(screen.queryByRole("link", { name: "PocketBase 后台" })).not.toBeInTheDocument();
  });

  it("passes the effective theme mode to the appearance selector", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: { themeMode: "light" },
      effectiveThemeMode: "dark",
    }));

    renderSettingsScreen();

    expect(screen.getByTestId("theme-selector-mode")).toHaveTextContent("dark");
  });

  it("lets users choose Frankfurter as the exchange-rate source", async () => {
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    const user = userEvent.setup();
    const controller = createControllerState({
      settings: {
        exchangeRateProvider: "floatrates",
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    await user.click(screen.getByRole("combobox", { name: "汇率来源" }));
    await user.click(screen.getByRole("option", { name: "Frankfurter" }));

    expect(controller.handleExchangeRateProviderChange).toHaveBeenCalledWith("frankfurter");
  });

  it("shows the selected draft exchange-rate source without forcing an immediate save", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        exchangeRateProvider: "floatrates",
      },
    }));

    renderSettingsScreen();

    const select = screen.getByRole("combobox", { name: "汇率来源" });
    expect(select).toHaveTextContent("FloatRates JSON Feeds");
    expect(select).toBeEnabled();
  });

  it("shows partial exchange-rate warnings without opening raw error details", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      activeRateProvider: "exchange-api",
      ratesWarning: {
        kind: "partial",
        provider: "exchange-api",
        missingCurrencies: ["SYP"],
        fillSources: { SYP: "frankfurter" },
      },
    }));

    renderSettingsScreen();

    expect(screen.getByText("汇率已更新，SYP 暂用 Frankfurter 补齐。")).toBeInTheDocument();
    expect(screen.getByText("补齐：Frankfurter")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看错误响应" })).not.toBeInTheDocument();
  });

  it("shows common currency quotes in the reporting currency direction", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        defaultCurrency: "CNY",
      },
      rates: {
        USD: 1,
        CNY: 6.78,
      },
    }));

    renderSettingsScreen();

    expect(screen.getByRole("heading", { name: "常用货币折算为 CNY" })).toBeInTheDocument();
    const defaultCurrencySelect = screen.getByRole("combobox", { name: "统计货币" });
    expect(defaultCurrencySelect).toHaveTextContent("¥ 人民币 (CNY)");
    expect(defaultCurrencySelect).not.toHaveTextContent("¥ 人民币 (¥)");
    expect(screen.queryByRole("heading", { name: "汇率预览 (1 CNY = )" })).not.toBeInTheDocument();
    expect(screen.getByText("1 USD")).toBeInTheDocument();
    expect(screen.getAllByText("≈ ¥6.78 CNY").length).toBeGreaterThan(0);
  });

  it("uses CNY as the first preview reference when another reporting currency is selected", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        defaultCurrency: "USD",
      },
      rates: {
        USD: 1,
        CNY: 6.78,
      },
    }));

    renderSettingsScreen();

    expect(screen.getByRole("heading", { name: "常用货币折算为 USD" })).toBeInTheDocument();
    const previewCards = screen.getByText("1 CNY").closest("div")?.parentElement?.children;
    expect(previewCards?.[0]).toHaveTextContent("1 CNY");
    expect(screen.getByText("≈ $0.1475 USD")).toBeInTheDocument();
  });

  it("renders the monthly budget as a formatted text input instead of a spinbutton", () => {
    renderSettingsScreen();

    const budgetInput = screen.getByLabelText("月度预算金额");
    expect(budgetInput).toHaveAttribute("type", "text");
    expect(budgetInput).toHaveAttribute("name", "monthlyBudget");
    expect(budgetInput).toHaveAttribute("inputmode", "decimal");
    expect(budgetInput).toHaveAttribute("enterkeyhint", "done");
    expect(screen.queryByRole("spinbutton", { name: "月度预算金额" })).not.toBeInTheDocument();
  });

  it("keeps the monthly budget empty while editing and formats the next valid value", async () => {
    const user = userEvent.setup();
    mocks.useSettingsFormController.mockImplementation(() => useStatefulMonthlyBudgetController());

    renderSettingsScreen();

    const budgetInput = screen.getByLabelText("月度预算金额") as HTMLInputElement;
    expect(budgetInput).toHaveValue("10,000");

    await user.clear(budgetInput);

    expect(budgetInput).toHaveValue("");
    expect(budgetInput).not.toHaveValue("0");
    expect(screen.getByText("预算金额无效")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存更改" })).toBeDisabled();

    await user.type(budgetInput, "10000");

    expect(budgetInput).toHaveValue("10,000");
    expect(screen.queryByText("预算金额无效")).not.toBeInTheDocument();
  });

  it("lets users edit the global notification reminder lead time", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      settings: { notificationReminderDays: 5 },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    const input = screen.getByLabelText("默认提前提醒天数");
    expect(input).toHaveValue("5");
    expect(input).toHaveAttribute("inputmode", "numeric");
    const notificationScheduleRow = input.closest('[data-slot="form-field-row"]');
    expect(notificationScheduleRow).toHaveAttribute("data-align-at", "sm");
    expect(notificationScheduleRow).toHaveAttribute("data-tracks", "3");

    await user.clear(input);
    await user.type(input, "14");

    expect(controller.updateSetting).toHaveBeenLastCalledWith("notificationReminderDays", 14);
  });

  it("opens the calendar feed manager with separate global and subscription tabs", async () => {
    const user = userEvent.setup();
    const calendarFeed = createCalendarFeedControllerState({
      global: {
        data: {
          enabled: true,
          feedUrl: "https://example.com/calendar/renewals.ics?token=all",
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
        },
      },
      subscriptions: {
        data: {
          total: 1,
          hasMore: false,
          items: [{
            id: "cal-sub",
            feedUrl: "https://example.com/calendar/renewals.ics?token=fastmail",
            createdAt: "2026-08-19T00:00:00.000Z",
            updatedAt: "2026-08-19T00:00:00.000Z",
            subscription: {
              id: "sub-fastmail",
              name: "Fastmail",
              status: "active",
              nextBillingDate: assertDateOnly("2026-09-01"),
            },
          }],
        },
      },
    });
    mocks.useCalendarFeedSettingsController.mockReturnValue(calendarFeed);

    renderSettingsScreen();

    expect(screen.getByRole("heading", { name: "日历订阅" })).toBeInTheDocument();
    expect(screen.getByText("单个订阅 · 1 个")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "管理" }));

    const manager = screen.getByRole("dialog", { name: "日历订阅" });
    expect(within(manager).getByLabelText("「全部续费」的日历订阅 URL")).toHaveValue(
      "https://example.com/calendar/renewals.ics?token=all",
    );
    expect(within(manager).queryByText("Fastmail")).not.toBeInTheDocument();

    await user.click(within(manager).getByRole("tab", { name: "单个订阅" }));
    const row = within(manager).getByRole("listitem");
    expect(row).toHaveTextContent("Fastmail");
    await user.click(within(row).getByRole("button", { name: "复制「Fastmail」的日历订阅 URL" }));
    expect(calendarFeed.copyUrl).toHaveBeenCalledWith(
      "https://example.com/calendar/renewals.ics?token=fastmail",
      expect.any(HTMLInputElement),
    );
  });

  it("offers global feed generation when no feed has been created", async () => {
    const user = userEvent.setup();
    const calendarFeed = createCalendarFeedControllerState();
    mocks.useCalendarFeedSettingsController.mockReturnValue(calendarFeed);

    renderSettingsScreen();

    await user.click(screen.getByRole("button", { name: "管理" }));
    const manager = screen.getByRole("dialog", { name: "日历订阅" });
    await user.click(within(manager).getByRole("button", { name: "生成全部续费日历订阅链接" }));
    expect(calendarFeed.create).toHaveBeenCalledWith({ scope: "all" });
  });

  it("lets users choose the public status reporting currency from the public status section", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      settings: {
        defaultCurrency: "USD",
        publicStatusCurrency: "inherit",
      },
      publicStatusPage: {
        enabled: true,
        pageUrl: "https://example.com/status/secret",
        showPrices: true, hideExpired: false, hideLifetime: false,
        visibleCount: 3,
        hiddenCount: 1, expiredCount: 0, lifetimeCount: 0,
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    expect(screen.getByRole("heading", { name: "公开展示" })).toBeInTheDocument();
    expect(screen.getByLabelText("公开展示 URL")).toHaveValue("https://example.com/status/secret");
    expect(screen.getByText("展示 3 · 隐藏 1")).toBeInTheDocument();
    expect(screen.queryByText("当前将展示 3 条订阅，隐藏 1 条。")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "复制 URL" }));
    expect(controller.publicStatusPage.copyUrl).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "打开公开页" }));
    expect(controller.publicStatusPage.openPage).toHaveBeenCalled();

    await user.click(screen.getByRole("switch", { name: "公开金额" }));
    expect(controller.publicStatusPage.updateShowPrices).toHaveBeenCalledWith(false);

    const currencySelect = screen.getByRole("combobox", { name: "公开页统计货币" });
    const publicStatusFields = currencySelect.closest('[data-slot="form-field-row"]');
    expect(publicStatusFields).toHaveAttribute("data-align-at", "lg");
    expect(publicStatusFields?.querySelectorAll('[data-slot="form-field"]')).toHaveLength(4);
    expect(screen.getByRole("switch", { name: "公开金额" }).closest('[data-slot="form-field-row"]')).toBe(publicStatusFields);
    expect(currencySelect).toHaveTextContent("继承统计货币（当前 USD）");

    await user.click(currencySelect);

    expect(controller.updateSetting).toHaveBeenLastCalledWith("publicStatusCurrency", "CNY");

    const regenerateTrigger = screen.getByRole("button", { name: "重新生成" });
    await user.click(regenerateTrigger);
    const regenerateDialog = await screen.findByRole("alertdialog", { name: "重新生成公开展示 URL？" });
    expect(within(regenerateDialog).getByText("旧 URL 会立即失效，已经分享出去的公开页需要使用新链接访问。")).toBeInTheDocument();
    const regenerateDialogClosed = waitForElementToBeRemoved(regenerateDialog);
    await user.click(within(regenerateDialog).getByRole("button", { name: "重新生成" }));
    expect(controller.publicStatusPage.regenerate).toHaveBeenCalled();
    await regenerateDialogClosed;
    await waitFor(() => {
      expect(regenerateTrigger).toHaveFocus();
      expect(document.body).not.toHaveAttribute("data-scroll-locked");
    });

    await user.click(screen.getByRole("button", { name: "撤销公开页" }));
    const revokeDialog = await screen.findByRole("alertdialog", { name: "撤销公开展示？" });
    expect(within(revokeDialog).getByText("公开链接会立即失效，后续访问将返回 404。")).toBeInTheDocument();
    await user.click(within(revokeDialog).getByRole("button", { name: "撤销公开页" }));
    expect(controller.publicStatusPage.revoke).toHaveBeenCalled();
  });

  it("shows an explicit public status reporting currency without duplicated symbols", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        defaultCurrency: "USD",
        publicStatusCurrency: "CNY",
      },
      publicStatusPage: {
        enabled: true,
        pageUrl: "https://example.com/status/secret",
        showPrices: true, hideExpired: false, hideLifetime: false,
      },
    }));

    renderSettingsScreen();

    const currencySelect = screen.getByRole("combobox", { name: "公开页统计货币" });
    expect(currencySelect).toHaveTextContent("¥ 人民币 (CNY)");
    expect(currencySelect).not.toHaveTextContent("¥ 人民币 (¥)");
  });

  it("returns focus to public status generation after revocation removes its trigger", async () => {
    const user = userEvent.setup();
    mocks.useSettingsFormController.mockImplementation(useStatefulPublicStatusController);
    renderSettingsScreen();

    await user.click(screen.getByRole("button", { name: "撤销公开页" }));
    const dialog = await screen.findByRole("alertdialog", { name: "撤销公开展示？" });
    await user.click(within(dialog).getByRole("button", { name: "撤销公开页" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", { name: "撤销公开展示？" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "生成公开链接" })).toHaveFocus();
    });
  });

  it("keeps the public status setup compact before URL generation", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      publicStatusPage: {
        enabled: false,
        pageUrl: null,
        visibleCount: 105,
        hiddenCount: 0, expiredCount: 0, lifetimeCount: 0,
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    expect(screen.getByRole("heading", { name: "公开展示" })).toBeInTheDocument();
    expect(screen.getByText("生成后展示未隐藏订阅，金额默认隐藏。")).toBeInTheDocument();
    expect(screen.getByText("展示 105 · 隐藏 0")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "公开金额" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "公开页统计货币" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("公开展示 URL")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "生成公开链接" }));
    expect(controller.publicStatusPage.createOrRotate).toHaveBeenCalled();
  });

  it("uses H5 layout classes and native phone metadata for settings", () => {
    const { container } = renderSettingsScreen();

    expect(container.querySelector(".app-page")).toBeInTheDocument();
    expect(container.querySelector("main")).not.toHaveClass("h5-bottom-bar-space");
    const phoneInput = screen.getByLabelText("第三方 API 测试号码");
    expect(phoneInput).toHaveAttribute("name", "testPhone");
    expect(phoneInput).toHaveAttribute("type", "tel");
    expect(phoneInput).toHaveAttribute("inputmode", "tel");
    expect(phoneInput).toHaveAttribute("autocomplete", "tel");
    expect(phoneInput).toHaveAttribute("enterkeyhint", "done");
  });

  it("keeps category and payment add actions visible when default lists exceed the dialog cap", () => {
    expect(DEFAULT_CUSTOM_CONFIG.categories.length).toBeGreaterThan(20);
    expect(DEFAULT_CUSTOM_CONFIG.paymentMethods.length).toBeGreaterThan(20);

    renderSettingsScreen();

    const categoryManager = screen.getByRole("region", { name: "分类管理" });
    const paymentManager = screen.getByRole("region", { name: "支付方式管理" });

    expect(within(categoryManager).getByRole("button", { name: "添加选项" })).toBeInTheDocument();
    expect(within(paymentManager).getByRole("button", { name: "添加选项" })).toBeInTheDocument();
  });

  it("keeps AI recognition provider and model controls in the shared field grid", () => {
    renderSettingsScreen();

    const providerModelGrid = screen.getByTestId("ai-provider-model-grid");
    expect(providerModelGrid).toHaveAttribute("data-align-at", "md");
    expect(providerModelGrid).toHaveAttribute("data-tracks", "2");
    expect(providerModelGrid.firstElementChild).toHaveClass("md:grid-cols-2", "md:gap-y-2");
  });

  it("uses test wording for the Notifyx channel button", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        enabledChannels: ["notifyx"],
        notifyxApiKey: "notifyx-key",
      },
    }));

    renderSettingsScreen();

    expect(screen.getByRole("button", { name: "测试 Notifyx 通知" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发送 Notifyx 通知" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notifyx 说明" })).toHaveAttribute(
      "href",
      "https://www.notifyx.cn/help",
    );
  });

  it("shows loading state on the active notification test button and disables other test buttons", async () => {
    const user = userEvent.setup();
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        enabledChannels: ["telegram", "webhook"],
      },
      testingChannel: "telegram",
    }));

    renderSettingsScreen();

    const loadingButton = screen.getByRole("button", { name: "测试中..." });
    expect(loadingButton).toBeDisabled();
    expect(loadingButton).toHaveAttribute("aria-busy", "true");

    await user.click(screen.getByRole("button", { name: "配置 Webhook 通知" }));

    expect(screen.getByRole("button", { name: "测试 Webhook 通知" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "测试 Telegram 通知" })).not.toBeInTheDocument();
  });

  it("renders only the active notification channel config panel", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        enabledChannels: ["telegram", "notifyx", "webhook", "wechat", "email", "bark"],
      },
    }));

    renderSettingsScreen();

    expect(screen.getByRole("heading", { name: "Telegram 配置" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Notifyx 配置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Webhook 通知 配置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "企业微信机器人 配置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "邮件通知 配置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Bark 配置" })).not.toBeInTheDocument();
  });

  it("switches to Bark config when the Bark channel is selected", async () => {
    const user = userEvent.setup();
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        enabledChannels: ["telegram", "bark"],
        barkServerUrl: "https://api.day.app",
        barkDeviceKey: "bark-device-key",
      },
    }));

    renderSettingsScreen();

    await user.click(screen.getByRole("button", { name: "配置 Bark" }));

    expect(screen.getByRole("heading", { name: "Bark 配置" })).toBeInTheDocument();
    expect(screen.getByLabelText("服务器地址")).toHaveValue("https://api.day.app");
    expect(screen.getByLabelText("设备 Key")).toHaveValue("bark-device-key");
    expect(screen.getByLabelText("静音推送")).toBeInTheDocument();
  });

  it("selects Bark immediately after checking it and keeps the test button available before enabling it", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      settings: {
        enabledChannels: ["telegram"],
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    await user.click(screen.getByRole("checkbox", { name: "启用 Bark" }));

    expect(controller.toggleChannel).toHaveBeenCalledWith("bark");
    expect(screen.getByRole("heading", { name: "Bark 配置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试 Bark 通知" })).toBeEnabled();
  });

  it("renders ServerChan config with SendKey input and help link", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      settings: {
        enabledChannels: ["telegram", "serverchan"],
        serverchanSendKey: "SCT123456",
      },
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    expect(screen.getByText("SendKey 已填写")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "配置 Server酱" }));

    expect(screen.getByRole("heading", { name: "Server酱 配置" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Server酱 文档" })).toHaveAttribute("href", "https://sct.ftqq.com/");
    const input = screen.getByLabelText("SendKey");
    expect(input).toHaveValue("SCT123456");
    await user.type(input, "x");
    expect(controller.updateSetting).toHaveBeenLastCalledWith("serverchanSendKey", "SCT123456x");
    expect(screen.getByRole("button", { name: "测试 Server酱 通知" })).toBeEnabled();
  });

  it("renders Webhook examples as placeholders instead of default textarea values", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      settings: {
        enabledChannels: ["webhook"],
        webhookUrl: "https://example.com/webhook",
        webhookHeaders: "",
        webhookPayload: "",
      },
    }));

    renderSettingsScreen();

    const headers = screen.getByLabelText("自定义请求头 (JSON格式，可选)");
    const payload = screen.getByLabelText("发送负载 (JSON格式，可选)");

    expect(headers).toHaveValue("");
    expect(headers).toHaveAttribute("placeholder", WEBHOOK_HEADERS_PLACEHOLDER);
    expect(payload).toHaveValue("");
    expect(payload).toHaveAttribute("placeholder", WEBHOOK_PAYLOAD_PLACEHOLDER);
  });

  it("does not show the save bar when there are no unsaved changes", () => {
    renderSettingsScreen();

    expect(screen.queryByText("有未保存更改")).not.toBeInTheDocument();
    expect(document.querySelector(".h5-bottom-bar")).toBeNull();
  });

  it("uses the unified settings layout contract without horizontal gutter workarounds", () => {
    const { container } = renderSettingsScreen();

    const pageLayout = screen.getByTestId("settings-page-layout");
    const content = screen.getByTestId("settings-section-content");
    expect(screen.getByTestId("settings-main")).toHaveClass("flex-1");
    expect(pageLayout).toHaveClass("grid", "min-w-0", "gap-6", "lg:gap-8", "lg:grid-cols-[14rem_minmax(0,1fr)]");
    expect(pageLayout.className).toContain("[--settings-mobile-header-offset:calc(8.25rem+env(safe-area-inset-top))]");
    expect(pageLayout.className).toContain("[--settings-desktop-sticky-top:7rem]");
    expect(pageLayout.className).toContain("[--settings-desktop-section-scroll-offset:var(--settings-desktop-sticky-top)]");
    expect(pageLayout.className).toContain("[--settings-section-scroll-offset:calc(var(--settings-mobile-header-offset)+var(--settings-mobile-sticky-gap)+var(--settings-mobile-header-height)+0.75rem)]");
    expect(pageLayout.className).toContain("lg:[--settings-section-scroll-offset:var(--settings-desktop-section-scroll-offset)]");
    expect(content).toHaveClass("grid", "min-w-0", "gap-6", "lg:gap-8");
    expect(content).not.toHaveClass("lg:overflow-y-auto");
    expect(content.querySelector(".-mx-4")).toBeNull();
    expect(content.querySelector(".overflow-x-auto")).toBeNull();

    SETTINGS_SECTION_IDS.forEach((id) => {
      const section = container.querySelector(`section#${id}`);
      expect(section).toHaveClass(
        "min-w-0",
        "w-full",
        "rounded-xl",
        "border",
        "bg-card",
        "p-4",
        "sm:p-6",
        "scroll-mt-(--settings-section-scroll-offset)",
      );
      expect(section).not.toHaveClass("lg:scroll-mt-24");
      expect(section).not.toHaveClass("p-6");
    });
  });

  it("shows discard and save actions only when there are unsaved changes", async () => {
    const user = userEvent.setup();
    const controller = createControllerState({
      hasUnsavedChanges: true,
    });
    mocks.useSettingsFormController.mockReturnValue(controller);

    renderSettingsScreen();

    expect(screen.getByText("有未保存更改")).toBeInTheDocument();
    expect(screen.getByTestId("settings-main")).toHaveClass("h5-bottom-bar-space");
    const bottomBar = screen.getByText("有未保存更改").closest(".h5-bottom-bar");
    expect(bottomBar).not.toBeNull();
    await user.click(within(bottomBar as HTMLElement).getByRole("button", { name: "放弃更改" }));
    expect(controller.handleDiscardChanges).toHaveBeenCalled();
    await user.click(within(bottomBar as HTMLElement).getByRole("button", { name: "保存更改" }));
    expect(controller.handleSaveChanges).toHaveBeenCalled();
  });

  it("shows loading state on the save changes button", () => {
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      hasUnsavedChanges: true,
      isSavingSettings: true,
    }));

    renderSettingsScreen();

    const saveButton = screen.getByRole("button", { name: "保存中..." });
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "保存所有设置" })).not.toBeInTheDocument();
  });
});
