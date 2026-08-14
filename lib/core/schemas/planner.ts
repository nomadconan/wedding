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
