/**
 * React Router SPA 兜底 404 页面。
 *
 * 这里会记录一次统一客户端错误，便于开发和线上采样发现 Cloudflare Static Assets
 * fallback 或 Docker 嵌入静态资源漏配导致的错误路由。
 */

import { useEffect } from "react";
import { useRouteReady } from "@/components/route-progress";
import { usePathname } from '@/lib/router';
import Link from '@/components/router-link';
import { useI18n } from "@/i18n/I18nProvider";
import { reportClientError } from "@/lib/report-client-error";

export default function NotFound() {
  useRouteReady();
  const pathname = usePathname();
  const { t } = useI18n();

  useEffect(() => {
    reportClientError(new Error("not found route"), { source: "not-found", pathname });
  }, [pathname]);

  return (
    <div className="auth-page bg-muted">
      <div className="text-center">
        <h1 className="mb-4 text-4xl font-bold">404</h1>
        <p className="mb-4 text-xl text-muted-foreground">{t("notFound.title")}</p>
        <Link href="/" className="text-primary underline hover:text-primary/90">
          {t("notFound.home")}
        </Link>
      </div>
    </div>
  );
}
