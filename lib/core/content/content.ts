import { VENDOR_CATEGORIES, VENDOR_CATEGORY_LABEL, type VendorCategory } from "../schemas/vendor";

/**
 * SEO 콘텐츠 허브 (S7-10 · 명세서 §2.1 F-C-24 · §3.7 · §6.2 `/guides/[slug]` · §7.1)
 *
 * 프레임워크를 모르는 순수 모듈이다.
 *
 * ── 이 파일이 지키는 것 ─────────────────────────────────────────────────────
 *  1. **없는 기능을 있는 것처럼 쓰지 않는다.** 글 끝의 도구 CTA 는 **레지스트리에
 *     등록된 실재 경로**로만 나간다. 모르는 키는 그리지 않고 **떨어뜨린다** —
 *     죽은 링크는 "누를 수 있는데 아무 일도 안 일어나는 자리" 이고 그것이 가장 나쁘다
 *     (D-91 이 견적 업로드 슬롯에서 세운 규칙 그대로다).
 *  2. **빈 참가격 지수를 콘텐츠로 세우지 않는다.** `price_report` 유형은 어휘에
 *     있지만 **글을 만들지 않는다**(S3-08 의 표본이 대부분 부족하다 · S8-10 대기).
 *     그 자리에는 빈 글 대신 **왜 아직 없는지**를 적는다.
 *  3. **로그인 상태로 갈리지 않는다.** 이 모듈은 사용자를 모른다 — 알면 화면이
 *     정적으로 굳지 않고, 그러면 SEO 대상 화면이 매 요청 렌더된다.
 */

// =============================================================================
// 유형
// =============================================================================

/** DB `content_post_type` enum 과 같은 집합이다(0004). `db:rls` 가 대조한다. */
export const CONTENT_TYPES = ["guide", "price_report", "glossary"] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

export const CONTENT_TYPE_LABEL: Record<ContentType, string> = {
  guide: "가이드",
  price_report: "가격 리포트",
  glossary: "용어사전",
};

export const CONTENT_TYPE_DESCRIPTION: Record<ContentType, string> = {
  guide: "준비 순서와 계약에서 실제로 걸리는 것들을 정리했어요.",
  price_report: "지역·카테고리별 등록 판매가 분포를 표본수와 함께 공개해요.",
  glossary: "계약서와 견적서에 나오는 말을 그대로 풀어 적었어요.",
};

/**
 * **아직 글이 없는 유형에 무엇을 적는가.**
 *
 * `price_report` 는 어휘에 있지만 지금 글이 없다. 이유는 **참가격 지수의 표본이
 * 대부분 부족**하기 때문이다(S3-08 · 적재는 S8-10). 표본 없는 숫자로 "리포트" 를 쓰면
 * 그건 리포트가 아니라 **빈 페이지에 제목만 붙인 것**이고, 색인되면 그 인상이 남는다.
 *
 * 대신 **이미 있는 화면**으로 잇는다 — `/prices/[region]/[category]` 는 표본이 부족하면
 * 부족하다고 말하는 화면이고, 그것이 지금 우리가 정직하게 줄 수 있는 전부다.
 */
export const EMPTY_TYPE_NOTICE: Record<ContentType, string> = {
  guide: "아직 발행한 가이드가 없어요.",
  price_report:
    "가격 리포트는 아직 쓰지 않았어요. 참가격 표본이 모이는 대로 지역·카테고리별로 올릴게요. 지금도 지역별 분포는 가격 화면에서 표본수와 함께 볼 수 있어요.",
  glossary: "아직 정리한 용어가 없어요.",
};

// =============================================================================
// 슬러그
// =============================================================================

