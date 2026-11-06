/**
 * 新增订阅弹窗适配器。
 *
 * 架构位置：
 * - 外层页面只关心 onAdd。
 * - 本组件维护 create dialog 的 open 状态和默认触发按钮。
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SubscriptionDialog } from "@/components/subscription-dialog";
import type { SubscriptionFormSubmission } from "@/types/subscription";
import { useI18n } from "@/i18n/I18nProvider";

interface AddSubscriptionDialogProps {
  /** 提交新增订阅（不包含 id，由后端生成）。 */
  onAdd: (submission: SubscriptionFormSubmission) => void | Promise<void>;
  /** 当前用户已有标签建议。 */
  availableTags?: readonly string[] | undefined;
  /** 自定义触发器（不传则使用默认 “+ 新增订阅” 按钮）。 */
  trigger?: ReactNode;
}

/** 以 create mode 渲染通用订阅弹窗。 */
export function AddSubscriptionDialog({ onAdd, availableTags, trigger }: AddSubscriptionDialogProps) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();

  const defaultTrigger = (
    <Button className="h-12 w-12 shrink-0 gap-2 bg-primary px-0 text-primary-foreground hover:bg-primary-glow sm:h-10 sm:w-10 sm:px-0 xl:w-auto xl:px-4">
      <Plus className="h-4 w-4" />
      <span className="hidden xl:inline">{t("subscription.add")}</span>
      <span className="sr-only xl:hidden">{t("subscription.add")}</span>
    </Button>
  );

  return (
    <SubscriptionDialog
      mode="create"
      open={open}
      onOpenChange={setOpen}
      onSubmit={onAdd}
      loadingPreview={null}
      availableTags={availableTags}
      trigger={trigger || defaultTrigger}
    />
  );
}
