import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateSubscriptionCollections, subscriptionQueryKeys } from "@/hooks/subscription-query-cache";
import { bulkPublicVisibility } from "@/services/subscription-public-visibility-service";

export function useBulkPublicVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: bulkPublicVisibility,
    onSuccess: (result, body) => {
      // 预览不写库；应用只返回计数，必须让集合与已缓存详情重新取值，防止后续编辑带回旧 publicHidden。
      if (body.dryRun || result.changedCount === 0) return;
      void invalidateSubscriptionCollections(queryClient);
      void queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.details });
    },
  });
}
