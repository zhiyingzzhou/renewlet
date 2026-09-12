// 导入 Logo 编辑器测试保护“暂存资产先预览、apply 时再持久化”的导入边界。
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ImportLogoEditor } from "./import-logo-editor";

type MediaCandidateResolve = typeof import("@/services/media-candidate-service").mediaCandidateService.resolve;

const mocks = vi.hoisted(() => ({
  loadUploadedLogosInitial: vi.fn<() => Promise<void>>(),
  loadUploadedLogosMore: vi.fn<() => Promise<void>>(),
  resetUploadedLogos: vi.fn<() => void>(),
  resolveMediaCandidates: vi.fn<MediaCandidateResolve>(),
}));

vi.mock("@/services/media-candidate-service", () => ({
  mediaCandidateService: {
    resolve: mocks.resolveMediaCandidates,
  },
}));

vi.mock("@/hooks/use-uploaded-logo-assets", () => ({
  useUploadedLogoAssets: () => ({
    assets: [],
    error: null,
    hasLoaded: true,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    loadInitial: mocks.loadUploadedLogosInitial,
    loadMore: mocks.loadUploadedLogosMore,
    reset: mocks.resetUploadedLogos,
  }),
}));

function mockMatchMedia(matchesByQuery: Record<string, boolean> = {}) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: matchesByQuery[query] ?? false,
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

