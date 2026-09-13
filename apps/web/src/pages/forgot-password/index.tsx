/**
 * 忘记密码页面入口。
 *
 * 架构位置：Docker/PocketBase 可通过部署邮件启用；Cloudflare 固定关闭，账号恢复走管理员重置。
 */
import { ForgotPasswordClient } from "./forgot-password-client";
import { usePasswordResetAvailability } from "@/hooks/use-password-reset-availability";
import { useRouteReady } from "@/components/route-progress";

export default function ForgotPasswordPage() {
  useRouteReady();
  const enabled = usePasswordResetAvailability();
  return <ForgotPasswordClient enabled={enabled} />;
}
