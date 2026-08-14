import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { RateCloseSchema, RateCreateSchema } from "@/lib/core/schemas/rate-admin";
import { closeRate, createRate, isRateFailure, listRates } from "@/lib/rates/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * CRUD /api/admin/commission-rates — 수수료 요율 관리 (F-A-15 · §4.3)
 *
 *  - `GET`    범위·기간별 목록(이력 포함). 플래너 요율도 같은 응답에 `type` 으로 담긴다.
 *  - `POST`   새 요율. **겹침을 저장 전에 잡아** 어느 행과 부딪혔는지 알려준다.
 *  - `PATCH`  종료(`effective_to` 를 닫는다).
 *
 * ── DELETE 가 없다 ──────────────────────────────────────────────────────────
 * 요율 행을 지우면 "그때 어떤 요율표가 있었나" 를 재현할 수 없다(D-23). 과거 계약의
 * 요율은 스냅샷으로 박혀 있지만(D-16), 그 스냅샷이 **어디서 나왔는지**를 답하는 것이
 * 이 표다. DB 도 DELETE 권한을 회수해 뒀다(0034) — 라우트가 없는 것과 권한이 없는
 * 것이 함께 있어야 경계가 선다.
 *
 * ── 값을 판정하지 않는다 (O-02) ─────────────────────────────────────────────
 * 0~10000bp 를 벗어나는 것은 막지만(입력 사고) **업무 상한은 두지 않는다.** 이 화면이
 * 존재하는 이유가 값을 나중에 넣기 위해서인데, 코드가 범위를 정하면 그 순간
 * 미결정이 조용히 확정된다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  if (!isOperator(user.role)) return fail(403, "ADMIN_FORBIDDEN", "운영자만 볼 수 있어요.");

  // 세션 클라이언트로 읽는다 — 0034 가 운영자 열람 정책을 만들었고 경계는 RLS 다(§5.5).
  return ok({ rates: await listRates(await createClient()) });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  if (!isOperator(user.role)) return fail(403, "ADMIN_FORBIDDEN", "운영자만 등록할 수 있어요.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "RATE_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = RateCreateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await createRate({
    draft: {
      type: parsed.data.type,
      scopeType: parsed.data.scopeType,
      scopeKey: parsed.data.scopeKey,
      serviceLevel: parsed.data.serviceLevel ?? null,
      feeRateBp: parsed.data.feeRateBp,
      effectiveFrom: parsed.data.effectiveFrom,
      effectiveTo: parsed.data.effectiveTo,
      memo: parsed.data.memo ?? null,
    },
    actorId: user.id,
  });

  return isRateFailure(result)
    ? fail(result.status, result.code, result.message)
    : ok(result, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  if (!isOperator(user.role)) return fail(403, "ADMIN_FORBIDDEN", "운영자만 종료할 수 있어요.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "RATE_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = RateCloseSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await closeRate({
    type: parsed.data.type,
    rateId: parsed.data.rateId,
    endAt: parsed.data.endAt,
    actorId: user.id,
  });

  return isRateFailure(result) ? fail(result.status, result.code, result.message) : ok(result);
}

function isOperator(role: string | null | undefined): boolean {
  return role === "admin" || role === "ops";
}
