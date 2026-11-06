import { z } from "zod";
import { moneyStringSchema } from "../money";

export const subscriptionBalanceWriteShape = {
  balance: moneyStringSchema.nullable().optional(),
  balanceCurrency: z.string().trim().regex(/^[A-Z]{3}$/).nullable().optional(),
};

export const subscriptionBalanceReadShape = {
  balance: moneyStringSchema.optional().describe("手动记录的预付账户余额，与订阅价格独立；不自动扣减。未记录时省略，零是有效金额。"),
  balanceCurrency: z.string().regex(/^[A-Z]{3}$/).optional().describe("余额的 ISO 4217 币种；与 balance 成对返回，不随订阅币种变化。"),
};

type BalanceFields = {
  balance?: string | null | undefined;
  balanceCurrency?: string | null | undefined;
};

// 余额是手动记录的金额快照：缺席保留、双 null 清空、金额和币种一起替换；零不能代表未设置。
export function subscriptionBalanceFieldsAreConsistent(value: BalanceFields): boolean {
  if (value.balance === undefined) return value.balanceCurrency === undefined;
  if (value.balance === null) return value.balanceCurrency === null;
  return typeof value.balanceCurrency === "string";
}

export const subscriptionBalanceCheck = z.refine<BalanceFields>(subscriptionBalanceFieldsAreConsistent, {
  path: ["balance"],
  message: "Balance and balance currency must be provided together",
});
