import { describe, expect, it } from "vitest";

import { maskText } from "./index";
import { SHOULD_MASK, SHOULD_NOT_MASK, type NameCase } from "./name-cases";

/**
 * 이름 마스킹의 **두 방향을 각각 잰다** (FIX-31)
 *
 * 한쪽만 세면 반드시 다른 쪽이 나빠진다 — 전부 마스킹하면 미탐 0 이지만 문장이
 * 남아나지 않고, 아무것도 안 하면 오탐 0 이지만 개인정보가 그대로 나간다.
 * 그래서 **두 표를 함께** 두고 둘 다 0 이어야 통과한다.
 */

type Outcome = { leaks: NameCase[]; damages: NameCase[] };

function measure(): Outcome {
  const leaks: NameCase[] = [];
  const damages: NameCase[] = [];

  for (const c of SHOULD_MASK) {
    const masked = maskText(c.text, { kinds: ["name"] }).masked;
    // **원문에 이름이 남아 있으면 새어 나간 것**이다. 토큰 수를 세지 않는 이유는
    // 다른 이름이 대신 잡혀도 수는 맞을 수 있기 때문이다.
    if (c.names.some((name) => masked.includes(name))) leaks.push(c);
  }

  for (const c of SHOULD_NOT_MASK) {
    // **이름 종류만 켜고 잰다.** 주소·전화가 섞이면 이 표가 무엇을 재는지 흐려진다.
    if (maskText(c.text, { kinds: ["name"] }).counts.name > 0) damages.push(c);
  }

  return { leaks, damages };
}

describe("이름 마스킹 정밀도 (FIX-31)", () => {
  const { leaks, damages } = measure();

  it("**케이스를 실제로 읽었다** — 빈 표는 무엇이든 통과시킨다", () => {
    expect(SHOULD_MASK.length).toBeGreaterThanOrEqual(35);
    expect(SHOULD_NOT_MASK.length).toBeGreaterThanOrEqual(25);
    // 성씨를 넓게 깔았는지 — 흔한 성 셋만으로 통과하는 표가 아니어야 한다.
    const surnames = new Set(SHOULD_MASK.flatMap((c) => c.names).map((n) => n.slice(0, 1)));
    expect(surnames.size).toBeGreaterThanOrEqual(25);
  });

  it("**미탐 0** — 진짜 이름을 놓치면 개인정보가 AI 로 나간다", () => {
    expect(leaks.map((c) => `${c.text} (${c.note})`)).toEqual([]);
  });

  it("**오탐 0** — 이름이 아닌 것을 지우면 조항이 '없다' 로 뒤집힌다", () => {
    expect(damages.map((c) => `${c.text} (${c.note})`)).toEqual([]);
  });

  it("**FIX-31 이 실제로 깨뜨린 문장이 그대로 남는다**", () => {
    const text = "담당 작가 교체가 필요한 경우 계약 해지 없이 변경할 수 있다.";

    expect(maskText(text).masked).toBe(text);
  });

  it("같은 문장에서 이름은 잡고 일반 명사는 남긴다", () => {
    const result = maskText("담당 작가 조은수 님의 교체가 필요한 경우", { kinds: ["name"] });

    expect(result.counts.name).toBe(1);
    expect(result.masked).toContain("교체가");
    expect(result.masked).not.toContain("조은수");
  });
});
