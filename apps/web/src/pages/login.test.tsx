// Login 页面测试保护 setup/forgot-password 能力入口和 next 跳转清洗，不让认证页绕过公共路由契约。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { MfaRequiredResponse } from "@renewlet/shared/schemas/auth";
import Login from "./login";

const mocks = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  signInPasskey: vi.fn(),
  verifyMfa: vi.fn(),
  cancelPasskeyCeremony: vi.fn(),
  reportClientError: vi.fn(),
  oidcStart: vi.fn(),
  oidcFinish: vi.fn(),
  useAppStatus: vi.fn(),
  setTheme: vi.fn(),
  resolvedTheme: "dark" as const,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: mocks.signInEmail,
      passkey: mocks.signInPasskey,
    },
    verifyMfa: mocks.verifyMfa,
    cancelPasskeyCeremony: mocks.cancelPasskeyCeremony,
  },
}));

vi.mock("@/services/oidc-service", () => ({
  oidcService: { login: mocks.oidcStart, finish: mocks.oidcFinish },
  oidcErrorKey: () => "auth.oidcFailed",
}));

vi.mock("@/lib/report-client-error", () => ({
  reportClientError: mocks.reportClientError,
}));

vi.mock("@/hooks/use-app-status", () => ({
  useAppStatus: mocks.useAppStatus,
}));

vi.mock("@/lib/theme-provider", () => ({
  useTheme: () => ({
    theme: mocks.resolvedTheme,
    resolvedTheme: mocks.resolvedTheme,
    setTheme: mocks.setTheme,
  }),
}));

const oidcStatus = {
  status: "ready",
  data: {
    setupRequired: false, setupEnabled: true, demoMode: false, passwordReset: false, oidc: true,
    turnstile: { enabled: false, siteKey: "" },
  },
  isLoading: false,
} as const;

const rememberedLoginEmailStorageKey = "renewlet_login_email";

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );
}

