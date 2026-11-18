/**
 * 统计页 application hook。
 *
 * 将 React memo 边界包在 domain 模型外层，页面无需知道金额/预算/图表聚合细节。
 * 注意： `config` 对象来自 Context，若未来拆分 Context，需要保持引用稳定以避免图表重算过频。
 */
import { useMemo } from "react";
import type { DateOnly } from "@/lib/time/date-only";
import type { Locale } from "@/i18n/locales";
import type { CustomConfig } from "@/types/config";
import type { SubscriptionCollectionItem } from "@/types/subscription";
import { statisticsModelTask } from "../domain/statistics-model";
import { useForecastTask } from "./use-forecast-task";

/** 统计页视图模型 hook。 */
export function useStatisticsModel(
  subscriptions: readonly SubscriptionCollectionItem[],
  config: CustomConfig,
  monthlyBudget: string,
  defaultCurrency: string,
  convert: (amount: number | string, from: string, to: string) => number,
  today: DateOnly,
  locale: Locale,
  costBasis: "total" | "personal" = "total",
) {
  const factory = useMemo(
    () => () => statisticsModelTask({ subscriptions, config, monthlyBudget, defaultCurrency, convert, locale, costBasis, today }),
    [today, config, convert, costBasis, defaultCurrency, locale, monthlyBudget, subscriptions],
  );
  return useForecastTask(factory);
}
