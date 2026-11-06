import type { ReactNode } from "react";
import type {
  Subscription,
  SubscriptionCollectionItem,
  SubscriptionFormSubmission,
} from "@/types/subscription";

type CreateSubscriptionDialogProps = {
  mode: "create";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (submission: SubscriptionFormSubmission) => void | Promise<void>;
  initialSubscription?: Subscription | null | undefined;
  availableTags?: readonly string[] | undefined;
  trigger?: ReactNode;
  loading?: boolean | undefined;
  loadingPreview: SubscriptionCollectionItem | null;
};

type EditSubscriptionDialogProps = {
  mode: "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription: Subscription | null;
  onSubmit: (submission: SubscriptionFormSubmission) => void | Promise<void>;
  availableTags?: readonly string[] | undefined;
  loading?: boolean | undefined;
  loadingPreview: SubscriptionCollectionItem | null;
};

export type SubscriptionDialogProps = CreateSubscriptionDialogProps | EditSubscriptionDialogProps;

export type SubscriptionDialogContentProps = SubscriptionDialogProps & {
  onNestedDialogOpenChange: (open: boolean) => void;
  onRequestClose: () => void;
  onSubmittingChange: (submitting: boolean) => void;
};
