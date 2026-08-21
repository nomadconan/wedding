import { describe, expect, it } from "vitest";

import {
  CONTENT_TYPES,
  CONTENT_TYPE_LABEL,
  EMPTY_TYPE_NOTICE,
  SLUG_MAX_LENGTH,
  TOOL_CTAS,
  articleJsonLd,
  isValidSlug,
  jsonLdScript,
  parseSeo,
  priceLinkOf,
  resolveCtas,
} from "./content";

/**
 * 콘텐츠 허브 규칙 (S7-10)
 *
 * **이 파일이 붙잡는 것은 "없는 것을 있다고 말하지 않는가" 하나다.**
 */

describe("유형", () => {
  it("DB enum 과 같은 셋이다", () => {
    expect(CONTENT_TYPES).toEqual(["guide", "price_report", "glossary"]);
  });

  it("모든 유형이 이름과 빈 상태 문구를 갖는다", () => {
    for (const type of CONTENT_TYPES) {
      expect(CONTENT_TYPE_LABEL[type].length).toBeGreaterThan(0);
      expect(EMPTY_TYPE_NOTICE[type].length).toBeGreaterThan(0);
    }
  });

  it("**가격 리포트의 빈 상태는 이유를 말한다** — 빈 지수를 콘텐츠로 세우지 않는다", () => {
    // "아직 없어요" 만 적으면 사용자는 우리가 게으른 줄 안다. 표본이 없다는 사실과
    // 지금 대신 볼 수 있는 곳을 함께 적는다.
    expect(EMPTY_TYPE_NOTICE.price_report).toContain("표본");
    expect(EMPTY_TYPE_NOTICE.price_report).toContain("가격 화면");
  });
});

describe("슬러그", () => {
  it("소문자 영숫자와 하이픈만 받는다", () => {
    expect(isValidSlug("hall-contract-guide")).toBe(true);
    expect(isValidSlug("guide2026")).toBe(true);
  });

  it("**한글 슬러그를 받지 않는다** — URL 이 공유될 때 깨져 보인다", () => {
    expect(isValidSlug("웨딩홀-가이드")).toBe(false);
  });

  it("경로 조작에 쓰일 모양을 막는다", () => {
    expect(isValidSlug("../etc/passwd")).toBe(false);
    expect(isValidSlug("a/b")).toBe(false);
    expect(isValidSlug("-앞뒤-")).toBe(false);
    expect(isValidSlug("두--하이픈")).toBe(false);
    expect(isValidSlug("")).toBe(false);
  });

  it("길이 상한이 있다", () => {
    expect(isValidSlug("a".repeat(SLUG_MAX_LENGTH))).toBe(true);
    expect(isValidSlug("a".repeat(SLUG_MAX_LENGTH + 1))).toBe(false);
  });
});

