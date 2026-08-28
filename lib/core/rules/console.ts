// 룰·프롬프트 콘솔 (S8-06 · F-A-03)
//
// ══════════════════════════════════════════════════════════════════════════
// **읽기 전용 콘솔이다. 명세보다 좁다 — 그 사실을 화면이 적는다.**
// ══════════════════════════════════════════════════════════════════════════
//
// §2.3 F-A-03 은 '검출 룰 20종 CRUD'·'프롬프트 배포·롤백'·'스테이징 A/B 검증' 을
// 적는다. 이 리포의 실제와 셋 다 어긋나며, **어긋난 쪽을 명세에 맞추는 것이 아니라
// 명세가 실제를 말하게 한다**(07 §2.3 반영 제안 · D-140).
//
//   CRUD          **정규식은 코드가 갖는다**(S7-01). DB 에만 있는 룰은 정규식이 없어
//                 실행되지 않고 `unknownInDatabase` 로만 남는다 — 만들 수 있게 하면
//                 화면은 "룰을 추가했다" 고 말하는데 스캔은 그 룰을 모른다.
//                 지우는 것도 같다: 코드에 있는 한 다음 스캔에서 되살아난다.
//                 **그래서 C 와 D 가 없다.** U 만 있고, U 의 대상은 DB 가 가진
//                 운영자 자산(켬/끔·지시문·근거)뿐이다.
//   프롬프트 배포  프롬프트 본문은 코드 자산이다(CLAUDE.md §8). 화면에서 고치면
//                 **판본 태깅이 뜻을 잃는다** — 결과가 달라졌을 때 모델이 바뀐 건지
//                 문구가 바뀐 건지 구분하려고 판본을 붙였는데, 문구가 배포 밖에서
//                 바뀌면 그 구분이 불가능해진다.
//   스테이징 A/B   **환경이 없다.** 만들지 않고 그 사실을 적는다(O-22).
//
// **왜 이 경계인가.** 운영자가 정규식을 한 글자 잘못 적으면 스캔이 통째로 멈추거나
// (SyntaxError) 특정 문서에서 되돌아오지 않는다(파국적 백트래킹). 룰을 고치는 일은
// 배포로 하고, 그 편이 리뷰를 거친다. S7-01 이 그렇게 정한 이유가 그것이다.

import type { DetectRule } from "./types";
import type { MergedRuleSet, RuleDrift } from "./rule-source";

/** 콘솔에서 고칠 수 있는 칸. **여기 없는 것은 배포로만 바뀐다.** */
export const EDITABLE_RULE_FIELDS = ["is_active", "prompt_fragment", "basis_ref"] as const;
export type EditableRuleField = (typeof EDITABLE_RULE_FIELDS)[number];

export const EDITABLE_RULE_FIELD_LABEL: Record<EditableRuleField, string> = {
  is_active: "켬/끔",
  prompt_fragment: "지시문",
  basis_ref: "근거 표기",
};

/** 코드가 갖고 화면이 못 고치는 칸. 화면이 **왜 못 고치는지**를 함께 적는다. */
export const CODE_OWNED_FIELDS = [
  { field: "pattern_json", label: "정규식·검출 조건", reason: "오타 하나가 스캔을 멈추거나 되돌아오지 않게 만듭니다. 배포로 고칩니다." },
  { field: "code", label: "룰 코드", reason: "코드에 없는 코드는 정규식이 없어 실행되지 않습니다." },
  { field: "severity_default", label: "기본 등급", reason: "리포트의 위험 판정 기준이라 배포와 함께 바뀝니다." },
  { field: "category", label: "카테고리", reason: "룰의 정의 자체입니다." },
] as const;

