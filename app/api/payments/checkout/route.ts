import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { ipHash } from "@/lib/contract/hash";
import {
  CHECKOUT_CONSENT_VERSION,
  CONSENT_REQUIRED_MESSAGE,
  consentComplete,
} from "@/lib/core/payment/checkout";
import { CheckoutRequestSchema } from "@/lib/core/schemas/payment";
import { chargeInstallment, isChargeFailure, recordConsents } from "@/lib/payments/charge";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/payments/checkout — 회차 결제 실행 (§4.2 · F-C-14 · D-28)
 *
 * ── 금액을 입력으로 받지 않는다 ─────────────────────────────────────────────
 * 요청은 **어느 회차를** 만 말한다. 금액은 계약이 정한 회차 금액이며 서버가 읽는다 —
 * 클라이언트가 보낸 숫자를 쓰면 고객이 스스로 금액을 적을 수 있다.
 *
 * **쿠폰도 같다**(S5-12) — 받는 것은 발급분 id 뿐이고 할인액과 부담 주체는 서버가
 * 결제 직전에 다시 정한다. 쓰지 못하는 쿠폰이면 **정가로 청구하지 않고 422 로 막는다** —
 * 고객은 할인을 보고 눌렀고, 그대로 긁으면 본 금액과 다른 돈이 빠져나간다.
 *
 * ── 순서 ────────────────────────────────────────────────────────────────────
 *  1. 세션 확인 → 2. 입력 검증 → 3. **RLS 로 대상 확인**(읽히면 당사자다) →
 *  4. **동의 기록** → 5. 결제 실행.
 *
 * 동의를 결제보다 **먼저** 기록하는 이유 — 0030 의 트리거가 동의 없는 승인을 막는다.
 * 반대로 결제 뒤에 기록하면 "고지 없이 결제된" 순간이 트랜잭션 안에 존재하게 되고,
 * 그 사이에 실패하면 동의 없는 결제가 장부에 남는다(F-C-14).
 *
 * ── 멱등 ────────────────────────────────────────────────────────────────────
 * `Idempotency-Key` 헤더를 받지 않고 **회차 id 로 서버가 만든다**
 * (`paymentIdempotencyKey`). 클라이언트가 정하면 매 요청마다 새 열쇠를 만들 수 있고,
 * 그러면 같은 회차가 두 번 결제된다. 명시적 재결제만 `attempt` 로 구분한다.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "PAY_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = CheckoutRequestSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  if (!consentComplete(parsed.data.consents)) {
    return fail(422, "PAY_CONSENT_REQUIRED", CONSENT_REQUIRED_MESSAGE);
  }

  // 이 회차가 내게 보이는가 — RLS 에게 묻는다. 커플은 **owner 만** 보인다(§3.9).
  const supabase = await createClient();
  const { data: scheduleRow } = await supabase
    .from("payment_schedules")
    .select("id")
    .eq("id", parsed.data.scheduleId)
    .maybeSingle();

  if (!scheduleRow) {
    return fail(404, "PAY_SCHEDULE_NOT_FOUND", "결제 회차를 찾을 수 없습니다.");
  }

  await recordConsents({
    scheduleId: parsed.data.scheduleId,
    userId: user.id,
    kinds: parsed.data.consents,
    version: CHECKOUT_CONSENT_VERSION,
    // 원본 IP 를 저장하지 않는다(§7.3). 소금 있는 해시만 남긴다.
    ipHash: ipHash(request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null),
  });

  const result = await chargeInstallment({
    scheduleId: parsed.data.scheduleId,
    actorId: user.id,
    attempt: parsed.data.attempt,
    // **id 만 넘긴다.** 할인액·부담 주체는 서버가 결제 직전에 다시 정한다(S5-12).
    couponIssueId: parsed.data.couponIssueId ?? null,
  });

  if (isChargeFailure(result)) return fail(result.status, result.code, result.message);

  if (result.status === "failed") {
    // **200 이 아니다.** 결제가 안 된 것을 성공 응답으로 내리면 화면이 성공으로 그린다.
    return fail(402, "PAY_FAILED", result.reason, {
      retryable: result.retryable,
      nextAction: result.nextAction,
      paymentId: result.paymentId,
    });
  }

  return ok(result);
}
