import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { SettlementRunSchema } from "@/lib/core/schemas/settlement";
import {
  confirmSettlement,
  isSettlementFailure,
  paySettlement,
  runSettlement,
} from "@/lib/settlements/actions";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * POST /api/admin/settlements/run — 정산 배치 실행·확정·지급 (F-A-11 · §4.3)
 *
 * ── 하나의 라우트에 세 동작을 둔 이유 ───────────────────────────────────────
 * 셋 다 **같은 정산서를 앞으로 미는 일**이고 순서가 정해져 있다(집계 → 확정 → 지급).
 * 라우트를 셋으로 나누면 운영이 순서를 외워야 하고, 잘못된 순서로 부른 요청이
 * 404·422 로 흩어져 원인을 읽기 어려워진다. `action` 하나로 받고 **가능한 전이인지는
 * 서버가 판정**한다(DB 트리거가 최종 경계다).
 *
 * ── 금액을 입력으로 받지 않는다 ─────────────────────────────────────────────
 * 요청이 말하는 것은 "어느 업체의 어느 기간을" 또는 "어느 정산서를" 까지다. 금액은
 * 거래 이력에서 나오며 서버가 산정한다 — 받으면 **운영자가 지급액을 손으로 적을 수
 * 있고**, 그 순간 정산은 계산이 아니라 재량이 된다.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  if (user.role !== "admin" && user.role !== "ops") {
    return fail(403, "ADMIN_FORBIDDEN", "운영자만 정산을 집행할 수 있어요.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "SETTLEMENT_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = SettlementRunSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const input = parsed.data;

  if (input.action === "run") {
    const result = await runSettlement({
      vendorId: input.vendorId,
      period:
        input.periodStart && input.periodEnd
          ? { start: input.periodStart, end: input.periodEnd }
          : undefined,
      actor: { id: user.id, role: user.role },
      source: "admin",
    });

    return isSettlementFailure(result)
      ? fail(result.status, result.code, result.message)
      : ok(result);
  }

  if (input.action === "confirm") {
    const result = await confirmSettlement({ settlementId: input.settlementId, actorId: user.id });

    return isSettlementFailure(result)
      ? fail(result.status, result.code, result.message)
      : ok(result);
  }

  const result = await paySettlement({
    settlementId: input.settlementId,
    actorId: user.id,
    attempt: input.attempt,
  });

  if (isSettlementFailure(result)) return fail(result.status, result.code, result.message);

  if (result.status === "failed") {
    // **200 이 아니다.** 지급이 안 된 것을 성공 응답으로 내리면 화면이 지급됐다고 그린다.
    return fail(502, "SETTLEMENT_PAYOUT_FAILED", result.reason, {
      retryable: result.retryable,
      payoutId: result.payoutId,
    });
  }

  return ok(result);
}
