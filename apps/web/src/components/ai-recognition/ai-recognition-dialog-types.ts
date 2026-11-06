import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import type { AIDraftConfirmationField } from "@/modules/ai-recognition/domain/ai-recognition-form";
import type { SubscriptionFormState } from "@/types/subscription-form";

export interface AIRecognitionImageItem {
  id: string;
  file: File;
  // thumbnailUrl 是浏览器 object URL；弹层关闭和图片移除时必须显式 revoke，不能交给 GC 碰运气。
  thumbnailUrl: string | null;
  originalSizeBytes?: number;
  targetSizeBytes?: number;
  optimized?: boolean;
  optimizationWarning?: "large-after-optimization" | null;
}

export interface AIDraftListItem {
  id: string;
  // sourceDraft 是不可变识别证据，formData 是唯一可编辑事实源；pending 只记录 AI 默认值是否经用户显式确认，不能由当前表单是否合法反推。
  sourceDraft: AiRecognizedSubscriptionDraft;
  formData: SubscriptionFormState;
  pendingConfirmationFields: readonly AIDraftConfirmationField[];
}

export type AIDraftFilter = "all" | "warning" | "low-confidence" | "missing-core";
