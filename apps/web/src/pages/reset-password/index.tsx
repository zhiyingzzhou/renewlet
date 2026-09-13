/**
 * 重置密码页面入口。
 *
 * 架构位置：从 URL query 提取 PocketBase reset token，并把提交流程交给客户端表单。
 *
 * 注意： token 只能在提交时由后端验证；前端不要尝试解析或缓存 token。
 */
import { useSearchParams } from "react-router";
import { ResetPasswordClient } from "./reset-password-client";
import { useRouteReady } from "@/components/route-progress";

export default function ResetPasswordPage() {
  useRouteReady();
  const [searchParams] = useSearchParams();
  return <ResetPasswordClient token={searchParams.get("token") ?? ""} />;
}
