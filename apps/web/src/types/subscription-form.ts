/**
 * 订阅表单本地状态类型。
 *
 * 架构位置：表单组件使用字符串状态适配输入控件，提交边界再转换为
 * `SubscriptionFormSubmission` 写入命令。
 *
 * 注意： 这里允许的空字符串是 UI 中间态；不要把该类型直接传给 API 写入层。
 */
import type {
  BillingCycle,
  Category,
  CostSharing,
  CustomCycleUnit,
  PaymentMethod,
  RepeatReminderInterval,
  RepeatReminderWindow,
  SubscriptionStatus,
} from "@/types/subscription";
import type { DateOnly } from "@/lib/time/date-only";

/**
 * 订阅表单提醒类型：
 * - disabled：保存为 -2，不进入应用通知和重复提醒
 * - preset：使用预设提醒天数（下拉选项）
 * - custom：使用自定义提醒天数（输入框）
 * - inherit：保存为 -1，通知计算时读取设置页全局提醒提前时间
 */
export type SubscriptionFormReminderType = "disabled" | "inherit" | "preset" | "custom";
export type OneTimePurchaseMode = "term" | "buyout";

/**
 * 订阅表单的本地状态（UI 输入专用）。
 *
 * 说明：
 * - 这里的 `price/customDays/reminderDays/...` 使用 string，是为了直接绑定 `<input />` 的 value
 * - 最终提交时（新增/编辑）会转换为业务模型所需的 `number | DateOnly | undefined`
 */
export type SubscriptionFormState = {
  name: string;
  /** Logo 的表单值必须已经是可持久化 URL，裁剪上传的 data URL 只能停留在组件内部预览态。 */
  logo: string | undefined;
  price: string;
  currency: string;
  balanceEnabled: boolean;
  balance: string;
  balanceCurrency: string;
  billingCycle: BillingCycle;
  customDays: string;
  customCycleUnit: CustomCycleUnit;
  oneTimeMode: OneTimePurchaseMode;
  oneTimeTermCount: string;
  oneTimeTermUnit: CustomCycleUnit;
  category: Category;
  status: SubscriptionStatus;
  publicHidden: boolean;
  paymentMethod: PaymentMethod | "";
  /** date-only 在表单内保持字符串，只有日历控件边界才临时转 Date。 */
  startDate: DateOnly | undefined;
  nextBillingDate: DateOnly | undefined;
  autoRenew: boolean;
  autoCalculate: boolean;
  reminderType: SubscriptionFormReminderType;
  /** `-2/-1` 是 UI 对“不提醒/继承全局提醒”的哨兵值，提交层会转回订阅存储契约。 */
  reminderDays: string;
  customReminderDays: string;
  repeatReminderEnabled: boolean;
  repeatReminderInterval: RepeatReminderInterval;
  repeatReminderWindow: RepeatReminderWindow;
  costSharing: CostSharing | undefined;
  website: string;
  notes: string;
  tags: string[];
};

export function createSubscriptionFormState(
  overrides: Partial<SubscriptionFormState> = {},
): SubscriptionFormState {
  return {
    name: "",
    logo: undefined,
    price: "",
    currency: "CNY",
    balanceEnabled: false,
    balance: "",
    balanceCurrency: "",
    billingCycle: "monthly",
    customDays: "",
    customCycleUnit: "day",
    oneTimeMode: "buyout",
    oneTimeTermCount: "1",
    oneTimeTermUnit: "month",
    category: "productivity",
    status: "active",
    publicHidden: false,
    paymentMethod: "",
    startDate: undefined,
    nextBillingDate: undefined,
    autoRenew: false,
    autoCalculate: false,
    reminderType: "inherit",
    reminderDays: "-1",
    customReminderDays: "",
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    costSharing: undefined,
    website: "",
    notes: "",
    tags: [],
    ...overrides,
  };
}
