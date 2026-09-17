// 모델 출력 게이트 케이스 (FIX-42 · 명세서 §5.2 6·7단계 · CLAUDE.md §8)
//
// ══════════════════════════════════════════════════════════════════════════
// **모델이 쓴 문장을 재지 않는다. 문이 열리고 닫히는 조건을 잰다.**
//
// §5.2 는 LLM 단계에 문을 둘 세웠다:
//   6단계 스키마 검증 — 형태가 어긋나면 **응답 전체**를 버린다(부분 결과 비노출 · §5.1)
//   7단계 인용 대조 — 원문에 없는 문장을 인용한 finding 을 **개별** 폐기한다
// 여기에 T-04 가 하나를 더했다: **조항 번호를 지어낸 근거는 버린다**(법무 검수 전까지
// 우리는 조 번호를 말하지 않는다).
//
// 이 셋은 전부 **결정적**이다 — 같은 입력이면 같은 결과다. 그래서 골든셋에 들어간다.
// 반대로 "모델이 좋은 설명을 썼는가" 는 매번 달라 여기 들어오지 못한다(S8-07 소관).
//
// ── 왜 이것까지 재는가 ──────────────────────────────────────────────────────
// 프롬프트를 고치면 모델이 내는 **모양**이 바뀐다. 모양이 바뀌면 문이 다르게 동작하고,
// 그 변화는 문장 품질 지표에 잡히지 않는다 — 버려진 finding 은 애초에 화면에 안 뜨므로
// 아무도 못 본다. §7.5 가 "룰·프롬프트 배포 전" 이라고 **둘을 함께** 적은 이유다.
// ══════════════════════════════════════════════════════════════════════════

import { AI_DISCLAIMER } from "../../legal";
import type { DiscardedFinding } from "../../report/pipeline";
import type { Finding } from "../../schemas/report";

/** 케이스가 재는 문. */
export type ModelCase =
  /** 6단계 — 스키마 검증. 어긋나면 **응답 전체**를 버린다. */
  | {
      id: string;
      stage: "schema";
      title: string;
      note: string;
      output: unknown;
      expect: "accept" | "reject";
    }
  /** 7단계 — 인용 대조·폐기. 통과한 것만 리포트에 남는다. */
  | {
      id: string;
      stage: "merge";
      title: string;
      note: string;
      maskedText: string;
      findings: readonly Finding[];
      expectKept: readonly string[];
      expectDiscarded: readonly { ruleCode: string; reason: DiscardedFinding["reason"] }[];
    };

/** 케이스용 계약서 본문. 아래 인용은 **이 문장들 안에 실재**해야 통과한다. */
const SAMPLE_TEXT = [
  "제1조 총 금액은 28,500,000원으로 한다.",
  "예식일 30일 이내 취소 시 총 계약금액의 80%를 위약금으로 청구합니다.",
  "납부한 계약금은 어떠한 경우에도 반환하지 아니합니다.",
  "당사는 예식 진행 중 발생한 어떠한 손해에 대해서도 책임을 지지 아니합니다.",
].join("\n");

function finding(input: Partial<Finding> & { rule_code: string; clause_excerpt: string }): Finding {
  return {
    severity: "high",
    issue: "기준 대비 편차가 있습니다.",
    basis_ref: "소비자분쟁해결기준(예식업)",
    negotiation_script: "해당 조항을 기준에 맞춰 조정해 주실 수 있을까요?",
    ...input,
  };
}

/** 스키마가 통과시켜야 하는 최소 형태. */
const VALID_REPORT = {
  risk_score: 40,
  summary: "위약·해지 항목에서 기준 대비 편차가 확인됐습니다.",
  findings: [
    finding({
      rule_code: "R-01",
      clause_excerpt: "예식일 30일 이내 취소 시 총 계약금액의 80%를 위약금으로 청구합니다.",
    }),
  ],
  missing_clauses: ["불가항력 처리 기준"],
  negotiation_points: ["위약금 구간을 기준표에 맞춰 조정"],
  disclaimer: AI_DISCLAIMER,
};

