import type { Metadata } from "next";
import Link from "next/link";

import { BrokerNotice } from "@/components/domain/BrokerNotice";
import { PriceDisplay } from "@/components/domain/PriceDisplay";
import { AssetImage } from "@/components/ui/AssetImage";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { NO_PAID_RANKING_CLAIM, NO_PAID_RANKING_DETAIL } from "@/lib/core/legal";

/**
 * / — 랜딩 (S3-10 · 명세서 §2.1 F-C-24, §6.1)
 *
 * **완전 정적이다.** 쿠키도 DB 도 읽지 않는다.
 *  · §7.1 이 SEO 페이지에 LCP 2.5초와 SSG/ISR 우선을 요구한다.
 *  · 검색에서 들어오는 트래픽은 대부분 **비로그인**이다. 로그인 사용자를 위해 화면을
 *    가르면(쿠키 조회) 전체가 동적이 되어 다수의 경험을 소수를 위해 희생하게 된다.
 *  · 그래서 분기를 **서버가 아니라 링크로** 한다 — '내 홈' 링크는 항상 있고, 누르면
 *    미인증자는 미들웨어가 로그인으로 보낸다.
 *
 * **하단 탭(ConsumerShell)을 쓰지 않는다.** 탭은 로그인 사용자의 1차 경로라
 * 비로그인 방문자에게는 누를 때마다 로그인으로 튕기는 링크가 된다. 게다가
 * `max-w-consumer`(480px)는 데스크톱 검색 유입에 좁다.
 *
 * **없는 기능을 있는 것처럼 말하지 않는다.** AI 플래너·계약서 검토는 7단계이므로
 * '준비 중'으로 적고 **링크를 달지 않는다**(S3-11 홈의 '준비 중인 기능'과 같은 방식).
 */
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: "웨딩클리어 — 웨딩도 이제 장바구니에 담으세요",
  description:
    "상품을 보고, 가격을 보고, 골라서 담습니다. 웨딩홀도 스드메도 총액과 추가금이 상품 정보에 적혀 있습니다.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "웨딩클리어",
    title: "웨딩클리어 — 웨딩도 이제 장바구니에 담으세요",
    description:
      "상품을 보고, 가격을 보고, 골라서 담습니다. 담아서 나란히 비교하세요.",
    images: [{ url: "/images/brand/brand-og-default@1200x630.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "웨딩클리어 — 웨딩도 이제 장바구니에 담으세요",
    description: "상품을 보고, 가격을 보고, 골라서 담습니다.",
    images: ["/images/brand/brand-og-default@1200x630.png"],
  },
};

/**
 * 구조화 데이터.
 *
 * **없는 것을 주장하지 않는다.** `SearchAction` 은 검색 엔드포인트가 있어야 성립하는데
 * 조건 검색(`/search`)은 7단계(S7-02)라 넣지 않았다 — 구조화 데이터의 거짓은
 * 색인에서 걷어내기 어렵다.
 */
const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${APP_URL}/#organization`,
      name: "웨딩클리어",
      url: APP_URL,
      logo: `${APP_URL}/images/brand/brand-logo@240x64.svg`,
      description:
        "웨딩 상품을 진열하고 판매가를 공개하는 웨딩 직거래 플랫폼. 담아서 총액으로 비교한다.",
    },
    {
      "@type": "WebSite",
      "@id": `${APP_URL}/#website`,
      url: APP_URL,
      name: "웨딩클리어",
      inLanguage: "ko-KR",
      publisher: { "@id": `${APP_URL}/#organization` },
    },
  ],
};

/**
 * 뒷받침 3가지 (확정 카피).
 *
 * **화면 언어를 쇼핑몰에 맞춘다** — 상품·담기·비교·총액. 기존 웨딩 시장은 상품과
 * 가격을 알 수 없고 플래너가 소개하며 값을 정하는 구조였다. 여기서는 상품이 진열되고
 * 판매가가 정해져 있다는 것이 제품의 주장이므로, 말도 그 구조를 따라야 한다.
 */
const PILLARS = [
  {
    title: "담아서 나란히 비교하세요",
    body: "여러 업체를 담아 총액을 한 화면에서 봅니다.",
    href: "/explore",
    cta: "상품 보러 가기",
  },
  {
    title: "추가금까지 상품 정보에 있습니다",
    body: "사전에 적지 않은 항목은 나중에 청구할 수 없습니다.",
    href: "/explore",
    cta: "추가금 확인하기",
  },
  {
    /**
     * **"살 수 없다" 는 지금도 사실이다** — 광고 구좌 자체가 없다. 정책도 그대로
     * 담기고, 나중에 실적 지표가 붙어도 문구를 고칠 필요가 없다.
     *
     * 이전 문구("상담·예약·계약·리뷰 실적으로만 정렬합니다")는 아직 하지 않는 일을
     * 현재형으로 말했다. 그래서 같은 카드에 '지금 열려 있는 정렬' 을 덧붙여 두었는데,
     * 문구가 사실이 된 지금은 그 각주가 필요 없다 — 지금 무엇으로 정렬하는지는
     * 목록 화면의 **정렬 기준 배지**가 결과와 함께 말한다(D-03). 랜딩에서 정렬
     * 목록을 다시 세는 것은 같은 사실을 두 곳에서 관리하는 일이 된다.
     */
    title: "광고비로 순위를 살 수 없습니다",
    body: "순위는 실적 지표로만 정합니다. 광고 구좌는 검색 결과와 분리해 표시합니다.",
    href: null,
    cta: null,
  },
] as const;

