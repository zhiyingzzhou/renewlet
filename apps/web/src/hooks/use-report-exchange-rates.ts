import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ExchangeRateProvider,
  ExchangeRateSnapshotBody,
  ExchangeRateSnapshotV1,
} from "@/lib/api/schemas/exchange-rates";
import { exchangeRateSnapshotService } from "@/services/exchange-rate-snapshot-service";
import {
  DEFAULT_EXCHANGE_RATE_PROVIDER,
  type ExchangeRateStore,
  defaultExchangeRateStore,
} from "./exchange-rate-store";
import { createUseExchangeRates } from "./use-exchange-rates";
import { moneyToNumber } from "@renewlet/shared/money";

export type ReportExchangeRateBasisStatus = {
  month: string;
  locked: boolean;
  sourceDate: string | null;
  capturedAt: string | null;
};

type CurrentReportSnapshotState = {
  month: string;
  snapshot: ExchangeRateSnapshotV1 | null;
  loaded: boolean;
};

function isSnapshotProvider(value: string): value is ExchangeRateProvider {
  return value === "frankfurter" || value === "floatrates" || value === "exchange-api";
}

function currentReportMonthUTC(): string {
  return new Date().toISOString().slice(0, 7);
}

function exchangeRateSnapshotSignature(
  snapshot: Pick<ExchangeRateSnapshotBody, "rates" | "requestedProvider" | "provider" | "sourceDate" | "warning"> | null,
): string {
  if (snapshot === null) return "";
  return JSON.stringify({
    rates: snapshot.rates,
    requestedProvider: snapshot.requestedProvider,
    provider: snapshot.provider,
    sourceDate: snapshot.sourceDate,
    warning: snapshot.warning ?? null,
  });
}

function snapshotCapturedDate(snapshot: ExchangeRateSnapshotV1 | null): Date | null {
  if (!snapshot) return null;
  const capturedAt = new Date(snapshot.capturedAt);
  return Number.isNaN(capturedAt.getTime()) ? null : capturedAt;
}

/** 整页销毁不触发 React 卸载；只取消本视图请求，BFCache 暂存后恢复仍沿用原 Hook 和请求。 */
function abortOnDocumentDiscard(controller: AbortController): () => void {
  const onPageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) controller.abort();
  };
  window.addEventListener("pagehide", onPageHide);
  return () => {
    window.removeEventListener("pagehide", onPageHide);
    controller.abort();
  };
}

export function createUseReportExchangeRates(store: ExchangeRateStore) {
  const useExchangeRates = createUseExchangeRates(store);

  return function useReportExchangeRates(preferredProvider: ExchangeRateProvider = DEFAULT_EXCHANGE_RATE_PROVIDER) {
    const live = useExchangeRates(preferredProvider);
    const [snapshotState, setSnapshotState] = useState<CurrentReportSnapshotState>({
      month: "",
      snapshot: null,
      loaded: false,
    });
    const [captureError, setCaptureError] = useState<unknown>(null);
    const capturedSignatureRef = useRef<string>("");
    const month = currentReportMonthUTC();
    const snapshotLoaded = snapshotState.month === month && snapshotState.loaded;
    const currentSnapshot = snapshotLoaded ? snapshotState.snapshot : null;

    useEffect(() => {
      const controller = new AbortController();
      const dispose = abortOnDocumentDiscard(controller);
      capturedSignatureRef.current = "";
      // 先读当前月快照再决定 capture；loaded 和 snapshot 必须原子更新，避免短暂 null 被误判成未锁定。
      setSnapshotState({ month, snapshot: null, loaded: false });
      void exchangeRateSnapshotService.list({ from: month, to: month }, controller.signal)
        .then((snapshots) => {
          if (!controller.signal.aborted) {
            setSnapshotState({ month, snapshot: snapshots[0] ?? null, loaded: true });
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSnapshotState({ month, snapshot: null, loaded: true });
          }
        });
      return dispose;
    }, [month]);

    useEffect(() => {
      if (!snapshotLoaded || live.loading || live.isRefreshing || !isSnapshotProvider(live.activeProvider) || !live.sourceDate) return;
      const snapshotBody = {
        base: "USD" as const,
        rates: live.rates,
        requestedProvider: preferredProvider,
        provider: live.activeProvider,
        sourceDate: live.sourceDate,
        ...(live.warning ? { warning: live.warning } : {}),
      };
      const signature = exchangeRateSnapshotSignature(snapshotBody);
      if (capturedSignatureRef.current === signature || exchangeRateSnapshotSignature(currentSnapshot) === signature) return;
      const controller = new AbortController();
      const dispose = abortOnDocumentDiscard(controller);
      capturedSignatureRef.current = signature;
      // 当前月快照是报表口径缓存，不是实时汇率请求的成功条件；capture 失败只降级为未锁定状态。
      void exchangeRateSnapshotService.capture(month, snapshotBody, controller.signal)
        .then((snapshot) => {
          if (controller.signal.aborted) return;
          setSnapshotState({ month, snapshot, loaded: true });
          setCaptureError(null);
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          capturedSignatureRef.current = "";
          setCaptureError(error);
        });
      return dispose;
    }, [currentSnapshot, live.activeProvider, live.isRefreshing, live.loading, live.rates, live.sourceDate, live.warning, month, preferredProvider, snapshotLoaded]);

    useEffect(() => {
      // 请求拒绝可先于 pagehide 的取消监听执行；诊断跟随错误状态 commit，销毁文档不再产生迟到副作用。
      if (captureError !== null) console.warn("Failed to capture report exchange-rate snapshot:", captureError);
    }, [captureError]);

    const reportBasisStatus = useMemo<ReportExchangeRateBasisStatus>(() => ({
      month,
      locked: currentSnapshot !== null,
      sourceDate: currentSnapshot?.sourceDate ?? null,
      capturedAt: currentSnapshot?.capturedAt ?? null,
    }), [currentSnapshot, month]);
    // 报表消费者必须优先使用已锁定快照；实时 rates 只在当前月还没有快照时作为临时口径。
    const basisRates = currentSnapshot?.rates ?? live.rates;
    const convert = useCallback((
      amount: number | string,
      fromCurrency: string,
      toCurrency: string,
    ): number => {
      const numericAmount = moneyToNumber(amount);
      if (fromCurrency === toCurrency) return numericAmount;
      const fromRate = basisRates[fromCurrency] || 1;
      const toRate = basisRates[toCurrency] || 1;
      return (numericAmount / fromRate) * toRate;
    }, [basisRates]);

    return {
      ...live,
      rates: basisRates,
      activeProvider: currentSnapshot?.provider ?? live.activeProvider,
      sourceDate: currentSnapshot?.sourceDate ?? live.sourceDate,
      lastUpdated: snapshotCapturedDate(currentSnapshot) ?? live.lastUpdated,
      // 锁定快照保证报表可继续读取；主动刷新进度必须单独透出，不能让旧口径掩盖按钮状态。
      loading: currentSnapshot ? false : live.loading,
      isRefreshing: live.isRefreshing,
      convert,
      reportBasisStatus,
      reportBasisCaptureError: captureError,
    };
  };
}

export const useReportExchangeRates = createUseReportExchangeRates(defaultExchangeRateStore);
