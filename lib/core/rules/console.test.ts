import { describe, expect, it } from "vitest";

import {
  CODE_OWNED_FIELDS,
  DEPLOYMENT_LEDGER_EMPTY,
  EDITABLE_RULE_FIELDS,
  RELEASE_GATE_BLOCKED,
  RELEASE_GATE_FALLBACK,
  buildRuleConsole,
  deactivationWarning,
} from "./console";
import { mergeDetectRules } from "./rule-source";
import type { DetectRule } from "./types";

const rule = (over: Partial<DetectRule> = {}): DetectRule => ({
  code: "R-01",
  title: "계약금 반환 불가",
  category: "penalty",
  severity_default: "high",
  basis_ref: "소비자분쟁해결기준",
  prompt_fragment: "코드 지시문",
  detect: {},
  version: "v1",
  is_active: true,
  ...over,
});

const row = (over: Partial<{
  code: string;
  is_active: boolean;
  version: string;
  prompt_fragment: string | null;
  basis_ref: string | null;
}> = {}) => ({
  code: "R-01",
  is_active: true,
  version: "v1",
  prompt_fragment: null,
  basis_ref: null,
  ...over,
});

function consoleOf(codeRules: DetectRule[], rows: ReturnType<typeof row>[]) {
  return buildRuleConsole(codeRules, mergeDetectRules(codeRules, rows), rows);
}

// ══════════════════════════════════════════════════════════════════════════
// 실행되는 값을 보여준다
// ══════════════════════════════════════════════════════════════════════════

