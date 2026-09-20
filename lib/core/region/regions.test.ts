import { describe, expect, it } from "vitest";

import {
  REGIONS,
  REGION_ALIASES,
  REGION_CODES,
  SIDO_CODES,
  SIDO_LABEL,
  isRegionCode,
  isSidoCode,
  isWithinRegion,
  regionLabel,
  regionSido,
  resolveRegionInput,
  toRegionCode,
} from "./regions";

describe("어휘", () => {
  it("시도 17개가 전부 있다 — 표현 불가한 지역이 없다", () => {
    expect(SIDO_CODES).toHaveLength(17);
    for (const sido of SIDO_CODES) {
      expect(isRegionCode(sido)).toBe(true);
      expect(SIDO_LABEL[sido]).toBeTruthy();
    }
  });

  it("시도 17 + 시군구 56 = 73", () => {
    expect(REGION_CODES).toHaveLength(73);
    expect(REGIONS.filter((r) => r.code === r.sido)).toHaveLength(17);
    expect(REGIONS.filter((r) => r.code !== r.sido)).toHaveLength(56);
  });

  it("코드가 겹치지 않는다", () => {
    expect(new Set(REGION_CODES).size).toBe(REGION_CODES.length);
  });

  it("코드가 전부 ASCII 슬러그다 — URL 조각이라 한글을 쓰지 않는다", () => {
    for (const code of REGION_CODES) {
      expect(code).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    }
  });

  it("라벨이 전부 한글이다 — 화면은 한글을 보여 준다", () => {
    for (const region of REGIONS) {
      expect(region.label).toMatch(/[가-힣]/);
    }
  });

  it("경기 광주와 광주광역시가 다른 코드다 — 슬러그가 갈라 준다", () => {
    expect(isRegionCode("gwangju")).toBe(true);
    expect(isRegionCode("gyeonggi-gwangju")).toBe(true);
    expect(regionLabel("gwangju")).toBe("광주");
    expect(regionLabel("gyeonggi-gwangju")).toBe("경기 광주");
    expect(regionSido("gyeonggi-gwangju")).toBe("gyeonggi");
  });

  it("서울 25구 · 경기 31시군이 깊이를 갖는다", () => {
    expect(REGIONS.filter((r) => r.sido === "seoul" && r.code !== "seoul")).toHaveLength(25);
    expect(REGIONS.filter((r) => r.sido === "gyeonggi" && r.code !== "gyeonggi")).toHaveLength(31);
  });

  it("깊이를 안 넣은 시도도 유효하다 — 어느 지역도 막히지 않는다", () => {
    for (const sido of ["gangwon", "jeju", "chungbuk", "gyeongnam"]) {
      expect(isRegionCode(sido)).toBe(true);
      expect(REGIONS.filter((r) => r.sido === sido && r.code !== sido)).toHaveLength(0);
    }
  });
});

describe("표시", () => {
  it("코드를 한글로 바꾼다", () => {
    expect(regionLabel("seoul-gangnam")).toBe("서울 강남");
    expect(regionLabel("jeju")).toBe("제주");
  });

  it("모르는 코드는 지어내지 않고 그대로 돌려준다", () => {
    expect(regionLabel("nope")).toBe("nope");
    expect(regionLabel(null)).toBeNull();
  });
});

