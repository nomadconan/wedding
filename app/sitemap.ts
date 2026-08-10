import type { MetadataRoute } from "next";

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
 * 색인 자체는 `robots.txt` 가 막고 있다(공개 전). 사이트맵을 미리 두는 이유는 공개
 * 시점에 환경 변수 하나만 바꾸면 되도록 하기 위해서다.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = appUrl();
  const now = new Date();

  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/explore`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    { url: `${base}/login`, lastModified: now, changeFrequency: "monthly", priority: 0.3 },
  ];
}