describe("도구 CTA — 실재하는 경로만", () => {
  it("전부 내부 경로다", () => {
    expect(TOOL_CTAS.every((cta) => cta.href.startsWith("/") && !cta.href.startsWith("//"))).toBe(
      true,
    );
  });

  it("키가 겹치지 않는다", () => {
    const keys = TOOL_CTAS.map((cta) => cta.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("**로그인이 필요한지 값으로 갖는다** — 검색으로 들어온 사람이 튕기면 막다른 길이다", () => {
    expect(TOOL_CTAS.some((cta) => cta.requiresLogin)).toBe(true);
    expect(TOOL_CTAS.some((cta) => !cta.requiresLogin)).toBe(true);
  });

  it("**목록에 없는 화면을 넣지 않았다** — `/prices` 는 목록 라우트가 없다", () => {
    expect(TOOL_CTAS.some((cta) => cta.href === "/prices")).toBe(false);
  });

  it("아는 키만 CTA 가 된다", () => {
    const { ctas, unknown } = resolveCtas(["penalty", "explore"]);

    expect(ctas.map((cta) => cta.href)).toEqual(["/tools/penalty", "/explore"]);
    expect(unknown).toEqual([]);
  });

  it("**모르는 키는 던지지 않고 떨어진다** — 글 하나의 오타가 페이지를 죽이면 안 된다", () => {
    const { ctas, unknown } = resolveCtas(["penalty", "없는도구"]);

    expect(ctas).toHaveLength(1);
    // 조용히 사라지지는 않는다 — 운영이 알 수 있게 함께 돌려준다.
    expect(unknown).toEqual(["없는도구"]);
  });

  it("같은 키를 두 번 적어도 한 번만 그린다", () => {
    expect(resolveCtas(["explore", "explore"]).ctas).toHaveLength(1);
  });

  it("빈 목록이면 빈 결과다", () => {
    expect(resolveCtas([])).toEqual({ ctas: [], unknown: [] });
  });
});

describe("seo_json", () => {
  it("읽을 수 있는 것만 읽는다", () => {
    const seo = parseSeo({
      description: "설명",
      keywords: ["웨딩홀", 3, null],
      tools: ["penalty"],
      region_code: "서울",
      category: "hall",
    });

    expect(seo).toEqual({
      description: "설명",
      keywords: ["웨딩홀"],
      tools: ["penalty"],
      regionCode: "서울",
      category: "hall",
    });
  });

  it("**모양이 틀려도 페이지가 선다** — 오타 하나로 공개 페이지가 죽으면 안 된다", () => {
    expect(parseSeo(null)).toEqual({
      description: null,
      keywords: [],
      tools: [],
      regionCode: null,
      category: null,
    });
    expect(parseSeo({ keywords: "문자열", tools: 5 }).keywords).toEqual([]);
  });

  it("**어휘에 없는 카테고리는 받지 않는다** — 링크가 404 가 된다", () => {
    expect(parseSeo({ category: "없는카테고리" }).category).toBeNull();
  });

  it("가격 링크는 지역·카테고리가 둘 다 있을 때만 만든다", () => {
    expect(priceLinkOf(parseSeo({ region_code: "서울", category: "hall" }))).toEqual({
      href: "/prices/%EC%84%9C%EC%9A%B8/hall",
      label: "서울 웨딩홀 가격 분포 보기",
    });
    expect(priceLinkOf(parseSeo({ region_code: "서울" }))).toBeNull();
    expect(priceLinkOf(parseSeo({ category: "hall" }))).toBeNull();
  });
});

describe("JSON-LD", () => {
  const base = {
    slug: "hall-guide",
    title: "웨딩홀 계약 가이드",
    description: "총액을 보는 법",
    publishedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    baseUrl: "https://weddingclear.kr",
  };

  it("필수 항목을 담는다", () => {
    const json = articleJsonLd(base);

    expect(json["@type"]).toBe("Article");
    expect(json.headline).toBe("웨딩홀 계약 가이드");
    expect(json.mainEntityOfPage).toMatchObject({
      "@id": "https://weddingclear.kr/guides/hall-guide",
    });
  });

  it("**없는 값을 지어내지 않는다** — 작성자·이미지·평점을 넣지 않는다", () => {
    const json = articleJsonLd({ ...base, description: null, updatedAt: null });

    expect("description" in json).toBe(false);
    expect("dateModified" in json).toBe(false);
    expect("author" in json).toBe(false);
    expect("image" in json).toBe(false);
    expect("aggregateRating" in json).toBe(false);
  });

  it("**`</script>` 로 태그를 끊지 못한다** — 이 파일에서 유일하게 위험한 자리다", () => {
    const script = jsonLdScript(
      articleJsonLd({ ...base, title: "</script><img src=x onerror=alert(1)>" }),
    );

    expect(script).not.toContain("</script>");
    expect(script).not.toContain("<img");
    expect(script).toContain("\\u003c");
  });

  it("이스케이프해도 다시 읽으면 같은 값이다", () => {
    const json = articleJsonLd({ ...base, title: "a < b" });

    expect(JSON.parse(jsonLdScript(json)).headline).toBe("a < b");
  });
});
