import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DashboardPageSkeleton, SettingsPageSkeleton } from "./loading-skeleton";

describe("HeaderSkeleton", () => {
  it("shares the real header responsive layout contract", () => {
    render(<DashboardPageSkeleton />);

    expect(screen.getByTestId("app-header-skeleton")).toHaveClass("sticky", "top-0", "z-50", "bg-card/80");
    expect(screen.getByTestId("route-progress")).toHaveClass("absolute", "bottom-0", "h-0.5", "opacity-0");
    expect(screen.getByTestId("app-header-skeleton-inner")).toHaveClass("max-w-7xl", "justify-between", "gap-3");
    expect(screen.getByTestId("app-header-actions-skeleton")).toHaveClass("min-w-0", "shrink-0", "justify-end");

    const desktopNav = screen.getByTestId("app-header-desktop-nav-skeleton");
    const mobileNav = screen.getByTestId("app-header-mobile-nav-skeleton");
    const firstDesktopItem = desktopNav.firstElementChild;
    const firstDesktopLabel = firstDesktopItem?.lastElementChild;

    expect(desktopNav).toHaveClass("hidden", "min-w-0", "lg:flex");
    expect(mobileNav).toHaveClass("flex", "border-t", "lg:hidden");
    expect(firstDesktopItem).toHaveClass("h-10", "w-auto", "justify-start", "gap-2", "px-3", "xl:px-4");
    expect(firstDesktopItem).not.toHaveClass("lg:w-10", "lg:px-0");
    expect(firstDesktopLabel).toHaveClass("h-4", "w-16");
    expect(firstDesktopLabel).not.toHaveClass("hidden", "xl:block");
  });
});

describe("DashboardPageSkeleton", () => {
  it("shares the compact dashboard stat grid contract", () => {
    render(<DashboardPageSkeleton />);

    const grid = screen.getByTestId("dashboard-skeleton-stat-grid");
    const monthlySpend = screen.getByTestId("dashboard-skeleton-stat-monthly-spend");
    const trials = screen.getByTestId("dashboard-skeleton-stat-trials");

    expect(grid).toHaveClass("grid", "gap-3", "sm:gap-5", "sm:grid-cols-2", "lg:grid-cols-4");
    expect(grid.className).toContain("grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))]");
    expect(monthlySpend).toHaveClass("p-4", "lg:p-6", "col-span-full", "sm:col-span-1");
    expect(trials).toHaveClass("p-4", "lg:p-6", "col-span-full", "sm:col-span-1");
  });
});

describe("SettingsPageSkeleton", () => {
  it("shares the real settings layout contract", () => {
    render(<SettingsPageSkeleton />);

    const grid = screen.getByTestId("settings-page-skeleton-grid");
    const mobileHeader = screen.getByTestId("settings-page-skeleton-mobile-header");
    const desktopNav = screen.getByTestId("settings-page-skeleton-desktop-nav");
    const firstSection = grid.querySelector("section");

    expect(grid).toHaveClass("grid", "min-w-0", "gap-6", "lg:gap-8", "lg:grid-cols-[14rem_minmax(0,1fr)]");
    expect(grid.className).toContain("[--settings-mobile-header-offset:calc(8.25rem+env(safe-area-inset-top))]");
    expect(grid.className).toContain("[--settings-desktop-sticky-top:7rem]");
    expect(grid.className).toContain("[--settings-desktop-section-scroll-offset:var(--settings-desktop-sticky-top)]");
    expect(grid.className).toContain("lg:[--settings-section-scroll-offset:var(--settings-desktop-section-scroll-offset)]");
    expect(mobileHeader).toHaveClass(
      "sticky",
      "top-[calc(var(--settings-mobile-header-offset)+var(--settings-mobile-sticky-gap))]",
      "rounded-xl",
      "border",
      "bg-background/95",
      "p-4",
      "lg:hidden",
    );
    expect(mobileHeader).not.toHaveClass("-mx-4", "border-b", "top-[calc(8.25rem+env(safe-area-inset-top))]");
    expect(desktopNav).toHaveClass(
      "sticky",
      "top-(--settings-desktop-sticky-top)",
      "max-h-[calc(var(--app-viewport-height)-var(--settings-desktop-sticky-top)-1rem)]",
      "bg-card/70",
      "shadow-card",
      "backdrop-blur",
      "overflow-y-auto",
    );
    expect(desktopNav).not.toHaveClass("top-28", "max-h-[calc(100vh-8rem)]");
    expect(firstSection).toHaveClass(
      "min-w-0",
      "w-full",
      "rounded-xl",
      "border",
      "bg-card",
      "p-4",
      "sm:p-6",
      "scroll-mt-(--settings-section-scroll-offset)",
    );
    expect(firstSection).not.toHaveClass("lg:scroll-mt-24");
    expect(firstSection).not.toHaveClass("p-6");
  });
});
