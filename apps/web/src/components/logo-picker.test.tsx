// LogoPicker 测试覆盖私有资产、远端 URL、内置候选和上传状态，防止订阅 logo 契约回退到 data URL。
import type { ReactNode } from "react";
import { render as renderComponent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IMAGE_UPLOAD_ACCEPT } from "@/lib/upload-constraints";
import { LogoPicker } from "./logo-picker";

type ApiFetchMock = (
  url: string,
  responseSchema: unknown,
  init?: RequestInit & { signal?: AbortSignal },
) => Promise<unknown>;

type UploadedLogoAssetFixture = {
  id: string;
  url: string;
  kind: "logo";
  originalName?: string;
};

type UploadedLogosStateFixture = {
  assets: UploadedLogoAssetFixture[];
  error: Error | null;
  hasLoaded: boolean;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
};

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn<ApiFetchMock>(),
  loadUploadedLogosInitial: vi.fn<() => Promise<void>>(),
  loadUploadedLogosMore: vi.fn<() => Promise<void>>(),
  resetUploadedLogos: vi.fn<() => void>(),
  uploadedLogosState: {
    current: {
      assets: [],
      error: null,
      hasLoaded: false,
      hasMore: false,
      isLoading: false,
      isLoadingMore: false,
    } as UploadedLogosStateFixture,
  },
}));

vi.mock("@/lib/api-client", () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }

  return {
    ApiError,
    apiFetch: mocks.apiFetch,
  };
});

vi.mock("@/hooks/use-cropped-image-upload", () => ({
  useCroppedImageUpload: (options: { onChange: (value: string | undefined) => void }) => ({
    fileInputRef: { current: null },
    cropDialogOpen: false,
    setCropDialogOpen: vi.fn(),
    uploadedImage: "",
    uploadStatus: "idle",
    previewUrl: undefined,
    handleFileUpload: vi.fn(),
    handleCropComplete: vi.fn(),
    applyValue: (value: string | undefined) => options.onChange(value),
  }),
}));

vi.mock("@/hooks/use-uploaded-logo-assets", () => ({
  useUploadedLogoAssets: () => ({
    ...mocks.uploadedLogosState.current,
    loadInitial: mocks.loadUploadedLogosInitial,
    loadMore: mocks.loadUploadedLogosMore,
    reset: mocks.resetUploadedLogos,
  }),
}));

function expectMediaCandidateRequest(name: string, website?: string) {
  const call = mocks.apiFetch.mock.calls.find(([url]) => url === "/api/app/media/candidates");
  expect(call?.[0]).toBe("/api/app/media/candidates");
  expect(JSON.parse(String(call?.[2]?.body))).toMatchObject({
    kind: "logo",
    mode: "search",
    items: [{ id: "search", name, ...(website ? { website } : {}) }],
  });
  expect(call?.[2]?.signal).toBeInstanceOf(AbortSignal);
}