export const MODEL_CASES: readonly ModelCase[] = [
  // ══ 6단계 — 스키마 ═══════════════════════════════════════════════════════
  {
    id: "G-M-schema-ok",
    stage: "schema",
    title: "형태가 맞는 출력은 통과한다",
    note: "**양성이 없으면 스키마를 조여도 표가 초록이다** — 통과해야 하는 것이 통과하는지 먼저 본다",
    output: VALID_REPORT,
    expect: "accept",
  },
  {
    id: "G-M-schema-disclaimer-default",
    stage: "schema",
    title: "고지를 빼먹으면 코드가 채운다",
    note: "모델이 disclaimer 를 안 쓴 것은 거절 사유가 아니다 — 기본값이 들어간다(§2.3 상시 고지)",
    output: { ...VALID_REPORT, disclaimer: undefined },
    expect: "accept",
  },
  {
    id: "G-M-schema-disclaimer-tampered",
    stage: "schema",
    title: "고지를 다른 문구로 바꾸면 거절한다",
    note: "'법률 자문이 아닙니다' 가 빠진 리포트는 화면에 뜨면 안 된다(CLAUDE.md §2.3 · §7.7)",
    output: { ...VALID_REPORT, disclaimer: "본 내용은 참고용입니다." },
    expect: "reject",
  },
  {
    id: "G-M-schema-unknown-rule",
    stage: "schema",
    title: "정의되지 않은 rule_code 는 응답 전체를 버린다",
    note: "룰 20종 밖의 코드는 화면이 이름을 못 붙인다 — 지어낸 룰이 리포트에 실리는 길을 막는다",
    output: {
      ...VALID_REPORT,
      findings: [finding({ rule_code: "R-99", clause_excerpt: "지어낸 조항입니다." })],
    },
    expect: "reject",
  },
  {
    id: "G-M-schema-score-out-of-range",
    stage: "schema",
    title: "위험 점수가 범위를 벗어나면 거절한다",
    note: "점수는 코드가 다시 계산하지만, 범위를 벗어난 응답은 모델이 형식을 못 지켰다는 신호다",
    output: { ...VALID_REPORT, risk_score: 120 },
    expect: "reject",
  },
  {
    id: "G-M-schema-empty-excerpt",
    stage: "schema",
    title: "인용이 비어 있으면 거절한다",
    note: "빈 인용은 대조할 것이 없다 — 7단계가 무조건 버릴 것을 6단계에서 먼저 막는다",
    output: {
      ...VALID_REPORT,
      findings: [finding({ rule_code: "R-01", clause_excerpt: "" })],
    },
    expect: "reject",
  },
  {
    id: "G-M-schema-empty-script",
    stage: "schema",
    title: "협상 문구가 비어 있으면 거절한다",
    note: "빈 문자열을 화면이 받으면 '요청 문구' 자리가 그냥 빈칸으로 뜬다",
    output: {
      ...VALID_REPORT,
      findings: [
        finding({
          rule_code: "R-01",
          clause_excerpt: "예식일 30일 이내 취소 시 총 계약금액의 80%를 위약금으로 청구합니다.",
          negotiation_script: "",
        }),
      ],
    },
    expect: "reject",
  },

  // ══ 7단계 — 인용 대조·폐기 ═══════════════════════════════════════════════
  {
    id: "G-M-merge-all-real",
    stage: "merge",
    title: "원문에 실재하는 인용은 전부 남는다",
    note: "**양성이 없으면 대조를 '전부 폐기' 로 바꿔도 표가 초록이다**",
    maskedText: SAMPLE_TEXT,
    findings: [
      finding({
        rule_code: "R-01",
        clause_excerpt: "예식일 30일 이내 취소 시 총 계약금액의 80%를 위약금으로 청구합니다.",
      }),
      finding({
        rule_code: "R-02",
        clause_excerpt: "납부한 계약금은 어떠한 경우에도 반환하지 아니합니다.",
      }),
    ],
    expectKept: ["R-01", "R-02"],
    expectDiscarded: [],
  },
  {
    id: "G-M-merge-whitespace",
    stage: "merge",
    title: "공백 차이는 같은 인용으로 본다",
    note: "모델이 줄바꿈·띄어쓰기를 다르게 옮기는 것은 지어낸 것이 아니다",
    maskedText: SAMPLE_TEXT,
    findings: [
      finding({
        rule_code: "R-02",
        clause_excerpt: "납부한  계약금은\n어떠한 경우에도 반환하지 아니합니다.",
      }),
    ],
    expectKept: ["R-02"],
    expectDiscarded: [],
  },
  {
    id: "G-M-merge-invented-citation",
    stage: "merge",
    title: "원문에 없는 인용은 버린다",
    note: "**근거 없는 high 판정을 막는 문이다**(CLAUDE.md §8) — 나머지는 살리고 이것만 버린다",
    maskedText: SAMPLE_TEXT,
    findings: [
      finding({
        rule_code: "R-01",
        clause_excerpt: "예식일 30일 이내 취소 시 총 계약금액의 80%를 위약금으로 청구합니다.",
      }),
      finding({
        rule_code: "R-10",
        clause_excerpt: "업체는 고객의 예식을 임의로 취소할 수 있습니다.",
      }),
    ],
    expectKept: ["R-01"],
    expectDiscarded: [{ ruleCode: "R-10", reason: "citation_mismatch" }],
  },
  {
    id: "G-M-merge-unknown-rule",
    stage: "merge",
    title: "룰 20종 밖의 코드는 여기서도 버린다",
    note: "스키마가 이미 막지만 그쪽은 **응답 전체**를 버린다 — 둘째 그물을 따로 확인한다",
    maskedText: SAMPLE_TEXT,
    findings: [
      finding({
        rule_code: "R-99",
        clause_excerpt: "납부한 계약금은 어떠한 경우에도 반환하지 아니합니다.",
      }),
    ],
    expectKept: [],
    expectDiscarded: [{ ruleCode: "R-99", reason: "unknown_rule" }],
  },
  {
    id: "G-M-merge-invented-clause-number",
    stage: "merge",
    title: "근거에 조항 번호를 지어내면 버린다",
    note:
      "법무 검수(부록 D ②) 전까지 우리는 조 번호를 말하지 않는다 — 시드 쪽은 T-04·db:rls 가 막고 " +
      "모델 쪽은 이 문이 막는다. 한쪽만 막으면 화면에는 결국 번호가 뜬다",
    maskedText: SAMPLE_TEXT,
    findings: [
      finding({
        rule_code: "R-02",
        clause_excerpt: "납부한 계약금은 어떠한 경우에도 반환하지 아니합니다.",
        basis_ref: "소비자분쟁해결기준(예식업) 제12조 제2항",
      }),
    ],
    expectKept: [],
    expectDiscarded: [{ ruleCode: "R-02", reason: "invented_clause_number" }],
  },
  {
    id: "G-M-merge-mixed",
    stage: "merge",
    title: "섞여 들어와도 살릴 것만 살린다",
    note: "하나가 지어졌다고 나머지가 지어진 것은 아니다 — 응답 전체를 버리지 않는 이유",
    maskedText: SAMPLE_TEXT,
    findings: [
      finding({
        rule_code: "R-01",
        clause_excerpt: "예식일 30일 이내 취소 시 총 계약금액의 80%를 위약금으로 청구합니다.",
      }),
      finding({
        rule_code: "R-02",
        clause_excerpt: "납부한 계약금은 어떠한 경우에도 반환하지 아니합니다.",
        basis_ref: "표준약관 제3조",
      }),
      finding({
        rule_code: "R-05",
        clause_excerpt: "원판 추가 비용은 현장에서 정합니다.",
      }),
      finding({
        rule_code: "R-10",
        clause_excerpt: "당사는 예식 진행 중 발생한 어떠한 손해에 대해서도 책임을 지지 아니합니다.",
      }),
    ],
    expectKept: ["R-01", "R-10"],
    expectDiscarded: [
      { ruleCode: "R-02", reason: "invented_clause_number" },
      { ruleCode: "R-05", reason: "citation_mismatch" },
    ],
  },
];