export type RuleRow = {
  code: string;
  title: string;
  category: string;
  severity: string;
  /** 실행되는 값. 병합 결과이며 DB 가 비어 있으면 코드 값이다. */
  basisRef: string;
  promptFragment: string;
  version: string;
  /** 지금 스캔에서 도는가. **코드와 DB 둘 다 켜져 있어야 참이다.** */
  active: boolean;
  /** DB 행이 있는가. 없으면 시드가 밀린 것이고 코드 값으로 돈다. */
  inDatabase: boolean;
  /** 코드와 DB 의 판본이 다른가. */
  versionMismatch: boolean;
  /** DB 에만 있는 코드인가. **실행되지 않는다** — 정규식이 없다. */
  orphaned: boolean;
};

export type RuleConsole = {
  rows: RuleRow[];
  source: MergedRuleSet["source"];
  drift: RuleDrift;
  /** 지금 스캔에서 도는 룰 수. **0이면 분석이 서지 않는다**(S7-01). */
  activeCount: number;
  totalCount: number;
};

/**
 * 코드 룰과 DB 행을 콘솔이 읽을 모양으로 접는다.
 *
 * **`mergeDetectRules` 를 다시 구현하지 않는다** — 스캔이 쓰는 병합과 화면이 보여주는
 * 병합이 갈리면 화면이 거짓말을 한다. 그쪽 결과를 받아 표시용으로만 바꾼다.
 */
export function buildRuleConsole(
  codeRules: readonly DetectRule[],
  merged: MergedRuleSet,
  rows: readonly { code: string; is_active: boolean; version: string; prompt_fragment: string | null; basis_ref: string | null }[],
): RuleConsole {
  const byCode = new Map(rows.map((row) => [row.code, row]));
  const activeCodes = new Set(merged.rules.map((rule) => rule.code));

  const known: RuleRow[] = codeRules.map((rule) => {
    const row = byCode.get(rule.code);
    const active = activeCodes.has(rule.code);

    return {
      code: rule.code,
      title: rule.title,
      category: rule.category,
      severity: rule.severity_default,
      // 실행되는 값을 보여준다 — DB 가 비어 있으면 코드 값이 돈다(`mergeDetectRules`).
      basisRef: row?.basis_ref?.trim() ? row.basis_ref : rule.basis_ref,
      promptFragment: row?.prompt_fragment?.trim() ? row.prompt_fragment : rule.prompt_fragment,
      version: row?.version ?? rule.version,
      active,
      inDatabase: row !== undefined,
      versionMismatch: row !== undefined && row.version !== rule.version,
      orphaned: false,
    };
  });

  // **DB 에만 있는 코드도 목록에 남긴다.** 빼면 운영자는 그 행이 존재한다는 사실조차
  // 모르고, 그 행은 영원히 실행되지 않는다.
  const orphans: RuleRow[] = merged.drift.unknownInDatabase.map((code) => {
    const row = byCode.get(code);

    return {
      code,
      title: "코드에 없는 룰",
      category: "—",
      severity: "—",
      basisRef: row?.basis_ref ?? "",
      promptFragment: row?.prompt_fragment ?? "",
      version: row?.version ?? "",
      active: false,
      inDatabase: true,
      versionMismatch: false,
      orphaned: true,
    };
  });

  return {
    rows: [...known, ...orphans],
    source: merged.source,
    drift: merged.drift,
    activeCount: merged.rules.length,
    totalCount: codeRules.length,
  };
}

/**
 * 이 조치가 분석을 멈추는가.
 *
 * **마지막 룰을 끄면 분석이 서지 않는다**(S7-01 · `ruleSetUsable`). "위험 없음" 을
 * 내는 것이 아니라 **아예 시작하지 않는다** — 그 둘은 화면에서 구분되지 않기 때문이다.
 * 막지는 않는다(정당한 운영 판단일 수 있다). **누르기 전에 결과를 말한다.**
 */
export function deactivationWarning(activeCount: number, turningOff: boolean): string | null {
  if (!turningOff) return null;
  if (activeCount > 1) return null;

  return "마지막으로 켜져 있는 룰입니다. 끄면 계약서 분석이 '위험 없음'을 내는 것이 아니라 아예 시작되지 않습니다.";
}

