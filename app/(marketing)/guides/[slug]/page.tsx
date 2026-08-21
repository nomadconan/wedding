import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ContentBody } from "@/components/domain/ContentBody";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Badge } from "@/components/ui/badge";
import {
  CONTENT_TYPE_LABEL,
  articleJsonLd,
  isValidSlug,
  jsonLdScript,
  priceLinkOf,
} from "@/lib/core/content/content";
import { findContent, publishedSlugs } from "@/lib/content/loader";
import { ROBOTS_META, appUrl } from "@/lib/seo";

/**
 * /guides/[slug] — 가이드 콘텐츠 (F-C-24 · 명세서 §6.2 · §7.1)
 *
 * §6.2 가 요구한 넷을 그린다 — **SEO 본문 · 목차 · 관련 도구 CTA · JSON-LD**.
 *
 * ── 정적 생성 ───────────────────────────────────────────────────────────────
 * `generateStaticParams` 가 발행된 슬러그를 미리 만든다. **쿠키를 읽지 않으므로**
 * 굳을 수 있고, 굳는 것이 이 화면의 목적이다. 새 글은 `dynamicParams` 기본값(true)
 * 으로 첫 요청 때 만들어진다 — 발행할 때마다 배포하지 않아도 된다.
 *
 * ── 본문에 HTML 을 넣지 않는다 ──────────────────────────────────────────────
 * 파서가 **블록 구조**를 돌려주고 `ContentBody` 가 React 요소로 그린다. 문자열 HTML 을
 * 만들지 않으므로 살균기가 필요 없다. 이 파일에서 `dangerouslySetInnerHTML` 을 쓰는
 * 자리는 **JSON-LD 하나뿐**이고, 그 문자열은 `jsonLdScript()` 가 `<` 를 이스케이프해
 * 만든다(태그를 끊고 나올 수 없다).
 *
 * ── 없는 글은 404 다 ────────────────────────────────────────────────────────
 * 소프트 404(200 + '없어요' 화면)를 내보내면 검색엔진에 빈 페이지가 쌓인다
 * (`/prices/[region]/[category]` 가 세운 판단과 같다).
 */

export const revalidate = 300;

type Params = { slug: string };

export async function generateStaticParams(): Promise<Params[]> {
  // **못 읽으면 빈 목록으로 빌드한다.** 콘텐츠 DB 가 잠깐 닿지 않는다고 빌드가
  // 죽으면 배포가 콘텐츠에 인질로 잡힌다 — `dynamicParams` 기본값이 true 라
  // 첫 요청 때 만들어진다(글이 안 나오는 것이 아니라 늦게 나올 뿐이다).
  try {
    return (await publishedSlugs()).map(({ slug }) => ({ slug }));
  } catch {
    return [];
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  if (!isValidSlug(params.slug)) return { title: "가이드 — 웨딩클리어", robots: ROBOTS_META };

  const post = await findContent(params.slug);
  if (post === null) return { title: "가이드 — 웨딩클리어", robots: ROBOTS_META };

  const canonical = `${appUrl()}/guides/${post.slug}`;

  return {
    title: `${post.title} — 웨딩클리어`,
    // **없으면 비운다.** 설명 자리에 제목을 다시 넣으면 검색 결과가 같은 말을 두 번 한다.
    ...(post.description === null ? {} : { description: post.description }),
    ...(post.seo.keywords.length === 0 ? {} : { keywords: post.seo.keywords }),
    alternates: { canonical },
    robots: ROBOTS_META,
    openGraph: {
      type: "article",
      title: post.title,
      url: canonical,
      ...(post.description === null ? {} : { description: post.description }),
      publishedTime: post.publishedAt,
    },
  };
}

export default async function GuidePage({ params }: { params: Params }) {
  // **형식부터 본다.** 조회 전에 막으면 이상한 슬러그로 DB 를 두드리지 않는다.
  if (!isValidSlug(params.slug)) notFound();

  const post = await findContent(params.slug);
  if (post === null) notFound();

  const priceLink = priceLinkOf(post.seo);
  const jsonLd = articleJsonLd({
    slug: post.slug,
    title: post.title,
    description: post.description,
    publishedAt: post.publishedAt,
    updatedAt: post.updatedAt,
    baseUrl: appUrl(),
  });

  return (
    <ConsumerShell title="가이드">
      {/* 구조화 데이터(§2.1). 이 파일에서 유일한 HTML 삽입이며 `<` 는 이스케이프돼 있다. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />

      <article className="space-y-5" data-testid="guide">
        <header className="space-y-2">
          <Badge variant="outline">{CONTENT_TYPE_LABEL[post.type]}</Badge>
          <h1 className="text-xl font-semibold leading-snug text-foreground">{post.title}</h1>
          <p className="text-caption text-muted-foreground">
            {post.publishedAt.slice(0, 10)} 발행
            {post.updatedAt !== null && post.updatedAt.slice(0, 10) !== post.publishedAt.slice(0, 10)
              ? ` · ${post.updatedAt.slice(0, 10)} 수정`
              : ""}
          </p>
        </header>

        {/* ── 목차 ─────────────────────────────────────────────────────────
            제목이 둘 미만이면 파서가 빈 배열을 준다 — 항목 하나짜리 목차는
            정보가 아니라 장식이고 375px 에서 본문을 한 번 더 밀어낸다. */}
        {post.toc.length === 0 ? null : (
          <nav
            className="space-y-1 rounded-lg border border-border p-3"
            aria-label="목차"
            data-testid="guide-toc"
          >
            <p className="text-caption font-medium text-muted-foreground">목차</p>
            <ul className="space-y-1">
              {post.toc.map((entry) => (
                <li key={entry.anchor} className={entry.level === 3 ? "pl-3" : undefined}>
                  <a href={`#${entry.anchor}`} className="text-sm text-brand-600">
                    {entry.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <ContentBody blocks={post.blocks} />

        {/* ── 관련 도구 ────────────────────────────────────────────────────
            §2.1 "콘텐츠 → 도구 전환". **레지스트리에 있는 실재 경로만** 나간다 —
            모르는 키는 떨어지므로 죽은 링크가 그려지지 않는다. */}
        {post.ctas.length === 0 ? null : (
          <section className="space-y-2" data-testid="guide-ctas">
            <h2 className="text-base font-semibold text-foreground">이어서 해 볼 것</h2>
            <ul className="space-y-2">
              {post.ctas.map((cta) => (
                <li key={cta.key}>
                  <Link
                    href={cta.href}
                    className="block space-y-1 rounded-lg border border-border p-3"
                    data-testid={`guide-cta-${cta.key}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">{cta.label}</span>
                      {/* **로그인이 필요하면 미리 말한다.** 검색으로 들어온 사람이
                          눌렀는데 로그인으로 튕기면 그건 막다른 길이다. */}
                      {cta.requiresLogin ? <Badge variant="secondary">로그인 필요</Badge> : null}
                    </div>
                    <p className="text-caption text-muted-foreground">{cta.description}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {priceLink === null ? null : (
          <Link
            href={priceLink.href}
            className="block rounded-lg border border-border p-3 text-sm font-medium text-brand-600"
            data-testid="guide-price-link"
          >
            {priceLink.label}
          </Link>
        )}

        <Link href="/guides" className="block text-sm font-medium text-brand-600">
          다른 가이드 보기
        </Link>
      </article>
    </ConsumerShell>
  );
}
