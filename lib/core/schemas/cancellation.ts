import { z } from "zod";

import { CANCEL_REASON_CODES, FAULT_PARTIES } from "../cancellation/cancellation";

/**
 * 해지 API 입출력 스키마 (S5-08 · §4.2 · CLAUDE.md §6)
 *
 * **금액을 입력으로 받지 않는다.** 위약금·환불액은 계약과 결제 이력에서 나오며
 * 서버가 산정한다 — 클라이언트가 보낸 숫자를 쓰면 **당사자가 자기 위약금을 스스로
 * 적을 수 있다.** 요청이 말하는 것은 "왜, 그리고 누구 사정이라고 보는가" 뿐이다.
 *
 * **귀책은 주장으로만 받는다.** `claim` 이라는 이름이 그 사실을 드러낸다 — 이 값이
 * 곧 `fault` 가 되지 않으며, 양측 일치나 운영자 결정을 거쳐야 확정된다.
 */
export const ClaimSchema = z.enum(FAULT_PARTIES);

export const CancelRequestSchema = z.object({
  reasonCode: z.enum(CANCEL_REASON_CODES),
  /** 짧은 보충 설명. 개인식별정보를 적을 자리가 아니다(§7.3). */
  reasonNote: z.string().max(500, "설명은 500자 이내로 적어 주세요.").nullable().optional(),
  claim: ClaimSchema,
});

export type CancelRequest = z.infer<typeof CancelRequestSchema>;

/**
 * 확인 요청.
 *
 * **어느 편인지는 받지 않는다.** 서버가 세션으로 판정한다(S4-07 이행 확인과 같은 규칙) —
 * 받으면 고객이 업체 칸에 답하는 요청을 만들 수 있다.
 */
export const CancelConfirmSchema = z.object({
  agreed: z.boolean(),
  claim: ClaimSchema,
});

export type CancelConfirm = z.infer<typeof CancelConfirmSchema>;

/** 운영자 조율 결과(F-A-17). **사유가 없으면 받지 않는다**(D-24). */
export const PenaltyResolveSchema = z.object({
  cancellationId: z.string().uuid("해지 절차 식별자가 올바르지 않습니다."),
  // **미정으로 종결할 수 없다.** 조율의 결과는 결론이어야 하고, 결론 없이 정산하면
  // 한쪽 주장이 그대로 이긴다.
  decision: z.enum(["couple", "vendor", "mutual"]),
  note: z.string().min(1, "조율 사유를 적어 주세요.").max(1000),
});

export type PenaltyResolve = z.infer<typeof PenaltyResolveSchema>;
