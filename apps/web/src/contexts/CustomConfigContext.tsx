import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useCustomConfigController } from "@/modules/custom-config/application/use-custom-config-state";
import type { CustomConfig } from "@/types/config";
import { useSettings } from "@/hooks/use-settings";
import { useI18n } from "@/i18n/I18nProvider";
import { isChineseLunarCalendarSupported } from "@/lib/time/chinese-lunar";

interface CustomConfigStateValue {
  config: CustomConfig;
}

interface CustomConfigActionsValue {
  saveConfig: (config: CustomConfig) => Promise<CustomConfig>;
}

const CustomConfigStateContext = createContext<CustomConfigStateValue | null>(null);
const CustomConfigActionsContext = createContext<CustomConfigActionsValue | null>(null);

interface LunarCalendarContextValue {
  enabled: boolean;
  supported: boolean;
}

const LunarCalendarContext = createContext<LunarCalendarContextValue>({ enabled: false, supported: false });

/** 私有壳层共享账号设置；查询未就绪时保持关闭，避免日期控件伪造远端偏好。 */
export function LunarCalendarProvider({ children }: { children: ReactNode }) {
  const { data: settings } = useSettings();
  const { locale } = useI18n();
  const supported = isChineseLunarCalendarSupported(locale);
  const value = useMemo<LunarCalendarContextValue>(
    () => ({ supported, enabled: supported && settings?.showLunarCalendar === true }),
    [settings?.showLunarCalendar, supported],
  );

  return <LunarCalendarContext.Provider value={value}>{children}</LunarCalendarContext.Provider>;
}

export function useLunarCalendar(): LunarCalendarContextValue {
  return useContext(LunarCalendarContext);
}

/** 配置数据与写动作分开发布，保存状态变化不会让所有只读卡片重新渲染。 */
export function CustomConfigProvider({ children }: { children: ReactNode }) {
  const { config, saveConfig } = useCustomConfigController();
  const stateValue = useMemo(() => ({ config }), [config]);
  const actionsValue = useMemo(() => ({ saveConfig }), [saveConfig]);

  return (
    <CustomConfigActionsContext.Provider value={actionsValue}>
      <CustomConfigStateContext.Provider value={stateValue}>
        {children}
      </CustomConfigStateContext.Provider>
    </CustomConfigActionsContext.Provider>
  );
}

export function useCustomConfigState(): CustomConfigStateValue {
  const context = useContext(CustomConfigStateContext);
  if (!context) {
    throw new Error("useCustomConfigState must be used within a CustomConfigProvider");
  }
  return context;
}

export function useCustomConfigActions(): CustomConfigActionsValue {
  const context = useContext(CustomConfigActionsContext);
  if (!context) {
    throw new Error("useCustomConfigActions must be used within a CustomConfigProvider");
  }
  return context;
}
