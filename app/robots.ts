import type { MetadataRoute } from "next";

import { INDEXING_ALLOWED, appUrl } from "@/lib/seo";

/**
 * robots.txt (S3-10 · §7.1)
 *
 * **기본은 색인 금지다.** 서비스가 아직 공개 전이고, 지금 색인되면 '표본이 아직
 * 모이지 않았어요'·'준비 중' 화면이 검색 결과로 남는다. 그 인상은 나중에 걷어내기
 * 어렵다 — 색인은 넣기보다 빼기가 훨씬 오래 걸린다.
 *
 * 공개 시점에 `ALLOW_INDEXING=true` 하나로 연다. 코드를 고치지 않고 환경으로
 * 제어하는 이유는 CLAUDE.md §2.1 의 원칙과 같다 — **'나중에 만든다'가 아니라
 * '만들어 두고 켜지 않는다'.**
 *
 * 로그인이 필요한 경로는 열린 뒤에도 색인 대상이 아니다. 검색 결과에서 눌러도
 * 로그인 화면으로 튕기고, 그건 검색 사용자에게 막다른 길이다.
 */
const PRIVATE_PATHS = [
  "/api/",
  "/home",
  "/cart",
  "/wishlist",
  "/me",
  "/onboarding",
  "/vendor",
  "/admin",
  "/explore/compare",
  "/design-system",
  // 초대(청첩) 링크는 **검색 결과에 나올 값이 아니다**(S7-09). 토큰을 가진 것이
  // 곧 권한이므로 색인되면 그 자체가 유출이다. 페이지 메타에도 noindex 를 걸었다.
  "/rsvp/",
  "/guests",
];

export default function robots(): MetadataRoute.Robots {
  if (!INDEXING_ALLOWED) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }

  return {
    rules: [{ userAgent: "*", allow: "/", disallow: PRIVATE_PATHS }],
    sitemap: `${appUrl()}/sitemap.xml`,
  };
}
