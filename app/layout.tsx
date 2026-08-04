import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "웨딩클리어 — 투명한 웨딩 준비의 시작",
  description: "AI 플래너와 함께 정찰 가격으로 비교하고, 안전하게 계약하는 웨딩 직거래 플랫폼",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
