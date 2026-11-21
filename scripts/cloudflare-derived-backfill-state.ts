/** migration 与 v5 marker 共同决定升级状态；旧 v2/v3 marker 都不能授权跳过 cancelled 派生语义重建。 */
export const SUBSCRIPTION_DERIVED_BACKFILL_NAME = "subscription-derived-state-v5";

export type DerivedBackfillState =
  | "legacy"
  | "v2-needs-repair-migration"
  | "v5-pending-backfill"
  | "v5-complete"
  | "invalid-mixed";

/** migration 记录、完整列签名和 completion marker 共同组成可部署状态，不能只信任其中一个信号。 */
export interface DerivedSchemaShape {
  v2MigrationApplied: boolean;
  v3MigrationApplied: boolean;
  listIndexColumns: readonly string[];
  tagColumns: readonly string[];
  statsColumns: readonly string[];
  repeatScheduleColumns: readonly string[];
  repeatScheduleIndexColumns: readonly string[];
  schedulerColumns: readonly string[];
  schedulerAutoIndexColumns: readonly string[];
  schedulerDailyIndexColumns: readonly string[];
  schedulerRepeatIndexColumns: readonly string[];
  backfillColumns: readonly string[];
  primaryKeysValid: boolean;
  foreignKeysValid: boolean;
  constraintsValid: boolean;
  markerPresent: boolean;
}

/** 状态机将可重放写入、全量不变量校验和 marker 提交拆开，强制完成证据最后落库。 */
export interface DerivedBackfillActions {
  rebuild(): Promise<void>;
  verify(): Promise<void>;
  markComplete(): Promise<void>;
}

const statsV2Columns = [
  "user_id",
  "total_count",
  "trial_count",
  "active_count",
  "expired_count",
  "paused_count",
  "cancelled_count",
  "created_at",
  "updated_at",
] as const;
const listIndexColumns = [
  "subscription_id",
  "user_id",
  "name",
  "website",
  "notes",
  "search_text_lower",
  "category",
  "billing_cycle",
  "currency",
  "payment_method",
  "status",
  "pinned",
  "public_hidden",
  "next_billing_date",
  "trial_end_date",
  "one_time_term_count",
  "auto_renew",
  "reminder_days",
  "repeat_reminder_enabled",
  "created_at",
  "updated_at",
] as const;
const tagColumns = ["user_id", "subscription_id", "tag_norm", "tag", "created_at", "updated_at"] as const;

const repeatScheduleColumns = ["user_id", "subscription_id", "next_due_at_utc"] as const;
const repeatScheduleIndexColumns = ["user_id", "next_due_at_utc", "subscription_id"] as const;
const schedulerColumns = [
  "user_id",
  "auto_renew_count",
  "repeat_reminder_count",
  "last_auto_renew_local_date",
  "created_at",
  "updated_at",
  "next_auto_renew_check_at_utc",
  "next_daily_notification_due_at_utc",
  "next_repeat_notification_due_at_utc",
] as const;
const backfillColumns = ["name", "completed_at"] as const;
const statsV2ExclusiveColumns = [
  "trial_count",
  "active_count",
  "expired_count",
  "paused_count",
  "cancelled_count",
] as const;

function sameOrderedValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

/** 按完整有序列签名识别 schema，避免同名但列顺序/形状漂移的表被误判为可用。 */
export function classifyDerivedSchema(shape: DerivedSchemaShape): DerivedBackfillState {
  const completeCollectionShape = sameOrderedValues(shape.listIndexColumns, listIndexColumns)
    && sameOrderedValues(shape.tagColumns, tagColumns);
  const completeV2Shape = sameOrderedValues(shape.statsColumns, statsV2Columns)
    && sameOrderedValues(shape.repeatScheduleColumns, repeatScheduleColumns)
    && sameOrderedValues(shape.repeatScheduleIndexColumns, repeatScheduleIndexColumns)
    && sameOrderedValues(shape.schedulerColumns, schedulerColumns)
    && sameOrderedValues(shape.schedulerAutoIndexColumns, ["next_auto_renew_check_at_utc", "user_id"])
    && sameOrderedValues(shape.schedulerDailyIndexColumns, ["next_daily_notification_due_at_utc", "user_id"])
    && sameOrderedValues(shape.schedulerRepeatIndexColumns, ["next_repeat_notification_due_at_utc", "user_id"])
    && sameOrderedValues(shape.backfillColumns, backfillColumns)
    && shape.primaryKeysValid
    && shape.foreignKeysValid
    && shape.constraintsValid;
  if (shape.v2MigrationApplied && shape.v3MigrationApplied && completeCollectionShape && completeV2Shape) {
    return shape.markerPresent ? "v5-complete" : "v5-pending-backfill";
  }
  if (shape.v2MigrationApplied && !shape.v3MigrationApplied && completeCollectionShape && completeV2Shape && !shape.markerPresent) {
    return "v2-needs-repair-migration";
  }

  const hasAnyV2Object = shape.repeatScheduleColumns.length > 0
    || shape.repeatScheduleIndexColumns.length > 0
    || shape.backfillColumns.length > 0
    || shape.statsColumns.some((column) => statsV2ExclusiveColumns.some((expected) => expected === column));
  const hasLegacyStats = shape.statsColumns.length === 0 || shape.statsColumns.includes("status_counts_json");
  const hasLegacyCollectionShape = (shape.listIndexColumns.length === 0 && shape.tagColumns.length === 0)
    || completeCollectionShape;
  if (
    !shape.v2MigrationApplied
    && !shape.v3MigrationApplied
    && !hasAnyV2Object
    && hasLegacyCollectionShape
    && hasLegacyStats
    && !shape.markerPresent
  ) {
    return "legacy";
  }
  return "invalid-mixed";
}

/** 执行唯一允许的状态迁移；complete 仍需复验，缺 migration 或 mixed 不做现场 ALTER 修补。 */
export async function executeDerivedBackfillState(
  state: DerivedBackfillState,
  actions: DerivedBackfillActions,
): Promise<void> {
  switch (state) {
    case "legacy":
      throw new Error("Cloudflare subscription derived-state schema is legacy; apply migrations 0036 and 0039 before backfill");
    case "v2-needs-repair-migration":
      throw new Error("Cloudflare subscription derived-state schema is v2; apply migration 0039 before v5 backfill");
    case "invalid-mixed":
      throw new Error("Cloudflare subscription derived-state schema is invalid or mixed; refusing automatic schema repair");
    case "v5-complete":
      await actions.verify();
      return;
    case "v5-pending-backfill":
      // pending 可能来自进程中断或 REST 响应丢失；只重放幂等派生写入，marker 永远排在完整校验之后。
      await actions.rebuild();
      await actions.verify();
      await actions.markComplete();
      return;
    default: {
      const unsupportedState: never = state;
      throw new Error(`Unsupported derived backfill state: ${unsupportedState}`);
    }
  }
}
