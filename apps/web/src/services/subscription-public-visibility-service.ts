import { apiFetch } from "@/lib/api-client";
import {
  subscriptionBulkPublicVisibilityRequestSchema,
  subscriptionBulkPublicVisibilityResponseSchema,
  type SubscriptionBulkPublicVisibilityRequest,
} from "@renewlet/shared/schemas/subscriptions";

// 批量命令独立于常驻查询服务，使列表可以按管理意图加载这条写入路径。
export function bulkPublicVisibility(body: SubscriptionBulkPublicVisibilityRequest) {
  return apiFetch("/api/app/subscriptions/bulk-public-visibility", subscriptionBulkPublicVisibilityResponseSchema, {
    method: "POST",
    body: JSON.stringify(subscriptionBulkPublicVisibilityRequestSchema.parse(body)),
  });
}
