import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { StatisticsChartsProps } from "@/components/statistics-charts";

const LazyStatisticsCharts = lazy(() =>
  import("@/components/statistics-charts").then((module) => ({
    default: ({ data }: { data: StatisticsChartsProps | undefined }) => data
      ? <module.StatisticsCharts {...data} />
      : <StatisticsChartsLoading />,
  })),
);

function StatisticsChartsLoading() {
  return (
    <div className="grid gap-8" aria-hidden="true" data-testid="statistics-charts-loading">
      <Skeleton className="h-96 w-full rounded-xl" />
      <div className="grid gap-6 md:grid-cols-2">
        <Skeleton className="h-80 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl md:col-span-2" />
      </div>
    </div>
  );
}

/** 模型分片与图表模块并行就绪，避免模型提交后再触发第二轮 Suspense；概要和开关始终可用。 */
export function DeferredStatisticsCharts({ data }: { data: StatisticsChartsProps | undefined }) {
  return (
    <Suspense fallback={<StatisticsChartsLoading />}>
      <LazyStatisticsCharts data={data} />
    </Suspense>
  );
}
