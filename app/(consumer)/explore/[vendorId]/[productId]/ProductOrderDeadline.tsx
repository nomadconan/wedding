import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { findMyCouple } from "@/lib/couple/membership";
import {
  LEAD_TIME_NO_WEDDING_DATE_NOTE,
  LEAD_TIME_SOURCE_NOTE,
  orderDeadline,
  orderDeadlineCaption,
  type LeadTime,
} from "@/lib/core/product/lead-time";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * 상품 상세의 주문 기한 (C-4b · F-V-03 확장 · F-C-38)
 *
 * ── 왜 페이지에서 떼어 냈나 ─────────────────────────────────────────────────
 * **예식일은 보는 커플마다 다르다.** 페이지 본체에 두면 상품 상세가 통째로 동적이
 * 되어 비로그인에게도 캐시가 안 된다 — `ProductCartActions` 와 같은 이유·같은 모양이다.
 *
 * ── 네 가지를 다르게 말한다 ─────────────────────────────────────────────────
 * **"업체가 아직 안 정했다" 와 "따로 기한이 없다" 는 다르고, 둘 다 0 이 아니다.**
 * 판정은 `orderDeadline` 이 하고 문구도 거기서 받는다 — 화면이 문장을 손으로 적으면
 * 같은 사실을 두 곳에 쓰게 되고 한쪽만 고쳐진다.
 *
 * ── 업체가 적은 정보라고 밝힌다 ─────────────────────────────────────────────
 * 리드타임은 **업체의 사실 진술**이지 우리가 보증하는 일정이 아니다(D-24 · §7.7).
 * 근거 문구를 **숫자와 함께** 보이는 것도 같은 이유다 — 왜 그만큼 걸리는지 읽을 수
 * 없으면 고객은 그 숫자를 확인할 방법이 없다(D-224).
 */
export async function ProductOrderDeadline({ leadTime }: { leadTime: LeadTime | null }) {
  const user = await getSessionUser();

  let weddingDate: string | null = null;

  if (user) {
    const couple = await findMyCouple(user.id);

    if (couple) {
      const supabase = await createClient();
      const { data } = await supabase
        .from("couples")
        .select("wedding_date")
        .eq("id", couple.coupleId)
        .maybeSingle();

      weddingDate = (data as { wedding_date: string | null } | null)?.wedding_date ?? null;
    }
  }

  const deadline = orderDeadline({ weddingDate, leadTime });

  return (
    <Card data-testid="order-deadline" data-kind={deadline.kind}>
      <CardHeader>
        <CardTitle className="text-base">주문 기한</CardTitle>
        <CardDescription>{orderDeadlineCaption(deadline)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {/* 근거는 업체가 적은 문장이다. **숫자만 보이지 않는다.** */}
        {deadline.kind === "deadline" ||
        deadline.kind === "no_deadline" ||
        deadline.kind === "no_wedding_date" ? (
          <>
            <p className="text-sm text-foreground" data-testid="lead-time-note">
              {deadline.note}
            </p>
            <p className="text-caption text-muted-foreground">{LEAD_TIME_SOURCE_NOTE}</p>
          </>
        ) : null}

        {/* 예식일이 없으면 **날짜를 지어내지 않고** 어떻게 하면 알 수 있는지 적는다. */}
        {deadline.kind === "no_wedding_date" ? (
          <p className="text-caption text-muted-foreground" data-testid="need-wedding-date">
            {LEAD_TIME_NO_WEDDING_DATE_NOTE}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
