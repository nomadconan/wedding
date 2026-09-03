import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { RateVoidSchema } from "@/lib/core/schemas/rate-admin";
import { isRateFailure, voidRateRow } from "@/lib/rates/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * POST /api/admin/commission-rates/void — 요율 무효화 (F-A-15 · FIX-12)
 *
 * ── 왜 별도 라우트인가 ──────────────────────────────────────────────────────
 * 같은 표를 고치지만 **다른 일**이다. `PATCH` 는 종료(“여기까지 적용했다”)이고 이것은
 * 무효화(“이 줄은 없던 것으로 친다”)다. 한 엔드포인트에 `action` 을 섞으면 어느 쪽인지가
 * 본문 모양에 숨고, 감사 로그와 권한 심사에서도 둘이 한 덩어리로 보인다.
 * 이웃한 `resolve/` 가 같은 이유로 하위 라우트다.
 *
 * ── DELETE 는 여전히 없다 ───────────────────────────────────────────────────
 * 무효화는 **삭제의 대체가 아니라 삭제를 하지 않기 위한 수단**이다. 행은 남고
 * (D-23 — 스냅샷의 출처를 답해야 한다) 해석에서만 빠진다. DB 도 DELETE 권한을
 * 회수한 그대로다(0034).
 *
 * ── 되돌리는 라우트를 두지 않았다 ───────────────────────────────────────────
 * 무효화된 행은 DB 트리거가 UPDATE 자체를 막는다(`rate_voided_is_final`). 잘못
 * 무효화했으면 **올바른 요율을 새로 등록**한다 — 무효 행은 겹침을 막지 않으므로 같은
 * 구간에 넣을 수 있다. 되돌리기를 열면 한 행이 무효와 유효를 오가고, 그 사이에 확정된
 * 계약의 근거를 나중에 재현할 수 없다.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  // 이웃 라우트는 같은 판정을 파일 안에 다시 적어 뒀지만(`isOperator(role)`) 여기서는
  // **공유 함수를 쓴다** — 판정이 두 벌이면 언젠가 한쪽만 고쳐진다.
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "운영자만 무효화할 수 있어요.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "RATE_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = RateVoidSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await voidRateRow({
    type: parsed.data.type,
    rateId: parsed.data.rateId,
    reason: parsed.data.reason,
    actorId: user.id,
  });

  if (isRateFailure(result)) return fail(result.status, result.code, result.message);

  return ok(result);
}
