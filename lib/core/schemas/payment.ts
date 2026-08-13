import { z } from "zod";

import { CONSENT_KINDS } from "../payment/checkout";

/**
 * 결제 API 입출력 스키마 (S5-06 · §4.2 · CLAUDE.md §6)
 *
 * 검증 실패는 **422** 다. 금액을 입력으로 받지 않는 것이 이 스키마의 핵심이다 —
 * 낼 금액은 계약이 정한 회차 금액이고, 클라이언트가 보낸 숫자를 쓰면 **고객이
 * 스스로 금액을 적을 수 있다.** 그래서 요청은 "어느 회차를" 만 말한다.
 */
export const CheckoutRequestSchema = z.object({
  scheduleId: z.string().uuid("회차 식별자가 올바르지 않습니다."),
  /** 결제 전 고지에 대한 동의. 모든 종류가 있어야 결제가 진행된다(F-C-14). */
  consents: z.array(z.enum(CONSENT_KINDS)).min(1, "동의 항목이 필요합니다."),
  /**
   * 명시적 재결제 회차. **자동 재시도에서는 올리지 않는다** — 올리면 열쇠가 바뀌어
   * 멱등이 사라지고 재시도가 새 결제가 된다(`paymentIdempotencyKey`).
   */
  attempt: z.number().int().min(1).max(9).optional(),
});

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

export const IssueContractRequestSchema = z.object({
  bookingId: z.string().uuid("예약 식별자가 올바르지 않습니다."),
  quoteId: z.string().uuid().nullable().optional(),
  plannerId: z.string().uuid().nullable().optional(),
});

export type IssueContractRequest = z.infer<typeof IssueContractRequestSchema>;

/**
 * 서명 요청은 **역할을 받지 않는다.**
 *
 * 어느 편인지는 서버가 세션으로 판정한다(S4-07 의 이행 확인 API 와 같은 규칙).
 * 입력으로 받으면 고객이 업체 칸에 서명하는 요청을 만들 수 있고, 트리거가 막더라도
 * 그런 모양의 API 를 두지 않는다.
 */
export const SignContractRequestSchema = z.object({
  /** 화면이 보고 있던 정본 해시. 다른 내용에 서명하는 것을 한 층 더 막는다(D-23). */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, "정본 해시 형식이 올바르지 않습니다."),
});

export type SignContractRequest = z.infer<typeof SignContractRequestSchema>;