function renderWithTooltipProvider(ui: ReactNode) {
  return render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

describe("ImportLogoEditor", () => {
  beforeEach(() => {
    mocks.loadUploadedLogosInitial.mockReset();
    mocks.loadUploadedLogosMore.mockReset();
    mocks.resetUploadedLogos.mockReset();
    mocks.loadUploadedLogosInitial.mockResolvedValue(undefined);
    mocks.loadUploadedLogosMore.mockResolvedValue(undefined);
    mocks.resolveMediaCandidates.mockReset();
    mocks.resolveMediaCandidates.mockResolvedValue({
      items: [{
        id: "search",
        autoCandidate: null,
        candidates: {
          best: null,
          builtIn: [],
          appStore: [],
          favicon: [],
        },
      }],
    });
  });

  it("uses a dedicated tall mobile sheet and scroll viewport for import Logo editing", async () => {
    const user = userEvent.setup();
    mockMatchMedia({ "(max-width: 767px)": true });

    renderWithTooltipProvider(
      <ImportLogoEditor
        name="Apple"
        value={null}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "修改 Logo" }));

    const sheet = await screen.findByTestId("import-logo-sheet");
    expect(sheet).toHaveClass(
      "media-candidate-popover-import",
      "h5-logo-sheet",
      "h5-import-logo-sheet",
      "h5-mobile-sheet-content",
      "h5-mobile-sheet-large",
    );
    expect(sheet).toHaveAttribute("data-vaul-drawer");
    expect(sheet.querySelector("[data-vaul-handle]")).not.toBeNull();
    expect(sheet.querySelector(".h5-import-logo-panel")).not.toBeNull();
    expect(sheet.querySelector(".h5-import-logo-tabs")).not.toBeNull();
    expect(screen.getByTestId("import-logo-search-results")).toHaveClass(
      "media-candidate-scroll-viewport",
      "h5-logo-sheet-results",
      "h5-import-logo-results",
    );

    await user.click(screen.getByRole("tab", { name: "已上传" }));
    expect(screen.getByTestId("import-uploaded-logo-results")).toHaveClass(
      "media-candidate-scroll-viewport",
      "h5-logo-sheet-results",
      "h5-import-logo-results",
    );
    expect(screen.getByRole("tab", { name: "链接" })).toBeInTheDocument();
  });

  it("keeps the sheet close icon distinct from the clear Logo action", async () => {
    const user = userEvent.setup();
    mockMatchMedia({ "(max-width: 767px)": true });

    renderWithTooltipProvider(
      <ImportLogoEditor
        name="Apple"
        value="https://example.com/apple.svg"
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "修改 Logo" }));

    expect(await screen.findByRole("button", { name: "关闭" })).toBeInTheDocument();
    const clearLogoButton = screen.getByRole("button", { name: "清除 Logo" });
    expect(clearLogoButton.querySelector(".lucide-image-off")).not.toBeNull();

    await user.hover(clearLogoButton);

    expect(await screen.findByRole("tooltip")).toHaveTextContent("清除 Logo");
  });

  it("renders the trigger and sheet preview on the unified subscription logo surface", async () => {
    const user = userEvent.setup();
    mockMatchMedia({ "(max-width: 767px)": true });

    renderWithTooltipProvider(
      <ImportLogoEditor
        name="Apple"
        value="https://example.com/apple.svg"
        onChange={vi.fn()}
      />,
    );

    const triggerLogo = screen.getByRole("button", { name: "修改 Logo" }).querySelector(".subscription-logo-tile");
    expect(triggerLogo).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "修改 Logo" }));

    const logo = screen.getAllByAltText("Apple")[0];
    if (!logo) throw new Error("Expected Apple logo preview to render.");
    const logoTile = logo.closest(".subscription-logo-tile");
    if (!logoTile) throw new Error("Expected Apple logo preview to use the subscription logo tile.");

    expect(logo).toHaveClass("subscription-logo-image", "object-contain");
    expect(logo).not.toHaveClass("media-thumbnail-image", "invert", "brightness-125", "mix-blend-screen");
    expect(logoTile).not.toHaveClass("media-thumbnail-canvas");
  });

  it("passes the imported website into manual Logo search candidates", async () => {
    const user = userEvent.setup();
    mockMatchMedia({ "(max-width: 767px)": true });

    renderWithTooltipProvider(
      <ImportLogoEditor
        name="Svix"
        website="https://www.svix.com/"
        value={null}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "修改 Logo" }));

    await screen.findByTestId("import-logo-sheet");
    await waitFor(() => {
      expect(mocks.resolveMediaCandidates).toHaveBeenCalledWith({
        kind: "logo",
        mode: "search",
        items: [{ id: "search", name: "Svix", website: "https://www.svix.com/" }],
        limit: 32,
      }, expect.any(AbortSignal));
    });
  });

  it("keeps the import Logo editor open when the search button is clicked", async () => {
    const user = userEvent.setup();
    mockMatchMedia({ "(max-width: 767px)": true });

    renderWithTooltipProvider(
      <ImportLogoEditor
        name="Apple"
        value={null}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "修改 Logo" }));
    const sheet = await screen.findByTestId("import-logo-sheet");
    const input = within(sheet).getByPlaceholderText("输入服务名称、品牌或网址...");
    await user.clear(input);
    await user.type(input, "YouTube");
    await user.click(within(sheet).getByRole("button", { name: "搜索" }));

    expect(screen.getByTestId("import-logo-sheet")).toBe(sheet);
    expect(input).toHaveValue("YouTube");
  });

  it("applies a custom Logo link without carrying a deferred asset", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockMatchMedia({ "(max-width: 767px)": true });

    renderWithTooltipProvider(
      <ImportLogoEditor
        name="Apple"
        value={null}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "修改 Logo" }));
    await user.click(screen.getByRole("tab", { name: "链接" }));
    await user.type(screen.getByPlaceholderText("https://example.com/logo.svg"), "https://example.com/apple.svg");
    await user.click(screen.getByRole("button", { name: "使用链接" }));

    expect(onChange).toHaveBeenCalledWith("https://example.com/apple.svg");
  });

  it("shows custom Logo link validation only after submitting in the import editor", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockMatchMedia({ "(max-width: 767px)": true });

    renderWithTooltipProvider(
      <ImportLogoEditor
        name="Apple"
        value={null}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "修改 Logo" }));
    await user.click(screen.getByRole("tab", { name: "链接" }));
    const input = screen.getByPlaceholderText("https://example.com/logo.svg");
    await user.type(input, "ftp://example.com/apple.svg");

    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("Logo 链接只支持 http:// 或 https://")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "使用链接" }));

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(await screen.findByText("Logo 链接只支持 http:// 或 https://")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
