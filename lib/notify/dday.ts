import { dDay } from "@/lib/core/schemas/home";
import { dedupeKey } from "@/lib/core/schemas/notification";
import { createAdminClient } from "@/lib/supabase/admin";

import { sendNotification } from "./send";

/**
 * D-day 리마인더 배치 (S4-13 · `dday-notifications`, 매일 09:00 KST)
 *
 * **로직만 만든다. 실행 등록(Cron·`job_runs` 기록·실패 경보)은 S8-13 소관이다**(커버리지
 * 표 배치 절 주석). 그래서 이 파일은 "지금 돌려라" 하면 도는 순수한 함수 하나다.
 *
 * ── 왜 마일스톤에서만 보내는가 ──────────────────────────────────────────────
 * 매일 "364일 남았어요" 를 보내면 그것은 알림이 아니라 소음이고, 소음이 되는 순간
 * 사용자는 채널 전체를 끈다. 그러면 정작 필요한 안내(계약 단계·일정 변경)도 못 받는다.
 * 그래서 **의미가 바뀌는 지점**에서만 보낸다.
 *
 * ── 왜 멱등 열쇠에 날짜가 아니라 마일스톤이 들어가는가 ──────────────────────
 * 배치가 하루에 두 번 돌거나 실패 후 재실행돼도 같은 마일스톤은 한 번만 나가야 한다.
 * 열쇠에 실행 날짜를 넣으면 재실행 때 다른 열쇠가 되어 중복이 나간다. 마일스톤을 넣으면
 * "이 커플의 D-30 안내" 는 영원히 하나다.
 */
export const DDAY_MILESTONES = [100, 60, 30, 14, 7, 3, 1, 0] as const;

export type DdayRunResult = {
  /** 예식일이 있는 커플 수. */
  scanned: number;
  sent: number;
  duplicate: number;
  skipped: number;
  failed: number;
};

/**
 * @param today 기준일(YYYY-MM-DD). **호출자가 넘긴다** — 배치가 '오늘' 을 스스로 정하면
 *              같은 입력으로 같은 결과가 나오지 않아 재현할 수 없다(S2-06·S3-03 과 같은 규칙).
 */
export async function runDdayNotifications(today: string): Promise<DdayRunResult> {
  const admin = createAdminClient();
  const result: DdayRunResult = { scanned: 0, sent: 0, duplicate: 0, skipped: 0, failed: 0 };

  const { data: couples } = await admin
    .from("couples")
    .select("id, wedding_date")
    .not("wedding_date", "is", null);

  const rows = (couples ?? []) as { id: string; wedding_date: string }[];
  if (rows.length === 0) return result;

  const { data: memberRows } = await admin
    .from("couple_members")
    .select("couple_id, user_id")
    .in("couple_id", rows.map((row) => row.id))
    .in("member_role", ["owner", "partner"]);

  const members = new Map<string, string[]>();
  for (const row of (memberRows ?? []) as { couple_id: string; user_id: string }[]) {
    members.set(row.couple_id, [...(members.get(row.couple_id) ?? []), row.user_id]);
  }

  // 이메일 주소는 **어댑터에만 넘기고 저장하지 않는다**(§7.3). auth 에서 그때그때 읽는다.
  const emails = new Map<string, string>();
  const { data: authUsers } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const user of authUsers?.users ?? []) {
    if (user.email) emails.set(user.id, user.email);
  }

  for (const couple of rows) {
    result.scanned += 1;

    const days = dDay(today, couple.wedding_date);
    if (!(DDAY_MILESTONES as readonly number[]).includes(days)) continue;

    for (const userId of members.get(couple.id) ?? []) {
      /**
       * 앱 알림함과 이메일 **둘 다** 보낸다.
       *  · 앱 알림함은 끌 수 없으므로 기록이 반드시 남는다(증적).
       *  · 이메일은 앱을 열지 않는 사람에게 닿는 유일한 길이라 D-day 는 그 대상이다.
       * 수신 설정으로 이메일을 끈 사람에게는 `sendNotification` 이 알아서 걸러 낸다 —
       * 여기서 미리 판단하면 판정이 두 곳으로 갈린다.
       */
      for (const channel of ["in_app", "email"] as const) {
        const outcome = await sendNotification({
          userId,
          topic: "dday",
          channel,
          templateKey: "dday.remind",
          // **참조와 숫자만.** 예식일 자체를 넣지 않는다 — 날짜는 개인을 특정하는 값이다(§7.3).
          params: { days, coupleId: couple.id },
          dedupeKey: dedupeKey({
            templateKey: "dday.remind",
            subjectId: `${couple.id}:${userId}:${channel}`,
            period: `d-${days}`,
          }),
          email: emails.get(userId) ?? null,
        });

        if (outcome.status === "sent") result.sent += 1;
        else if (outcome.status === "duplicate") result.duplicate += 1;
        else if (outcome.status === "skipped") result.skipped += 1;
        else result.failed += 1;
      }
    }
  }

  return result;
}

/**
 * `sla-escalation`(Cron, 1시간)은 **만들지 않았다.**
 *
 * 대상이 "문의·채팅 미응답·심사 지연" 인데 문의(S4-12)와 채팅(S4-04)이 아직 없다.
 * 훑을 테이블이 없는 배치를 지금 쓰면 조건을 상상해서 짜게 되고, 실제 스키마가
 * 생기는 순간 다시 쓰게 된다. 커버리지 표에 그 사실과 담당을 적어 뒀다.
 */
export const SLA_ESCALATION_BLOCKED_BY = ["S4-04", "S4-12"] as const;
