/**
 * 서명 전 본인확인 (S5-05 · D-28)
 *
 * **어댑터 + 스텁.** 문자 인증은 발송 대행 계약이 필요하고 그것은 아직 없다
 * (알림의 `sms` 채널이 같은 이유로 대기 중이다). 서명 흐름 전체를 미룰 수는 없으므로
 * S4-08·S4-13 이 쓴 형태를 그대로 가져온다.
 *
 * ── 스텁 여부가 증적에 남는다 ──────────────────────────────────────────────
 * `contract_signatures.verification_method` 에 `sms_stub` 이 그대로 적힌다.
 * 나중에 "이 서명에 본인확인이 있었는가" 를 물었을 때 **답할 수 있어야** 하고,
 * "있었다고 적혀 있는데 사실은 없었다" 가 되면 그 기록이 분쟁에서 거짓말이 된다.
 *
 * ── 프로덕션에서 스텁을 거부한다 ────────────────────────────────────────────
 * 본인확인 없는 서명으로 계약이 성립하면 되돌릴 방법이 없다. 결제 스텁과 같은
 * 무게로 다룬다.
 */
export type VerificationMethod = "sms" | "sms_stub";

export type VerificationResult =
  | { ok: true; method: VerificationMethod; ref: string }
  | { ok: false; reason: string };

export function resolveVerificationMethod(): VerificationMethod {
  if (process.env.NODE_ENV === "production") {
    // 실연동 어댑터가 붙기 전까지 프로덕션에서는 서명을 받지 않는다.
    throw new Error(
      "본인확인 실연동이 없습니다. 프로덕션에서 sms_stub 으로 서명을 받을 수 없습니다(D-28).",
    );
  }

  return "sms_stub";
}

/**
 * 본인확인을 수행한다.
 *
 * 스텁은 **확인이 있었다는 사실과 참조만** 만든다. 인증번호를 실제로 보내거나
 * 맞추는 절차를 흉내 내지 않는 이유 — 그 절차는 발송사 API 의 모양에 달려 있어
 * 지금 흉내 내면 실연동에서 버릴 코드가 된다. 우리 쪽 상태 기계에 들어오는 신호는
 * "확인됐다 / 안 됐다" 둘뿐이다.
 */
export async function verifyIdentity(input: {
  userId: string;
  contractId: string;
}): Promise<VerificationResult> {
  const method = resolveVerificationMethod();

  if (process.env.VERIFICATION_STUB_FAIL === "1") {
    return { ok: false, reason: "본인확인에 실패했습니다(개발용 스위치)." };
  }

  // 참조는 어느 서명 시도였는지만 가리킨다. 전화번호·인증번호를 담지 않는다(§7.3).
  return {
    ok: true,
    method,
    ref: `stub_verify_${input.contractId.slice(0, 8)}_${input.userId.slice(0, 8)}`,
  };
}
