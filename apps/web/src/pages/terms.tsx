/**
 * 服务条款（公开页面，无需登录）。
 *
 * 说明：
 * - 登录页会链接到这里；因此必须在 `src/components/auth-sync.tsx` 中加入白名单
 * - 这里提供“自托管开源项目”的通用条款说明；你可以按自己的需求进一步补充/替换
 */

import { LegalPageShell } from "@/components/legal-page";
import { useI18n } from "@/i18n/I18nProvider";
import { useRouteReady } from "@/components/route-progress";
import type { MessageKey } from "@/i18n/messages";

const TERMS_SECTIONS: Array<{ title: MessageKey; items: MessageKey[] }> = [
  {
    title: "legal.terms.scope.title",
    items: ["legal.terms.scope.lawful", "legal.terms.scope.accuracy"],
  },
  {
    title: "legal.terms.account.title",
    items: ["legal.terms.account.localAuth", "legal.terms.account.operator"],
  },
  {
    title: "legal.terms.thirdParty.title",
    items: ["legal.terms.thirdParty.features", "legal.terms.thirdParty.responsibility"],
  },
  {
    title: "legal.terms.disclaimer.title",
    items: ["legal.terms.disclaimer.asIs", "legal.terms.disclaimer.loss"],
  },
];

export default function TermsPage() {
  useRouteReady();
  const { t } = useI18n();

  return (
    <LegalPageShell title={t("legal.terms.title")} subtitle={t("legal.terms.subtitle")}>
      <div className="grid gap-4">
        <p>{t("legal.terms.intro")}</p>
        {TERMS_SECTIONS.map((section) => (
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
