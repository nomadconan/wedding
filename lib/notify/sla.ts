import { dedupeKey } from "@/lib/core/schemas/notification";
import { createAdminClient } from "@/lib/supabase/admin";

import { sendNotification } from "./send";

/**
 * 미응답 에스컬레이션 배치 (S4-13 `sla-escalation`, Cron 1시간)
 *
 * S4-13 이 "대상이 없어 만들지 않았다" 며 남긴 잔여분이다. S4-04(채팅)와 S4-12(문의)가
 * 훑을 표를 만들었으므로 이제 쓸 수 있다.
 *
 * ── 로직만 만든다 ───────────────────────────────────────────────────────────
 * **실행 등록(Cron 스케줄·`job_runs` 기록·실패 경보)은 S8-13 소관이다**(커버리지 표
 * 배치 절). `dday.ts` 와 같은 모양으로, "지금 돌려라" 하면 도는 함수 하나다.
 * 라우트는 `/api/jobs/sla-escalation` 이며 서비스롤 키로만 부른다.
 *
 * ── 왜 여기(`lib/notify`)인가 ───────────────────────────────────────────────
 * 이 배치가 하는 일은 **훑어서 알리는 것**이고, 훑는 조건은 이미 두 도메인이 컬럼
 * 하나로 정리해 두었다(`inquiry_targets.sla_deadline` · `chat_rooms.awaiting_vendor_since`).
 * 판정 로직이 따로 없으므로 도메인마다 배치를 나눌 이유가 없고, `dday.ts` 와 나란히
 * 두면 "알림을 만드는 배치는 여기 있다" 가 유지된다.
 *
 * ── 왜 누적이 아니라 한 번인가 ──────────────────────────────────────────────
 * 한 시간마다 도는 배치가 매번 보내면 지연된 문의 하나가 하루에 24번 알린다. 그러면
 * 업체는 채널을 끄고, 정작 필요한 안내도 못 받는다. `dedupe_key` 에 **대상 id** 만
 * 넣어 "이 문의의 지연 알림" 이 영원히 하나가 되게 한다 — `dday.ts` 가 마일스톤으로
 * 같은 문제를 푼 방식이다.
 */
export type SlaRunResult = {
  /** 기한을 넘긴 채 아직 응답이 없는 대상 수. */
  overdueInquiries: number;
  /** 기한을 넘긴 채팅 방 수. */
  overdueChatRooms: number;
  sent: number;
  duplicate: number;
  skipped: number;
  failed: number;
};

/**
 * @param now 기준 시각(ISO). **호출자가 넘긴다** — 배치가 '지금' 을 스스로 정하면
 *            같은 입력으로 같은 결과가 나오지 않아 재현할 수 없다(S2-06 규칙).
 */
