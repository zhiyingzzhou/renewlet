import { useCallback } from "react";
import {
  useCreatePublicStatusPage,
  useDeletePublicStatusPage,
  usePublicStatusPageStatus,
  useUpdatePublicStatusPage,
} from "@/hooks/use-public-status-page";
import { useBulkPublicVisibility } from "@/hooks/use-bulk-public-visibility";
import { toast } from "@/components/ui/sonner";
import { useI18n } from "@/i18n/I18nProvider";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { copyTextToClipboard, type ClipboardCopyTarget } from "@/shared/browser/clipboard";
import type { PublicStatusPage } from "@/lib/api/schemas/public-status";
import type { SubscriptionFacets } from "@/services/subscription-service";
import { toSettingsReadState, type SettingsReadState } from "./settings-read-state";

export interface SettingsPublicStatusPageController {
  status: SettingsReadState<PublicStatusPage>;
  visibility: SettingsReadState<{ visibleCount: number; hiddenCount: number; expiredCount: number; lifetimeCount: number }>;
  isCreating: boolean;
  isDeleting: boolean;
  isUpdating: boolean;
  createOrRotate: () => Promise<void>;
  copyUrl: (target?: ClipboardCopyTarget | null) => Promise<void>;
  openPage: () => Promise<void>;
  regenerate: () => Promise<boolean>;
  revoke: () => Promise<boolean>;
  updateShowPrices: (checked: boolean) => Promise<void>;
  updateHideExpired: (checked: boolean) => Promise<void>;
  updateHideLifetime: (checked: boolean) => Promise<void>;
  bulkPublicVisibility: (categories: Array<"expired" | "lifetime">, publicHidden: boolean, dryRun?: boolean) => Promise<{ matchedCount: number; changedCount: number }>;
}

