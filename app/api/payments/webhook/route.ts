import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { handleWebhook } from "@/lib/payments/webhook";

/**
 * POST /api/payments/webhook — 결제사 웹훅 수신 (§3.4 · §4.2 · §7.3 · D-28)
 *
 * ── 세션이 없다 ─────────────────────────────────────────────────────────────
 * 부르는 쪽이 사용자가 아니라 **결제사**다. 그래서 인증은 세션이 아니라 **서명**이며,
 * 서명 검증이 곧 인가다. 비밀이 없으면 **거부한다**(닫힌 쪽으로 실패) — 통과시키면
 * 누구나 "결제됐다" 를 보낼 수 있고 그것이 `paid` 로 적힌다.
 *
 * ── 원문을 읽되 저장하지 않는다 ─────────────────────────────────────────────
 * 서명 검증에 원문 바이트가 필요하므로 `request.text()` 로 받는다. 저장하는 것은
 * 정규화 스냅샷과 sha256 해시뿐이다(§7.3).
 *
 * ── 재시도에 200 을 준다 ────────────────────────────────────────────────────
 * 중복 수신은 **정상 동작**이다. 4xx 를 주면 결제사가 계속 재시도하고, 그 재시도는
 * 우리가 이미 처리한 사건이다. 그래서 duplicate 도 200 이다.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const result = await handleWebhook({
    provider: "toss",
    rawBody,
    // 헤더 이름은 결제사 규격을 따른다. 실연동 시 어댑터와 함께 확정된다(D-28).
    signature: request.headers.get("toss-signature") ?? request.headers.get("x-signature"),
    // 웹훅은 사람이 부른 것이 아니다. 증적의 actor 는 시스템이다.
    actorId: "00000000-0000-0000-0000-000000000000",
  });

  if (result.status === "rejected") {
    // 사유를 응답 본문에 자세히 적지 않는다 — 서명이 왜 틀렸는지 알려주면
    // 맞출 때까지 시도할 수 있다.
    return fail(401, "PAY_WEBHOOK_REJECTED", "웹훅을 처리할 수 없습니다.");
  }

  return ok(result);
}
