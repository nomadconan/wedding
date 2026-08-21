import type { MetadataRoute } from "next";

import { publishedSlugs } from "@/lib/content/loader";
import { appUrl } from "@/lib/seo";

/**
 * sitemap.xml (S3-10 · §7.1)
 *
 * **지금 공개된 화면만 싣는다.** 로그인이 필요한 화면(홈·장바구니·찜·마이·온보딩)은
 * 검색에서 들어와도 로그인으로 튕겨 막다른 길이 되므로 넣지 않는다.
 *
 * 지역·카테고리별 가격 리포트(`/prices/[region]/[category]`)는 조합이 데이터에서
 * 나오므로 여기에 **하드코딩하지 않는다.** 지금 넣으면 표본이 없는 조합까지 사이트맵에
 * 올라가고, 그건 "있다고 신고했는데 비어 있는 페이지" 가 된다. 참가격 적재(S8-10)가
 * 붙으면 `price_index` 를 읽어 실제로 값이 있는 조합만 싣는다.
 *
 * **가이드는 발행된 것만 싣는다**(S7-10). 슬러그 목록을 화면·상세와 **같은 함수**
 * (`published_content`)에서 가져온다 — 사이트맵이 자기 조회를 따로 쓰면 "발행됐다" 의
 * 판정이 둘로 갈리고, 그러면 **사이트맵에는 있는데 열면 404** 인 경로가 생긴다.
 * 검색엔진에 있다고 신고해 놓고 없는 페이지를 주는 셈이다. 발행 예약(미래)·미발행
 * 글은 RLS 가 이미 거른다(0005 [58]).
 *
 * 색인 자체는 `robots.txt` 가 막고 있다(공개 전). 사이트맵을 미리 두는 이유는 공개
 * 시점에 환경 변수 하나만 바꾸면 되도록 하기 위해서다.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = appUrl();
  const now = new Date();

  // **못 읽으면 가이드 없이 낸다.** 사이트맵이 통째로 죽는 것보다 낫다 — 나머지
  // 경로는 사실이고, 다음 재생성 때 가이드가 다시 실린다.
  let guides: { slug: string; publishedAt: string }[] = [];
  try {
    guides = await publishedSlugs();
  } catch {
    guides = [];
  }

  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/explore`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    // 조건 검색(S7-02)도 비로그인 화면이다(§1.4 guest). 결과 링크가 아니라 입력 화면만 싣는다 —
    // 조건 조합은 무한하고, 그중 결과가 있는 조합을 우리가 미리 알지 못한다.
    { url: `${base}/search`, lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/login`, lastModified: now, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/guides`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    // 글마다 **발행 시각을 `lastModified` 로** 준다. `now` 를 쓰면 매번 "방금 바뀌었다"
    // 고 신고하는 셈이고, 그러면 이 값이 아무 정보도 주지 않는다.
    ...guides.map((guide) => ({
      url: `${base}/guides/${guide.slug}`,
      lastModified: new Date(guide.publishedAt),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}
