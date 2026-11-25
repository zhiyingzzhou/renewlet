import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api-client";
import { useAppStatus } from "./use-app-status";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useAppStatus", () => {
  afterEach(() => {
    apiFetchMock.mockReset();
  });

  it("keeps the ready payload unchanged", async () => {
    apiFetchMock.mockResolvedValue({
      setupRequired: false,
      setupEnabled: false,
      demoMode: true,
      turnstile: { enabled: true, siteKey: "site-key" },
    });

    const { result } = renderHook(() => useAppStatus(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data).toEqual({
      setupRequired: false,
      setupEnabled: false,
      demoMode: true,
      turnstile: { enabled: true, siteKey: "site-key" },
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith("/api/app/auth/options", expect.anything(), expect.objectContaining({
      authMode: "none",
      cache: "no-store",
      timeoutMs: 10_000,
    }));
  });

  it("keeps an unavailable status as error instead of completed", async () => {
    apiFetchMock.mockRejectedValue(new Error("503"));

    const { result } = renderHook(() => useAppStatus(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.data).toBeNull();
    expect(result.current.isReady).toBe(false);
  });

  it("supports one explicit retry without automatic retries", async () => {
    apiFetchMock
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({
        setupRequired: true,
        setupEnabled: true,
        demoMode: false,
        turnstile: { enabled: false, siteKey: "" },
      });

    const { result } = renderHook(() => useAppStatus(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await result.current.retry();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent consumers through the shared query cache", async () => {
    apiFetchMock.mockResolvedValue({
      setupRequired: false,
      setupEnabled: true,
      demoMode: false,
      turnstile: { enabled: false, siteKey: "" },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const first = renderHook(() => useAppStatus(), { wrapper });
    const second = renderHook(() => useAppStatus(), { wrapper });

    await waitFor(() => {
      expect(first.result.current.status).toBe("ready");
      expect(second.result.current.status).toBe("ready");
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains the last ready data when an explicit refresh fails", async () => {
    apiFetchMock.mockResolvedValueOnce({
      setupRequired: false,
      setupEnabled: true,
      demoMode: false,
      turnstile: { enabled: false, siteKey: "" },
    });
    const { result } = renderHook(() => useAppStatus(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    apiFetchMock.mockRejectedValueOnce(new Error("refresh failed"));
    await result.current.retry();
    await waitFor(() => expect(result.current.status).toBe("error"));

    expect(result.current.data).toEqual({
      setupRequired: false,
      setupEnabled: true,
      demoMode: false,
      turnstile: { enabled: false, siteKey: "" },
    });
  });
});
