import { z } from "zod";

/**
 * 에스크로 API 스키마 (S5-09 · §4.2 · CLAUDE.md §6)
 *
 * **금액을 입력으로 받지 않는다.** 맡긴 금액은 결제 회차가 정하고 서버가 읽는다 —
 * 받으면 당사자가 **돌려받을 금액을 스스로 적을 수 있다.**
 *
 * **릴리즈를 직접 명령하지 못한다.** 당사자가 보내는 것은 "이행됐다/아니다" 라는
 * **사실 진술**이고, 그 결과로 릴리즈할지는 `decideRelease` 가 판정한다 —
 * 플랫폼은 보관자이지 한쪽의 대리인이 아니다(D-24).
 */
export const EscrowConfirmSchema = z.object({
  holdId: z.string().uuid("안전거래 식별자가 올바르지 않습니다."),
  confirmed: z.boolean(),
});

export type EscrowConfirm = z.infer<typeof EscrowConfirmSchema>;

/**
 * 운영자 조율 결과.
 *
 * **사유가 없으면 받지 않는다**(D-24 — 0025 보증금·0029 계약 취소·0031 해지가 건
 * 같은 규칙). 플랫폼이 재량으로 정한 값이 아님을 기록으로 남기기 위해서다.
 */
export const EscrowResolveSchema = z.object({
  action: z.literal("resolve"),
  holdId: z.string().uuid("안전거래 식별자가 올바르지 않습니다."),
  direction: z.enum(["release", "refund"]),
  note: z.string().min(1, "조율 사유를 적어 주세요.").max(500),
});

export type EscrowResolve = z.infer<typeof EscrowResolveSchema>;