export async function runSlaEscalation(now: string): Promise<SlaRunResult> {
  const admin = createAdminClient();
  const result: SlaRunResult = {
    overdueInquiries: 0,
    overdueChatRooms: 0,
    sent: 0,
    duplicate: 0,
    skipped: 0,
    failed: 0,
  };

  const tally = (status: string) => {
    if (status === "sent") result.sent += 1;
    else if (status === "duplicate") result.duplicate += 1;
    else if (status === "skipped") result.skipped += 1;
    else result.failed += 1;
  };

  // ── 문의 미응답 (S4-12) ───────────────────────────────────────────────────
  // 부분 인덱스 idx_inquiry_targets_pending_sla 를 타는 조회다.
  // **거절은 잡히지 않는다** — status 가 pending 이 아니기 때문이고, 그것이 미응답과
  // 거절을 나눈 이유다. 거절한 업체를 지연으로 재촉하면 안 된다.
  const { data: targets } = await admin
    .from("inquiry_targets")
    .select("id, vendor_id, inquiry_id, sla_deadline")
    .eq("status", "pending")
    .not("sla_deadline", "is", null)
    .lt("sla_deadline", now);

  const overdueTargets = (targets ?? []) as {
    id: string;
    vendor_id: string;
    inquiry_id: string;
  }[];

  result.overdueInquiries = overdueTargets.length;

  for (const target of overdueTargets) {
    const { data: members } = await admin
      .from("vendor_members")
      .select("user_id")
      .eq("vendor_id", target.vendor_id);

    for (const member of (members ?? []) as { user_id: string }[]) {
      const outcome = await sendNotification({
        userId: member.user_id,
        topic: "inquiry",
        channel: "in_app",
        templateKey: "inquiry.received",
        // 참조만. 어느 문의가 늦었는지는 화면이 보여준다(§7.3).
        params: { inquiryId: target.inquiry_id, targetId: target.id, overdue: true },
        // 대상당 하나. 한 시간마다 다시 보내지 않는다.
        dedupeKey: dedupeKey({
          templateKey: "inquiry.sla_overdue",
          subjectId: `${target.id}:${member.user_id}`,
        }),
      });

      tally(outcome.status);
    }
  }

  // ── 채팅 미응답 (S4-04) ───────────────────────────────────────────────────
  // 눈금은 app_settings.chat.sla_response_minutes 가 갖는다. 값이 없으면 채팅 쪽은
  // 건너뛴다 — 기준 없이 "늦었다" 고 말할 수 없다.
  const { data: chatSetting } = await admin
    .from("app_settings")
    .select("value_json")
    .eq("key", "chat.sla_response_minutes")
    .maybeSingle();

  const chatMinutes = Number(
    (chatSetting?.value_json as { minutes?: unknown } | null)?.minutes ?? Number.NaN,
  );

  if (Number.isFinite(chatMinutes) && chatMinutes > 0) {
    const cutoff = new Date(new Date(now).getTime() - chatMinutes * 60_000).toISOString();

    const { data: rooms } = await admin
      .from("chat_rooms")
      .select("id, vendor_id, assigned_to, awaiting_vendor_since")
      .not("awaiting_vendor_since", "is", null)
      .lt("awaiting_vendor_since", cutoff)
      .eq("status", "active");

    const overdueRooms = (rooms ?? []) as {
      id: string;
      vendor_id: string;
      assigned_to: string | null;
      awaiting_vendor_since: string;
    }[];

    result.overdueChatRooms = overdueRooms.length;

    for (const room of overdueRooms) {
      // 담당자가 있으면 담당자에게만 — 배정(F-V-15)을 무의미하게 만들지 않는다.
      let recipients: string[] = room.assigned_to ? [room.assigned_to] : [];

      if (recipients.length === 0) {
        const { data: members } = await admin
          .from("vendor_members")
          .select("user_id")
          .eq("vendor_id", room.vendor_id);

        recipients = ((members ?? []) as { user_id: string }[]).map((row) => row.user_id);
      }

      for (const userId of recipients) {
        const outcome = await sendNotification({
          userId,
          topic: "chat",
          channel: "in_app",
          templateKey: "chat.new_message",
          params: { roomId: room.id, overdue: true },
          // **대기 시작 시각을 열쇠에 넣는다.** 방은 계속 쓰이므로 방 id 만으로는
          // 다음 대기 때 다시 알릴 수 없다. 같은 대기 구간에서는 한 번만 나간다.
          dedupeKey: dedupeKey({
            templateKey: "chat.sla_overdue",
            subjectId: `${room.id}:${userId}`,
            period: room.awaiting_vendor_since,
          }),
        });

        tally(outcome.status);
      }
    }
  }

  return result;
}

/**
 * 만료 처리.
 *
 * 배치가 함께 한다 — 만료는 "시간이 지나면 저절로" 벌어지는 일이라 누군가 화면을
 * 열어야 반영되면 안 된다. 고객이 문의함을 안 열어도 견적은 만료되어야 한다.
 *
 * **지우지 않고 상태만 바꾼다.** 받은 적 있는 제안이 흔적 없이 사라지면 "그런 값을
 * 제시한 적 없다" 가 되고, 그건 분쟁에서 재구성해야 할 사실이다(D-23).
 */
export async function runExpiry(
  now: string,
  today: string,
): Promise<{ quotes: number; targets: number }> {
  const admin = createAdminClient();

  const { data: expiredQuotes } = await admin
    .from("quotes")
    .update({ status: "expired" })
    .eq("status", "sent")
    .not("valid_until", "is", null)
    .lt("valid_until", now)
    .select("id");

  // ── 대상의 만료는 **SLA 기한이 아니라 예식일**이 정한다 ────────────────────
  // SLA 기한을 넘긴 것은 "늦었다" 이지 "끝났다" 가 아니다. 둘을 같은 시점으로 두면
  // 지연 알림이 나가자마자 상태가 expired 로 바뀌어, 업체가 뒤늦게라도 답할 길이
  // 닫히고 `runSlaEscalation` 이 다음 회차에 아무것도 못 찾는다.
  // 예식일이 지난 문의는 그때야 의미가 없어지므로 그 시점에 닫는다.
  const { data: pastInquiries } = await admin
    .from("inquiries")
    .select("id")
    .not("event_date", "is", null)
    .lt("event_date", today);

  const pastIds = ((pastInquiries ?? []) as { id: string }[]).map((row) => row.id);

  const { data: expiredTargets } = pastIds.length
    ? await admin
        .from("inquiry_targets")
        .update({ status: "expired" })
        .eq("status", "pending")
        .in("inquiry_id", pastIds)
        .select("id")
    : { data: [] };

  return {
    quotes: (expiredQuotes ?? []).length,
    targets: (expiredTargets ?? []).length,
  };
}
