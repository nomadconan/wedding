import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { getSessionUser } from "@/lib/supabase/auth";
import { duplicateProduct, isDuplicateFailure } from "@/lib/vendor/duplicate";

/**
 * POST /api/vendor/products/[id]/duplicate — 상품 복제 (C-3 · F-V-03 · §4.3 반영 제안)
 *
 * ── 왜 별도 라우트인가 ─────────────────────────────────────────────────────
 * `POST /api/vendor/products` 는 본문이 `ProductInputSchema` 하나다 — 판별 유니온이
 * 아니라 `action` 을 끼울 자리가 없고, 끼우면 **모든 등록 요청이 유니온 파싱을
 * 지나게 된다.** 반대로 `PATCH /[id]` 에 넣으면 "수정" 이 "생성" 을 하게 된다.
 * 만드는 것은 **새 행**이므로 POST 이고, 대상이 원본이므로 `[id]` 아래다.
 *
 * ── 본문을 받지 않는다 ─────────────────────────────────────────────────────
 * 복제는 **원본이 전부를 정한다.** 이름·금액을 본문으로 받으면 그건 복제가 아니라
 * 생성이고, 그 길은 이미 있다. 받을 것이 없으므로 **파싱도 하지 않는다** —
 * 검증할 입력이 없는데 스키마를 두면 다음 사람이 거기에 필드를 더하게 된다.
 *
 * 인가는 **RLS 가 한다**(§3.9 — `products` 는 owner 전용). 여기서는 세션이 있는지만
 * 보고, 스태프의 요청은 `lib/vendor/duplicate.ts` 가 42501 을 받아 403 으로 바꾼다.
 */
export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { id } = await context.params;

  const result = await duplicateProduct({
    sourceId: id,
    actorId: user.id,
    actorRole: user.role,
  });

  if (isDuplicateFailure(result)) return fail(result.status, result.code, result.message);

  return ok(result, { status: 201 });
}
