import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { loadWallet } from "@/lib/coupons/read";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * GET /api/coupons — 쿠폰함 (F-C-35 · §4.2 · S5-12)
 *
 * **못 쓰는 쿠폰도 사유와 함께 돌려준다**(F-C-36 · 함정 3). 화면에서만 이유를 적으면
 * 이 API 를 쓰는 다음 사람은 목록이 '쓸 수 있는 것' 만 담고 있다고 읽는다.
 *
 * `amount` 를 주면 그 금액을 놓고 판정하고, 없으면 **판정하지 않는다** —
 * `usable: null` 이며 0원으로 재서 전부 "못 쓴다" 로 만들지 않는다(함정 2).
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const raw = request.nextUrl.searchParams.get("amount");
  const parsed = raw === null ? null : Number(raw);
  const orderAmount =
    parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;

  try {
    const wallet = await loadWallet({ orderAmount, now: new Date() });

    return ok({
      ...wallet,
      // **판정하지 않았다는 사실을 본문이 말한다** — 숫자만 내보내면 0 으로 읽힌다.
      judged: orderAmount !== null,
    });
  } catch {
    return fail(500, "COUPON_LOAD_FAILED", "쿠폰함을 불러오지 못했습니다.");
  }
}
