import { describe, expect, it } from "vitest";

import {
  SHARE_RESOURCE_SPECS,
  SHARE_STATES,
  SHARE_STATE_LABEL,
  SHARE_STATE_NOTE,
  SHARE_TOKEN_BYTES,
  remainingHours,
  shareExpiresAt,
  shareGaps,
  shareLinkState,
  shareResourceSpec,
  shareUrl,
  shareableTypes,
} from "./share";

const always = () => true;
const never = () => false;

describe("공유할 수 있는 자원 — 로더가 있는 것만 연다", () => {
  it("가용 유형만 내보낸다", () => {
    // S7-05 가 `estimate_comparison` 을 열었다 — 비교표 행이 생기면서 로더가 붙었다.
    expect(shareableTypes(always)).toEqual(["report", "estimate_comparison"]);
  });

  it("**로더가 없으면 상태가 가용이어도 열지 않는다** — 링크는 나가는데 여는 쪽이 실패한다", () => {
    expect(shareableTypes(never)).toEqual([]);
  });

  it("**대기 유형에는 담당 태스크가 적혀 있다** — 언제 열리는지 모르는 대기는 방치다", () => {
    // 지금은 대기가 없다. 규칙은 남긴다 — 유형이 늘면 다시 걸린다.
    for (const spec of SHARE_RESOURCE_SPECS.filter((item) => item.status === "pending")) {
      expect(spec.filledBy).toMatch(/^S\d-\d\d$/);
    }
  });

  it("가용 유형에는 근거 표가 적혀 있다", () => {
    for (const spec of SHARE_RESOURCE_SPECS.filter((item) => item.status === "available")) {
      expect(spec.backing).not.toBe("");
      expect(spec.filledBy).toBeNull();
    }
  });

  it("**비교표가 열렸다** — S7-05 가 스냅샷 행을 만들면서 상태 한 글자와 로더 하나로 열었다", () => {
    const spec = shareResourceSpec("estimate_comparison");

    expect(spec?.status).toBe("available");
    expect(spec?.filledBy).toBeNull();
    expect(spec?.backing).toContain("estimate_comparisons");
  });

  it("안 열린 유형과 그 이유를 낸다", () => {
    // 상태는 둘 다 available 이므로 **로더가 없을 때만** 빈자리가 생긴다.
    expect(shareGaps(always)).toEqual([]);
    expect(shareGaps(never).map((gap) => gap.reason)).toEqual(["loader", "loader"]);
  });

  it("모르는 유형은 null 이다", () => {
    expect(shareResourceSpec("cart")).toBeNull();
  });
});

describe("만료 — 설정이 없으면 발급하지 않는다", () => {
  const issued = "2026-08-21T00:00:00.000Z";

  it("시간을 더해 만료 시각을 만든다", () => {
    expect(shareExpiresAt(issued, 24)).toBe("2026-08-22T00:00:00.000Z");
  });

  it("**설정이 없으면 null 이다** — 호출부가 링크를 만들지 않는다", () => {
    expect(shareExpiresAt(issued, null)).toBeNull();
  });

  it("**0이나 음수도 null 이다** — 기한 없는 링크는 영구 공개와 같다", () => {
    expect(shareExpiresAt(issued, 0)).toBeNull();
    expect(shareExpiresAt(issued, -1)).toBeNull();
  });

  it("소수 시간은 잘라 쓴다", () => {
    expect(shareExpiresAt(issued, 1.9)).toBe("2026-08-21T01:00:00.000Z");
  });

  it("해석할 수 없는 발급 시각은 던진다", () => {
    expect(() => shareExpiresAt("어제", 24)).toThrow(RangeError);
  });

  it("토큰은 추측에 견디는 길이다", () => {
    expect(SHARE_TOKEN_BYTES).toBeGreaterThanOrEqual(32);
  });
});

describe("상태 — 없음·만료·거둠을 가른다", () => {
  const now = "2026-08-21T12:00:00.000Z";

  it("살아 있으면 live", () => {
    expect(
      shareLinkState({ found: true, expiresAt: "2026-08-22T00:00:00.000Z", revokedAt: null, now }),
    ).toBe("live");
  });

  it("기한이 지나면 expired", () => {
    expect(
      shareLinkState({ found: true, expiresAt: "2026-08-21T11:59:59.000Z", revokedAt: null, now }),
    ).toBe("expired");
  });

  it("**경계는 지난 것으로 본다** — 같은 시각이면 닫힌다", () => {
    expect(shareLinkState({ found: true, expiresAt: now, revokedAt: null, now })).toBe("expired");
  });

  it("거두면 revoked", () => {
    expect(
      shareLinkState({
        found: true,
        expiresAt: "2026-08-30T00:00:00.000Z",
        revokedAt: "2026-08-21T01:00:00.000Z",
        now,
      }),
    ).toBe("revoked");
  });

  it("**거둠이 만료보다 먼저다** — 사람이 한 일을 말하는 편이 정확하다", () => {
    expect(
      shareLinkState({
        found: true,
        expiresAt: "2026-08-01T00:00:00.000Z",
        revokedAt: "2026-08-02T00:00:00.000Z",
        now,
      }),
    ).toBe("revoked");
  });

  it("**없는 토큰은 만료와 다르다** — 뭉뚱그리면 주소를 잘못 옮겼다고 생각한다", () => {
    expect(shareLinkState({ found: false, expiresAt: null, revokedAt: null, now })).toBe("missing");
  });

  it("만료 시각이 없는 행은 열지 않는다", () => {
    expect(shareLinkState({ found: true, expiresAt: null, revokedAt: null, now })).toBe("expired");
  });

  it("**네 상태 모두 라벨을 갖고, 닫힌 셋은 다음에 할 일을 적는다**", () => {
    for (const state of SHARE_STATES) {
      expect(SHARE_STATE_LABEL[state]).not.toBe("");
      if (state !== "live") expect(SHARE_STATE_NOTE[state]).not.toBe("");
    }
  });
});

describe("남은 시간", () => {
  const now = "2026-08-21T12:00:00.000Z";

  it("올림해서 준다 — '0시간 남음' 이 뜨지 않게", () => {
    expect(remainingHours("2026-08-21T12:30:00.000Z", now)).toBe(1);
    expect(remainingHours("2026-08-22T12:00:00.000Z", now)).toBe(24);
  });

  it("**지난 링크는 0이고 음수가 되지 않는다**", () => {
    expect(remainingHours("2026-08-20T12:00:00.000Z", now)).toBe(0);
  });

  it("만료 시각이 없으면 null 이다", () => {
    expect(remainingHours(null, now)).toBeNull();
  });
});

describe("링크 주소", () => {
  it("`/share/<token>` 이다", () => {
    expect(shareUrl("https://weddingclear.kr", "abc")).toBe("https://weddingclear.kr/share/abc");
  });

  it("끝 슬래시를 두 번 붙이지 않는다", () => {
    expect(shareUrl("http://localhost:3000/", "abc")).toBe("http://localhost:3000/share/abc");
  });
});