function render(ui: ReactNode) {
  const result = renderComponent(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
  return {
    ...result,
    rerender: (nextUi: ReactNode) => result.rerender(<TooltipProvider delayDuration={0}>{nextUi}</TooltipProvider>),
  };
}

const netflixCandidate = {
  id: "builtin:thesvg:netflix:default",
  kind: "logo",
  source: "builtIn",
  provider: "thesvg",
  label: "Netflix",
  variant: "default",
  url: "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/netflix/default.svg",
  confidence: "exact",
  autoAssignable: true,
  matchedQuery: "netflix",
  rank: 0,
};

const netflixLabel = "Netflix - TheSVG / Default";
const linearLabel = "Linear - TheSVG / Default";
const googleDefaultLabel = "Google - TheSVG / Default";
const googleWordmarkLabel = "Google - TheSVG / Wordmark";
const desktopTooltipQuery = "(hover: hover) and (pointer: fine) and (min-width: 768px)";

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

describe("LogoPicker", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.loadUploadedLogosInitial.mockReset();
    mocks.loadUploadedLogosMore.mockReset();
    mocks.resetUploadedLogos.mockReset();
    mocks.loadUploadedLogosInitial.mockResolvedValue(undefined);
    mocks.loadUploadedLogosMore.mockResolvedValue(undefined);
    mocks.uploadedLogosState.current = {
      assets: [],
      error: null,
      hasLoaded: false,
      hasMore: false,
      isLoading: false,
      isLoadingMore: false,
    };
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === "/api/app/media/candidates") {
        return Promise.resolve({
          items: [{
            id: "search",
            autoCandidate: null,
            candidates: {
              best: netflixCandidate,
              builtIn: [netflixCandidate],
              appStore: [],
              favicon: [],
            },
          }],
        });
      }

      return Promise.resolve({});
    });
    mockMatchMedia({ [desktopTooltipQuery]: true });
  });

  it("searches and selects a built-in theSVG logo from the unified Logo search", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<LogoPicker value={undefined} onChange={onChange} serviceName="Netflix" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));

    await waitFor(() => {
      expectMediaCandidateRequest("Netflix");
    });

    expect(await screen.findByText("内置图标：")).toBeInTheDocument();
    const netflixButton = await screen.findByRole("button", { name: netflixLabel });
    expect(netflixButton).toHaveClass("media-thumbnail-canvas");
    expect(netflixButton).not.toHaveAttribute("title");
    expect(await screen.findByAltText(netflixLabel)).toHaveClass("media-thumbnail-image");
    await user.hover(netflixButton);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(netflixLabel);
    await user.click(netflixButton);

    expect(onChange).toHaveBeenCalledWith(
      "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/netflix/default.svg",
    );
  });

  it("passes the subscription website into Logo search candidates", async () => {
    const user = userEvent.setup();

    render(<LogoPicker value={undefined} onChange={vi.fn()} serviceName="Svix" website="https://www.svix.com/" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));

    await waitFor(() => {
      expectMediaCandidateRequest("Svix", "https://www.svix.com/");
    });
  });

  it("keeps the desktop Logo search popover open when the search button is clicked", async () => {
    const user = userEvent.setup();
    let resolveRequest: ((value: unknown) => void) | undefined;
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === "/api/app/media/candidates") {
        return new Promise((resolve) => {
          resolveRequest = resolve;
        });
      }
      return Promise.resolve({});
    });

    render(<LogoPicker value={undefined} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const sheet = screen.getByTestId("logo-search-sheet");
    const input = within(sheet).getByPlaceholderText("输入服务名称、品牌或网址...");
    await user.type(input, "YouTube");
    await user.click(within(sheet).getByRole("button", { name: "搜索" }));

    expect(screen.getByTestId("logo-search-sheet")).toBe(sheet);
    expect(input).toHaveValue("YouTube");
    expect(within(sheet).getByRole("button", { name: "搜索" })).toBeDisabled();

    resolveRequest?.({
      items: [{ id: "search", autoCandidate: null, candidates: { best: null, builtIn: [], appStore: [], favicon: [] } }],
    });
  });

  it("keeps the mobile Logo search sheet open when the search button is clicked", async () => {
    const user = userEvent.setup();
    mockMatchMedia({ "(max-width: 767px)": true, [desktopTooltipQuery]: false });
    let resolveRequest: ((value: unknown) => void) | undefined;
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === "/api/app/media/candidates") {
        return new Promise((resolve) => {
          resolveRequest = resolve;
        });
      }
      return Promise.resolve({});
    });

    render(<LogoPicker value={undefined} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const sheet = screen.getByTestId("logo-search-sheet");
    const input = within(sheet).getByPlaceholderText("输入服务名称、品牌或网址...");
    await user.type(input, "YouTube");
    await user.click(within(sheet).getByRole("button", { name: "搜索" }));

    expect(screen.getByTestId("logo-search-sheet")).toBe(sheet);
    expect(sheet).toHaveAttribute("data-vaul-drawer");
    expect(input).toHaveValue("YouTube");

    resolveRequest?.({
      items: [{ id: "search", autoCandidate: null, candidates: { best: null, builtIn: [], appStore: [], favicon: [] } }],
    });
  });

  it("keeps typed Logo search state inside the shared mobile sheet until selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockMatchMedia({
      "(max-width: 767px)": true,
      [desktopTooltipQuery]: false,
    });
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === "/api/app/media/candidates") {
        const linearCandidate = {
          ...netflixCandidate,
          id: "builtin:thesvg:linear:default",
          label: "Linear",
          variant: "default",
          url: "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/linear/default.svg",
          matchedQuery: "linear",
        };
        return Promise.resolve({
          items: [{
            id: "search",
            autoCandidate: null,
            candidates: {
              best: linearCandidate,
              builtIn: [linearCandidate],
              appStore: [],
              favicon: [],
            },
          }],
        });
      }

      return Promise.resolve({});
    });

    render(<LogoPicker value={undefined} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const sheet = screen.getByTestId("logo-search-sheet");
    expect(sheet).toHaveClass("media-candidate-popover", "h5-logo-sheet", "h5-logo-search-sheet", "h5-mobile-sheet-content", "h5-mobile-sheet-large");
    expect(sheet).toHaveAttribute("data-vaul-drawer");
    expect(sheet.querySelector("[data-vaul-handle]")).not.toBeNull();
    expect(sheet).toHaveAttribute("aria-label", "搜索 Logo");
    const resultsViewport = screen.getByTestId("logo-search-results");
    expect(resultsViewport).toHaveClass("media-candidate-scroll-viewport", "h5-logo-sheet-results", "h5-logo-search-results");
    expect(resultsViewport).toHaveTextContent("输入服务名称、品牌或网址后点击搜索");

    const searchInput = screen.getByPlaceholderText("输入服务名称、品牌或网址...");
    await user.type(searchInput, "Linear{enter}");

    await waitFor(() => {
      expectMediaCandidateRequest("Linear");
    });
    expect(searchInput).toHaveValue("Linear");
    expect(screen.getByTestId("logo-search-results")).toBe(resultsViewport);

    await screen.findByRole("button", { name: linearLabel });
    expect(resultsViewport.querySelector(".media-candidate-scroll-content")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: linearLabel }));

    expect(onChange).toHaveBeenCalledWith(
      "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/linear/default.svg",
    );
    await waitFor(() => {
      expect(screen.queryByTestId("logo-search-sheet")).not.toBeInTheDocument();
    });
  });

  it("does not attach thumbnail tooltips inside the mobile Logo sheet", async () => {
    const user = userEvent.setup();
    mockMatchMedia({
      "(max-width: 767px)": true,
      [desktopTooltipQuery]: false,
    });

    render(<LogoPicker value={undefined} onChange={vi.fn()} serviceName="Netflix" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const netflixButton = await screen.findByRole("button", { name: netflixLabel });

    expect(netflixButton).not.toHaveAttribute("title");
    await user.hover(netflixButton);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("uses the shared low-noise canvas for the current Logo preview without clipping the clear control", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<LogoPicker value="https://example.com/logo.svg" onChange={onChange} />);

    const logo = screen.getByAltText("Logo");
    const logoPreview = logo.closest(".media-thumbnail-canvas");
    const clearLogoButton = screen.getByRole("button", { name: "清除 Logo" });
    expect(logo).toHaveClass("media-thumbnail-image");
    expect(logoPreview).not.toBeNull();
    expect(logoPreview).not.toHaveClass("border-dashed");
    expect(clearLogoButton.closest(".media-thumbnail-canvas")).toBeNull();

    await user.click(clearLogoButton);

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("allows SVG files in the custom Logo file picker", () => {
    const { container } = render(<LogoPicker value={undefined} onChange={vi.fn()} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const emptyPreviewButton = screen.getByRole("button", { name: "上传 Logo 图片" });

    expect(input).toHaveAttribute("accept", IMAGE_UPLOAD_ACCEPT);
    expect(emptyPreviewButton).toHaveClass("border-dashed");
    expect(emptyPreviewButton).not.toHaveClass("media-thumbnail-canvas");
  });

  it("keeps English Logo action labels at content width", () => {
    Object.defineProperty(globalThis.navigator, "languages", { configurable: true, value: ["en-US"] });
    Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });

    render(<LogoPicker value={undefined} onChange={vi.fn()} />);

    const uploadButton = screen.getByRole("button", { name: "Upload Logo" });
    const controlRow = screen.getByTestId("logo-picker-control-row");
    const secondaryActions = screen.getByTestId("logo-picker-secondary-actions");
    expect(uploadButton).toHaveClass("w-full");
    expect(controlRow).toHaveClass("flex", "flex-wrap", "items-center", "gap-3");
    expect(secondaryActions).toHaveClass(
      "flex",
      "w-max",
      "max-w-full",
      "flex-wrap",
      "items-center",
      "justify-start",
      "gap-2"
    );
    expect(secondaryActions).not.toHaveClass("grid");
    expect(secondaryActions).not.toHaveClass("grid-cols-3");
    expect(secondaryActions.parentElement).toHaveClass(
      "min-w-0",
      "w-fit",
      "max-w-full",
      "gap-2"
    );
    expect(secondaryActions.parentElement).not.toHaveClass("flex-1");
    expect(secondaryActions.parentElement).not.toHaveClass("max-w-52");

    for (const label of ["Uploaded", "Search", "Link"]) {
      const button = screen.getByRole("button", { name: label });
      const labelText = button.querySelector("span");
      if (!labelText) throw new Error(`Expected ${label} action to render a text wrapper.`);
      expect(button).toHaveClass("h-8", "w-fit", "max-w-full", "shrink-0", "px-3");
      expect(button).not.toHaveClass("w-full");
      expect(labelText).toHaveClass("min-w-0", "truncate");
    }
  });

  it("selects an uploaded custom Logo from the uploaded Logo picker", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockMatchMedia({
      "(max-width: 767px)": true,
      [desktopTooltipQuery]: false,
    });
    mocks.uploadedLogosState.current = {
      assets: [
        {
          id: "asset-1",
          url: "/api/app/assets/asset-1",
          kind: "logo",
          originalName: "netflix.png",
        },
      ],
      error: null,
      hasLoaded: true,
      hasMore: false,
      isLoading: false,
      isLoadingMore: false,
    };

    render(<LogoPicker value={undefined} onChange={onChange} />);

    expect(screen.getByRole("button", { name: "上传 Logo" })).toHaveClass("w-full");
    expect(screen.getByRole("button", { name: "已上传" })).toHaveClass("h-8");
    expect(screen.getByRole("button", { name: "搜索" })).toHaveClass("h-8");
    await user.click(screen.getByRole("button", { name: "已上传" }));

    expect(mocks.loadUploadedLogosInitial).toHaveBeenCalledTimes(1);
    const uploadedSheet = screen.getByTestId("uploaded-logo-sheet");
    expect(uploadedSheet).toHaveClass("media-candidate-popover", "h5-logo-sheet", "h5-uploaded-logo-sheet", "h5-mobile-sheet-large");
    expect(screen.getByTestId("uploaded-logo-results")).toHaveClass(
      "media-candidate-scroll-viewport",
      "h5-logo-sheet-results",
      "h5-uploaded-logo-results",
    );
    expect(screen.getByTestId("uploaded-logo-results").querySelector(".media-candidate-scroll-content")).not.toBeNull();
    const uploadedLogoButton = await screen.findByRole("button", { name: "netflix.png" });
    expect(uploadedLogoButton).toHaveClass("media-thumbnail-canvas");
    expect(uploadedLogoButton).toHaveAttribute("aria-pressed", "false");
    await user.click(uploadedLogoButton);

    expect(onChange).toHaveBeenCalledWith("/api/app/assets/asset-1");
  });

  it("adds a custom Logo link entry and saves the original HTTP URL", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<LogoPicker value={undefined} onChange={onChange} />);

    expect(screen.getByRole("button", { name: "已上传" })).toHaveClass("h-8");
    expect(screen.getByRole("button", { name: "搜索" })).toHaveClass("h-8");
    expect(screen.getByRole("button", { name: "链接" })).toHaveClass("h-8");
    await user.click(screen.getByRole("button", { name: "链接" }));

    const sheet = screen.getByTestId("logo-link-sheet");
    expect(sheet).toHaveClass("media-candidate-popover", "h5-logo-sheet", "h5-logo-link-sheet");
    const input = screen.getByPlaceholderText("https://example.com/logo.svg");
    await user.type(input, "http://example.com/logo.png");
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("http://example.com/logo.png");
  });

  it("rejects unsupported custom Logo link values before applying", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<LogoPicker value={undefined} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "链接" }));

    const input = screen.getByPlaceholderText("https://example.com/logo.svg");
    const apply = screen.getByRole("button", { name: "使用链接" });
    await user.type(input, "data:image/png;base64,aGVsbG8=");

    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("Logo 链接只支持 http:// 或 https://")).not.toBeInTheDocument();
    expect(apply).toBeEnabled();

    await user.click(apply);

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(await screen.findByText("Logo 链接只支持 http:// 或 https://")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "https://example.com/logo.svg");

    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("Logo 链接只支持 http:// 或 https://")).not.toBeInTheDocument();
    await user.click(apply);

    expect(onChange).toHaveBeenCalledWith("https://example.com/logo.svg");
  });

  it("keeps the Logo link field neutral when focus leaves without submitting", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<LogoPicker value={undefined} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "链接" }));

    const input = screen.getByPlaceholderText("https://example.com/logo.svg");
    const apply = screen.getByRole("button", { name: "使用链接" });
    await user.click(input);
    expect(input).toHaveFocus();

    await user.tab();

    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText("请输入 Logo 链接")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(apply);

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(await screen.findByText("请输入 Logo 链接")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows empty, retry, load-more, and selected states in the uploaded Logo picker", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<LogoPicker value={undefined} onChange={vi.fn()} />);

    mocks.uploadedLogosState.current = {
      assets: [],
      error: null,
      hasLoaded: true,
      hasMore: false,
      isLoading: false,
      isLoadingMore: false,
    };
    rerender(<LogoPicker value={undefined} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "已上传" }));
    expect(await screen.findByText("还没有上传过自定义 Logo")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "已上传" }));
    mocks.uploadedLogosState.current = {
      assets: [],
      error: new Error("offline"),
      hasLoaded: true,
      hasMore: false,
      isLoading: false,
      isLoadingMore: false,
    };
    rerender(<LogoPicker value={undefined} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "已上传" }));
    expect(await screen.findByText("已上传 Logo 加载失败")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(mocks.loadUploadedLogosInitial).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "已上传" }));
    mocks.uploadedLogosState.current = {
      assets: [
        {
          id: "asset-2",
          url: "/api/app/assets/asset-2",
          kind: "logo",
          originalName: "selected.svg",
        },
      ],
      error: null,
      hasLoaded: true,
      hasMore: true,
      isLoading: false,
      isLoadingMore: false,
    };
    rerender(<LogoPicker value="/api/app/assets/asset-2" onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "已上传" }));

    const selectedLogoButton = await screen.findByRole("button", { name: "selected.svg" });
    expect(selectedLogoButton).toHaveClass("media-thumbnail-canvas", "border-primary");
    expect(selectedLogoButton).toHaveAttribute("aria-pressed", "true");
    expect(selectedLogoButton.querySelector("span[aria-hidden='true'] svg")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(mocks.loadUploadedLogosMore).toHaveBeenCalledTimes(1);
  });

  it("shows favicon fallback results when there is no built-in match", async () => {
    const user = userEvent.setup();
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === "/api/app/media/candidates") {
        const faviconCandidate = {
          id: "favicon:site:dmit.io:0",
          kind: "logo",
          source: "favicon",
          provider: "site",
          label: "dmit.io",
          variant: null,
          url: "https://dmit.io/favicon.ico",
          confidence: "weak",
          autoAssignable: false,
          matchedQuery: "dmit.io",
          rank: 0,
        };
        return Promise.resolve({
          items: [{
            id: "search",
            autoCandidate: null,
            candidates: {
              best: faviconCandidate,
              builtIn: [],
              appStore: [],
              favicon: [faviconCandidate],
            },
          }],
        });
      }

      return Promise.resolve({});
    });

    render(<LogoPicker value={undefined} onChange={vi.fn()} serviceName="DMIT" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));

    expect(await screen.findByText("网站/Favicon 备用：")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "dmit.io" })).toBeInTheDocument();
  });

  it("shows and selects multiple theSVG Logo variants as direct candidates", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const wordmarkUrl = "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/google/wordmark.svg";
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === "/api/app/media/candidates") {
        const defaultCandidate = {
          ...netflixCandidate,
          id: "builtin:thesvg:google:default",
          label: "Google",
          variant: "default",
          url: "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/google/default.svg",
          matchedQuery: "google",
        };
        const wordmarkCandidate = {
          ...defaultCandidate,
          id: "builtin:thesvg:google:wordmark",
          variant: "wordmark",
          url: wordmarkUrl,
          rank: 1,
        };
        return Promise.resolve({
          items: [{
            id: "search",
            autoCandidate: null,
            candidates: {
              best: defaultCandidate,
              builtIn: [defaultCandidate, wordmarkCandidate],
              appStore: [],
              favicon: [],
            },
          }],
        });
      }

      return Promise.resolve({});
    });

    render(<LogoPicker value={wordmarkUrl} onChange={onChange} serviceName="Google" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByRole("button", { name: googleDefaultLabel })).toHaveAttribute("aria-pressed", "false");
    const wordmarkButton = await screen.findByRole("button", { name: googleWordmarkLabel });
    expect(wordmarkButton).toHaveAttribute("aria-pressed", "true");
    await user.click(wordmarkButton);

    expect(onChange).toHaveBeenCalledWith(wordmarkUrl);
  });

  it("shows a unified failure state when media candidates fail", async () => {
    const user = userEvent.setup();
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === "/api/app/media/candidates") {
        return Promise.reject(new Error("media offline"));
      }

      return Promise.resolve({});
    });

    render(<LogoPicker value={undefined} onChange={vi.fn()} serviceName="DMIT" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));

    expect(await screen.findByText("搜索失败，请稍后重试")).toBeInTheDocument();
  });

  it("keeps the search box empty after clearing the auto-filled service name", async () => {
    const user = userEvent.setup();

    render(<LogoPicker value={undefined} onChange={vi.fn()} serviceName="youtube" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const searchInput = screen.getByPlaceholderText("输入服务名称、品牌或网址...");

    await waitFor(() => {
      expect(searchInput).toHaveValue("youtube");
    });
    expectMediaCandidateRequest("youtube");

    await user.clear(searchInput);

    expect(searchInput).toHaveValue("");
  });
});
