import { describe, expect, it } from "vitest";

import { DETECT_RULES } from "../detect-rules";
import type { DetectRule } from "../types";

import { runGoldenSet } from "./run";

/**
 * **정규식 한 줄마다 그것에 기대는 케이스가 있는가** (FIX-42)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 룰 하나에 패턴이 둘·셋씩 붙어 있다. "룰마다 케이스 둘" 로는 **그 안의 한 줄을 지워도
 * 표가 초록이다** — 남은 패턴이 같은 문장을 대신 잡기 때문이다.
 *
 * 실제로 그랬다. 이 검사를 처음 돌렸을 때 **패턴 26개가 아무 케이스에도 안 걸려 있었다.**
 * 그중에는 룰 전체를 무력화하는 자리도 있었다 — R-04 의 존재 패턴 넷은 **부재 패턴이
 * 대신 걸리는 바람에** 넷 다 지워도 표가 초록이었다(총액 없는 문장으로만 쟀기 때문이다).
 *
 * 그래서 **패턴을 하나씩 못 맞추게 바꿔 보고 골든셋이 빨개지는지** 센다. 안 빨개지면
 * 그 패턴은 **아무도 지키지 않는 줄**이고, 지워져도 아무도 모른다.
 *
 * 룰을 넓히는 사람에게 이 검사가 주는 요구는 하나다 — **패턴을 더하면 그 패턴만 받는
 * 케이스도 함께 더한다.**
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 어떤 계약서 문장에도 맞지 않는 패턴. 이것으로 갈아 끼워 '지운 셈' 친다. */
const NEVER = /절대로나오지않는문구/;

/**
 * **다른 패턴에 완전히 먹혀 케이스를 만들 수 없는 줄.**
 *
 * 목록은 비어 있는 것이 정상이며, 넣으려면 **왜 케이스가 불가능한지**를 적어야 한다.
 * "지금은 시간이 없어서" 는 사유가 아니다 — 그건 케이스를 안 쓴 것이지 못 쓴 것이 아니다.
 */
const SUBSUMED: readonly { key: string; why: string; fix: string }[] = [
  {
    key: "R-16 absence.expected[1]",
    why:
      "앞 줄(expected[0] `(지연|지체|불이행|미이행)…(배상|손해배상|보상|위약금|환급)`)에 " +
      "**완전히 포함된다** — 이 줄이 맞는 문자열은 같은 '지연·지체' 에서 앞 줄도 맞으므로 " +
      "이 줄만 받는 문장이 존재하지 않는다. 지워도 동작이 바뀌지 않는 죽은 줄이다.",
    fix: "FIX-60",
  },
];

type Slot = { key: string; mutate: (rule: DetectRule) => DetectRule };

/** 룰 하나가 가진 정규식 자리를 전부 나열한다. */
function slots(rule: DetectRule): Slot[] {
  const out: Slot[] = [];
  const presence = rule.detect.presence;
  const absence = rule.detect.absence;

  presence?.patterns.forEach((_pattern, index) => {
    out.push({
      key: `${rule.code} presence[${index}]`,
      mutate: (r) => ({
        ...r,
        detect: {
          ...r.detect,
          presence: {
            ...presence,
            patterns: presence.patterns.map((p, j) => (j === index ? NEVER : p)),
          },
        },
      }),
    });
  });

  presence?.excludes?.forEach((_pattern, index) => {
    const excludes = presence.excludes ?? [];
    out.push({
      key: `${rule.code} excludes[${index}]`,
      mutate: (r) => ({
        ...r,
        detect: {
          ...r.detect,
          presence: {
            ...presence,
            excludes: excludes.map((p, j) => (j === index ? NEVER : p)),
          },
        },
      }),
    });
  });

  absence?.expected.forEach((_pattern, index) => {
    out.push({
      key: `${rule.code} absence.expected[${index}]`,
      mutate: (r) => ({
        ...r,
        detect: {
          ...r.detect,
          absence: {
            ...absence,
            expected: absence.expected.map((p, j) => (j === index ? NEVER : p)),
          },
        },
      }),
    });
  });

  return out;
}

const allSlots = DETECT_RULES.flatMap(slots);

const unguarded = allSlots
  .filter((slot) => {
    const mutated = DETECT_RULES.map((rule) =>
      slot.key.startsWith(`${rule.code} `) ? slot.mutate(rule) : rule,
    );

    return runGoldenSet({ rules: mutated }).passed;
  })
  .map((slot) => slot.key);

describe("패턴 단위 커버리지 (FIX-42)", () => {
  it("**자리를 실제로 셌다** — 0개를 세고 통과하지 않는다", () => {
    expect(allSlots.length).toBeGreaterThanOrEqual(45);
  });

  it("**정규식 한 줄을 지우면 골든셋이 빨개진다** — 아무도 지키지 않는 줄이 없다", () => {
    const allowed = new Set(SUBSUMED.map((row) => row.key));

    expect(unguarded.filter((key) => !allowed.has(key))).toEqual([]);
  });

  it("예외 목록은 **사유와 FIX 번호를 달고 있고, 실제로 예외여야 한다**", () => {
    for (const row of SUBSUMED) {
      expect(row.why.length).toBeGreaterThan(30);
      expect(row.fix).toMatch(/^FIX-\d+$/);
      // 목록에 적어 놓고 실제로는 케이스가 생긴 줄은 **지워야 한다** —
      // 남겨 두면 다음 사람이 그 줄을 지켜지지 않는 것으로 오해한다.
      expect(unguarded).toContain(row.key);
    }
  });
});
