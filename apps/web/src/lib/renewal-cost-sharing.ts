import { costSharingMemberJoinedDateIsWithinRange, type CostSharing } from "@renewlet/shared/cost-sharing";
import type { DateOnly } from "@/lib/time/date-only";

export interface RenewalMemberDate {
  id: string;
  name: string;
  originalDate: DateOnly;
  joinedDate: DateOnly;
  invalid: boolean;
}

export function renewalMemberDateFields(
  costSharing: CostSharing | undefined,
  startDate: DateOnly | null,
  nextBillingDate: DateOnly,
  drafts: ReadonlyMap<string, DateOnly>,
): RenewalMemberDate[] {
  if (!costSharing?.enabled || !startDate) return [];
  const range = { minDate: startDate, maxDate: nextBillingDate };
  return costSharing.members.flatMap((member) => {
    if (!member.joinedDate) return [];
    if (!drafts.has(member.id) && costSharingMemberJoinedDateIsWithinRange(member, range)) return [];
    // 越界日期的默认建议随新区间计算；用户手改后保留草稿并校验，不能因改订阅日期或刷新而再次覆盖。
    const joinedDate = drafts.get(member.id) ?? startDate;
    return [{ id: member.id, name: member.name, originalDate: member.joinedDate, joinedDate,
      invalid: !costSharingMemberJoinedDateIsWithinRange({ joinedDate }, range) }];
  });
}