describe("이행 — 자유 문자열을 코드로", () => {
  it("이미 코드면 그대로다", () => {
    expect(toRegionCode("seoul-gangnam")).toBe("seoul-gangnam");
  });

  it("라벨과 정확히 맞으면 옮긴다", () => {
    expect(toRegionCode("서울 강남")).toBe("seoul-gangnam");
    expect(toRegionCode("  서울 강남  ")).toBe("seoul-gangnam");
  });

  it("공백 차이를 무시한다", () => {
    expect(toRegionCode("서울강남")).toBe("seoul-gangnam");
  });

  it("시군구 접미사 한 글자를 떼고 맞춘다", () => {
    expect(toRegionCode("서울 강남구")).toBe("seoul-gangnam");
    expect(toRegionCode("경기 수원시")).toBe("gyeonggi-suwon");
    expect(toRegionCode("경기 가평군")).toBe("gyeonggi-gapyeong");
  });

  it("시도만 적혀 있어도 옮긴다", () => {
    expect(toRegionCode("서울")).toBe("seoul");
    expect(toRegionCode("제주")).toBe("jeju");
  });

  it("**추측하지 않는다** — 주소가 섞인 값은 사람이 본다", () => {
    expect(toRegionCode("서울 강남구 테헤란로 123")).toBeNull();
    expect(toRegionCode("강남")).toBeNull(); // 시도가 없으면 어느 강남인지 모른다
    expect(toRegionCode("서울시 강남구")).toBeNull(); // '서울시' 는 라벨이 아니다
  });

  it("빈 값·null 은 null 이다 — 0 이나 기본값을 만들지 않는다", () => {
    expect(toRegionCode(null)).toBeNull();
    expect(toRegionCode("")).toBeNull();
    expect(toRegionCode("   ")).toBeNull();
  });

  it("어휘 밖 문자열은 null 이다 — 오타가 새 지역을 만들지 않는다", () => {
    expect(toRegionCode("서울 강남区")).toBeNull();
    expect(toRegionCode("Seoul Gangnam")).toBeNull();
  });
});
describe("시도 — 고르면 그 안이 함께 나온다", () => {
  it("시도 코드만 시도다", () => {
    expect(isSidoCode("seoul")).toBe(true);
    expect(isSidoCode("jeju")).toBe(true);
    expect(isSidoCode("seoul-gangnam")).toBe(false);
    expect(isSidoCode("nope")).toBe(false);
  });

  it("시도를 고르면 그 안의 시군구가 포함된다", () => {
    expect(isWithinRegion("seoul-gangnam", "seoul")).toBe(true);
    expect(isWithinRegion("seoul", "seoul")).toBe(true);
  });

  it("**시군구를 고르면 그것만이다** — 넓어지지 않는다", () => {
    expect(isWithinRegion("seoul-gangnam", "seoul-gangnam")).toBe(true);
    expect(isWithinRegion("seoul", "seoul-gangnam")).toBe(false);
    expect(isWithinRegion("seoul-seocho", "seoul-gangnam")).toBe(false);
  });

  it("다른 시도는 안 걸린다 — 접두어가 우연히 겹치지 않는다", () => {
    expect(isWithinRegion("gyeonggi-gwangju", "gwangju")).toBe(false);
    expect(isWithinRegion("seoul-gangnam", "gyeonggi")).toBe(false);
  });
});

describe("별칭 — 사람이 쓰는 말", () => {
  it("**모든 별칭이 어휘 안의 코드를 가리킨다**", () => {
    // 이 시험이 없으면 오타 난 별칭이 조용히 아무 데도 안 걸리는 조건이 된다.
    for (const [alias, code] of Object.entries(REGION_ALIASES)) {
      expect(isRegionCode(code), `${alias} → ${code}`).toBe(true);
    }
  });

  it("시도 없이 구 이름만 말해도 알아듣는다", () => {
    expect(resolveRegionInput("강남")).toBe("seoul-gangnam");
    expect(resolveRegionInput("강남구")).toBe("seoul-gangnam");
  });

  it("생활권 이름은 담는 시군구로 간다", () => {
    expect(resolveRegionInput("판교")).toBe("gyeonggi-seongnam");
    expect(resolveRegionInput("여의도")).toBe("seoul-yeongdeungpo");
    expect(resolveRegionInput("잠실")).toBe("seoul-songpa");
  });

  it("옛 자유 문자열도 받는다 — 공유된 링크가 깨지지 않게", () => {
    expect(resolveRegionInput("서울 강남")).toBe("seoul-gangnam");
    expect(resolveRegionInput("경기 수원시")).toBe("gyeonggi-suwon");
    expect(resolveRegionInput("seoul-gangnam")).toBe("seoul-gangnam");
  });

  it("못 알아들으면 null 이다 — **지어내지 않는다**", () => {
    expect(resolveRegionInput("여기 어딘가")).toBeNull();
    expect(resolveRegionInput("Gangnam")).toBeNull();
    expect(resolveRegionInput("")).toBeNull();
    expect(resolveRegionInput(null)).toBeNull();
  });

  it("**이행보다 너그럽다** — 둘의 쓰임이 다르다", () => {
    // 이행은 틀리면 되돌릴 수 없어 엄격하고, 검색·링크는 못 알아들으면 안 걸면 그만이다.
    expect(toRegionCode("강남")).toBeNull();
    expect(resolveRegionInput("강남")).toBe("seoul-gangnam");
  });
});
