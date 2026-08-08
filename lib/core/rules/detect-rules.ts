// 검출 룰 20종 (명세서 부록 A, §5.2 4단계)
//
// 부록 A 의 R-01~R-20 을 데이터로 옮긴 것이다. 룰을 줄이거나 합치지 않는다.
//
// ── basis_ref 에 대하여 ────────────────────────────────────────────────────
// 정확한 **조항 번호는 지어내지 않는다**. 부록 A 는 "등급·문안은 법무 검수 후 확정"
// 이라고 명시하고 있고, 후속 작업 ②(표준 계약서 템플릿·근거 조항 매핑)가 아직
// 끝나지 않았다. 따라서 여기에는 출처 문서 수준까지만 적고, 조항 단위 매핑은
// 아래 TODO 로 남긴다.
//
// TODO(법무 검수 · 부록 D ②): basis_ref 를 조항 단위로 확정한다.
//   - 공정거래위원회 표준약관(예식업·결혼중개업·사진촬영업)의 조 번호
//   - 소비자분쟁해결기준 해당 업종의 항목 번호
//   확정 전까지 UI 는 이 문자열을 그대로 '근거' 로 노출하며,
//   확정적 법적 결론으로 표현하지 않는다(CLAUDE.md §2.3).

import type { DetectRule } from "./types";

/** 룰 세트 버전. 변경 시 detect_rules.version·seed.sql 과 함께 올린다. */
export const DETECT_RULES_VERSION = "2026-08-08-draft";

// ── 근거 출처 상수 ──────────────────────────────────────────────────────────
const BASIS_STANDARD_TERMS = "공정거래위원회 표준약관";
const BASIS_DISPUTE_WEDDING = "소비자분쟁해결기준(예식업)";
const BASIS_DISPUTE_PHOTO = "소비자분쟁해결기준(사진촬영업)";
const BASIS_DISPUTE_AGENCY = "소비자분쟁해결기준(결혼준비대행업)";

const V = DETECT_RULES_VERSION;

