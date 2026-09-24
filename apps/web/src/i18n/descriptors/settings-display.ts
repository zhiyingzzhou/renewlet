import { msg } from "@lingui/core/macro";

export const messages = [
  msg({ id: "settings.showLunarCalendar", message: "显示中国农历日期" }),
  msg({ id: "settings.showLunarCalendarHelp", message: "仅在日期选择器中显示公历与中国农历，不改变账单、提醒或日历日期。" }),
  msg({ id: "settings.showLunarCalendarUnsupported", message: "当前浏览器不支持中国农历显示。请升级浏览器后再启用。" }),
] as const;