/**
 * 슬러그 형식.
 *
 * 소문자 영숫자와 하이픈만 받는다. **한글을 받지 않는 이유**는 앵커와 다르다 —
 * 앵커는 한 페이지 안의 조각이지만 슬러그는 **URL 그 자체**이고, 퍼센트 인코딩된
 * 한글 URL 은 공유될 때 깨져 보인다. 대신 제목이 한글을 갖는다.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SLUG_MAX_LENGTH = 80;

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug);
}

// =============================================================================
// 도구 CTA — 실재하는 경로만
// =============================================================================

export type ToolCta = {
  key: string;
  href: string;
  label: string;
  description: string;
  /**
   * 로그인이 필요한가.
   *
   * **화면이 이 사실을 미리 적는다.** 검색으로 들어온 사람이 눌렀는데 로그인으로
   * 튕기면 그건 막다른 길이다(S3-10 이 사이트맵에서 세운 판단과 같다).
   */
  requiresLogin: boolean;
};

/**
 * **여기 있는 것만 CTA 가 된다.**
 *
 * 글이 `seo_json.tools` 로 키를 지정하고, 모르는 키는 **조용히 떨어진다.**
 * 기능이 생기면 여기 한 줄을 더한다 — 글을 고치지 않아도 그날 CTA 가 붙는다.
 *
 * **없는 화면을 넣지 않는다.** 넣는 순간 글은 "이런 도구가 있습니다" 라고 말하는데
 * 눌러 보면 404 다. 지금 목록은 전부 실재하며 흐름 점검이 실제로 열어 본다.
 */
export const TOOL_CTAS: readonly ToolCta[] = [
  {
    key: "penalty",
    href: "/tools/penalty",
    label: "위약금 계산해 보기",
    description: "계약 해지 시점을 넣으면 기준 대비 얼마인지 비교해 드려요.",
    requiresLogin: false,
  },
  {
    key: "explore",
    href: "/explore",
    label: "총액 공개 업체 보기",
    description: "등록 판매가와 추가금을 합친 총액으로 견줍니다.",
    requiresLogin: false,
  },
  {
    key: "search",
    href: "/search",
    label: "조건으로 찾기",
    description: "지역·예산·날짜를 문장으로 적으면 조건을 읽어 찾아요.",
    requiresLogin: false,
  },
  // **`/prices` 를 넣지 않았다.** 지역·카테고리가 붙은 `/prices/[region]/[category]` 만
  // 실재하고 목록 화면은 없다 — 넣었다면 글이 "이런 도구가 있습니다" 라고 말하는데
  // 눌러 보면 404 다. 지역별 링크는 `priceLinkOf()` 가 글의 `seo_json` 에서 만든다.
  {
    key: "reports",
    href: "/reports",
    label: "계약서 검토 맡기기",
    description: "표준약관·분쟁해결기준과 견줘 위험 조항을 짚어 드려요.",
    requiresLogin: true,
  },
  {
    key: "estimates",
    href: "/estimates",
    label: "받은 견적 비교하기",
    description: "표준 항목으로 맞춰 나란히 놓고 실총액을 견줍니다.",
    requiresLogin: true,
  },
  {
    key: "checklist",
    href: "/checklist",
    label: "준비 순서 보기",
    description: "무엇을 먼저 해야 다음이 되는지 순서로 보여드려요.",
    requiresLogin: true,
  },
  {
    key: "budget",
    href: "/budget",
    label: "예산 짜기",
    description: "총예산을 카테고리로 나누고 실지출을 견줍니다.",
    requiresLogin: true,
  },
];

const CTA_BY_KEY = new Map(TOOL_CTAS.map((cta) => [cta.key, cta]));

/**
 * 글이 지정한 키 → 실제 CTA.
 *
 * **모르는 키는 떨어진다.** 던지지 않는 이유는 글 하나의 오타가 페이지 전체를
 * 500 으로 만들면 안 되기 때문이다 — 다만 **조용히 사라지는 것을 운영이 알 수
 * 있도록** 떨어진 키를 함께 돌려준다.
 */
export function resolveCtas(keys: readonly string[]): { ctas: ToolCta[]; unknown: string[] } {
  const ctas: ToolCta[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    const cta = CTA_BY_KEY.get(key);

    if (cta === undefined) {
      unknown.push(key);
      continue;
    }

    // 같은 CTA 를 두 번 그리지 않는다.
    if (seen.has(key)) continue;

    seen.add(key);
    ctas.push(cta);
  }

  return { ctas, unknown };
}

