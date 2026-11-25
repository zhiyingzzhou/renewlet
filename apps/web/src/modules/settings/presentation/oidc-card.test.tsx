import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { OidcCard } from "./oidc-card";
import { oidcService } from "@/services/oidc-service";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/settings");
});

function renderCard(site: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OidcCard site={site} enabled={false} />
    </QueryClientProvider>,
  );
}

it.each([true, false])(
  "requires explicit confirmation after the provider returns (site=%s)",
  async (site) => {
    const purpose = site ? "test" : "link";
    window.history.replaceState(
      null,
      "",
      "/settings?oidc=" + purpose + (site ? "#settings-access-security" : "#settings-account"),
    );
    vi.spyOn(oidcService, "review").mockResolvedValue({
      purpose,
      issuer: "https://id.example",
      clientId: "client",
      subject: "external-person",
    });
    const commit = site
      ? vi.spyOn(oidcService, "enable").mockResolvedValue({})
      : vi.spyOn(oidcService, "confirm").mockResolvedValue();
    renderCard(site);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(site ? "client" : "external-person")).toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(commit).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: site ? "保存并启用" : "确认绑定" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(commit).toHaveBeenCalledTimes(1);
  },
);
