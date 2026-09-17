import { describe, expect, it } from "vitest";

import { DETECT_RULES } from "@/lib/core/rules/detect-rules";
import { GOLDEN_UNMEASURED, runGoldenSet } from "@/lib/core/rules/golden";
import { toReleaseGate } from "@/lib/core/rules/console";

import { html, text } from "../test-render";
import { ReleaseGateCard } from "./ReleaseGateCard";

/**
 * 배포 게이트가 **화면에서 실제로 무엇을 말하는가** (FIX-42 · S8-06 · §7.5)
 *
 * S8-06 은 이 자리를 `blocked` 로 세웠고, FIX-42 는 그것이 풀리는 조건을 "골든셋이
 * 생기면" 이라고 적었다. **그 확인을 브라우저에만 맡기지 않는다** — 로그인·DB 가
 * 있어야만 볼 수 있는 확인은 결국 아무도 하지 않는다(T-00h 가 §7.5 '완료' 의 뜻을
 * 다시 적으며 지적한 것).
 *
 * 그래서 여기서 **같은 함수 → 같은 컴포넌트**로 문자열을 만들어 검사한다.
 */

const passed = toReleaseGate(runGoldenSet());

describe("배포 게이트 카드 (FIX-42 해소 확인)", () => {
  it("**blocked 가 아니다** — 골든셋이 실제로 돌아 통과를 말한다", () => {
    expect(passed.status).toBe("passed");

    const rendered = text(<ReleaseGateCard gate={passed} unmeasured={GOLDEN_UNMEASURED} />);

    expect(rendered).toContain("통과했습니다");
    expect(rendered).not.toContain("검사가 서지 않았습니다");
    expect(rendered).toContain(`검출 룰 ${DETECT_RULES.filter((r) => r.is_active).length}종`);
    // 지표 타일이 **측정됨**으로 그려진다 — '모수 없음' 이 아니다.
    expect(html(<ReleaseGateCard gate={passed} unmeasured={GOLDEN_UNMEASURED} />)).toContain(
      'data-status="measured"',
    );
  });

  it("**재지 않는 것을 통과 옆에 적는다** — 초록불이 실제보다 넓게 읽히지 않게", () => {
    const rendered = text(<ReleaseGateCard gate={passed} unmeasured={GOLDEN_UNMEASURED} />);

    expect(rendered).toContain("재지 않는 것");
    for (const row of GOLDEN_UNMEASURED) expect(rendered).toContain(row.what);
    expect(rendered).toContain("AI 품질·비용");
  });

  it("**깨졌을 때 무엇이 깨졌는지 적는다** — 건수만으로는 못 고친다", () => {
    const broken = toReleaseGate(
      runGoldenSet({
        rules: DETECT_RULES.map((rule) =>
          rule.code === "R-01" ? { ...rule, detect: { presence: { patterns: [/없는 문장/] } } } : rule,
        ),
      }),
    );

    expect(broken.status).toBe("failed");

    const rendered = text(<ReleaseGateCard gate={broken} unmeasured={GOLDEN_UNMEASURED} />);

    expect(rendered).toContain("배포하지 마세요");
    expect(rendered).toContain("R-01");
    expect(rendered).toContain("npm run ai:golden");
  });

  it("**검사가 서지 않으면 통과로 적지 않는다** — FIX-42 가 기록된 이유", () => {
    const blocked = toReleaseGate(runGoldenSet({ cases: [], modelCases: [] }));

    expect(blocked.status).toBe("blocked");

    const rendered = text(<ReleaseGateCard gate={blocked} unmeasured={GOLDEN_UNMEASURED} />);

    expect(rendered).toContain("검사가 서지 않았습니다");
    expect(rendered).toContain("통과");
    expect(rendered).toContain("해당 없음");
    expect(rendered).not.toContain("통과했습니다");
    // 실패 0건으로 적지 않는다 — 세지 못한 것이다.
    expect(html(<ReleaseGateCard gate={blocked} unmeasured={GOLDEN_UNMEASURED} />)).toContain(
      'data-status="no_basis"',
    );
  });

  it("**꺼진 룰이 있으면 통과 옆에 적는다** — 그 통과는 그 룰을 확인한 결과가 아니다", () => {
    const partial = toReleaseGate(
      runGoldenSet({
        rules: DETECT_RULES.map((rule) =>
          rule.code === "R-13" ? { ...rule, is_active: false } : rule,
        ),
      }),
    );

    expect(partial.status).toBe("passed");
    expect(partial.status === "passed" && partial.unmeasuredRules).toEqual(["R-13"]);

    const rendered = text(<ReleaseGateCard gate={partial} unmeasured={GOLDEN_UNMEASURED} />);

    expect(rendered).toContain("재지 못한 룰이 1종");
    expect(rendered).toContain("R-13");
  });
});