function getTopDialogOverlay() {
  const overlays = document.querySelectorAll<HTMLElement>("[data-dialog-overlay]");
  const overlay = overlays.item(overlays.length - 1);
  if (!overlay) throw new Error("Dialog overlay was not rendered");
  return overlay;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function mockPasswordMfa(methods: MfaRequiredResponse["methods"]) {
  const challenge: MfaRequiredResponse = {
    type: "mfa_required",
    ticketId: "ticket-1",
    expiresAt: "2026-07-01T00:00:00.000Z",
    methods,
  };
  mocks.signInEmail.mockResolvedValueOnce({ data: challenge, error: null });
}

function getVerifyMfaCall(index = 0): [unknown, unknown] {
  const calls = mocks.verifyMfa.mock.calls as unknown as Array<[unknown, unknown]>;
  const call = calls[index];
  if (!call) throw new Error(`Missing verifyMfa call at index ${index}`);
  return call;
}

function getShouldPersistSession(options: unknown): (session: unknown) => boolean {
  if (!options || typeof options !== "object") {
    throw new Error("Missing verifyMfa options");
  }
  const candidate = (options as { shouldPersistSession?: unknown }).shouldPersistSession;
  if (typeof candidate !== "function") {
    throw new Error("Missing verifyMfa shouldPersistSession guard");
  }
  return candidate as (session: unknown) => boolean;
}

describe("Login page", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis.navigator, "languages", { configurable: true, value: ["en-US"] });
    Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
    // 登录页的条件式 Passkey UI 是浏览器级异步能力；这里固定为不可用，避免它抢跑密码/MFA 路径断言。
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: {
        isConditionalMediationAvailable: vi.fn().mockResolvedValue(false),
      },
    });
    mocks.signInEmail.mockReset();
    mocks.signInEmail.mockResolvedValue({ error: null });
    mocks.signInPasskey.mockReset();
    mocks.signInPasskey.mockResolvedValue({
      data: {
        type: "session",
        session: { expiresAt: "2026-07-01T00:00:00.000Z" },
        user: { id: "user-1", email: "passkey@example.com", name: "Passkey", role: "user", banned: false },
      },
      error: null,
      cancelled: false,
    });
    mocks.verifyMfa.mockReset();
    mocks.verifyMfa.mockResolvedValue({ error: null });
    mocks.cancelPasskeyCeremony.mockReset();
    mocks.reportClientError.mockReset();
    mocks.setTheme.mockReset();
    mocks.resolvedTheme = "dark";
    localStorage.clear();
    mocks.oidcStart.mockReset();
    mocks.oidcFinish.mockReset();
    window.history.replaceState(null, "", "/login");
    mocks.useAppStatus.mockReturnValue({
      status: "ready",
      data: {
        setupRequired: false,
        setupEnabled: true,
        demoMode: false,
        turnstile: { enabled: false, siteKey: "" },
      },
      error: null,
      isLoading: false,
      isRefreshing: false,
      isReady: true,
      retry: vi.fn(),
    });
  });

  it("starts single sign-on from the configured site with a sanitized return path", async () => {
    mocks.useAppStatus.mockReturnValue(oidcStatus);
    window.history.replaceState(null, "", "/login?next=%2Fcalendar");
    renderLogin();
    await userEvent.click(screen.getByRole("button", { name: "Use single sign-on" }));
    expect(mocks.cancelPasskeyCeremony).toHaveBeenCalled();
    expect(mocks.oidcStart).toHaveBeenCalledWith("/calendar");
  });

  it("restores focus after cancellation when login options arrive late", async () => {
    mocks.useAppStatus.mockReturnValue({ status: "loading", isLoading: true, data: null });
    window.history.replaceState(null,"","/login?oidc=cancelled");
    const view=renderLogin();
    mocks.useAppStatus.mockReturnValue(oidcStatus);
    view.rerender(<MemoryRouter><Login /></MemoryRouter>);
    await waitFor(()=>expect(screen.getByRole("button",{name:"Use single sign-on"})).toHaveFocus());
    expect(mocks.oidcFinish).not.toHaveBeenCalled();
  });

  it("consumes the OIDC return once and opens the local MFA dialog", async () => {
    mocks.useAppStatus.mockReturnValue(oidcStatus);
    mocks.oidcFinish.mockResolvedValue({ type: "mfa_required", ticketId:"ticket-oidc", expiresAt:"2099-01-01T00:00:00Z", methods:["totp"] });
    window.history.replaceState(null, "", "/login?oidc=login&next=%2Fcalendar");
    renderLogin();
    const dialog=await screen.findByRole("dialog", { name:"Complete sign-in verification" });
    expect(mocks.oidcFinish).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?next=%2Fcalendar");
    await userEvent.click(within(dialog).getByRole("button", { name:"Close" }));
    await waitFor(()=>expect(screen.getByRole("button", { name:"Use single sign-on" })).toHaveFocus());
  });

  it("hides the first deployment setup prompt after setup is complete", () => {
    renderLogin();

    expect(screen.queryByText("First deployment? Go to")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "initialize admin" })).not.toBeInTheDocument();
  });

  it("shows the setup prompt only when setup is required and enabled", () => {
    mocks.useAppStatus.mockReturnValue({
      status: "ready",
      data: {
        setupRequired: true,
        setupEnabled: true,
        demoMode: false,
        turnstile: { enabled: false, siteKey: "" },
      },
      error: null,
      isLoading: false,
      isRefreshing: false,
      isReady: true,
      retry: vi.fn(),
    });

    renderLogin();

    expect(screen.getByText("First deployment? Go to")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "initialize admin" })).toHaveAttribute("href", "/setup");
  });

  it("fails closed for password login while keeping Passkey available", () => {
    mocks.useAppStatus.mockReturnValue({
      status: "error",
      data: null,
      error: new Error("status unavailable"),
      isLoading: false,
      isRefreshing: false,
      isReady: false,
      retry: vi.fn(),
    });

    renderLogin();

    expect(screen.getByRole("alert")).toHaveTextContent("Login service is temporarily unavailable");
    expect(screen.getByRole("button", { name: "Log in" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign in with passkey" })).toBeEnabled();
    expect(screen.queryByRole("link", { name: "initialize admin" })).not.toBeInTheDocument();
  });

  it("uses login autofill metadata for email and password fields", () => {
    renderLogin();

    const emailInput = screen.getByLabelText("Email");
    const passwordInput = screen.getByLabelText("Password");
    expect(emailInput).toHaveAttribute("autocomplete", "username webauthn");
    expect(emailInput).toHaveAttribute("inputmode", "email");
    expect(emailInput).toHaveAttribute("enterkeyhint", "next");
    expect(emailInput).toHaveAttribute("autocapitalize", "none");
    expect(emailInput).toHaveAttribute("spellcheck", "false");
    expect(passwordInput).toHaveAttribute("autocomplete", "current-password");
    expect(passwordInput).toHaveAttribute("enterkeyhint", "done");
  });

  it("shows the remember email option checked by default", () => {
    renderLogin();

    expect(screen.getByRole("checkbox", { name: "Remember email" })).toBeChecked();
  });

  it("prefills only the remembered email from localStorage", () => {
    localStorage.setItem(rememberedLoginEmailStorageKey, " alice@example.com ");

    renderLogin();

    expect(screen.getByLabelText("Email")).toHaveValue("alice@example.com");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "Remember email" })).toBeChecked();
  });

  it("remembers the trimmed email only after a successful login", async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText("Email"), " alice@example.com ");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => {
      expect(mocks.signInEmail).toHaveBeenCalledWith({
        email: "alice@example.com",
        password: "password123",
      });
    });
    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBe("alice@example.com");
  });

  it("does not start conditional passkey sign-in after password login has begun", async () => {
    const user = userEvent.setup();
    const availability = createDeferred<boolean>();
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: {
        isConditionalMediationAvailable: vi.fn().mockReturnValue(availability.promise),
      },
    });
    renderLogin();

    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => {
      expect(mocks.signInEmail).toHaveBeenCalled();
    });

    availability.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.signInPasskey).not.toHaveBeenCalled();
    expect(mocks.cancelPasskeyCeremony).toHaveBeenCalled();
    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBe("alice@example.com");
  });

  it("cancels the browser passkey ceremony as soon as password login starts", async () => {
    const user = userEvent.setup();
    const login = createDeferred<Awaited<ReturnType<typeof mocks.signInEmail>>>();
    mocks.signInEmail.mockReturnValueOnce(login.promise);
    renderLogin();

    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => {
      expect(mocks.signInEmail).toHaveBeenCalled();
    });
    expect(mocks.cancelPasskeyCeremony).toHaveBeenCalledTimes(1);

    login.resolve({ error: null });
    await waitFor(() => {
      expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBe("alice@example.com");
    });
    expect(mocks.cancelPasskeyCeremony).toHaveBeenCalledTimes(2);
  });

  it("ignores stale conditional passkey results after password login succeeds", async () => {
    const user = userEvent.setup();
    const passkey = createDeferred<Awaited<ReturnType<typeof mocks.signInPasskey>>>();
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: {
        isConditionalMediationAvailable: vi.fn().mockResolvedValue(true),
      },
    });
    mocks.signInPasskey.mockReturnValue(passkey.promise);
    renderLogin();

    await waitFor(() => {
      expect(mocks.signInPasskey).toHaveBeenCalled();
    });
    const passkeyOptions = mocks.signInPasskey.mock.calls[0]?.[0] as {
      useBrowserAutofill?: boolean;
      shouldPersistSession?: (session: unknown) => boolean;
    };
    expect(passkeyOptions.useBrowserAutofill).toBe(true);
    expect(passkeyOptions.shouldPersistSession).toEqual(expect.any(Function));
    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => {
      expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBe("alice@example.com");
    });

    expect(mocks.cancelPasskeyCeremony).toHaveBeenCalled();
    expect(passkeyOptions.shouldPersistSession?.({})).toBe(false);
    passkey.resolve({
      data: {
        type: "session",
        session: { expiresAt: "2026-07-01T00:00:00.000Z" },
        user: { id: "user-1", email: "passkey@example.com", name: "Passkey", role: "user", banned: false },
      },
      error: null,
      cancelled: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBe("alice@example.com");
    expect(mocks.reportClientError).not.toHaveBeenCalled();
  });

  it("keeps password input focus while a conditional passkey flow is pending", async () => {
    const user = userEvent.setup();
    const passkey = createDeferred<Awaited<ReturnType<typeof mocks.signInPasskey>>>();
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: {
        isConditionalMediationAvailable: vi.fn().mockResolvedValue(true),
      },
    });
    mocks.signInPasskey.mockReturnValue(passkey.promise);
    renderLogin();

    await waitFor(() => {
      expect(mocks.signInPasskey).toHaveBeenCalledTimes(1);
    });
    const passwordInput = screen.getByLabelText("Password");

    await user.click(passwordInput);
    expect(passwordInput).toHaveFocus();
    await user.type(passwordInput, "password123");

    expect(passwordInput).toHaveFocus();
    expect(passwordInput).toHaveValue("password123");
    expect(mocks.signInPasskey).toHaveBeenCalledTimes(1);
  });

  it("cancels the browser passkey ceremony when the login page unmounts", async () => {
    const passkey = createDeferred<Awaited<ReturnType<typeof mocks.signInPasskey>>>();
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: {
        isConditionalMediationAvailable: vi.fn().mockResolvedValue(true),
      },
    });
    mocks.signInPasskey.mockReturnValue(passkey.promise);
    const { unmount } = renderLogin();

    await waitFor(() => {
      expect(mocks.signInPasskey).toHaveBeenCalledTimes(1);
    });
    expect(mocks.cancelPasskeyCeremony).not.toHaveBeenCalled();

    unmount();

    expect(mocks.cancelPasskeyCeremony).toHaveBeenCalledTimes(1);
  });

  it("does not remember the email when login fails", async () => {
    const user = userEvent.setup();
    mocks.signInEmail.mockResolvedValueOnce({ error: new Error("invalid credentials") });
    renderLogin();

    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => {
      expect(mocks.signInEmail).toHaveBeenCalled();
    });
    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBeNull();
  });

  it("opens the MFA dialog without replacing the password form after password verification", async () => {
    const user = userEvent.setup();
    mockPasswordMfa(["totp", "recovery_code"]);
    const { container } = renderLogin();

    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    const dialog = await screen.findByRole("dialog", { name: "Complete sign-in verification" });
    expect(within(dialog).getByText("alice@example.com")).toBeInTheDocument();
    expect(mocks.cancelPasskeyCeremony).toHaveBeenCalled();
    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBeNull();
    expect(container.querySelector("#login-password")).toBeInTheDocument();
    expect(container.querySelector("#login-password")).toHaveValue("");
  });

  it("focuses the MFA code field when the dialog opens", async () => {
    const user = userEvent.setup();
    mockPasswordMfa(["totp", "recovery_code"]);
    renderLogin();

    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    const dialog = await screen.findByRole("dialog", { name: "Complete sign-in verification" });
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Code")).toHaveFocus();
    });

    const totpMethodButton = within(dialog).getByRole("button", { name: "Authenticator code" });
    const recoveryMethodButton = within(dialog).getByRole("button", { name: "Recovery code" });
    const methodSelector = totpMethodButton.parentElement;
    if (!methodSelector) throw new Error("Missing MFA method selector");
    expect(methodSelector).toHaveClass("grid", "grid-cols-1", "gap-3", "min-[420px]:grid-cols-2");
    expect(totpMethodButton).toHaveClass("min-h-12", "min-w-0", "px-3");
    expect(recoveryMethodButton).toHaveClass("min-h-12", "min-w-0", "px-3");
    expect(totpMethodButton).toHaveAttribute("aria-pressed", "true");
    expect(recoveryMethodButton).toHaveAttribute("aria-pressed", "false");

    await user.click(recoveryMethodButton);
    expect(totpMethodButton).toHaveAttribute("aria-pressed", "false");
    expect(recoveryMethodButton).toHaveAttribute("aria-pressed", "true");
  });

  it("closes the MFA dialog and returns focus to the password field", async () => {
    const user = userEvent.setup();
    mockPasswordMfa(["totp"]);
    const { container } = renderLogin();

    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    const dialog = await screen.findByRole("dialog", { name: "Complete sign-in verification" });
    expect(within(dialog).queryByRole("button", { name: "Back to password login" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Complete sign-in verification" })).not.toBeInTheDocument();
    });
    expect(container.querySelector("#login-password")).toHaveFocus();
  });

  it("requires the explicit close button for the MFA dialog", async () => {
    const user = userEvent.setup();
    mockPasswordMfa(["totp"]);
    renderLogin();

    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    const dialog = await screen.findByRole("dialog", { name: "Complete sign-in verification" });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Complete sign-in verification" })).toBeInTheDocument();

    await user.click(getTopDialogOverlay());
    expect(screen.getByRole("dialog", { name: "Complete sign-in verification" })).toBeInTheDocument();

    fireEvent.focusIn(screen.getByLabelText("Password"));
    expect(screen.getByRole("dialog", { name: "Complete sign-in verification" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Complete sign-in verification" })).not.toBeInTheDocument();
    });
  });

  it("verifies TOTP with the in-memory ticket and remembers the email only after MFA succeeds", async () => {
    const user = userEvent.setup();
    mockPasswordMfa(["totp"]);
    renderLogin();

    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    const dialog = await screen.findByRole("dialog", { name: "Complete sign-in verification" });
    await user.type(within(dialog).getByLabelText("Code"), "123456");
    await user.click(within(dialog).getByRole("button", { name: "Verify and sign in" }));

    await waitFor(() => {
      expect(mocks.verifyMfa).toHaveBeenCalledTimes(1);
    });
    const [body, options] = getVerifyMfaCall();
    expect(body).toEqual({
      method: "totp",
      ticketId: "ticket-1",
      code: "123456",
    });
    expect(getShouldPersistSession(options)).toEqual(expect.any(Function));
    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBe("alice@example.com");
  });

  it("verifies recovery codes from the MFA dialog", async () => {
    const user = userEvent.setup();
    mockPasswordMfa(["totp", "recovery_code"]);
    renderLogin();

    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    const dialog = await screen.findByRole("dialog", { name: "Complete sign-in verification" });

    await user.click(within(dialog).getByRole("button", { name: "Recovery code" }));
    await user.type(within(dialog).getByLabelText("Recovery code"), "ABCD-EFGH-IJKL");
    await user.click(within(dialog).getByRole("button", { name: "Verify and sign in" }));

    await waitFor(() => {
      expect(mocks.verifyMfa).toHaveBeenCalledTimes(1);
    });
    const [body, options] = getVerifyMfaCall();
    expect(body).toEqual({
      method: "recovery_code",
      ticketId: "ticket-1",
      code: "ABCD-EFGH-IJKL",
    });
    expect(getShouldPersistSession(options)).toEqual(expect.any(Function));
  });

  it("uses passkey sign-in without creating an MFA ticket", async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole("button", { name: "Sign in with passkey" }));

    await waitFor(() => {
      expect(mocks.signInPasskey).toHaveBeenCalledTimes(1);
    });
    expect(mocks.signInEmail).not.toHaveBeenCalled();
    expect(mocks.verifyMfa).not.toHaveBeenCalled();
    expect(mocks.cancelPasskeyCeremony).toHaveBeenCalled();
    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBe("passkey@example.com");
  });

  it("keeps explicit passkey cancellation neutral without reporting a login failure", async () => {
    const user = userEvent.setup();
    const passkey = createDeferred<Awaited<ReturnType<typeof mocks.signInPasskey>>>();
    mocks.signInPasskey.mockReturnValueOnce(passkey.promise);
    renderLogin();

    await user.click(screen.getByRole("button", { name: "Sign in with passkey" }));
    await waitFor(() => {
      expect(mocks.signInPasskey).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Verifying passkey..." })).toBeDisabled();
    });

    passkey.resolve({ data: null, error: null, cancelled: true });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in with passkey" })).toBeEnabled();
    });
    expect(mocks.signInEmail).not.toHaveBeenCalled();
    expect(mocks.verifyMfa).not.toHaveBeenCalled();
    expect(mocks.reportClientError).not.toHaveBeenCalled();
    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBeNull();
  });

  it("keeps passkey sign-in independent from MFA verification after password verification", async () => {
    const user = userEvent.setup();
    mockPasswordMfa(["totp"]);
    renderLogin();

    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    const dialog = await screen.findByRole("dialog", { name: "Complete sign-in verification" });
    await user.click(within(dialog).getByRole("button", { name: "Sign in with passkey" }));

    await waitFor(() => {
      expect(mocks.signInPasskey).toHaveBeenCalledTimes(1);
    });
    expect(mocks.verifyMfa).not.toHaveBeenCalled();
  });

  it("keeps the MFA dialog state when passkey sign-in is cancelled from MFA verification", async () => {
    const user = userEvent.setup();
    mockPasswordMfa(["totp"]);
    mocks.signInPasskey.mockResolvedValueOnce({ data: null, error: null, cancelled: true });
    renderLogin();

    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    const dialog = await screen.findByRole("dialog", { name: "Complete sign-in verification" });

    await user.type(within(dialog).getByLabelText("Code"), "123456");
    await user.click(within(dialog).getByRole("button", { name: "Sign in with passkey" }));

    await waitFor(() => {
      expect(mocks.signInPasskey).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole("dialog", { name: "Complete sign-in verification" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Code")).toHaveValue("123456");
    expect(mocks.verifyMfa).not.toHaveBeenCalled();
    expect(mocks.reportClientError).not.toHaveBeenCalled();
    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBeNull();
  });

  it("ignores stale MFA verification results after the dialog is closed", async () => {
    const user = userEvent.setup();
    const verification = createDeferred<Awaited<ReturnType<typeof mocks.verifyMfa>>>();
    mocks.verifyMfa.mockReturnValueOnce(verification.promise);
    mockPasswordMfa(["totp"]);
    renderLogin();

    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    const dialog = await screen.findByRole("dialog", { name: "Complete sign-in verification" });

    await user.type(within(dialog).getByLabelText("Code"), "123456");
    await user.click(within(dialog).getByRole("button", { name: "Verify and sign in" }));
    const [, verifyOptions] = getVerifyMfaCall();
    const shouldPersistSession = getShouldPersistSession(verifyOptions);
    expect(shouldPersistSession({})).toBe(true);

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(shouldPersistSession({})).toBe(false);
    verification.resolve({ data: { type: "session" }, error: null });
    await Promise.resolve();
    await Promise.resolve();

    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBeNull();
    expect(mocks.reportClientError).not.toHaveBeenCalled();
  });

  it("clears the remembered email when unchecked and does not write it back on login", async () => {
    const user = userEvent.setup();
    localStorage.setItem(rememberedLoginEmailStorageKey, "alice@example.com");
    renderLogin();

    await user.click(screen.getByRole("checkbox", { name: "Remember email" }));
    expect(screen.getByRole("checkbox", { name: "Remember email" })).not.toBeChecked();
    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBeNull();

    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => {
      expect(mocks.signInEmail).toHaveBeenCalled();
    });
    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBeNull();
  });

  it("does not restore the remembered email merely by checking the box again", async () => {
    const user = userEvent.setup();
    localStorage.setItem(rememberedLoginEmailStorageKey, "alice@example.com");
    renderLogin();

    await user.click(screen.getByRole("checkbox", { name: "Remember email" }));
    await user.click(screen.getByRole("checkbox", { name: "Remember email" }));

    expect(screen.getByRole("checkbox", { name: "Remember email" })).toBeChecked();
    expect(localStorage.getItem(rememberedLoginEmailStorageKey)).toBeNull();
  });

  it("uses form errors instead of native validation for empty credentials", async () => {
    const user = userEvent.setup();
    const { container } = renderLogin();

    expect(container.querySelector("form")).toHaveAttribute("novalidate");

    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(screen.getByText("Enter your email address")).toBeInTheDocument();
    expect(screen.getByText("Enter your password")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(mocks.signInEmail).not.toHaveBeenCalled();
  });

  it("does not treat the display name as a login identifier", async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText("Email"), "Admin");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(screen.getByText("Enter a valid email address")).toBeInTheDocument();
    expect(mocks.signInEmail).not.toHaveBeenCalled();
  });
});
