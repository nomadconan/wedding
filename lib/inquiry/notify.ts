import { dedupeKey } from "@/lib/core/schemas/notification";
import { sendNotification } from "@/lib/notify/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { vendorDelivery } from "@/lib/vendor/settings";

/**
 * 문의·견적 알림 (S4-12 → S4-13 발송 경로)
 *
 * **본문·업체명·금액을 담지 않는다.** 참조 id 만 담고 문장은 고정 틀이다(§7.3).
 * 금액을 넣지 않는 이유가 하나 더 있다 — 견적은 회수되거나 만료되는데, 알림에 박힌
 * 금액은 그 뒤에도 남아 "그때 이 금액이라고 했다" 는 또 하나의 진실이 된다.
 *
 * **알림 실패가 본 작업을 되돌리지 않는다.** 문의를 보냈는데 알림이 안 갔다면
 * 알림만 실패한 것이지 문의가 실패한 것이 아니다(S4-13 이 세운 원칙).
 */

/** 업체 멤버 전원에게. 담당자 라우팅은 S4-14 소관이다(채팅과 같은 판단). */
export async function notifyInquiryReceived(input: {
  inquiryId: string;
  targets: { targetId: string; vendorId: string }[];
}): Promise<void> {
  try {
    const admin = createAdminClient();

    for (const target of input.targets) {
      // 업체 조직 설정을 따른다(S4-14). 담당자 배정·전원 여부가 여기서 갈린다.
      const delivery = await vendorDelivery({ vendorId: target.vendorId, now: new Date() });

      for (const userId of delivery.recipients) {
        await sendNotification({
          userId,
          topic: "inquiry",
          channel: "in_app",
          templateKey: "inquiry.received",
          params: { inquiryId: input.inquiryId, targetId: target.targetId },
          // 대상 하나당 하나. 재시도해도 중복되지 않는다.
          dedupeKey: dedupeKey({
            templateKey: "inquiry.received",
            subjectId: `${target.targetId}:${userId}`,
          }),
        });
      }
    }
  } catch {
    console.error("[inquiry] received notification failed");
  }
}

/** 견적 도착 · 거절 — 커플 당사자 둘 다에게. 방을 공유하듯 문의도 공유한다(D-19). */
export async function notifyCouple(input: {
  inquiryId: string;
  templateKey: "inquiry.quote_arrived" | "inquiry.declined";
  subjectId: string;
}): Promise<void> {
  try {
    const admin = createAdminClient();

    const { data: inquiry } = await admin
      .from("inquiries")
      .select("couple_id")
      .eq("id", input.inquiryId)
      .maybeSingle();

    const coupleId = (inquiry as { couple_id?: string } | null)?.couple_id;
    if (!coupleId) return;

    const { data: members } = await admin
      .from("couple_members")
      .select("user_id")
      .eq("couple_id", coupleId)
      .in("member_role", ["owner", "partner"]);

    for (const row of (members ?? []) as { user_id: string }[]) {
      await sendNotification({
        userId: row.user_id,
        topic: "inquiry",
        channel: "in_app",
        templateKey: input.templateKey,
        params: { inquiryId: input.inquiryId },
        dedupeKey: dedupeKey({
          templateKey: input.templateKey,
          subjectId: `${input.subjectId}:${row.user_id}`,
        }),
      });
    }
  } catch {
    console.error("[inquiry] couple notification failed");
  }
}
