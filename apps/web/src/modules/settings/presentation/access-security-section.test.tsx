import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SettingsAuthSecurityController } from "../application/use-auth-security-settings-controller";
import { AccessSecuritySection } from "./access-security-section";

const translations: Record<string, string> = {
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.disabled": "未启用",
  "common.enabled": "已启用",
  "common.loading": "加载中",
  "settings.managerLoadFailed": "加载失败",
  "settings.managerRefreshFailed": "未更新",
  "settings.managerRetry": "重试",
  "settings.notUpdated": "未更新",
  "settings.statusUnknown": "状态未知",
  "settings.accessSecurity": "访问安全",
  "settings.turnstileClearSecret": "清除密钥",
  "settings.turnstileClearing": "清除中...",
  "settings.turnstileDiscard": "放弃更改",
  "settings.turnstileEnable": "要求邮箱密码登录通过人机验证",
  "settings.turnstileEnableHelp": "启用后必须同时填写 Site key 和 Secret key，否则人机验证不会生效。",
  "settings.turnstileHelp": "启用后，Renewlet 会在邮箱密码登录前校验 Turnstile，用于降低爆破和撞库风险；通行密钥、身份验证器二阶段和首次设置不受影响。",
  "settings.turnstileSave": "保存 Turnstile 配置",
  "settings.turnstileSaving": "保存中...",
  "settings.turnstileTest": "测试 Turnstile 配置",
  "settings.turnstileTesting": "测试中...",
  "settings.turnstileTestDialogTitle": "测试 Turnstile 配置",
  "settings.turnstileTestDialogDescription": "完成下方验证后，Renewlet 会检查当前 Site key 和 Secret key 是否可用。",
  "settings.turnstileSecret": "Secret key",
  "settings.turnstileSecretConfigured": "密钥已配置",
  "settings.turnstileSecretConfiguredPlaceholder": "已保存，留空则保持不变",
  "settings.turnstileSecretHelp": "只保存在服务端，用于调用 Cloudflare Siteverify。",
  "settings.turnstileSecretKeepHelp": "留空保持当前密钥；填写新值会替换旧密钥。",
  "settings.turnstileSecretPlaceholder": "输入 Cloudflare Turnstile Secret key",
  "settings.turnstileSiteKey": "Site key",
  "settings.turnstileSiteKeyHelp": "公开给登录页渲染 Turnstile widget。",
  "settings.turnstileSiteKeyPlaceholder": "0x4AAAA...",
  "settings.oidcTitle": "单点登录",
  "settings.turnstileTitle": "Cloudflare Turnstile",
};

