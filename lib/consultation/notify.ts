import { dedupeKey, type TemplateKey } from "@/lib/core/schemas/notification";
import { sendNotification } from "@/lib/notify/send";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 상담·탐방 알림 (S4-07 → S4-13 발송 경로)
 *
 * ── 왜 이 태스크에 알림이 반드시 붙는가 ────────────────────────────────────
 * D-23 이 분쟁의 쟁점으로 든 것이 **"안내를 받았는가"** 이고, §3.11 은 이행 확인
 * 요청 발송이 `notifications` 에 기록되어야 한다고 **명시**한다(1번). 보증금 몰취는
 * "확인해 달라고 했는데 답하지 않았다" 를 근거로 삼는데, 요청한 기록이 없으면 그
 * 근거가 통째로 사라진다. 알림은 이 기능의 부속이 아니라 **판정의 전제**다.
 *
 * ── 무엇을 담지 않는가 ──────────────────────────────────────────────────────
 * **날짜·시각·장소·금액을 담지 않는다.** 참조(consultationId)만 담고 문장은 고정
 * 틀이다(§7.3). 상담 일정은 "언제 어디서 만나는가" 라 개인을 특정하는 값이고,
 * `dday.remind` 가 예식일 대신 남은 일수만 담은 것과 같은 판단이다.
 */
export type Audience = "couple" | "vendor" | "both";

export async function notifyConsultation(input: {
  consultationId: string;
  templateKey: TemplateKey;
  audience: Audience;
}): Promise<void> {
  try {
    const admin = createAdminClient();

    const { data } = await admin
      .from("consultations")
      .select("couple_id, vendor_id")
      .eq("id", input.consultationId)
      .maybeSingle();

    if (!data) return;

    const row = data as { couple_id: string; vendor_id: string };
    const recipients: string[] = [];

    if (input.audience === "couple" || input.audience === "both") {
      const { data: members } = await admin
        .from("couple_members")
        .select("user_id")
        .eq("couple_id", row.couple_id)
        .in("member_role", ["owner", "partner"]);

      recipients.push(...((members ?? []) as { user_id: string }[]).map((item) => item.user_id));
    }

    if (input.audience === "vendor" || input.audience === "both") {
      // 담당자 라우팅은 S4-14 소관이다(채팅·문의와 같은 판단). 여기서는 멤버 전원.
      const { data: members } = await admin
        .from("vendor_members")
        .select("user_id")
        .eq("vendor_id", row.vendor_id);

      recipients.push(...((members ?? []) as { user_id: string }[]).map((item) => item.user_id));
    }

    for (const userId of [...new Set(recipients)]) {
      await sendNotification({
        userId,
        topic: "schedule",
        // in_app 만 보낸다. 외부 채널은 발송 대행 계약 전이다(D-28).
        channel: "in_app",
        templateKey: input.templateKey,
        params: { consultationId: input.consultationId },
        // **상태 전이 하나당 하나.** 배치가 한 시간마다 돌아도 같은 안내가 반복되지
        // 않는다 — 특히 이행 확인 요청은 반복되면 소음이 되고, 소음이 되면 사용자가
        // 채널을 끄고, 그러면 §3.11 의 전제가 무너진다.
        dedupeKey: dedupeKey({
          templateKey: input.templateKey,
          subjectId: `${input.consultationId}:${userId}`,
        }),
      });
    }
  } catch {
    // 알림 실패가 예약·판정을 되돌리지 않는다. 식별자도 남기지 않는다(§5.3).
    console.error("[consultation] notification failed");
  }
}
