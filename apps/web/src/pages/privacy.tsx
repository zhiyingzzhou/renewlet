/**
 * 隐私政策（公开页面，无需登录）。
 *
 * 说明：
 * - 本项目属于“可自托管开源应用”，因此隐私边界取决于“谁在运营部署实例”
 * - 该文档以“默认实现”为准：PocketBase + SQLite + PB 文件存储；通知渠道由用户配置
 */

import { LegalPageShell } from "@/components/legal-page";
import { useI18n } from "@/i18n/I18nProvider";
import { useRouteReady } from "@/components/route-progress";
import type { MessageKey } from "@/i18n/messages";

const PRIVACY_SECTIONS: Array<{ title: MessageKey; items: MessageKey[] }> = [
  {
    title: "legal.privacy.data.title",
    items: ["legal.privacy.data.account", "legal.privacy.data.business", "legal.privacy.data.files"],
  },
  {
    title: "legal.privacy.usage.title",
    items: ["legal.privacy.usage.core", "legal.privacy.usage.notifications"],
  },
  {
    title: "legal.privacy.thirdParty.title",
    items: [
      "legal.privacy.thirdParty.rates",
      "legal.privacy.thirdParty.icons",
      "legal.privacy.thirdParty.notifications",
      "legal.privacy.thirdParty.ai",
      "legal.privacy.thirdParty.customScript",
    ],
  },
  {
    title: "legal.privacy.control.title",
    items: ["legal.privacy.control.settings", "legal.privacy.control.selfHost"],
  },
];

export default function PrivacyPage() {
  useRouteReady();
  const { t } = useI18n();

  return (
    <LegalPageShell title={t("legal.privacy.title")} subtitle={t("legal.privacy.subtitle")}>
      <div className="grid gap-4">
        <p>{t("legal.privacy.intro")}</p>
        {PRIVACY_SECTIONS.map((section) => (
          <section key={section.title} className="grid gap-2">
            <h2 className="text-base font-semibold text-foreground">{t(section.title)}</h2>
            <ul className="list-disc pl-5 grid gap-1">
              {section.items.map((item) => <li key={item}>{t(item)}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </LegalPageShell>
  );
}
