// 위약금 기준 룰 세트 (명세서 §3.5 penalty_rules, §5.3)
//
// ⚠ 이 파일의 **수치는 법무 검수 전 가정치**다.
//
// TODO(법무 검수 · 부록 D ②): 소비자분쟁해결기준의 업종별 항목 번호와 구간·요율을
//   확정해 supabase seed(penalty_rules)에 넣는다. 확정 후에는 운영 경로가 DB 값을
//   주입하므로 이 파일은 로컬 개발·테스트 기본값으로만 남는다.
//
// 엔진(calculatePenalty)은 룰 세트를 **주입받는다**. 여기 수치가 바뀌어도,
// 혹은 DB 값으로 대체돼도 엔진 코드는 바뀌지 않는다.
//
// isDraft: true 인 룰 세트를 쓰면 결과 notes 에 가정치 경고가 붙고,
// 화면은 그 경고를 그대로 노출해야 한다(§7.7 법적 표현 원칙).

import type { PenaltyBand, PenaltyCategory, PenaltyRuleSet } from "../schemas/penalty";

export const PENALTY_RULES_VERSION = "2026-08-08-draft";

const DRAFT_BASIS_WEDDING = "소비자분쟁해결기준(예식업) — 조항 번호 확정 전 가정치";
const DRAFT_BASIS_PHOTO = "소비자분쟁해결기준(사진촬영업) — 조항 번호 확정 전 가정치";
const DRAFT_BASIS_AGENCY = "소비자분쟁해결기준(결혼준비대행업) — 조항 번호 확정 전 가정치";

/**
 * 예식장·대행 성격의 구간(가정치).
 * 남은 일수가 많을수록 부담이 작아지는 계단 구조다.
 */
const VENUE_BANDS: PenaltyBand[] = [
  {
    code: "D90_PLUS",
    label: "예식일 90일 전까지",
    minDaysBeforeEvent: 90,
    maxDaysBeforeEvent: null,
    rateBp: 0,
    refundDeposit: true,
  },
  {
    code: "D60_89",
    label: "예식일 89~60일 전",
    minDaysBeforeEvent: 60,
    maxDaysBeforeEvent: 89,
    rateBp: 1_000, // 10%
    refundDeposit: false,
  },
  {
    code: "D30_59",
    label: "예식일 59~30일 전",
    minDaysBeforeEvent: 30,
    maxDaysBeforeEvent: 59,
    rateBp: 2_000, // 20%
    refundDeposit: false,
  },
  {
    code: "D00_29",
    label: "예식일 29일 전~당일",
    minDaysBeforeEvent: 0,
    maxDaysBeforeEvent: 29,
    rateBp: 3_500, // 35%
    refundDeposit: false,
  },
];

/**
 * 스튜디오·드레스·메이크업 성격의 구간(가정치).
 * 촬영·대여는 예식일보다 앞선 일정에 묶이므로 구간을 더 짧게 잡았다.
 */
const SDM_BANDS: PenaltyBand[] = [
  {
    code: "D30_PLUS",
    label: "이용일 30일 전까지",
    minDaysBeforeEvent: 30,
    maxDaysBeforeEvent: null,
    rateBp: 0,
    refundDeposit: true,
  },
  {
    code: "D10_29",
    label: "이용일 29~10일 전",
    minDaysBeforeEvent: 10,
    maxDaysBeforeEvent: 29,
    rateBp: 1_000, // 10%
    refundDeposit: false,
  },
  {
    code: "D00_09",
    label: "이용일 9일 전~당일",
    minDaysBeforeEvent: 0,
    maxDaysBeforeEvent: 9,
    rateBp: 2_000, // 20%
    refundDeposit: false,
  },
];

/** 예식일이 지난 뒤 취소한 경우(가정치). */
const AFTER_EVENT_BAND: PenaltyBand = {
  code: "AFTER_EVENT",
  label: "예식일 경과 후",
  minDaysBeforeEvent: 0,
  maxDaysBeforeEvent: null,
  rateBp: 10_000, // 100%
  refundDeposit: false,
};

function draftRuleSet(
  category: PenaltyCategory,
  bands: PenaltyBand[],
  basisRef: string,
): PenaltyRuleSet {
  return {
    category,
    version: PENALTY_RULES_VERSION,
    basisRef,
    isDraft: true,
    // 호출부가 실수로 배열을 변형해도 원본이 오염되지 않게 복사해서 넘긴다.
    bands: bands.map((band) => ({ ...band })),
    afterEvent: { ...AFTER_EVENT_BAND },
  };
}

/**
 * 카테고리별 기본(가정치) 룰 세트.
 * 운영에서는 penalty_rules 테이블 값을 주입한다.
 */
export const DRAFT_PENALTY_RULE_SETS: Readonly<Record<PenaltyCategory, PenaltyRuleSet>> = {
  hall: draftRuleSet("hall", VENUE_BANDS, DRAFT_BASIS_WEDDING),
  agency: draftRuleSet("agency", VENUE_BANDS, DRAFT_BASIS_AGENCY),
  studio: draftRuleSet("studio", SDM_BANDS, DRAFT_BASIS_PHOTO),
  video: draftRuleSet("video", SDM_BANDS, DRAFT_BASIS_PHOTO),
  dress: draftRuleSet("dress", SDM_BANDS, DRAFT_BASIS_WEDDING),
  makeup: draftRuleSet("makeup", SDM_BANDS, DRAFT_BASIS_WEDDING),
};

/** 카테고리에 해당하는 기본 룰 세트를 돌려준다. */
export function getDraftPenaltyRuleSet(category: PenaltyCategory): PenaltyRuleSet {
  return DRAFT_PENALTY_RULE_SETS[category];
}