describe("buildRuleConsole", () => {
  it("DB 가 비어 있으면 코드 값이 실행되고 화면도 그 값을 보인다", () => {
    const view = consoleOf([rule()], [row()]);

    expect(view.rows[0].promptFragment).toBe("코드 지시문");
    expect(view.rows[0].basisRef).toBe("소비자분쟁해결기준");
  });

  it("DB 가 채워져 있으면 그 값이 실행되고 화면도 그 값을 보인다", () => {
    const view = consoleOf([rule()], [row({ prompt_fragment: "운영자 지시문", basis_ref: "표준약관" })]);

    expect(view.rows[0].promptFragment).toBe("운영자 지시문");
    expect(view.rows[0].basisRef).toBe("표준약관");
  });

  it("**빈 문자열은 '지웠다' 가 아니라 사고로 본다** — 코드 값이 남는다", () => {
    const view = consoleOf([rule()], [row({ prompt_fragment: "   ", basis_ref: "" })]);

    expect(view.rows[0].promptFragment).toBe("코드 지시문");
  });

  it("**코드와 DB 중 하나라도 꺼져 있으면 안 돈다**", () => {
    expect(consoleOf([rule()], [row({ is_active: false })]).rows[0].active).toBe(false);
    expect(consoleOf([rule({ is_active: false })], [row()]).rows[0].active).toBe(false);
    expect(consoleOf([rule()], [row()]).rows[0].active).toBe(true);
  });

  it("DB 에 행이 없으면 그 사실을 표시하고 코드 값으로 돈다", () => {
    const view = consoleOf([rule(), rule({ code: "R-02" })], [row()]);
    const missing = view.rows.find((r) => r.code === "R-02");

    expect(missing?.inDatabase).toBe(false);
    expect(missing?.active).toBe(true);
    expect(view.drift.missingInDatabase).toContain("R-02");
  });

  it("판본이 어긋나면 표시한다 — 룰 내용이 달라졌을 수 있다", () => {
    const view = consoleOf([rule()], [row({ version: "v2" })]);

    expect(view.rows[0].versionMismatch).toBe(true);
    expect(view.drift.versionMismatch).toContain("R-01");
  });

  it("**DB 에만 있는 코드도 목록에 남긴다** — 빼면 그 행이 있다는 사실조차 모른다", () => {
    const view = consoleOf([rule()], [row(), row({ code: "R-99" })]);
    const orphan = view.rows.find((r) => r.code === "R-99");

    expect(orphan?.orphaned).toBe(true);
    // 정규식이 없으므로 실행되지 않는다.
    expect(orphan?.active).toBe(false);
  });

  it("활성 수가 스캔이 실제로 도는 룰 수와 같다", () => {
    const view = consoleOf(
      [rule(), rule({ code: "R-02" }), rule({ code: "R-03" })],
      [row(), row({ code: "R-02", is_active: false }), row({ code: "R-03" })],
    );

    expect(view.activeCount).toBe(2);
    expect(view.totalCount).toBe(3);
  });

  it("DB 행이 하나도 없으면 코드 경로로 돈다 (시드 전)", () => {
    const view = consoleOf([rule()], []);

    expect(view.source).toBe("code");
    expect(view.activeCount).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 마지막 룰을 끄면 분석이 선다
// ══════════════════════════════════════════════════════════════════════════

describe("deactivationWarning", () => {
  it("**마지막 룰을 끌 때 결과를 미리 말한다**", () => {
    const warning = deactivationWarning(1, true);

    expect(warning).not.toBeNull();
    expect(warning).toContain("아예 시작되지 않습니다");
  });

  it("남는 룰이 있으면 경고하지 않는다", () => {
    expect(deactivationWarning(2, true)).toBeNull();
  });

  it("켜는 조치에는 경고하지 않는다", () => {
    expect(deactivationWarning(1, false)).toBeNull();
  });

  it("이미 0건이어도 경고한다 — 여전히 서지 않는 상태다", () => {
    expect(deactivationWarning(0, true)).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 경계 — 무엇을 고칠 수 있고 무엇을 못 고치는가
// ══════════════════════════════════════════════════════════════════════════

describe("편집 경계", () => {
  it("고칠 수 있는 칸은 DB 가 가진 운영자 자산 셋뿐이다", () => {
    expect([...EDITABLE_RULE_FIELDS]).toEqual(["is_active", "prompt_fragment", "basis_ref"]);
  });

  it("**정규식은 목록에 없다** — 오타가 스캔을 멈춘다", () => {
    expect(EDITABLE_RULE_FIELDS).not.toContain("pattern_json");
    expect(CODE_OWNED_FIELDS.map((f) => f.field)).toContain("pattern_json");
  });

  it("못 고치는 칸마다 **왜 못 고치는지**가 붙어 있다", () => {
    for (const field of CODE_OWNED_FIELDS) expect(field.reason.length).toBeGreaterThan(10);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 없는 것을 있는 것처럼 적지 않는다
// ══════════════════════════════════════════════════════════════════════════

describe("배포 게이트·이력", () => {
  it("**골든셋이 없으므로 게이트는 blocked 다** — 통과로도 해당 없음으로도 적지 않는다", () => {
    expect(RELEASE_GATE_BLOCKED.status).toBe("blocked");
    // 판별 유니온을 좁히지 않으면 tsc 가 막는다 — FIX-19 가 남긴 규칙이다.
    expect(RELEASE_GATE_BLOCKED.status === "blocked" && RELEASE_GATE_BLOCKED.reason).toBe(
      "golden_set_missing",
    );
    expect(RELEASE_GATE_BLOCKED.status === "blocked" && RELEASE_GATE_BLOCKED.fix).toMatch(
      /^FIX-\d+$/,
    );
  });

  it("게이트 자리를 비워 두지 않는다 — 지금 볼 수 있는 것을 가리킨다", () => {
    expect(RELEASE_GATE_FALLBACK.href).toBe("/admin/ai-quality");
  });

  it("**배포 이력 표가 비어 있다는 사실도 상태다** — 0건으로 접지 않는다", () => {
    expect(DEPLOYMENT_LEDGER_EMPTY.status).toBe("empty");
    expect(DEPLOYMENT_LEDGER_EMPTY.status === "empty" && DEPLOYMENT_LEDGER_EMPTY.openIssue).toMatch(
      /^O-\d+$/,
    );
    expect(
      DEPLOYMENT_LEDGER_EMPTY.status === "empty" && DEPLOYMENT_LEDGER_EMPTY.reason,
    ).toContain("계산");
  });
});