// =============================================================================
// seo_json — 글이 갖는 메타
// =============================================================================

export type ContentSeo = {
  description: string | null;
  keywords: string[];
  tools: string[];
  /** 이 글이 다루는 지역·카테고리. 있으면 가격 화면으로 잇는다. */
  regionCode: string | null;
  category: VendorCategory | null;
};

/**
 * `seo_json` 파싱.
 *
 * **모르는 모양이 와도 페이지가 서야 한다.** 콘텐츠는 운영자가 쓰고, 오타 하나로
 * 공개 페이지가 죽으면 그 사실을 아무도 즉시 모른다. 그래서 **읽을 수 있는 것만
 * 읽고 나머지는 기본값**이다 — 다만 카테고리는 **어휘에 있을 때만** 받는다
 * (없는 카테고리로 가격 화면을 링크하면 404 가 된다).
 */
export function parseSeo(raw: unknown): ContentSeo {
  const source = (raw ?? {}) as Record<string, unknown>;

  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  const category = source.category;
  const region = source.region_code ?? source.regionCode;

  return {
    description: typeof source.description === "string" ? source.description : null,
    keywords: strings(source.keywords),
    tools: strings(source.tools),
    regionCode: typeof region === "string" && region.length > 0 ? region : null,
    category:
      typeof category === "string" && (VENDOR_CATEGORIES as readonly string[]).includes(category)
        ? (category as VendorCategory)
        : null,
  };
}

/**
 * 글이 지역·카테고리를 밝혔으면 **가격 화면으로 잇는다.**
 *
 * 여기서 표본이 있는지 확인하지 않는다 — 그 판정은 `/prices/[region]/[category]` 가
 * 이미 하며(표본 부족이면 부족하다고 적는다) **같은 판정을 두 곳에 두면 갈린다.**
 */
export function priceLinkOf(seo: ContentSeo): { href: string; label: string } | null {
  if (seo.regionCode === null || seo.category === null) return null;

  return {
    href: `/prices/${encodeURIComponent(seo.regionCode)}/${seo.category}`,
    label: `${seo.regionCode} ${VENDOR_CATEGORY_LABEL[seo.category]} 가격 분포 보기`,
  };
}

// =============================================================================
// JSON-LD
// =============================================================================

export type ArticleJsonLdInput = {
  slug: string;
  title: string;
  description: string | null;
  publishedAt: string;
  updatedAt: string | null;
  baseUrl: string;
};

/**
 * 구조화 데이터(§2.1 "정적 생성 + 구조화 데이터").
 *
 * **없는 값을 지어내지 않는다.** 작성자 이름·이미지·평점은 우리가 갖고 있지 않으므로
 * 넣지 않는다 — 구조화 데이터에 사실이 아닌 값을 넣는 것은 검색엔진에 거짓을 신고하는
 * 일이고, 그것으로 받는 불이익이 얻는 것보다 크다.
 *
 * `publisher` 는 우리 자신이라 사실이다.
 */
export function articleJsonLd(input: ArticleJsonLdInput): Record<string, unknown> {
  const json: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    mainEntityOfPage: { "@type": "WebPage", "@id": `${input.baseUrl}/guides/${input.slug}` },
    headline: input.title,
    datePublished: input.publishedAt,
    publisher: { "@type": "Organization", name: "웨딩클리어" },
    inLanguage: "ko-KR",
  };

  if (input.description !== null) json.description = input.description;
  if (input.updatedAt !== null) json.dateModified = input.updatedAt;

  return json;
}

/**
 * JSON-LD 를 `<script>` 안에 넣을 문자열로.
 *
 * **`<` 를 이스케이프한다.** 본문에서 온 값이 `</script>` 를 담고 있으면 스크립트
 * 태그가 거기서 끊기고 그 뒤가 마크업이 된다 — 이 파일에서 유일하게 위험한 자리이며,
 * 그래서 문자열 만들기를 화면에 맡기지 않고 여기서 한다.
 */
export function jsonLdScript(json: Record<string, unknown>): string {
  return JSON.stringify(json).replace(/</g, "\\u003c");
}
