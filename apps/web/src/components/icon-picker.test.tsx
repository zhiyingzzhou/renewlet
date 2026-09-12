// IconPicker 测试覆盖内置候选、上传裁剪和暂存状态，防止自定义配置图标把 data URL 写入持久层。
import type { ReactNode } from "react";
import { render as renderComponent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IMAGE_UPLOAD_ACCEPT } from "@/lib/upload-constraints";
import { IconPicker } from "./icon-picker";

type ApiFetchMock = (
  url: string,
  responseSchema: unknown,
  init?: RequestInit & { signal?: AbortSignal },
) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn<ApiFetchMock>(),
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

function expectMediaCandidateRequest(name: string) {
  const call = mocks.apiFetch.mock.calls.find(([url]) => url === "/api/app/media/candidates");
  expect(call?.[0]).toBe("/api/app/media/candidates");
  expect(JSON.parse(String(call?.[2]?.body))).toMatchObject({
    kind: "icon",
    mode: "search",
    items: [{ id: "search", name }],
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

const binanceCandidate = {
  id: "builtin:thesvg:binance:default",
  kind: "icon",
  source: "builtIn",
  provider: "thesvg",
  label: "Binance",
  variant: "default",
  url: "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/binance/default.svg",
  confidence: "exact",
  autoAssignable: true,
  matchedQuery: "binance",
  rank: 0,
};

const binanceLabel = "Binance - TheSVG / Default";
const googleDefaultLabel = "Google - TheSVG / Default";
const googleMonoLabel = "Google - TheSVG / Mono";
const desktopTooltipQuery = "(hover: hover) and (pointer: fine) and (min-width: 768px)";

const actualBudgetIconCandidate = {
  ...binanceCandidate,
  id: "builtin:selfhst:actual-budget:default",
  provider: "selfhst",
  label: "Actual Budget",
  variant: "default",
  url: "https://testingcf.jsdelivr.net/gh/selfhst/icons@main/svg/actual-budget.svg",
  matchedQuery: "actual budget",
  rank: 1,
};
const actualBudgetIconLabel = "Actual Budget - selfh.st icons / Default";

const homepageIconCandidate = {
  ...binanceCandidate,
  id: "builtin:dashboardIcons:homepage:default",
  provider: "dashboardIcons",
  label: "Homepage",
  variant: "default",
  url: "https://testingcf.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/svg/homepage.svg",
  matchedQuery: "homepage",
  rank: 2,
};
const homepageIconLabel = "Homepage - Dashboard Icons / Default";

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

describe("IconPicker", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === "/api/app/media/candidates") {
        return Promise.resolve({
          items: [{
            id: "search",
            autoCandidate: null,
            candidates: {
              best: binanceCandidate,
              builtIn: [binanceCandidate],
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

  it("searches built-in theSVG icons when opening the payment icon search", async () => {
    const user = userEvent.setup();

    render(<IconPicker value={undefined} onChange={vi.fn()} searchHint="Binance" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));

    await waitFor(() => {
      expectMediaCandidateRequest("Binance");
    });
    expect(await screen.findByRole("button", { name: binanceLabel })).toHaveClass("media-thumbnail-canvas");
    expect(await screen.findByAltText(binanceLabel)).toHaveClass("media-thumbnail-image");
  });

  it("keeps the icon search popover open when the search button is clicked", async () => {
    const user = userEvent.setup();

    render(<IconPicker value={undefined} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const input = screen.getByPlaceholderText("输入名称...");
    const popover = input.closest<HTMLElement>('[role="dialog"]');
    if (!popover) throw new Error("Expected icon search popover to be open.");
    await user.type(input, "Binance");
    await user.click(within(popover).getByRole("button", { name: "搜索" }));

    expect(input.closest('[role="dialog"]')).toBe(popover);
    expect(input).toHaveValue("Binance");
  });

  it("allows SVG files in the custom icon file picker", () => {
    const { container } = render(<IconPicker value={undefined} onChange={vi.fn()} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    expect(input).toHaveAttribute("accept", IMAGE_UPLOAD_ACCEPT);
  });

  it("uses the shared low-noise canvas for the current icon preview without clipping the clear control", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<IconPicker value="https://example.com/icon.svg" onChange={onChange} />);

    const icon = screen.getByAltText("图标");
    const iconPreview = icon.closest(".media-thumbnail-canvas");
    const clearIconButton = screen.getByRole("button", { name: "清除图标" });
    expect(icon).toHaveClass("media-thumbnail-image");
    expect(iconPreview).not.toBeNull();
    expect(iconPreview).toHaveClass("media-thumbnail-canvas");
    expect(clearIconButton.closest(".media-thumbnail-canvas")).toBeNull();

    await user.click(clearIconButton);

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("selects a built-in theSVG icon from the unified icon search", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<IconPicker value={undefined} onChange={onChange} searchHint="Binance" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const binanceButton = await screen.findByRole("button", { name: binanceLabel });
    expect(binanceButton).toHaveAttribute("aria-pressed", "false");
    expect(binanceButton).not.toHaveAttribute("title");
    await user.hover(binanceButton);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(binanceLabel);
    await user.click(binanceButton);

    expect(onChange).toHaveBeenCalledWith(
      "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/binance/default.svg",
    );
  });

  it("does not attach thumbnail tooltips inside the mobile icon sheet", async () => {
    const user = userEvent.setup();
    mockMatchMedia({
      "(max-width: 767px)": true,
      [desktopTooltipQuery]: false,
    });

    render(<IconPicker value={undefined} onChange={vi.fn()} searchHint="Binance" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const binanceButton = await screen.findByRole("button", { name: binanceLabel });

    expect(binanceButton).not.toHaveAttribute("title");
    await user.hover(binanceButton);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("marks a selected built-in icon thumbnail with the shared canvas and pressed state", async () => {
    const user = userEvent.setup();
    const selectedIcon =
      "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/binance/default.svg";

    render(<IconPicker value={selectedIcon} onChange={vi.fn()} searchHint="Binance" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const selectedButton = await screen.findByRole("button", { name: binanceLabel });

    expect(selectedButton).toHaveClass("media-thumbnail-canvas", "border-primary");
    expect(selectedButton).toHaveAttribute("aria-pressed", "true");
    expect(selectedButton.querySelector("span[aria-hidden='true'] svg")).not.toBeNull();
  });

  it("shows provider filter tags only for icon providers returned by the API", async () => {
    const user = userEvent.setup();
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === "/api/app/media/candidates") {
        return Promise.resolve({
          items: [{
            id: "search",
            autoCandidate: null,
            candidates: {
              best: binanceCandidate,
              builtIn: [binanceCandidate, homepageIconCandidate],
              appStore: [],
              favicon: [],
            },
          }],
        });
      }

      return Promise.resolve({});
    });

    render(<IconPicker value={undefined} onChange={vi.fn()} searchHint="Dashboard" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const filterGroup = await screen.findByRole("group", { name: "筛选内置图标来源" });

    expect(filterGroup).toHaveTextContent("全部");
    expect(filterGroup).toHaveTextContent("TheSVG");
    expect(filterGroup).toHaveTextContent("Dashboard");
    expect(filterGroup).not.toHaveTextContent("Dashboard Icons");
    expect(filterGroup).not.toHaveTextContent("selfh.st");

    await user.click(within(filterGroup).getByRole("button", { name: /Dashboard/ }));

    expect(screen.queryByRole("button", { name: binanceLabel })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: homepageIconLabel })).toBeInTheDocument();
  });

  it("does not show provider filter tags for disabled or single-provider icon results", async () => {
    const user = userEvent.setup();
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === "/api/app/media/candidates") {
        return Promise.resolve({
          items: [{
            id: "search",
            autoCandidate: null,
            candidates: {
              best: actualBudgetIconCandidate,
              builtIn: [actualBudgetIconCandidate],
              appStore: [],
              favicon: [],
            },
          }],
        });
      }

      return Promise.resolve({});
    });

    render(<IconPicker value={undefined} onChange={vi.fn()} searchHint="Actual Budget" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByRole("button", { name: actualBudgetIconLabel })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "筛选内置图标来源" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /TheSVG/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dashboard/ })).not.toBeInTheDocument();
  });

  it("renders and selects distinct theSVG icon variants", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const monoUrl = "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/google/mono.svg";
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === "/api/app/media/candidates") {
        const defaultCandidate = {
          ...binanceCandidate,
          id: "builtin:thesvg:google:default",
          label: "Google",
          variant: "default",
          url: "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/google/default.svg",
          matchedQuery: "google",
        };
        const monoCandidate = {
          ...defaultCandidate,
          id: "builtin:thesvg:google:mono",
          variant: "mono",
          url: monoUrl,
          rank: 1,
        };
        return Promise.resolve({
          items: [{
            id: "search",
            autoCandidate: null,
            candidates: {
              best: defaultCandidate,
              builtIn: [defaultCandidate, monoCandidate],
              appStore: [],
              favicon: [],
            },
          }],
        });
      }

      return Promise.resolve({});
    });

    render(<IconPicker value={monoUrl} onChange={onChange} searchHint="Google" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByRole("button", { name: googleDefaultLabel })).toHaveAttribute("aria-pressed", "false");
    const monoButton = await screen.findByRole("button", { name: googleMonoLabel });
    expect(monoButton).toHaveAttribute("aria-pressed", "true");
    await user.click(monoButton);

    expect(onChange).toHaveBeenCalledWith(monoUrl);
  });

  it("keeps the search box empty after clearing the auto-filled payment name", async () => {
    const user = userEvent.setup();

    render(<IconPicker value={undefined} onChange={vi.fn()} searchHint="Binance" />);

    await user.click(screen.getByRole("button", { name: "搜索" }));
    const searchInput = screen.getByPlaceholderText("输入名称...");

    await waitFor(() => {
      expect(searchInput).toHaveValue("Binance");
    });
    expectMediaCandidateRequest("Binance");

    await user.clear(searchInput);

    expect(searchInput).toHaveValue("");
  });
});