export const DETECT_RULES: readonly DetectRule[] = [
  // ══ 위약·해지 ═════════════════════════════════════════════════════════════
  {
    code: "R-01",
    title: "위약금률이 소비자분쟁해결기준 대비 과다",
    category: "penalty",
    severity_default: "high",
    basis_ref: `${BASIS_DISPUTE_WEDDING} / ${BASIS_DISPUTE_AGENCY}`,
    prompt_fragment:
      "계약서에 규정된 위약금률을 취소 시점 구간별로 추출하고, 기준 대비 편차를 비교값으로만 서술한다. 확정적 법적 결론을 내리지 않는다.",
    detect: {
      presence: {
        patterns: [
          // 위약금 문구 + 50% 이상 요율
          /(위약금|해약금|위약벌|손해배상액)[^.\n]{0,40}?(?:[5-9]\d|100)\s*%/,
          /(?:[5-9]\d|100)\s*%[^.\n]{0,25}(위약금|해약금|위약벌)/,
          // 총액 전부를 배상액으로 규정
          /(총|계약)\s*금액의?\s*전액[^.\n]{0,20}(위약금|배상|청구)/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-02",
    title: "계약금 전액 몰취·환불 불가 조항",
    category: "penalty",
    severity_default: "high",
    basis_ref: `${BASIS_DISPUTE_WEDDING} / ${BASIS_STANDARD_TERMS}`,
    prompt_fragment:
      "계약금의 반환 여부와 조건을 확인한다. 시점과 무관하게 전액 몰취하는 조항이면 기준 대비 편차를 설명한다.",
    detect: {
      presence: {
        patterns: [
          /(계약금|예약금|착수금)[^.\n]{0,30}(반환|환불|반환하지|환불하지)\s*(?:하지\s*)?(?:아니|않|불가|되지\s*않|어렵)/,
          /(계약금|예약금|착수금)[^.\n]{0,25}(몰취|귀속|포기)/,
          /(환불|반환)\s*(?:은|는)?\s*불가/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-03",
    title: "취소 시점 구간이 불명확하거나 업체 재량으로 규정",
    category: "penalty",
    severity_default: "high",
    basis_ref: `${BASIS_DISPUTE_WEDDING} / ${BASIS_STANDARD_TERMS}`,
    prompt_fragment:
      "취소 시점별 환불·위약 구간이 날짜 기준으로 특정돼 있는지 확인한다. 업체 재량·내부 규정에 위임돼 있으면 지적한다.",
    detect: {
      presence: {
        patterns: [
          /(취소|해지|해제)[^.\n]{0,30}(당사|업체|회사|갑)[^.\n]{0,25}(재량|판단|결정|정하는\s*바)/,
          /(위약금|환불|반환)[^.\n]{0,30}(내부\s*규정|당사\s*규정|회사\s*방침|별도\s*협의|상호\s*협의)/,
        ],
      },
    },
    version: V,
    is_active: true,
  },

  // ══ 가격 ══════════════════════════════════════════════════════════════════
  {
    code: "R-04",
    title: "총액 미기재 또는 '별도 문의·협의' 표기",
    category: "price",
    severity_default: "high",
    basis_ref: BASIS_STANDARD_TERMS,
    prompt_fragment:
      "지불해야 할 총액이 숫자로 특정돼 있는지 확인한다. '별도 문의·협의·추후 결정' 표기는 총액 미확정으로 본다.",
    detect: {
      presence: {
        patterns: [
          /별도\s*(문의|협의|안내|상담)/,
          /(추후|차후)\s*(협의|결정|안내|공지)/,
          /(상담|미팅)\s*(?:후|시)\s*(결정|안내|확정)/,
          /견적\s*별도/,
        ],
      },
      // 총액 표기 자체가 아예 없는 경우도 같은 룰로 잡는다.
      absence: {
        expected: [
          /(총\s*금액|총액|계약\s*금액|합계)[^.\n]{0,20}[\d,]{4,}/,
          /[\d,]{4,}\s*원[^.\n]{0,10}(총액|합계|계약\s*금액)/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-05",
    title: "추가금 항목이 특정되지 않음(원판·수정·연장 등)",
    category: "price",
    severity_default: "high",
    basis_ref: BASIS_STANDARD_TERMS,
    prompt_fragment:
      "추가금이 발생할 수 있는 항목과 금액이 사전에 특정돼 있는지 확인한다. 사전 미특정 추가금은 사후 청구 근거가 될 수 있다.",
    detect: {
      presence: {
        patterns: [
          /(추가\s*(?:금액|비용|요금|촬영|보정))[^.\n]{0,30}(별도|현장|협의|발생할\s*수|청구될\s*수|부과)/,
          /(원판|수정|보정|연장|추가\s*컷)[^.\n]{0,25}(별도\s*(?:금액|비용|요금)|추가\s*(?:금액|비용|요금))/,
        ],
        excludes: [/(?:표|별표|아래)[^.\n]{0,10}(명시|기재|한정)/],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-06",
    title: "최소 보증인원 과다 및 미달 시 전액 부담",
    category: "price",
    severity_default: "high",
    basis_ref: `${BASIS_DISPUTE_WEDDING} / ${BASIS_STANDARD_TERMS}`,
    prompt_fragment:
      "최소 보증인원 수와 미달 시 정산 방식을 확인한다. 미달 인원의 식대를 전액 부담시키는 조항이면 지적한다.",
    detect: {
      presence: {
        patterns: [
          /(보증\s*인원|최소\s*보증)[^.\n]{0,40}(미달|미만)[^.\n]{0,30}(전액|전부|모두)\s*(부담|지불|지급|정산)/,
          /(보증\s*인원|최소\s*보증)[^.\n]{0,20}(?:[3-9]\d{2}|\d{4})\s*명/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-07",
    title: "식대·대관료 단가의 사후 인상 가능 조항",
    category: "price",
    severity_default: "high",
    basis_ref: BASIS_STANDARD_TERMS,
    prompt_fragment:
      "계약 후 단가가 인상될 수 있는 조항이 있는지 확인한다. 인상 사유·상한·통지 절차가 없으면 함께 지적한다.",
    detect: {
      presence: {
        patterns: [
          /(식대|대관료|단가|가격)[^.\n]{0,40}(인상|변동|조정)(?:될\s*수|할\s*수|가능|이\s*있을\s*수)/,
          /(물가|원자재|인건비)[^.\n]{0,30}(따라|반영)[^.\n]{0,20}(인상|조정|변경)/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-08",
    title: "부대비용(주차·음향·꽃장식) 누락 또는 현장 청구",
    category: "price",
    severity_default: "mid",
    basis_ref: BASIS_STANDARD_TERMS,
    prompt_fragment:
      "주차·음향·조명·생화 등 부대비용이 총액에 포함되는지, 현장에서 별도 청구되는지 확인한다.",
    detect: {
      presence: {
        patterns: [
          /(주차|음향|조명|꽃장식|생화|드라이아이스|폐백|피로연)[^.\n]{0,30}(현장[^.\n]{0,10}(결제|지급|청구|정산)|별도[^.\n]{0,8}(청구|지불|부담|결제))/,
        ],
      },
    },
    version: V,
    is_active: true,
  },

  // ══ 이행 ══════════════════════════════════════════════════════════════════
  {
    code: "R-09",
    title: "업체의 일방적 일정·장소 변경권",
    category: "performance",
    severity_default: "high",
    basis_ref: BASIS_STANDARD_TERMS,
    prompt_fragment:
      "업체가 단독으로 일정·장소·홀을 변경할 수 있는 조항인지 확인한다. 고객 동의·거부권 유무를 함께 본다.",
    detect: {
      presence: {
        patterns: [
          /(당사|업체|회사|갑)[^.\n]{0,25}(일정|날짜|시간|장소|홀|예식장)[^.\n]{0,25}(변경|조정|이전)할\s*수\s*있/,
          /(일정|장소|홀)[^.\n]{0,20}(변경|조정)[^.\n]{0,25}(이의|이견|거부)[^.\n]{0,15}(제기할\s*수\s*없|할\s*수\s*없)/,
        ],
        excludes: [/(합의|동의|협의)[^.\n]{0,10}(하에|하여|후|로만)/],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-10",
    title: "업체 귀책 사유에 대한 광범위한 면책",
    category: "performance",
    severity_default: "high",
    basis_ref: BASIS_STANDARD_TERMS,
    prompt_fragment:
      "업체의 고의·과실까지 면책하는 광범위한 조항인지 확인한다. 면책 범위가 특정 사유로 한정돼 있으면 해당하지 않는다.",
    detect: {
      presence: {
        patterns: [
          /(어떠한|어떤|일체의?|모든)[^.\n]{0,20}(책임|배상)[^.\n]{0,15}(지지\s*아니|지지\s*않|없|면제|면책)/,
          /(당사|업체|회사|갑)[^.\n]{0,25}(면책|책임을?\s*지지\s*아니|책임을?\s*지지\s*않)/,
        ],
      },
    },
    version: V,
    is_active: true,
  },

  // ══ 스드메 ════════════════════════════════════════════════════════════════
  {
    code: "R-11",
    title: "촬영 원본 미제공 또는 별도 구매 강제",
    category: "sdm",
    severity_default: "high",
    basis_ref: BASIS_DISPUTE_PHOTO,
    prompt_fragment:
      "촬영 원본(RAW·전체 파일) 제공 여부와 조건을 확인한다. 별도 구매를 강제하면 금액과 함께 지적한다.",
    detect: {
      presence: {
        patterns: [
          /(원본|RAW|raw|전체\s*파일|전\s*컷)[^.\n]{0,30}(제공하지|미제공|제공되지|별도\s*구매|추가\s*결제|구매해야|구입해야)/,
          /(원본|RAW|raw)[^.\n]{0,20}(?:은|는)?\s*[\d,]{3,}\s*원/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-12",
    title: "앨범·액자 사양(페이지·사이즈·재질) 미기재",
    category: "sdm",
    severity_default: "mid",
    basis_ref: BASIS_DISPUTE_PHOTO,
    prompt_fragment:
      "앨범·액자의 페이지 수, 사이즈, 재질이 계약서에 특정돼 있는지 확인한다.",
    detect: {
      absence: {
        requires: [/(앨범|액자)/],
        expected: [
          /(앨범|액자)[^.\n]{0,40}\d+\s*(페이지|p|P|매|장)/,
          /(앨범|액자)[^.\n]{0,40}\d+\s*(인치|절|x|X|\*)/,
          /(앨범|액자)[^.\n]{0,40}(재질|커버|하드커버|소재)/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-13",
    title: "헬퍼비·교통비 등 현장 현금 지급 관행 조항",
    category: "sdm",
    severity_default: "mid",
    basis_ref: BASIS_STANDARD_TERMS,
    prompt_fragment:
      "헬퍼비·교통비 등을 현장에서 현금으로 지급하도록 정하고 있는지 확인한다. 금액이 특정돼 있는지도 함께 본다.",
    detect: {
      presence: {
        patterns: [
          /(헬퍼비|헬퍼\s*비용|헬퍼\s*팁|교통비|출장비|식대비)[^.\n]{0,30}(현금|당일\s*지급|현장\s*지급|직접\s*지급|봉투)/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-14",
    title: "드레스 피팅·추가 대여료 미고지",
    category: "sdm",
    severity_default: "mid",
    basis_ref: BASIS_STANDARD_TERMS,
    prompt_fragment:
      "드레스 피팅 횟수와 추가 대여료가 계약서에 특정돼 있는지 확인한다.",
    detect: {
      absence: {
        requires: [/(드레스|피팅|가봉)/],
        expected: [
          /(피팅|가봉)[^.\n]{0,40}(\d+\s*회|무료|포함)/,
          /추가\s*대여료[^.\n]{0,25}([\d,]+\s*원|무료|없|포함)/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-15",
    title: "담당자·작가 교체 시 통지·거부권 부재",
    category: "performance",
    severity_default: "mid",
    basis_ref: BASIS_STANDARD_TERMS,
    prompt_fragment:
      "담당자·작가·실장이 교체될 때 사전 통지와 고객의 거부권이 규정돼 있는지 확인한다.",
    detect: {
      absence: {
        requires: [/(담당자|작가|실장|디자이너|플래너)/],
        expected: [
          /(담당자|작가|실장|디자이너|플래너)[^.\n]{0,40}(변경|교체)[^.\n]{0,40}(사전\s*통지|사전\s*고지|사전\s*동의|협의|거부할\s*수|해지할\s*수)/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-16",
    title: "업체 지연·불이행 시 지연배상 조항 부재",
    category: "performance",
    severity_default: "mid",
    basis_ref: `${BASIS_STANDARD_TERMS} / ${BASIS_DISPUTE_AGENCY}`,
    prompt_fragment:
      "업체의 납품 지연·불이행에 대한 배상 조항이 있는지 확인한다. 고객 측 위약 규정만 있고 업체 측 규정이 없으면 비대칭을 지적한다.",
    detect: {
      absence: {
        expected: [
          /(지연|지체|불이행|미이행)[^.\n]{0,25}(배상|손해배상|보상|위약금|환급)/,
          /(납품|제공|인도)[^.\n]{0,20}(지연|지체)[^.\n]{0,25}(배상|보상)/,
        ],
      },
    },
    version: V,
    is_active: true,
  },

  // ══ 법적 ══════════════════════════════════════════════════════════════════
  {
    code: "R-17",
    title: "분쟁 관할을 업체 소재지로 일방 지정",
    category: "legal",
    severity_default: "mid",
    basis_ref: BASIS_STANDARD_TERMS,
    prompt_fragment:
      "분쟁 관할 법원이 업체 소재지로 일방 지정돼 있는지 확인한다.",
    detect: {
      presence: {
        patterns: [
          /(관할\s*법원|재판\s*관할|관할)[^.\n]{0,30}(본사|당사|회사|갑)\s*(소재지|주소|본점)/,
          /전속적?\s*(합의)?\s*관할/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-18",
    title: "개인정보·초상권의 무기한·무제한 활용 동의",
    category: "legal",
    severity_default: "high",
    basis_ref: BASIS_STANDARD_TERMS,
    prompt_fragment:
      "촬영물·개인정보의 활용 범위와 기간이 제한돼 있는지, 동의 철회가 가능한지 확인한다.",
    detect: {
      presence: {
        patterns: [
          /(초상권|촬영물|사진|영상|이미지|개인정보)[^.\n]{0,40}(무기한|영구|기한\s*없이|기간\s*제한\s*없이|제한\s*없이|무제한)/,
          /(홍보|마케팅|광고|포트폴리오)[^.\n]{0,30}(사용|활용|게시)[^.\n]{0,25}(동의|승낙)[^.\n]{0,25}(철회할\s*수\s*없|취소할\s*수\s*없|불가)/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-19",
    title: "후기 작성 의무 부과 또는 부정 후기 금지",
    category: "legal",
    severity_default: "mid",
    basis_ref: BASIS_STANDARD_TERMS,
    prompt_fragment:
      "할인·서비스 제공의 조건으로 후기 작성을 의무화하거나 부정적 후기를 금지하는 조항인지 확인한다.",
    detect: {
      presence: {
        patterns: [
          /(후기|리뷰|평점)[^.\n]{0,30}(작성)[^.\n]{0,12}(의무|필수|조건)/,
          /(부정적?|악의적?|비방)[^.\n]{0,12}(후기|리뷰)[^.\n]{0,25}(금지|게시할\s*수\s*없|작성할\s*수\s*없|삭제)/,
        ],
      },
    },
    version: V,
    is_active: true,
  },
  {
    code: "R-20",
    title: "천재지변·감염병 등 불가항력 시 처리 조항 부재",
    category: "legal",
    severity_default: "mid",
    basis_ref: `${BASIS_STANDARD_TERMS} / ${BASIS_DISPUTE_WEDDING}`,
    prompt_fragment:
      "천재지변·감염병 등 불가항력 상황의 연기·해지·환불 처리 기준이 있는지 확인한다.",
    detect: {
      absence: {
        expected: [/(천재지변|불가항력|자연재해|감염병|전염병|재난)/],
      },
    },
    version: V,
    is_active: true,
  },
] as const;

/** 룰 코드 집합. ReportSchema 의 rule_code 검증에 쓴다. */
export const DETECT_RULE_CODES: ReadonlySet<string> = new Set(DETECT_RULES.map((r) => r.code));

/** 코드로 룰을 찾는다. */
export function getDetectRule(code: string): DetectRule | undefined {
  return DETECT_RULES.find((rule) => rule.code === code);
}
