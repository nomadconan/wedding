import { z } from "zod";

import { RATE_TYPES } from "../pricing/rate-admin";
import { RATE_SCOPES } from "./rates";

/**
 * 요율 관리 API 스키마 (S5-03 · §4.3 · CLAUDE.md §6)
 *
 * **요율 상한을 스키마가 정하지 않는다**(O-02). 0~10000bp 는 **스키마 수준 경계**이고
 * (그 밖은 입력 사고다) 업무 범위는 운영 결정이다 — 코드가 "5~8%" 를 강제하면
 * 미결정이 조용히 확정된다(`feeBasisOf`·`resolveSplitPlans` 와 같은 원칙).
 */
const InstantSchema = z.string().datetime({ offset: true });

export const RateCreateSchema = z.object({
  type: z.enum(RATE_TYPES),
  scopeType: z.enum(RATE_SCOPES),
  scopeKey: z.string().min(1).nullable(),
  serviceLevel: z.string().min(1).nullable().optional(),
  feeRateBp: z
    .number()
    .int("요율은 basis point 정수여야 합니다.")
    .min(0)
    .max(10_000, "0~10000bp 를 벗어나면 입력 사고입니다."),
  effectiveFrom: InstantSchema,
  effectiveTo: InstantSchema.nullable(),
  memo: z.string().max(200).nullable().optional(),
});

export type RateCreate = z.infer<typeof RateCreateSchema>;

/**
 * 종료 요청.
 *
 * **삭제 요청이 없다.** 요율 행을 지우면 "그때 어떤 요율표가 있었나" 를 재현할 수
 * 없고 그것이 정산 분쟁의 쟁점이다(D-23). DB 도 DELETE 권한을 회수해 뒀다(0034).
 */
export const RateCloseSchema = z.object({
  type: z.enum(RATE_TYPES),
  rateId: z.string().uuid("요율 식별자가 올바르지 않습니다."),
  endAt: InstantSchema,
});

export type RateClose = z.infer<typeof RateCloseSchema>;

/**
 * 무효화 요청 (FIX-12).
 *
 * **종료와 다른 요청이라 스키마를 나눴다.** 종료는 시각을 받고("여기까지 적용했다")
 * 무효화는 사유를 받는다("이 줄은 없던 것으로 친다"). 한 엔드포인트에 섞으면 어느
 * 쪽인지가 본문 모양에 숨고, 감사 로그에서도 구분되지 않는다.
 *
 * **사유가 필수다.** DB CHECK(`*_void_pair`)가 최종 경계이며 여기서 먼저 걸러
 * 사람이 읽을 수 있는 메시지를 준다. 상한 300자는 DB 와 같은 값이다.
 */
export const RateVoidSchema = z.object({
  type: z.enum(RATE_TYPES),
  rateId: z.string().uuid("요율 식별자가 올바르지 않습니다."),
  reason: z
    .string()
    .trim()
    .min(1, "무효화 사유를 적어 주세요.")
    .max(300, "무효화 사유는 300자를 넘을 수 없습니다."),
});

export type RateVoid = z.infer<typeof RateVoidSchema>;
