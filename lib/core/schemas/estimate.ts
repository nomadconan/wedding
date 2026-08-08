// 견적 정규화 입출력 스키마 (명세서 §5.4, §3.5 estimate_uploads·estimate_items)
//
//  * 파싱은 LLM 이 하지만(§5.4 1단계) **실총액 환산은 결정적 계산**이다.
//    금액은 원 단위 정수로 다룬다.
//  * 미매핑 항목은 버리지 않고 'unmapped' 로 분리 표시한다 — 화면에서 '확인 필요' 로 노출한다.
//  * 추정 항목은 is_estimated 로 표시하고 화면에서 '추정' 라벨을 강제한다(§5.4 검증 단계).

import { z } from "zod";

/**
 * 표준 견적 카테고리 코드.
 * quote_items.category_code / estimate_items.mapped_category 에 그대로 들어간다.
 */
export const ESTIMATE_CATEGORIES = [
  "hall", // 웨딩홀 대관
  "meal", // 식대
  "studio", // 스튜디오 촬영
  "dress", // 드레스
  "makeup", // 헤어·메이크업
  "video", // 본식 영상
  "snap", // 본식 스냅
  "flower", // 부케·꽃장식
  "invitation", // 청첩장
  "gift", // 예단·예물
  "officiant", // 주례·사회
  "helper", // 헬퍼비
  "etc", // 기타
  "unmapped", // 표준 카테고리로 매핑하지 못함 — '확인 필요'
] as const;

export type EstimateCategory = (typeof ESTIMATE_CATEGORIES)[number];

export const EstimateCategorySchema = z.enum(ESTIMATE_CATEGORIES);

export const ESTIMATE_CATEGORY_LABEL: Readonly<Record<EstimateCategory, string>> = {
  hall: "웨딩홀 대관",
  meal: "식대",
  studio: "스튜디오 촬영",
  dress: "드레스",
  makeup: "헤어·메이크업",
  video: "본식 영상",
  snap: "본식 스냅",
  flower: "부케·꽃장식",
  invitation: "청첩장",
  gift: "예단·예물",
  officiant: "주례·사회",
  helper: "헬퍼비",
  etc: "기타",
  unmapped: "확인 필요",
};

const AmountSchema = z.number().int("금액은 원 단위 정수여야 합니다.").min(0).finite();

/** LLM 파싱 단계(§5.4 1단계) 출력의 항목 하나. */
export const EstimateItemSchema = z.object({
  /** 견적서에 적힌 원래 표기. */
  raw_label: z.string().min(1).max(200),
  /** 표준 카테고리 매핑 결과. 매핑 실패 시 'unmapped'. */
  mapped_category: EstimateCategorySchema,
  amount: AmountSchema,
  /** 선택 항목인가. */
  is_option: z.boolean().default(false),
  /** 선택 항목이지만 사실상 필수인가(실총액 환산에 포함). */
  is_mandatory: z.boolean().default(false),
  /** 매핑·금액 추출 신뢰도. */
  confidence: z.number().min(0).max(1),
  /** 금액이 견적서에 명시되지 않아 추정한 값인가. */
  is_estimated: z.boolean().default(false),
});

export type EstimateItem = z.infer<typeof EstimateItemSchema>;

/** 견적 업로드 1건의 파싱 결과. */
export const EstimateParseResultSchema = z.object({
  /** 업체명은 마스킹된 값만 저장한다(estimate_uploads.vendor_name_masked). */
  vendor_name_masked: z.string().max(200).nullable(),
  items: z.array(EstimateItemSchema),
  /** 견적서에 적힌 합계. 항목 합과 다르면 검증 단계에서 플래그가 선다. */
  declared_total: AmountSchema.nullable(),
});

export type EstimateParseResult = z.infer<typeof EstimateParseResultSchema>;

/** 정규화 검증 플래그(§5.4 검증 단계). */
export const ESTIMATE_FLAGS = [
  "total_mismatch", // 항목 합과 표기 합계 불일치
  "has_unmapped", // 미매핑 항목 존재
  "has_estimated", // 추정 금액 포함
  "low_confidence", // 신뢰도 낮은 항목 존재
] as const;

export type EstimateFlag = (typeof ESTIMATE_FLAGS)[number];

export const EstimateFlagSchema = z.enum(ESTIMATE_FLAGS);

/** 정규화 결과 1건. */
export const NormalizedEstimateSchema = z.object({
  vendor_name_masked: z.string().max(200).nullable(),
  /** 카테고리별 합계. 표준 카테고리 축으로 정렬된 비교의 기준이 된다. */
  by_category: z.array(
    z.object({
      category: EstimateCategorySchema,
      amount: AmountSchema,
      is_estimated: z.boolean(),
    }),
  ),
  /** 필수 항목만 합산한 금액. */
  base_total: AmountSchema,
  /** 필수 옵션까지 반영한 실제 지불 예상액. */
  real_total: AmountSchema,
  declared_total: AmountSchema.nullable(),
  flags: z.array(EstimateFlagSchema),
});

export type NormalizedEstimate = z.infer<typeof NormalizedEstimateSchema>;

/** 2~5개 견적 병렬 비교표(F-C-06). */
export const EstimateComparisonSchema = z.object({
  estimates: z.array(NormalizedEstimateSchema).min(2).max(5),
  /** 비교에 사용된 카테고리 축(합집합). */
  categories: z.array(EstimateCategorySchema),
  /** 특정 견적에만 없는 항목 — 누락 하이라이트 대상. */
  missing_by_estimate: z.array(z.array(EstimateCategorySchema)),
});

export type EstimateComparison = z.infer<typeof EstimateComparisonSchema>;