// =============================================================================
// 프롬프트
// =============================================================================

/**
 * 코드가 가진 프롬프트 판본.
 *
 * **본문을 여기 복사하지 않는다** — 로더가 각 모듈에서 그대로 읽어 온다. 사본을 두면
 * 판본이 둘이 되고, 그것이 판본 태깅이 막으려던 바로 그 상황이다.
 */
export type PromptFeature = "report" | "planner" | "search";

export const PROMPT_FEATURE_LABEL: Record<PromptFeature, string> = {
  report: "계약서 검토",
  planner: "AI 플래너",
  search: "조건 검색 파서",
};

export type PromptRow = {
  feature: PromptFeature;
  /** 코드가 선언한 판본. `ai_call_logs.prompt_version` 에 그대로 남는다. */
  version: string;
  /** 본문 길이. **본문 자체는 화면이 접어 둔다** — 훑어보는 화면이다. */
  bodyLength: number;
  body: string;
  /**
   * 호출 로그에서 센 사용 이력. **저장된 값이 아니라 계산이다**(D-124).
   * 한 번도 안 불렸으면 `null` — **0으로 적지 않는다**(S8-07 이 겪은 것).
   */
  usage: { calls: number; firstSeen: string; lastSeen: string } | null;
  /** 로그에는 있는데 코드에 없는 판본. 되돌린 흔적이거나 낡은 로그다. */
  orphanedVersions: string[];
};

/** `prompt_versions` 표의 상태. **비어 있다는 사실도 상태다.** */
export type DeploymentLedger =
  | { status: "empty"; reason: string; openIssue: string }
  | { status: "used"; rows: number };

export const DEPLOYMENT_LEDGER_EMPTY: DeploymentLedger = {
  status: "empty",
  reason:
    "배포 이력 표가 비어 있습니다. 프롬프트 본문은 코드가 갖고, '어느 판본이 언제부터 돌았나'는 호출 로그에서 계산합니다 — 계산되는 값을 저장하지 않습니다. 이 표를 쓰려면 배포 파이프라인이 먼저 있어야 합니다.",
  openIssue: "O-22",
};

// =============================================================================
// 배포 전 검증 게이트 (§7.5)
// =============================================================================

/**
 * §7.5 는 AI 회귀(검출 룰 20종 × 샘플 계약서 세트, 골든셋 스냅샷 비교)를
 * **"룰·프롬프트 배포 전 필수 실행"** 이라고 적는다.
 *
 * **그 골든셋이 없다.** S8-07 이 품질 지표·검수 큐·오탐 신고를 세웠지만 회귀 세트는
 * 만들지 않았다(FIX-42). 그래서 이 콘솔은 게이트를 **`blocked` 로 보여준다** —
 * 통과했다고도, 해당 없다고도 적지 않는다. **없는 검사를 통과로 적는 것이 이 화면에서
 * 가장 나쁜 실패**이며, 그러면 다음 사람이 게이트가 도는 줄 알고 룰을 고친다.
 */
export type ReleaseGate =
  | { status: "blocked"; reason: "golden_set_missing"; message: string; fix: string }
  | { status: "passed"; ranAt: string; cases: number };

export const RELEASE_GATE_BLOCKED: ReleaseGate = {
  status: "blocked",
  reason: "golden_set_missing",
  message:
    "명세 §7.5 는 룰·프롬프트를 배포하기 전에 AI 회귀(검출 룰 20종 × 샘플 계약서 골든셋)를 반드시 돌리라고 적지만, 그 골든셋이 아직 없습니다. 지금 배포 전에 볼 수 있는 것은 품질 지표(검증 실패율·인용 폐기율)뿐입니다.",
  fix: "FIX-42",
};

/** 게이트 대신 지금 볼 수 있는 것. **빈 자리로 두지 않는다.** */
export const RELEASE_GATE_FALLBACK = {
  href: "/admin/ai-quality",
  label: "AI 품질·비용에서 실패율·폐기율 보기",
} as const;
