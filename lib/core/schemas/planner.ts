import { z } from "zod";

import {
  BIO_MAX,
  CAREER_YEARS_MAX,
  HEADLINE_MAX,
} from "../planner/profile";
import { PLANNER_CATEGORIES } from "../planner/scope";

/**
 * 플래너 프로필 API 스키마 (S6-02 · §4 · CLAUDE.md §6)
 *
 * **요금을 받지 않는다.** 요율은 `planner_fee_rates`(S5-01)가 갖고 계약 확정 시
 * 스냅샷된다(D-16) — 프로필로 받으면 요율의 진실이 둘이 되고 화면과 실제 청구가
 * 어긋난다. DB CHECK 도 `fee_json` 이 비어 있기를 요구한다(0037).
 *
 * **상태를 받지 않는다.** 공개(`active`)는 **심사의 결과**이지 본인의 선언이 아니다.
 * 본인이 할 수 있는 것은 **공개 신청**과 **내리기**뿐이며 그것은 별도 액션이다.
 */
export const PlannerProfileSchema = z.object({
  headline: z
    .string()
    .trim()
    .min(1, "한 줄 소개를 적어 주세요.")
    .max(HEADLINE_MAX, `한 줄 소개는 ${HEADLINE_MAX}자 이내로 적어 주세요.`),
  bio: z.string().max(BIO_MAX, `소개는 ${BIO_MAX}자 이내로 적어 주세요.`).default(""),
  careerYears: z
    .number()
    .int("경력은 정수로 적어 주세요.")
    .min(0)
    .max(CAREER_YEARS_MAX, `경력은 ${CAREER_YEARS_MAX}년 이내로 적어 주세요.`),
  categories: z
    .array(z.enum(PLANNER_CATEGORIES))
    .min(1, "맡을 수 있는 카테고리를 하나 이상 고르세요."),
  regions: z.array(z.string().trim().min(1)).min(1, "활동 지역을 하나 이상 고르세요."),
});

export type PlannerProfileInput = z.infer<typeof PlannerProfileSchema>;

/**
 * 공개 상태 변경.
 *
 * **`active` 가 없다.** 공개는 심사를 거치며(0037 트리거가 자가 공개를 막는다) 본인이
 * 보낼 수 있는 것은 **신청**(`pending`)과 **내리기**(`paused`)뿐이다.
 */
export const PlannerListingSchema = z.object({
  action: z.enum(["request_listing", "pause"]),
});

export type PlannerListing = z.infer<typeof PlannerListingSchema>;

/**
 * 위임 제안 (S6-04 · F-C-18 · §3.7 planner_engagements)
 *
 * **`plannerId` 는 경로가 정하고 `coupleId` 는 세션이 정한다** — 본문으로 받으면
 * 남의 커플 데이터를 내 플래너에게 여는 요청을 만들 수 있다(FIX-45 가 드러낸 자리:
 * "누구의 것인가" 가 판정에서 빠지면 비용도 권한도 엉뚱한 쪽으로 간다).
 *
 * **`status` 를 받지 않는다.** 제안은 언제나 `pending` 에서 시작하고 수락은 플래너의
 * 몫이다(D-165). 받으면 커플이 곧바로 `active` 로 적어 수락 절차를 우회한다.
 *
 * 범위 어휘는 `lib/core/planner/delegation.ts` 의 `DELEGATABLE_SCOPE_KEYS` 가 갖고
 * DB CHECK 이 같은 목록을 든다 — 여기서는 **모양만** 본다(문자열·비어 있지 않음).
 */
export const DelegationOfferSchema = z.object({
  scopes: z.array(z.string().trim().min(1)).min(1, "무엇을 보여줄지 하나 이상 골라 주세요."),
  validFrom: z.string().datetime(),
  validTo: z.string().datetime(),
});

export type DelegationOfferInput = z.infer<typeof DelegationOfferSchema>;

/**
 * 위임 상태 변경.
 *
 * **행위별로 갈랐다** — 상태 문자열을 그대로 받으면 "누가 무엇으로 옮길 수 있는가"
 * 를 본문이 정하게 된다. 여기서 받는 것은 **행위**이고 상태는 서버가 정한다.
 */
export const DelegationActionSchema = z.object({
  action: z.enum(["accept", "decline", "revoke"]),
});

export type DelegationAction = z.infer<typeof DelegationActionSchema>;
