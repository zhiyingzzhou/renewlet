import type { Messages } from "@lingui/core";
import { messages as admin } from "../catalogs/ru-RU/admin.po";
import { messages as auth } from "../catalogs/ru-RU/auth.po";
import { messages as common } from "../catalogs/ru-RU/common.po";
import { messages as customConfig } from "../catalogs/ru-RU/custom-config.po";
import { messages as error } from "../catalogs/ru-RU/error.po";
import { messages as labels } from "../catalogs/ru-RU/labels.po";
import { messages as legal } from "../catalogs/ru-RU/legal.po";
import { messages as notification } from "../catalogs/ru-RU/notification.po";
import { messages as publicStatus } from "../catalogs/ru-RU/public-status.po";
import { messages as settingsAccessSecurity } from "../catalogs/ru-RU/settings-access-security.po";
import { messages as settings } from "../catalogs/ru-RU/settings.po";
import { messages as subscription } from "../catalogs/ru-RU/subscription.po";

export const messages = {
  ...admin,
  ...auth,
  ...common,
  ...customConfig,
  ...error,
  ...labels,
  ...legal,
  ...notification,
  ...publicStatus,
  ...settingsAccessSecurity,
  ...settings,
  ...subscription,
} satisfies Messages;
