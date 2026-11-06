import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  prefetchSubscriptionDetail,
  subscriptionDetailQueryOptions,
  useCreateSubscription,
  useDeleteSubscription,
  usePatchSubscription,
  useRenewSubscription,
  useSubscriptionDetail,
  useUpdateSubscription,
} from "@/hooks/use-subscriptions";
import { useDeferredDialogCleanup } from "@/hooks/use-deferred-dialog-cleanup";
import { useDialogSessionSnapshot } from "@/hooks/use-dialog-session-snapshot";
import {
  createSubscriptionDialogTarget,
  type SubscriptionDialogTarget,
} from "@/hooks/subscription-dialog-target";
import { buildClonedSubscriptionDraft } from "@/modules/subscriptions/domain/subscription-clone";
import type {
  SubscriptionCollectionItem,
  SubscriptionFormSubmission,
} from "@/types/subscription";
import type { SubscriptionRenewBody } from "@renewlet/shared/schemas/subscriptions";

/** CRUD 控制器只保存会话目标与列表快照；完整对象始终来自唯一的详情查询缓存。 */
export function useSubscriptionCrud(subscriptions: readonly SubscriptionCollectionItem[]) {
  const queryClient = useQueryClient();
  const { mutateAsync: createSubscription } = useCreateSubscription();
  const { mutateAsync: updateSubscription } = useUpdateSubscription();
  const { mutate: patchSubscription } = usePatchSubscription();
  const {
    mutateAsync: renewSubscription,
    error: renewError,
    isPending: renewSubmitting,
    reset: resetRenewMutation,
  } = useRenewSubscription();
  const { mutate: deleteSubscription } = useDeleteSubscription();
  const [editingTarget, setEditingTarget] = useState<SubscriptionDialogTarget | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [cloningTarget, setCloningTarget] = useState<SubscriptionDialogTarget | null>(null);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [renewingTarget, setRenewingTarget] = useState<SubscriptionDialogTarget | null>(null);
  const [renewDialogOpen, setRenewDialogOpen] = useState(false);
  const editingSubscriptionId = editingTarget?.id ?? null;
  const cloningSubscriptionId = cloningTarget?.id ?? null;
  const renewingSubscriptionId = renewingTarget?.id ?? null;
  const editingQuery = useSubscriptionDetail(editingSubscriptionId, editDialogOpen);
  const cloningQuery = useSubscriptionDetail(cloningSubscriptionId, cloneDialogOpen);
  const renewingQuery = useSubscriptionDetail(renewingSubscriptionId, renewDialogOpen);
  const currentEditDialogSession = useMemo(() => ({
    subscription: editingQuery.data ?? null,
    collectionItem: editingTarget?.collectionItem ?? null,
    pending: editingQuery.isPending,
  }), [editingQuery.data, editingQuery.isPending, editingTarget?.collectionItem]);
  const currentCloneDialogSession = useMemo(() => ({
    subscription: cloningQuery.data ?? null,
    collectionItem: cloningTarget?.collectionItem ?? null,
    pending: cloningQuery.isPending,
  }), [cloningQuery.data, cloningQuery.isPending, cloningTarget?.collectionItem]);
  const currentRenewDialogSession = useMemo(() => ({
    subscription: renewingQuery.data ?? null,
    collectionItem: renewingTarget?.collectionItem ?? null,
    pending: renewingQuery.isPending,
    error: renewError ?? renewingQuery.error,
    submitting: renewSubmitting,
  }), [renewError, renewSubmitting, renewingQuery.data, renewingQuery.error, renewingQuery.isPending, renewingTarget?.collectionItem]);
  const editDialogSession = useDialogSessionSnapshot(editDialogOpen, editingSubscriptionId, currentEditDialogSession);
  const cloneDialogSession = useDialogSessionSnapshot(cloneDialogOpen, cloningSubscriptionId, currentCloneDialogSession);
  const renewDialogSession = useDialogSessionSnapshot(renewDialogOpen, renewingSubscriptionId, currentRenewDialogSession);
  const renewSubmitLock = useRef(false);
  const renewSession = useRef(0);
  const renewRestoreFocusRef = useRef<HTMLElement | null>(null);
  const { scheduleCleanup: scheduleEditCleanup, cancelCleanup: cancelEditCleanup } = useDeferredDialogCleanup(() => {
    // 关闭动画结束后再丢弃 id，避免 detail cache 在 fade-out 中解除绑定导致内容闪空。
    setEditingTarget(null);
  });
  const { scheduleCleanup: scheduleCloneCleanup, cancelCleanup: cancelCloneCleanup } = useDeferredDialogCleanup(() => {
    setCloningTarget(null);
  });
  const { scheduleCleanup: scheduleRenewCleanup, cancelCleanup: cancelRenewCleanup } = useDeferredDialogCleanup(() => {
    setRenewingTarget(null);
  });

  const handlePrefetchSubscription = useCallback((id: string) => {
    void prefetchSubscriptionDetail(queryClient, id);
  }, [queryClient]);

  const handleAddSubscription = useCallback(async (submission: SubscriptionFormSubmission) => {
    await createSubscription({ ...submission, pinned: false });
  }, [createSubscription]);

  const handleDeleteSubscription = useCallback((id: string) => {
    deleteSubscription(id);
  }, [deleteSubscription]);

  const handleTogglePinnedSubscription = useCallback((id: string) => {
    const subscription = subscriptions.find((item) => item.id === id);
    if (!subscription) return;
    // 快捷菜单只表达单字段意图，不能把列表旧快照当完整 PATCH 覆盖并发编辑。
    patchSubscription({ id, patch: { pinned: !subscription.pinned } });
  }, [patchSubscription, subscriptions]);

  const handleTogglePublicHiddenSubscription = useCallback((id: string) => {
    const subscription = subscriptions.find((item) => item.id === id);
    if (!subscription) return;
    patchSubscription({ id, patch: { publicHidden: !subscription.publicHidden } });
  }, [patchSubscription, subscriptions]);

  const handleRenewSubscription = useCallback((id: string, restoreTarget?: HTMLElement | null) => {
    if (renewSubmitLock.current) return;
    renewSession.current += 1;
    resetRenewMutation();
    renewRestoreFocusRef.current = restoreTarget ?? (typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null);
    cancelRenewCleanup();
    setRenewingTarget(createSubscriptionDialogTarget(subscriptions, id));
    setRenewDialogOpen(true);
  }, [cancelRenewCleanup, resetRenewMutation, subscriptions]);

  const handleEditSubscription = useCallback((id: string) => {
    cancelEditCleanup();
    setEditingTarget(createSubscriptionDialogTarget(subscriptions, id));
    setEditDialogOpen(true);
  }, [cancelEditCleanup, subscriptions]);

  const handleCloneSubscription = useCallback((id: string) => {
    cancelCloneCleanup();
    setCloningTarget(createSubscriptionDialogTarget(subscriptions, id));
    setCloneDialogOpen(true);
  }, [cancelCloneCleanup, subscriptions]);

  const handleSaveSubscription = useCallback(async (changes: SubscriptionFormSubmission) => {
    if (!editingSubscriptionId) return;
    await updateSubscription({ id: editingSubscriptionId, changes });
  }, [editingSubscriptionId, updateSubscription]);

  const handleSaveClonedSubscription = useCallback(async (submission: SubscriptionFormSubmission) => {
    if (!cloningQuery.data) return;
    await createSubscription(buildClonedSubscriptionDraft(cloningQuery.data, submission));
  }, [cloningQuery.data, createSubscription]);

  const handleSubmitRenewSubscription = useCallback(async (payload: SubscriptionRenewBody) => {
    if (!renewingSubscriptionId || renewSubmitLock.current) return;
    const session = renewSession.current;
    renewSubmitLock.current = true;
    try {
      await renewSubscription({ id: renewingSubscriptionId, payload });
      // 迟到响应只结束发起它的会话，不能关闭后来打开的其它订阅。
      if (renewSession.current !== session) return;
      setRenewDialogOpen(false);
      scheduleRenewCleanup();
    } finally { renewSubmitLock.current = false; }
  }, [renewSubscription, renewingSubscriptionId, scheduleRenewCleanup]);

  const handleRefreshRenewSubscription = useCallback(async () => {
    if (!renewingSubscriptionId) return null;
    const session = renewSession.current;
    resetRenewMutation();
    const result = await queryClient.fetchQuery({ ...subscriptionDetailQueryOptions(renewingSubscriptionId), staleTime: 0 });
    return session === renewSession.current ? result : null;
  }, [queryClient, renewingSubscriptionId, resetRenewMutation]);

  const handleEditRenewSubscription = useCallback(() => {
    if (!renewingSubscriptionId || renewSubmitLock.current) return;
    setRenewDialogOpen(false);
    scheduleRenewCleanup();
    handleEditSubscription(renewingSubscriptionId);
  }, [renewingSubscriptionId, scheduleRenewCleanup, handleEditSubscription]);

  const handleEditDialogOpenChange = useCallback((nextOpen: boolean) => {
    setEditDialogOpen(nextOpen);
    if (nextOpen) {
      cancelEditCleanup();
      return;
    }
    scheduleEditCleanup();
  }, [cancelEditCleanup, scheduleEditCleanup]);

  const handleCloneDialogOpenChange = useCallback((nextOpen: boolean) => {
    setCloneDialogOpen(nextOpen);
    if (nextOpen) {
      cancelCloneCleanup();
      return;
    }
    scheduleCloneCleanup();
  }, [cancelCloneCleanup, scheduleCloneCleanup]);

  const handleRenewDialogOpenChange = useCallback((nextOpen: boolean) => {
    if (renewSubmitLock.current) return;
    if (!nextOpen) renewSession.current += 1;
    setRenewDialogOpen(nextOpen);
    if (nextOpen) {
      cancelRenewCleanup();
      return;
    }
    scheduleRenewCleanup();
  }, [cancelRenewCleanup, scheduleRenewCleanup]);

  return {
    editingSubscription: editDialogSession.subscription,
    editingCollectionItem: editDialogSession.collectionItem,
    editDialogOpen,
    editDetailPending: editDialogSession.pending,
    cloningSubscription: cloneDialogSession.subscription,
    cloningCollectionItem: cloneDialogSession.collectionItem,
    cloneDialogOpen,
    cloneDetailPending: cloneDialogSession.pending,
    renewingSubscription: renewDialogSession.subscription,
    renewingCollectionItem: renewDialogSession.collectionItem,
    renewDialogOpen,
    renewDetailPending: renewDialogSession.pending,
    renewError: renewDialogSession.error,
    renewSubmitting: renewDialogSession.submitting,
    renewRestoreFocusRef,
    handlePrefetchSubscription,
    handleAddSubscription,
    handleDeleteSubscription,
    handleTogglePinnedSubscription,
    handleTogglePublicHiddenSubscription,
    handleRenewSubscription,
    handleSubmitRenewSubscription,
    handleRefreshRenewSubscription,
    handleEditRenewSubscription,
    handleEditSubscription,
    handleCloneSubscription,
    handleSaveSubscription,
    handleSaveClonedSubscription,
    handleEditDialogOpenChange,
    handleCloneDialogOpenChange,
    handleRenewDialogOpenChange,
  };
}
