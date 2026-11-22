// 添加到日历弹窗测试锁住一次性 ICS 下载不再依赖浏览器端序列化。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import { AddToCalendarDialog } from "./add-to-calendar-dialog";

type AppToast = (typeof import("@/components/ui/sonner"))["toast"];

const mocks = vi.hoisted(() => ({
  createCalendarFeed: vi.fn(),
  deleteCalendarFeed: vi.fn(),
  downloadFile: vi.fn(),
  downloadSubscriptionIcs: vi.fn(),
  getCalendarFeed: vi.fn(),
  rotateCalendarFeed: vi.fn(),
  toastError: vi.fn<AppToast["error"]>(),
  toastSuccess: vi.fn<AppToast["success"]>(),
}));
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalWindowOpen = window.open;
const createdCalendarFeed = {
  enabled: true,
  createdAt: "2026-05-18T00:00:00.000Z",
  updatedAt: "2026-05-18T00:00:00.000Z",
  feedUrl: "https://example.com/calendar/renewals.ics?token=secret",
};

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({
    config: {
      categories: [{
        id: "productivity",
        value: "productivity",
        labels: { "zh-CN": "效率工具", "en-US": "Productivity" },
      }],
      statuses: [],
      paymentMethods: [{
        id: "credit-card",
        value: "credit_card",
        labels: { "zh-CN": "信用卡", "en-US": "Credit Card" },
      }],
      currencies: [],
    },
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: { notificationReminderDays: 5 },
  }),
}));

vi.mock("@/services/calendar-feed-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/calendar-feed-service")>();
  return {
    ...actual,
    calendarFeedService: {
      create: mocks.createCalendarFeed,
      delete: mocks.deleteCalendarFeed,
      downloadSubscriptionIcs: mocks.downloadSubscriptionIcs,
      get: mocks.getCalendarFeed,
      list: vi.fn(),
      rotate: mocks.rotateCalendarFeed,
    },
  };
});

vi.mock("@/shared/browser/download-file", () => ({
  downloadFile: mocks.downloadFile,
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

const subscription: Subscription = {
  id: "sub-1",
  name: "Fastmail",
  logo: undefined,
  price: "5",
  currency: "USD",
  billingCycle: "monthly",
  customDays: undefined,
  customCycleUnit: undefined,
  oneTimeTermCount: undefined,
  oneTimeTermUnit: undefined,
  category: "productivity",
  status: "active",
  paymentMethod: "credit_card",
  startDate: assertDateOnly("2026-05-15"),
  nextBillingDate: assertDateOnly("2026-06-15"),
  autoRenew: false,
  autoCalculateNextBillingDate: true,
  trialEndDate: undefined,
  website: "https://fastmail.example",
  notes: "Team plan",
  tags: [],
  reminderDays: 7,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
  pinned: false,
  publicHidden: false,
};

function renderDialog(value: Subscription = subscription) {
  return renderCalendarDialog({ subscription: value, loadingPreview: value });
}

function renderCalendarDialog({
  subscription: value,
  loadingPreview,
  loading = false,
}: {
  subscription: Subscription | null;
  loadingPreview: Subscription | null;
  loading?: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AddToCalendarDialog
        open
        onOpenChange={vi.fn()}
        subscription={value}
        loadingPreview={loadingPreview}
        loading={loading}
      />
    </QueryClientProvider>,
  );
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function mockUserAgent(userAgent: string) {
  const descriptor = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: userAgent });
  return () => {
    if (descriptor) Object.defineProperty(window.navigator, "userAgent", descriptor);
    else Reflect.deleteProperty(window.navigator, "userAgent");
  };
}

function mockMobileViewport() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 639px)",
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

function withoutRandomUUID(callback: () => void) {
  const cryptoObject = window.crypto;
  const descriptor = Object.getOwnPropertyDescriptor(cryptoObject, "randomUUID");
  Object.defineProperty(cryptoObject, "randomUUID", { configurable: true, value: undefined });
  try {
    callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(cryptoObject, "randomUUID", descriptor);
    } else {
      Reflect.deleteProperty(cryptoObject, "randomUUID");
    }
  }
}