export function usePublicStatusPageSettingsController(
  facets: SettingsReadState<SubscriptionFacets>,
): SettingsPublicStatusPageController {
  const { t } = useI18n();
  const publicStatusPageStatus = usePublicStatusPageStatus();
  const createPublicStatusPage = useCreatePublicStatusPage();
  const updatePublicStatusPage = useUpdatePublicStatusPage();
  const deletePublicStatusPage = useDeletePublicStatusPage();
  const { mutateAsync: runBulkVisibility } = useBulkPublicVisibility();
  const visibility = {
    ...facets,
    data: facets.data ? {
      visibleCount: facets.data.visibleCount,
      hiddenCount: facets.data.hiddenCount,
      expiredCount: facets.data.expiredCount,
      lifetimeCount: facets.data.lifetimeCount,
    } : undefined,
  } satisfies SettingsReadState<{ visibleCount: number; hiddenCount: number; expiredCount: number; lifetimeCount: number }>;

  const handleCreatePublicStatusPage = useCallback(async () => {
    try {
      // 公开页 token 是 bearer secret；创建成功后立即更新缓存，避免复制到旧地址或空地址。
      await createPublicStatusPage.mutateAsync();
      toast.success(t("settings.publicStatusGenerated"));
    } catch (error) {
      toast.error(t("settings.publicStatusFailed"), {
        description: getDisplayErrorMessage(error, t("settings.publicStatusFailedDescription")),
      });
    }
  }, [createPublicStatusPage, t]);

  const handleCopyPublicStatusUrl = useCallback(async (target?: ClipboardCopyTarget | null) => {
    const pageUrl = publicStatusPageStatus.data?.pageUrl;
    if (!pageUrl) return;
    const copyResult = await copyTextToClipboard(pageUrl, { target });
    if (copyResult.ok) {
      toast.success(t("settings.publicStatusCopied"));
      return;
    }
    toast.error(t("settings.publicStatusCopyFailed"), {
      description: t("settings.publicStatusCopyFailedDescription"),
    });
  }, [publicStatusPageStatus.data?.pageUrl, t]);

  const handleOpenPublicStatusPage = useCallback(async () => {
    const pageUrl = publicStatusPageStatus.data?.pageUrl;
    if (!pageUrl) return;
    window.open(pageUrl, "_blank", "noopener,noreferrer");
  }, [publicStatusPageStatus.data?.pageUrl]);

  const handleRevokePublicStatusPage = useCallback(async () => {
    try {
      // 撤销的安全边界在服务端删除 token；前端缓存只是让设置页立刻停止显示旧 URL。
      await deletePublicStatusPage.mutateAsync();
      toast.success(t("settings.publicStatusRevoked"));
      return true;
    } catch (error) {
      toast.error(t("settings.publicStatusFailed"), {
        description: getDisplayErrorMessage(error, t("settings.publicStatusRevokeFailedDescription")),
      });
      return false;
    }
  }, [deletePublicStatusPage, t]);

  const handleRegeneratePublicStatusPage = useCallback(async () => {
    try {
      // 轮换采用先撤销后创建；只有旧 token 已失效后，设置页才展示新公开页 URL。
      await deletePublicStatusPage.mutateAsync();
      await createPublicStatusPage.mutateAsync();
      toast.success(t("settings.publicStatusRegenerated"));
      return true;
    } catch (error) {
      toast.error(t("settings.publicStatusFailed"), {
        description: getDisplayErrorMessage(error, t("settings.publicStatusFailedDescription")),
      });
      return false;
    }
  }, [createPublicStatusPage, deletePublicStatusPage, t]);

  const updatePage = useCallback(async (changes: { showPrices: boolean; hideExpired: boolean; hideLifetime: boolean }, message: string) => {
    if (!publicStatusPageStatus.data?.enabled) return;
    try {
      await updatePublicStatusPage.mutateAsync(changes);
      toast.success(message);
    } catch (error) {
      toast.error(t("settings.publicStatusFailed"), {
        description: getDisplayErrorMessage(error, t("settings.publicStatusUpdateFailedDescription")),
      });
    }
  }, [publicStatusPageStatus.data?.enabled, t, updatePublicStatusPage]);
  const handleUpdatePublicStatusShowPrices = useCallback((checked: boolean) => updatePage({
    showPrices: checked,
    hideExpired: publicStatusPageStatus.data?.hideExpired === true,
    hideLifetime: publicStatusPageStatus.data?.hideLifetime === true,
  }, checked ? t("settings.publicStatusPricesEnabled") : t("settings.publicStatusPricesDisabled")), [publicStatusPageStatus.data?.hideExpired, publicStatusPageStatus.data?.hideLifetime, updatePage, t]);
  const handleUpdatePublicStatusHideExpired = useCallback((checked: boolean) => updatePage({
    showPrices: publicStatusPageStatus.data?.showPrices === true,
    hideExpired: checked,
    hideLifetime: publicStatusPageStatus.data?.hideLifetime === true,
  }, checked ? t("settings.publicStatusExpiredHidden") : t("settings.publicStatusExpiredShown")), [publicStatusPageStatus.data?.hideLifetime, publicStatusPageStatus.data?.showPrices, updatePage, t]);
  const handleUpdatePublicStatusHideLifetime = useCallback((checked: boolean) => updatePage({
    showPrices: publicStatusPageStatus.data?.showPrices === true,
    hideExpired: publicStatusPageStatus.data?.hideExpired === true,
    hideLifetime: checked,
  }, checked ? t("settings.publicStatusLifetimeHidden") : t("settings.publicStatusLifetimeShown")), [publicStatusPageStatus.data?.hideExpired, publicStatusPageStatus.data?.showPrices, updatePage, t]);
  const handleBulkPublicVisibility = useCallback(async (categories: Array<"expired" | "lifetime">, publicHidden: boolean, dryRun = false) => {
    try {
      // 预览 Effect 依赖稳定的命令函数；mutation observer 会随 pending/success 状态换引用，不能把状态对象带进回调依赖。
      const result = await runBulkVisibility({ selection: { categories }, publicHidden, dryRun });
      if (!dryRun) toast.success(t("settings.publicStatusBulkVisibilityDone", { count: result.changedCount }));
      return result;
    } catch (error) {
      if (!dryRun) {
        toast.error(t("settings.publicStatusFailed"), { description: getDisplayErrorMessage(error, t("settings.publicStatusUpdateFailedDescription")) });
      }
      throw error;
    }
  }, [runBulkVisibility, t]);

  return {
    status: toSettingsReadState(publicStatusPageStatus),
    visibility,
    isCreating: createPublicStatusPage.isPending,
    isDeleting: deletePublicStatusPage.isPending,
    isUpdating: updatePublicStatusPage.isPending,
    createOrRotate: handleCreatePublicStatusPage,
    copyUrl: handleCopyPublicStatusUrl,
    openPage: handleOpenPublicStatusPage,
    regenerate: handleRegeneratePublicStatusPage,
    revoke: handleRevokePublicStatusPage,
    updateShowPrices: handleUpdatePublicStatusShowPrices,
    updateHideExpired: handleUpdatePublicStatusHideExpired,
    updateHideLifetime: handleUpdatePublicStatusHideLifetime,
    bulkPublicVisibility: handleBulkPublicVisibility,
  };
}