vi.mock("@/components/turnstile-widget", () => ({
  TurnstileWidget: ({
    siteKey,
    theme,
    errorId,
    resetSignal,
    error,
    onTokenChange,
  }: {
    siteKey: string;
    theme: string;
    errorId: string;
    resetSignal: number;
    error?: string | undefined;
    onTokenChange: (token: string) => void;
  }) => (
    <div data-testid="turnstile-test-widget" data-site-key={siteKey} data-theme={theme} data-error-id={errorId} data-reset-signal={resetSignal}>
      {error ? <p>{error}</p> : null}
      <button type="button" onClick={() => onTokenChange("test-token")}>Complete test verification</button>
    </div>
  ),
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

vi.mock("@/lib/theme-provider", () => ({
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: vi.fn(),
  }),
}));

function readState(
  data: SettingsAuthSecurityController["readState"]["data"],
  overrides: Partial<SettingsAuthSecurityController["readState"]> = {},
): SettingsAuthSecurityController["readState"] {
  return {
    data,
    hasData: data !== undefined,
    error: null,
    isInitialLoading: false,
    isRefreshing: false,
    retry: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createController(overrides: Partial<SettingsAuthSecurityController> = {}): SettingsAuthSecurityController {
  return {
    canManage: true,
    disabled: false,
    readState: readState({
      turnstile: { enabled: false, siteKey: "", secretConfigured: false },
    }),
    isSaving: false,
    isClearingSecret: false,
    isTesting: false,
    secretConfigured: false,
    hasChanges: false,
    draft: { enabled: false, siteKey: "", secret: "" },
    testDialogOpen: false,
    testDialogSiteKey: "",
    testResetSignal: 0,
    testError: undefined,
    setEnabled: vi.fn(),
    setSiteKey: vi.fn(),
    setSecret: vi.fn(),
    discard: vi.fn(),
    save: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    clearSecret: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    startTest: vi.fn(),
    handleTestDialogOpenChange: vi.fn(),
    handleTestTokenChange: vi.fn(),
    ...overrides,
  };
}

function renderAccessSecuritySection(controller = createController()) {
  return render(
    <AccessSecuritySection
      id="settings-access-security"
      className="scroll-mt-test"
      controller={controller}
    />,
  );
}

describe("AccessSecuritySection", () => {
  it("does not render for users that cannot manage site access security", () => {
    const { container } = renderAccessSecuritySection(createController({ canManage: false }));

    expect(container.firstChild).toBeNull();
  });

  it("does not report Turnstile as disabled when the first read fails", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    renderAccessSecuritySection(createController({
      readState: readState(undefined, {
        error: new Error("Turnstile unavailable"),
        retry,
      }),
    }));

    expect(within(screen.getByRole("group", { name: "Cloudflare Turnstile" })).getByText("状态未知")).toBeInTheDocument();
    expect(screen.getByText("加载失败")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Cloudflare Turnstile" })).queryByText("未启用")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Site key")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Secret key")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("renders Turnstile human verification as a top-level access security section", () => {
    renderAccessSecuritySection(createController({
      draft: { enabled: true, siteKey: "site-key", secret: "" },
      secretConfigured: true,
    }));

    expect(screen.getByRole("heading", { name: "访问安全" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Cloudflare Turnstile" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "单点登录" })).toBeInTheDocument();
    expect(screen.getByText("已启用")).toBeInTheDocument();
    expect(screen.getByText("密钥已配置")).toBeInTheDocument();
    expect(screen.getByText("启用后，Renewlet 会在邮箱密码登录前校验 Turnstile，用于降低爆破和撞库风险；通行密钥、身份验证器二阶段和首次设置不受影响。")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "要求邮箱密码登录通过人机验证" })).toBeChecked();
    expect(screen.getByLabelText("Site key")).toHaveValue("site-key");
    expect(screen.getByLabelText("Secret key")).toHaveAttribute("placeholder", "已保存，留空则保持不变");
    const credentialsRow = screen.getByLabelText("Site key").closest('[data-slot="form-field-row"]');
    expect(credentialsRow).toHaveAttribute("data-align-at", "sm");
    expect(credentialsRow).toHaveAttribute("data-tracks", "3");
    expect(credentialsRow?.querySelectorAll('[data-slot="form-field"]')).toHaveLength(2);
    expect(screen.getByRole("button", { name: "保存 Turnstile 配置" })).toBeDisabled();
    expect(screen.queryByTestId("turnstile-test-widget")).not.toBeInTheDocument();
  });

  it("forwards edits, discard, save and clear-secret actions to the controller", async () => {
    const user = userEvent.setup();
    const controller = createController({
      hasChanges: true,
      secretConfigured: true,
      draft: { enabled: true, siteKey: "site-key", secret: "" },
    });
    renderAccessSecuritySection(controller);

    await user.click(screen.getByRole("checkbox", { name: "要求邮箱密码登录通过人机验证" }));
    fireEvent.change(screen.getByLabelText("Site key"), { target: { value: "site-key-2" } });
    fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "secret-2" } });
    await user.click(screen.getByRole("button", { name: "保存 Turnstile 配置" }));
    await user.click(screen.getByRole("button", { name: "测试 Turnstile 配置" }));
    await user.click(screen.getByRole("button", { name: "放弃更改" }));
    await user.click(screen.getByRole("button", { name: "清除密钥" }));

    expect(controller.setEnabled).toHaveBeenCalledWith(false);
    expect(controller.setSiteKey).toHaveBeenCalledWith("site-key-2");
    expect(controller.setSecret).toHaveBeenCalledWith("secret-2");
    expect(controller.save).toHaveBeenCalledTimes(1);
    expect(controller.startTest).toHaveBeenCalledTimes(1);
    expect(controller.discard).toHaveBeenCalledTimes(1);
    expect(controller.clearSecret).toHaveBeenCalledTimes(1);
  });

  it("opens a dialog for temporary Turnstile configuration tests", async () => {
    const user = userEvent.setup();
    const controller = createController({
      draft: { enabled: false, siteKey: "site-key", secret: "secret-value" },
      testDialogOpen: true,
      testDialogSiteKey: "site-key",
      testResetSignal: 2,
      testError: "测试失败",
    });
    renderAccessSecuritySection(controller);

    expect(screen.getByRole("dialog", { name: "测试 Turnstile 配置" })).toBeInTheDocument();
    expect(screen.getByText("完成下方验证后，Renewlet 会检查当前 Site key 和 Secret key 是否可用。")).toBeInTheDocument();
    expect(screen.getByTestId("turnstile-test-widget")).toHaveAttribute("data-site-key", "site-key");
    expect(screen.getByTestId("turnstile-test-widget")).toHaveAttribute("data-theme", "dark");
    expect(screen.getByTestId("turnstile-test-widget")).toHaveAttribute("data-error-id", "settings-turnstile-test-error");
    expect(screen.getByTestId("turnstile-test-widget")).toHaveAttribute("data-reset-signal", "2");
    expect(screen.getByText("测试失败")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Complete test verification" }));

    expect(controller.handleTestTokenChange).toHaveBeenCalledWith("test-token");
  });

  it("closes the Turnstile test dialog through the controller", async () => {
    const user = userEvent.setup();
    const controller = createController({
      draft: { enabled: false, siteKey: "site-key", secret: "secret-value" },
      testDialogOpen: true,
      testDialogSiteKey: "site-key",
    });
    renderAccessSecuritySection(controller);

    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(controller.handleTestDialogOpenChange).toHaveBeenCalledWith(false);
  });
});
