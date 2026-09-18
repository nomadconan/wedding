import { describe, expect, it } from "vitest";

import type { Json } from "../../types/database";

import type { JsonObject, JsonValue } from "./json";

/**
 * `lib/core` 는 생성물에 기대지 않는다(CLAUDE.md §3.1). 그래서 `JsonValue` 를 따로
 * 적었고, **그 둘이 같은 모양인지는 여기서 지킨다** — `schemas.test.ts` 가
 * `finding_severity` enum 을 지키는 방식과 같다.
 *
 * 값이 아니라 **모양**을 보는 검사라 판정은 `tsc` 가 한다(`npm run typecheck`).
 * 아래 두 줄은 한쪽이라도 넓어지거나 좁아지면 컴파일이 안 된다.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// 한쪽이라도 어긋나면 `false` 가 되어 `true` 에 대입되지 않는다.
const SHAPES_AGREE: MutuallyAssignable<JsonValue, Json> = true;

describe("lib/core 의 JsonValue 와 생성된 Json", () => {
  it("모양이 같다 — 갈리면 위의 대입이 컴파일되지 않는다", () => {
    expect(SHAPES_AGREE).toBe(true);
  });

  /**
   * **모양 검사만으로는 헛돌 수 있다**(§7.0b) — `MutuallyAssignable` 이 늘 `true` 를
   * 내면 위의 줄은 아무것도 지키지 않는다. 그래서 **틀린 짝도 함께 넣어 본다**:
   * 이것이 `false` 여야 위의 `true` 가 뜻을 갖는다.
   */
  it("검사가 헛돌지 않는다 — 다른 모양은 false 다", () => {
    const wrong: MutuallyAssignable<JsonValue, string> = false;
    const alsoWrong: MutuallyAssignable<JsonObject, Json> = false;

    expect(wrong).toBe(false);
    expect(alsoWrong).toBe(false);
  });
});
