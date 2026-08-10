import type { Metadata } from "next";

import { ROBOTS_META, appUrl } from "@/lib/seo";

import "./globals.css";

/**
 * 사이트 전역 메타데이터 기본값.
 *
 * **없는 기능을 설명에 적지 않는다.** 이전 문구는 "AI 플래너와 함께" 로 시작했는데
 * AI 플래너는 7단계(S7-06)라 아직 없다. 검색 결과에 뜨는 문장이 제품보다 앞서가면
 * 들어온 사람이 처음 보는 것이 실망이 된다.
 *
 * `robots` 는 공개 전까지 색인을 막는다(`lib/seo.ts`). 각 페이지가 따로 정하지 않으면
 * 이 값을 물려받으므로 화면마다 어긋날 일이 없다.
 */
export const metadata: Metadata = {
  metadataBase: new URL(appUrl()),
  title: {
    default: "웨딩클리어 — 업체가 등록한 총액이 그대로 보입니다",
    template: "%s — 웨딩클리어",
  },
  description:
    "웨딩 업체의 총액과 추가금을 등록된 그대로 공개합니다. 검색 순위에 광고를 반영하지 않습니다.",
  robots: ROBOTS_META,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
