/**
 * 编辑订阅弹窗适配器。
 *
 * 架构位置：
 * - 页面控制器持有 editingSubscription/open 状态。
 * - 本组件只把编辑模式参数转发给通用 SubscriptionDialog，避免新增/编辑表单分叉。
 */
import { SubscriptionDialog } from "@/components/subscription-dialog";
import type {
  Subscription,
  SubscriptionCollectionItem,
  SubscriptionFormSubmission,
} from "@/types/subscription";

interface EditSubscriptionDialogProps {
  /** 当前正在编辑的订阅（null 表示未选中）。 */
  subscription: Subscription | null;
  loadingPreview: SubscriptionCollectionItem | null;
  /** 弹窗是否打开。 */
  open: boolean;
  /** 弹窗开关回调（由上层控制）。 */
  onOpenChange: (open: boolean) => void;
  onSave: (submission: SubscriptionFormSubmission) => void | Promise<void>;
  /** 当前用户已有标签建议。 */
  availableTags?: readonly string[] | undefined;
  loading?: boolean | undefined;
}

/** 以 edit mode 渲染通用订阅弹窗。 */
export function EditSubscriptionDialog({
  subscription,
  loadingPreview,
  open,
  onOpenChange,
  onSave,
  availableTags,
  loading,
}: EditSubscriptionDialogProps) {
  return (
    <SubscriptionDialog
      mode="edit"
      open={open}
      onOpenChange={onOpenChange}
      subscription={subscription}
      loadingPreview={loadingPreview}
      onSubmit={onSave}
      availableTags={availableTags}
      loading={loading}
    />
  );
}
