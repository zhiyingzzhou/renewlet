import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { StatisticsChartsProps } from "./statistics-charts";
import { DeferredStatisticsCharts } from "./statistics-charts-loader";

const moduleLoad = vi.hoisted(() => {
  let resolve!: () => void;
  return { started: vi.fn(), ready: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
});

vi.mock("@/components/statistics-charts", async () => {
  moduleLoad.started();
  await moduleLoad.ready;
  return { StatisticsCharts: ({ totalMonthly }: StatisticsChartsProps) => <div>chart amount {totalMonthly}</div> };
});

it("loads charts while the model is pending and renders only the completed model", async () => {
  const { rerender } = render(<DeferredStatisticsCharts data={undefined} />);
  await vi.waitFor(() => expect(moduleLoad.started).toHaveBeenCalledOnce());
  expect(screen.getByTestId("statistics-charts-loading")).toBeInTheDocument();
  await act(async () => { moduleLoad.resolve(); await moduleLoad.ready; });
  expect(screen.queryByText(/chart amount/)).not.toBeInTheDocument();
  expect(screen.getByTestId("statistics-charts-loading")).toBeInTheDocument();
  rerender(<DeferredStatisticsCharts data={{ trendData: [], categoryData: [], paymentData: [], budgetChartData: [], defaultCurrency: "CNY", monthlyBudget: "100", monthlyBudgetAmount: 100, totalMonthly: 42, budgetRemaining: 58, onViewSubscriptionDetails: vi.fn() }} />);
  expect(await screen.findByText("chart amount 42")).toBeInTheDocument();
  expect(screen.queryByTestId("statistics-charts-loading")).not.toBeInTheDocument();
});