/** 아직 없는 것. **링크를 달지 않는다** — 누르면 없는 화면이다. */
const COMING = [
  { title: "AI 플래너 '클리어'", note: "대화로 준비를 정리합니다.", stage: "7단계" },
  { title: "계약서 검토 리포트", note: "표준약관 대비 위험 조항을 짚어 줍니다.", stage: "7단계" },
  { title: "상담·탐방 예약", note: "가능한 시간대를 보고 바로 신청합니다.", stage: "4단계" },
] as const;

export default function LandingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        // 구조화 데이터는 정적 문자열이라 주입 위험이 없다.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      <div className="min-h-dvh bg-background">
        <header className="mx-auto flex h-header w-full max-w-5xl items-center justify-between px-gutter">
          <AssetImage id="brand.logo" priority className="h-6 w-auto" />
          <nav className="flex items-center gap-3 text-caption font-medium">
            <Link href="/explore" className="text-foreground">
              탐색
            </Link>
            {/* 로그인 여부로 화면을 가르지 않는다 — 누르면 미들웨어가 판단한다. */}
            <Link href="/home" className="text-foreground">
              내 홈
            </Link>
            <Link href="/login" className="text-brand-600">
              로그인
            </Link>
          </nav>
        </header>

        <main className="mx-auto w-full max-w-5xl px-gutter pb-16">
          {/* ── 가치 제안 (확정 카피) ──────────────────────────────────
              쇼핑몰 컨셉을 문장 구조로 그대로 옮긴다 — 보고, 고르고, 담는다. */}
          <section className="space-y-4 py-8" data-testid="landing-hero">
            {/* 태그라인을 헤드라인 위에 둔다. 이 서비스가 무엇을 뒤집는지가 먼저 오고
                (상담 → 쇼핑), 헤드라인이 그래서 무엇을 하라는지 말한다. */}
            <p className="text-sm font-medium text-brand-600" data-testid="landing-tagline">
              웨딩 준비, 상담이 아니라 쇼핑입니다
            </p>

            <h1 className="text-display-lg text-foreground">
              웨딩도 이제
              <br />
              장바구니에 담으세요
            </h1>

            <p className="text-base text-muted-foreground">
              상품을 보고, 가격을 보고, 골라서 담습니다.
              <br className="hidden sm:block" /> 웨딩홀도 스드메도 열어보면 다 적혀 있습니다.
            </p>

            <div className="flex flex-wrap gap-2">
              <Link
                href="/explore"
                className="rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground"
                data-testid="cta-explore"
              >
                상품 둘러보기
              </Link>
              <Link
                href="/vendor/apply"
                className="rounded-md border border-border px-4 py-2.5 text-sm font-medium text-foreground"
                data-testid="cta-vendor"
              >
                업체로 입점하기
              </Link>
            </div>

            <AssetImage
              id="landing.hero"
              // LCP 대상이다(§7.1). 매니페스트 note 가 priority 를 권장한다.
              priority
              className="h-auto w-full rounded-lg border border-border"
              sizes="(max-width: 640px) 100vw, 64rem"
            />
          </section>

          {/* ── 뒷받침 3가지 (확정 카피) ────────────────────────────────
              히어로 바로 다음이다. 주장을 읽은 사람이 근거를 찾을 자리이고,
              세 문장이 각각 탐색·상품 정보·정렬로 이어진다. */}
          <section className="space-y-3 py-8">
            <div className="grid gap-3 sm:grid-cols-3">
              {PILLARS.map((item) => (
                <Card key={item.title} data-testid="landing-pillar">
                  <CardContent className="space-y-2 pt-5">
                    <p className="text-sm font-semibold text-foreground">{item.title}</p>
                    <p className="text-caption text-muted-foreground">{item.body}</p>
                    {item.href && item.cta ? (
                      <Link href={item.href} className="text-sm font-medium text-brand-600">
                        {item.cta}
                      </Link>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          {/* ── 가격을 어떻게 보여주는가 ───────────────────────────────
              **참가격 지수 숫자를 걸지 않는다.** 표본이 모이기 전이라 대부분
              '표본 부족'이고, 그 상태를 첫 화면에 세우면 서비스가 비어 보인다.
              대신 이 제품의 주장을 증명하는 것은 지수가 아니라 **가격을 어떻게
              적는가**이므로, 그 규칙을 예시로 보여준다. 금액은 '예시' 임을
              배지로 못박아 시세로 읽히지 않게 한다. */}
          <section className="space-y-3 py-8" data-testid="landing-price-rule">
            <h2 className="text-display-sm text-foreground">상품 정보에 추가금까지 적혀 있습니다</h2>
            <p className="text-sm text-muted-foreground">
              총액만 크게 적고 추가금을 아래에 숨기지 않습니다. 업체가 추가금을 등록하지
              않았다면 &lsquo;미등록&rsquo;이라고 적습니다 — &lsquo;없음&rsquo;과 다른 말입니다.
              사전에 적지 않은 항목은 계약 이후에 청구할 수 없습니다.
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <Card>
                <CardContent className="space-y-2 pt-5">
                  <Badge variant="outline">예시 · 추가금을 확정한 업체</Badge>
                  <PriceDisplay
                    amount={12_000_000}
                    basePrice={10_000_000}
                    taxIncluded
                    addOns={{ kind: "listed", count: 3, total: 2_000_000 }}
                    plannerFee={{ kind: "not_selected" }}
                    size="sm"
                  />
                </CardContent>
              </Card>

              <Card>
                <CardContent className="space-y-2 pt-5">
                  <Badge variant="outline">예시 · 추가금을 등록하지 않은 업체</Badge>
                  <PriceDisplay
                    amount={10_000_000}
                    basePrice={10_000_000}
                    taxIncluded
                    addOns={{ kind: "unknown" }}
                    plannerFee={{ kind: "not_selected" }}
                    size="sm"
                  />
                </CardContent>
              </Card>
            </div>

            <p className="text-caption text-muted-foreground">
              위 금액은 화면 구성을 보여주기 위한 예시이며 실제 시세가 아닙니다.
            </p>
          </section>

          {/* ── 광고를 반영하지 않는다 ─────────────────────────────────── */}
          <section className="space-y-2 py-8" data-testid="landing-no-ads">
            <h2 className="text-display-sm text-foreground">{NO_PAID_RANKING_CLAIM}</h2>
            <p className="text-sm text-muted-foreground">{NO_PAID_RANKING_DETAIL}</p>
            <p className="text-sm text-muted-foreground">
              목록에는 <strong className="text-foreground">정렬 기준 배지</strong>가 항상 붙습니다.
              무엇으로 줄 세웠는지 화면에서 확인할 수 있어야 &lsquo;광고가 없다&rsquo;는 말이
              증명됩니다.
            </p>
          </section>

          {/* ── 준비 중 ────────────────────────────────────────────────
              링크를 달지 않는다. 없는 화면으로 보내면 그게 곧 거짓말이다. */}
          <section className="space-y-3 py-8">
            <h2 className="text-display-sm text-foreground">준비 중이에요</h2>
            <ul className="grid gap-2 sm:grid-cols-3" data-testid="landing-coming">
              {COMING.map((item) => (
                <li key={item.title} className="rounded-lg border border-border p-4">
                  <p className="text-sm font-medium text-foreground">{item.title}</p>
                  <p className="text-caption text-muted-foreground">{item.note}</p>
                  <p className="text-caption text-muted-foreground">{item.stage}에 열립니다</p>
                </li>
              ))}
            </ul>
          </section>

          {/* ── 업체 입점 ──────────────────────────────────────────────
              공급이 없으면 서비스가 돌지 않는다. 소비자 동선과 같은 무게로 둔다. */}
          <section className="space-y-2 rounded-lg border border-border p-6" data-testid="landing-vendor">
            <h2 className="text-display-sm text-foreground">업체이신가요?</h2>
            <p className="text-sm text-muted-foreground">
              등록한 판매가가 그대로 고객 노출가입니다. 광고비를 받지 않으므로 노출을 사기
              위한 비용이 들지 않습니다. 수수료는 거래가 성사된 뒤에만 발생합니다.
            </p>
            <Link href="/vendor/apply" className="text-sm font-medium text-brand-600">
              입점 신청하기
            </Link>
          </section>
        </main>

        {/*
          중개자 지위 고지(D-24). 명세가 요구하는 대상은 '거래 관련 화면'이라 랜딩은
          의무 대상이 아니다. 그래도 여기서 한 줄 적는 이유는, 랜딩이 "여기서 결혼
          준비를 한다"는 인상을 만드는 첫 화면이기 때문이다 — 나중에 오인이 생기는 것보다
          처음에 밝히는 편이 낫다. 다만 첫 화면을 위축시키지 않도록 하단에 compact 로 둔다.
        */}
        <footer className="mx-auto w-full max-w-5xl space-y-3 border-t border-border px-gutter py-6">
          <BrokerNotice variant="compact" />
          <p className="text-caption text-muted-foreground">
            © 웨딩클리어. 가격은 각 업체가 등록한 값이며 등록 시점 이후 달라질 수 있습니다.
          </p>
        </footer>
      </div>
    </>
  );
}
