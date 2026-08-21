import { fail, ok } from "@/lib/api/response";
import {
  MEMBERSHIP_BENEFITS,
  MEMBERSHIP_INTRO,
  APP_STORE_NOTICE,
  CANCEL_NOTICE,
  PRICE_UNCONFIGURED_NOTICE,
  daysLeft,
} from "@/lib/core/membership/membership";
import {
  cancelMembership,
  loadMembership,
  loadMembershipPrice,
  startMembership,
} from "@/lib/membership/actions";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST/DELETE /api/membership — 멤버십 구독 (F-C-19 · 명세서 §4.2)
 *
 * ── 등급을 여기서 정하지 않는다 ─────────────────────────────────────────────
 * 저장된 것은 **무엇을 샀는가**뿐이고 지금 유효한 등급은 `membershipState` 가
 * 계산한다. 그래서 이 경로와 AI 게이트가 **같은 함수**를 본다 — 두 곳이 각자
 * 판정하면 화면은 유료라는데 턴은 무료 상한에 걸리는 일이 생긴다.
 *
 * ── 응답 본문까지 정직해야 한다 ─────────────────────────────────────────────
 * 가격이 미설정이면 **`price.ok = false` 와 이유를 함께 보낸다.** 금액 자리를 0 으로
 * 채워 보내면 화면이 "0원" 을 그릴 수 있고, 그것은 "공짜로 준다" 는 뜻이 된다.
 */

/** 세션 쿠키를 읽는 경로다. 정적으로 굳으면 남의 등급이 캐시된다(FIX-22 계열). */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();
  const now = new Date();
  const { state } = await loadMembership(supabase, { now });
  const price = await loadMembershipPrice();

  return ok({
    state,
    daysLeft: daysLeft(state.expiresAt, now.toISOString()),
    price,
    benefits: MEMBERSHIP_BENEFITS,
    intro: MEMBERSHIP_INTRO,
    appStoreNotice: APP_STORE_NOTICE,
    cancelNotice: CANCEL_NOTICE,
    priceUnconfiguredNotice: price.ok ? null : PRICE_UNCONFIGURED_NOTICE,
  });
}

export async function POST() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();
  const result = await startMembership(supabase, { userId: user.id });

  if ("status" in result) return fail(result.status, result.code, result.message);

  return ok(result, { status: 201 });
}

export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();
  const result = await cancelMembership(supabase, { userId: user.id });

  if ("status" in result) return fail(result.status, result.code, result.message);

  return ok({ ...result, notice: CANCEL_NOTICE });
}
