import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscriptionQueryKeys } from "@/hooks/subscription-query-cache";
import { useBulkPublicVisibility } from "./use-bulk-public-visibility";

const counts = { matchedCount: 2, changedCount: 1, skippedCount: 1, failedIds: [] };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(subscriptionQueryKeys.facets, { total: 2 });
  client.setQueryData(subscriptionQueryKeys.detail("sub-1"), { publicHidden: false });
  client.setQueryData(["settings"], { timezone: "UTC" });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, ...renderHook(useBulkPublicVisibility, { wrapper: Wrapper }) };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: counts }))));
});
afterEach(() => vi.unstubAllGlobals());

describe("bulk public visibility command", () => {
  it("posts one validated command and invalidates collections and cached details after apply", async () => {
    const { client, result } = setup();
    const body = { selection: { ids: ["sub-1", "sub-2"] }, publicHidden: true, dryRun: false };
    await act(async () => { await expect(result.current.mutateAsync(body)).resolves.toEqual(counts); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/app/subscriptions/bulk-public-visibility", expect.objectContaining({
      method: "POST", body: JSON.stringify(body), credentials: "include",
    }));
    expect(client.getQueryState(subscriptionQueryKeys.facets)?.isInvalidated).toBe(true);
    expect(client.getQueryState(subscriptionQueryKeys.detail("sub-1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(["settings"])?.isInvalidated).toBe(false);
  });

  it("keeps caches fresh during category preview", async () => {
    const { client, result } = setup();
    await act(async () => {
      await result.current.mutateAsync({ selection: { categories: ["expired", "lifetime"] }, publicHidden: true, dryRun: true });
    });
    expect(client.getQueryState(subscriptionQueryKeys.facets)?.isInvalidated).toBe(false);
    expect(client.getQueryState(subscriptionQueryKeys.detail("sub-1"))?.isInvalidated).toBe(false);
  });

  it.each([409, 500])("keeps failure status and code without invalidating caches: %i", async (status) => {
    const code = status === 409 ? "SUBSCRIPTION_WRITE_CONFLICT" : "SUBSCRIPTION_PUBLIC_VISIBILITY_FAILED";
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: { code, message: "Retry", details: { requestId: "visibility-request" } } }), { status }));
    const { client, result } = setup();
    await act(async () => {
      await expect(result.current.mutateAsync({ selection: { ids: ["sub-1"] }, publicHidden: true, dryRun: false })).rejects.toMatchObject({ status, code, details: { requestId: "visibility-request" } });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(subscriptionQueryKeys.facets)?.isInvalidated).toBe(false);
    expect(client.getQueryState(subscriptionQueryKeys.detail("sub-1"))?.isInvalidated).toBe(false);
  });

  it("avoids refetching every collection for an idempotent no-change result", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { matchedCount: 1, changedCount: 0, skippedCount: 1, failedIds: [] } })));
    const { client, result } = setup();
    await act(async () => { await result.current.mutateAsync({ selection: { ids: ["sub-1"] }, publicHidden: true, dryRun: false }); });
    expect(client.getQueryState(subscriptionQueryKeys.facets)?.isInvalidated).toBe(false);
  });

  it("rejects invalid selection before any request", async () => {
    const { client, result } = setup();
    await act(async () => {
      await expect(result.current.mutateAsync({ selection: { ids: [] }, publicHidden: true, dryRun: false })).rejects.toThrow();
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(client.getQueryState(subscriptionQueryKeys.facets)?.isInvalidated).toBe(false);
  });

  it("rejects malformed server counts without treating the command as successful", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { ...counts, failedIds: null } })));
    const { client, result } = setup();
    await act(async () => {
      await expect(result.current.mutateAsync({ selection: { ids: ["sub-1"] }, publicHidden: true, dryRun: false })).rejects.toThrow();
    });
    expect(client.getQueryState(subscriptionQueryKeys.facets)?.isInvalidated).toBe(false);
  });
});