describe("AddToCalendarDialog", () => {
  beforeEach(() => {
    mocks.createCalendarFeed.mockReset();
    mocks.deleteCalendarFeed.mockReset();
    mocks.downloadFile.mockReset();
    mocks.downloadSubscriptionIcs.mockReset();
    mocks.getCalendarFeed.mockReset();
    mocks.rotateCalendarFeed.mockReset();
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.createCalendarFeed.mockResolvedValue(createdCalendarFeed);
    mocks.deleteCalendarFeed.mockResolvedValue(undefined);
    mocks.getCalendarFeed.mockResolvedValue({ enabled: false });
    mocks.rotateCalendarFeed.mockResolvedValue(createdCalendarFeed);
    mocks.downloadSubscriptionIcs.mockResolvedValue(new Blob(["BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"], { type: "text/calendar;charset=utf-8" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
      headers: { "content-type": "text/calendar; charset=utf-8" },
    })));
  });

  afterEach(() => {
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    if (originalExecCommandDescriptor) {
      Object.defineProperty(document, "execCommand", originalExecCommandDescriptor);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
    if (originalMatchMediaDescriptor) {
      Object.defineProperty(window, "matchMedia", originalMatchMediaDescriptor);
    } else {
      Reflect.deleteProperty(window, "matchMedia");
    }
    Object.defineProperty(window, "open", { configurable: true, value: originalWindowOpen });
    vi.unstubAllGlobals();
  });

  it("renders without crypto.randomUUID", () => {
    withoutRandomUUID(() => {
      renderDialog();
    });

    expect(screen.getByRole("dialog", { name: "添加到日历" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 ICS 文件" })).toBeInTheDocument();
  });

  it("uses a fixed desktop frame and focuses the static title first", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "添加到日历" });
    const title = within(dialog).getByRole("heading", { name: "添加到日历" });
    const header = title.parentElement;
    const scrollRegions = dialog.querySelectorAll('[data-dialog-scroll-region="subscription-calendar"]');

    expect(dialog).toHaveClass("h5-dialog-frame", "gap-0", "p-0");
    expect(header).toHaveClass("shrink-0");
    expect(scrollRegions).toHaveLength(1);
    expect(scrollRegions[0]).toHaveClass("h5-mobile-sheet-scroll", "min-h-0", "flex-1", "content-start");
    expect(scrollRegions[0]?.parentElement).toBe(dialog);
    expect(title).toHaveAttribute("tabindex", "-1");
    expect(title).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("uses one fixed-height mobile drawer with the scaffold as its scrollport", () => {
    mockMobileViewport();
    renderDialog();

    const drawer = screen.getByRole("dialog", { name: "添加到日历" });
    const title = within(drawer).getByRole("heading", { name: "添加到日历" });
    const header = title.parentElement?.parentElement?.parentElement;
    const scrollRegions = drawer.querySelectorAll('[data-dialog-scroll-region="subscription-calendar"]');

    expect(drawer).toHaveClass("h-[calc(var(--app-viewport-height)-1rem)]", "overflow-hidden");
    expect(header).toHaveClass("shrink-0");
    expect(scrollRegions).toHaveLength(1);
    expect(scrollRegions[0]).toHaveClass("h5-mobile-sheet-scroll", "min-h-0", "flex-1", "content-start");
    expect(scrollRegions[0]?.parentElement).toBe(drawer);
  });

  it("keeps one dialog shell while detail data replaces the loading state", () => {
    const onOpenChange = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <AddToCalendarDialog
          open
          onOpenChange={onOpenChange}
          subscription={null}
          loadingPreview={subscription}
          loading
        />
      </QueryClientProvider>,
    );
    const loadingDialog = screen.getByRole("dialog", { name: "添加到日历" });
    const loadingHeader = within(loadingDialog).getByRole("heading", { name: "添加到日历" }).parentElement;
    const scrollRegion = loadingDialog.querySelector('[data-dialog-scroll-region="subscription-calendar"]');
    const factsRegion = loadingDialog.querySelector('[data-dialog-region="calendar-facts"]');
    expect(scrollRegion).not.toBeNull();
    expect(loadingHeader).toHaveClass("shrink-0");
    expect(screen.getByTestId("subscription-calendar-data-loading")).toBeInTheDocument();

    rerender(
      <QueryClientProvider client={queryClient}>
        <AddToCalendarDialog
          open
          onOpenChange={onOpenChange}
          subscription={subscription}
          loadingPreview={subscription}
          loading={false}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("dialog", { name: "添加到日历" })).toBe(loadingDialog);
    expect(within(loadingDialog).getByRole("heading", { name: "添加到日历" }).parentElement).toBe(loadingHeader);
    expect(loadingDialog.querySelector('[data-dialog-scroll-region="subscription-calendar"]')).toBe(scrollRegion);
    expect(loadingDialog.querySelector('[data-dialog-region="calendar-facts"]')).toBe(factsRegion);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByTestId("subscription-calendar-data-loading")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 ICS 文件" })).toBeInTheDocument();
  });

  it("keeps independent calendar actions available while the feed status is loading", async () => {
    const feedStatus = createDeferred<{ enabled: false }>();
    mocks.getCalendarFeed.mockReturnValueOnce(feedStatus.promise);
    renderDialog();

    expect(screen.getByTestId("subscription-calendar-feed-status-loading")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成订阅链接" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在系统日历中订阅" })).not.toBeInTheDocument();
    expect(screen.queryByText("正在生成订阅链接...")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 ICS 文件" })).toBeEnabled();
    expect(await screen.findByRole("link", { name: "用 Google Calendar 打开" })).toBeInTheDocument();

    feedStatus.resolve({ enabled: false });

    await waitFor(() => expect(screen.queryByTestId("subscription-calendar-feed-status-loading")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "生成订阅链接" })).toBeEnabled();
  });

  it("offers an explicit retry when the feed status fails without cached data", async () => {
    const retryFeedStatus = createDeferred<void>();
    mocks.getCalendarFeed
      .mockRejectedValueOnce(new Error("status failed"))
      .mockReturnValueOnce(retryFeedStatus.promise.then(() => ({ enabled: false })));

    renderDialog();

    expect(await screen.findByRole("alert")).toHaveTextContent("订阅链接状态加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

    expect(mocks.getCalendarFeed).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "正在重新加载..." })).toBeDisabled();
    expect(mocks.createCalendarFeed).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "生成订阅链接" })).not.toBeInTheDocument();

    retryFeedStatus.resolve();
    expect(await screen.findByRole("button", { name: "生成订阅链接" })).toBeEnabled();
  });

  it("generates a feed without opening the system calendar and keeps one-time actions independent", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const createFeed = createDeferred<typeof createdCalendarFeed>();
    Object.defineProperty(window, "open", { configurable: true, value: open });
    mocks.createCalendarFeed.mockReturnValueOnce(createFeed.promise);

    renderDialog();

    await screen.findByRole("button", { name: "生成订阅链接" });
    expect(screen.getByText("为「Fastmail」选择持续同步，或单次添加到日历。")).toBeInTheDocument();
    expect(screen.getByText("2026年6月15日")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "持续同步" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "单次添加" })).toBeInTheDocument();
    expect(screen.getByText("下载 ICS 和在线日历服务是独立的一次性添加，无需生成订阅链接。")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "用 Google Calendar 打开" })).toHaveAttribute(
      "href",
      expect.stringContaining("calendar.google.com"),
    );
    expect(screen.getByRole("link", { name: "用 Outlook.com 打开" })).not.toHaveClass("bg-primary");
    expect(screen.getByRole("link", { name: "用 Office 365 打开" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "用 Yahoo Calendar 打开" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "生成订阅链接" }));

    expect(await screen.findByRole("button", { name: "正在生成订阅链接..." })).toBeDisabled();
    expect(mocks.createCalendarFeed).toHaveBeenCalledWith({ scope: "subscription", subscriptionId: "sub-1" });

    createFeed.resolve(createdCalendarFeed);
    await waitFor(() => expect(screen.getByLabelText("本次订阅 URL")).toHaveValue(createdCalendarFeed.feedUrl));
    expect(open).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "重新生成订阅链接" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 ICS 文件" })).toBeEnabled();
  });

  it("keeps feed generation failure recoverable without disabling one-time actions", async () => {
    mocks.createCalendarFeed.mockRejectedValueOnce(new Error("create failed"));
    renderDialog();

    const generateButton = await screen.findByRole("button", { name: "生成订阅链接" });
    fireEvent.click(generateButton);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("订阅链接生成失败"));
    expect(generateButton).toBeEnabled();
    expect(screen.queryByLabelText("本次订阅 URL")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 ICS 文件" })).toBeEnabled();
    expect(await screen.findByRole("link", { name: "用 Google Calendar 打开" })).toBeInTheDocument();
  });

  it("uses an existing feed without generating another token", async () => {
    const open = vi.fn();
    const validateFeed = createDeferred<Response>();
    Object.defineProperty(window, "open", { configurable: true, value: open });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(validateFeed.promise));
    mocks.getCalendarFeed.mockResolvedValueOnce({
      enabled: true,
      feedUrl: "https://example.com/calendar/renewals.ics?token=existing",
    });

    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "在系统日历中订阅" }));

    expect(screen.getByRole("button", { name: "正在打开系统日历..." })).toBeDisabled();
    expect(screen.queryByText("正在生成订阅链接...")).not.toBeInTheDocument();
    validateFeed.resolve(new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
      headers: { "content-type": "text/calendar; charset=utf-8" },
    }));

    await waitFor(() => expect(open).toHaveBeenCalledWith(
      "webcal://example.com/calendar/renewals.ics?token=existing",
      "_self",
    ));
    expect(screen.getByLabelText("本次订阅 URL")).toHaveValue("https://example.com/calendar/renewals.ics?token=existing");
    expect(screen.queryByRole("button", { name: "生成订阅链接" })).not.toBeInTheDocument();
    expect(mocks.createCalendarFeed).not.toHaveBeenCalled();
  });

  it("does not open the system calendar when feed preflight returns HTML", async () => {
    const open = vi.fn();
    Object.defineProperty(window, "open", { configurable: true, value: open });
    const fetchMock = vi.fn().mockResolvedValue(new Response("<html></html>", {
      headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.getCalendarFeed.mockResolvedValueOnce({
      enabled: true,
      feedUrl: "http://localhost:5173/calendar/renewals.ics?token=existing",
    });

    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "在系统日历中订阅" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5173/calendar/renewals.ics?token=existing",
      {
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "text/calendar,*/*;q=0.1" },
      },
    ));
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps regeneration pending in the confirmation dialog and prevents duplicate submission", async () => {
    const user = userEvent.setup();
    const rotateFeed = createDeferred<typeof createdCalendarFeed>();
    const regeneratedFeed = {
      ...createdCalendarFeed,
      feedUrl: "https://example.com/calendar/renewals.ics?token=regenerated",
    };
    mocks.getCalendarFeed.mockResolvedValueOnce({
      enabled: true,
      feedUrl: "https://example.com/calendar/renewals.ics?token=existing",
    });
    mocks.rotateCalendarFeed.mockReturnValueOnce(rotateFeed.promise);

    renderDialog();
    const trigger = await screen.findByRole("button", { name: "重新生成订阅链接" });
    await user.click(trigger);
    const confirmDialog = screen.getByRole("alertdialog", { name: "重新生成这个订阅链接？" });
    await user.click(within(confirmDialog).getByRole("button", { name: "重新生成订阅链接" }));

    const pendingAction = await within(confirmDialog).findByRole("button", { name: "正在重新生成..." });
    expect(pendingAction).toBeDisabled();
    expect(within(confirmDialog).getByRole("button", { name: "取消" })).toBeDisabled();
    fireEvent.click(pendingAction);
    expect(mocks.rotateCalendarFeed).toHaveBeenCalledTimes(1);
    expect(mocks.rotateCalendarFeed).toHaveBeenCalledWith({ scope: "subscription", subscriptionId: "sub-1" });
    expect(screen.getByRole("alertdialog", { name: "重新生成这个订阅链接？" })).toBeInTheDocument();
    expect(screen.getByLabelText("本次订阅 URL")).toHaveValue("https://example.com/calendar/renewals.ics?token=existing");

    rotateFeed.resolve(regeneratedFeed);
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "重新生成这个订阅链接？" })).not.toBeInTheDocument());
    expect(screen.getByLabelText("本次订阅 URL")).toHaveValue(regeneratedFeed.feedUrl);
    expect(trigger).toHaveFocus();
  });

  it("keeps a failed regeneration recoverable in the confirmation dialog", async () => {
    mocks.getCalendarFeed.mockResolvedValueOnce({
      enabled: true,
      feedUrl: "https://example.com/calendar/renewals.ics?token=existing",
    });
    mocks.rotateCalendarFeed
      .mockRejectedValueOnce(new Error("rotate failed"))
      .mockResolvedValueOnce(createdCalendarFeed);

    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "重新生成订阅链接" }));
    const confirmDialog = screen.getByRole("alertdialog", { name: "重新生成这个订阅链接？" });
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "重新生成订阅链接" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("订阅链接重新生成失败"));
    expect(screen.getByRole("alertdialog", { name: "重新生成这个订阅链接？" })).toBeInTheDocument();
    expect(within(confirmDialog).getByRole("button", { name: "重新生成订阅链接" })).toBeEnabled();
    expect(within(confirmDialog).getByRole("button", { name: "取消" })).toBeEnabled();

    fireEvent.click(within(confirmDialog).getByRole("button", { name: "重新生成订阅链接" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "重新生成这个订阅链接？" })).not.toBeInTheDocument());
    expect(mocks.rotateCalendarFeed).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("本次订阅 URL")).toHaveValue(createdCalendarFeed.feedUrl);
  });

  it("revokes an existing feed while preserving all one-time actions", async () => {
    mocks.getCalendarFeed.mockResolvedValueOnce({
      enabled: true,
      feedUrl: "https://example.com/calendar/renewals.ics?token=existing",
    });

    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "撤销订阅链接" }));
    const confirmDialog = screen.getByRole("alertdialog", { name: "撤销这个订阅链接？" });
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "撤销订阅链接" }));

    await waitFor(() => expect(mocks.deleteCalendarFeed).toHaveBeenCalledWith({
      scope: "subscription",
      subscriptionId: "sub-1",
    }));
    const generateButton = await screen.findByRole("button", { name: "生成订阅链接" });
    await waitFor(() => expect(generateButton).toHaveFocus());
    expect(screen.getByRole("button", { name: "下载 ICS 文件" })).toBeEnabled();
    expect(await screen.findByRole("link", { name: "用 Google Calendar 打开" })).toBeInTheDocument();
  });

  it("returns focus to the existing revoke trigger after cancellation", async () => {
    const user = userEvent.setup();
    mocks.getCalendarFeed.mockResolvedValueOnce({
      enabled: true,
      feedUrl: "https://example.com/calendar/renewals.ics?token=existing",
    });

    renderDialog();
    const trigger = await screen.findByRole("button", { name: "撤销订阅链接" });
    await user.click(trigger);
    const confirmDialog = screen.getByRole("alertdialog", { name: "撤销这个订阅链接？" });
    await user.click(within(confirmDialog).getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "撤销这个订阅链接？" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("uses an Android insert intent for the one-off calendar event", async () => {
    const restoreUserAgent = mockUserAgent(
      "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36",
    );
    try {
      renderDialog();

      const link = await screen.findByRole("link", { name: "添加单次事件到 Android 日历" });
      expect(link).toHaveAttribute("href", expect.stringContaining("intent://renewlet/calendar-event#Intent;"));
      expect(link).toHaveAttribute("href", expect.stringContaining("action=android.intent.action.INSERT"));
      expect(link).toHaveAttribute("href", expect.stringContaining("type=vnd.android.cursor.dir/event"));
      expect(link).toHaveAttribute("href", expect.stringContaining("S.title=Fastmail"));
    } finally {
      restoreUserAgent();
    }
  });

  it("renders fixed-term one-time subscriptions as expiry events", () => {
    const fixedTerm: Subscription = {
      ...subscription,
      billingCycle: "one-time",
      customDays: undefined,
      customCycleUnit: undefined,
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
      autoRenew: false,
      autoCalculateNextBillingDate: false,
    };

    renderDialog(fixedTerm);

    expect(screen.getByRole("dialog", { name: "添加到期日历" })).toBeInTheDocument();
    expect(screen.getByText("为「Fastmail」选择持续同步，或单次添加这次服务到期。")).toBeInTheDocument();
    expect(screen.getByText("2026年6月15日")).toBeInTheDocument();
  });

  it("downloads one-off ICS through the authenticated calendar service", async () => {
    const icsBlob = new Blob(["BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"], { type: "text/calendar;charset=utf-8" });
    mocks.downloadSubscriptionIcs.mockResolvedValueOnce(icsBlob);

    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "下载 ICS 文件" }));

    await waitFor(() => expect(mocks.downloadSubscriptionIcs).toHaveBeenCalledWith("sub-1"));
    expect(mocks.downloadFile).toHaveBeenCalledWith(icsBlob, "renewlet-sub-1.ics");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("ICS 文件已生成");
  });

  it("shows a recoverable toast when one-off ICS download fails", async () => {
    mocks.downloadSubscriptionIcs.mockRejectedValueOnce(new Error("download failed"));

    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "下载 ICS 文件" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("ICS 文件生成失败"));
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "添加到日历" })).toBeInTheDocument();
  });

  it("shows a localized copy failure instead of leaking missing Clipboard API errors", async () => {
    mocks.getCalendarFeed.mockResolvedValueOnce({
      enabled: true,
      feedUrl: "https://example.com/calendar/renewals.ics?token=secret",
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });

    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "复制 URL" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("订阅 URL 复制失败", {
      description: "当前一键复制不可用，请手动选择并复制本次 URL。",
    }));
    expect(mocks.toastError).not.toHaveBeenCalledWith(expect.stringContaining("writeText"));
    expect(screen.getByLabelText("本次订阅 URL")).toHaveFocus();
  });
});
