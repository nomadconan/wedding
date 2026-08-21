import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import {
  parseSeo,
  resolveCtas,
  type ContentSeo,
  type ContentType,
  type ToolCta,
} from "@/lib/core/content/content";
import {
  excerpt,
  parseMarkdown,
  tableOfContents,
  type ContentBlock,
  type TocEntry,
} from "@/lib/core/content/markdown";

/**
 * 콘텐츠 조회 (S7-10 · 명세서 §2.1 F-C-24 · §6.2 `/guides/[slug]`)
 *
 * ── 익명 클라이언트를 쓰는 이유 ─────────────────────────────────────────────
 * `content_posts` 는 **공개 데이터**이고 RLS(0005 [58])가 `published_at is not null
 * and published_at <= now()` 로 이미 거른다. 서비스롤로 읽으면 **미발행 글을 걸러
 * 내는 책임이 전부 애플리케이션 코드로 넘어온다** — 탐색(S3-03)이 익명 클라이언트를
 * 쓰는 것과 같은 이유다.
 *
 * ── 캐시를 끄지 않는다 ──────────────────────────────────────────────────────
 * 플래그(`lib/flags.ts`)·공유 링크(S7-12)는 `no-store` 를 못 박았지만 **여기는 반대**다.
 * 이 화면들은 SEO 대상이고 **정적으로 굳는 것이 목적**이다(§2.1 "정적 생성").
 * 대신 신선도는 페이지의 `revalidate` 가 잡는다 — 발행을 내려도 그 창 동안은 이전
 * 내용이 나갈 수 있으며, **그 사실을 알고 고른 값**이다(공개 데이터라 권한 문제가
 * 아니고, 공개 페이지가 매 요청 렌더되면 SEO 화면으로서 의미가 없다).
 *
 * ── 로그인 상태를 보지 않는다 ───────────────────────────────────────────────
 * 이 모듈은 쿠키를 읽지 않는다. 읽는 순간 라우트가 동적으로 바뀌어 정적 생성이
 * 무너진다. 로그인이 필요한 도구는 **CTA 에 그 사실을 적어** 알린다.
 */

export type ContentSummary = {
  slug: string;
  type: ContentType;
  title: string;
  description: string | null;
  publishedAt: string;
};

export type ContentDetail = ContentSummary & {
  updatedAt: string | null;
  blocks: ContentBlock[];
  toc: TocEntry[];
  seo: ContentSeo;
  ctas: ToolCta[];
  /** 레지스트리에 없어 떨어진 CTA 키. 화면은 쓰지 않고 흐름 점검이 본다. */
  unknownCtas: string[];
};

type Row = {
  slug: string;
  type: string;
  title: string;
  body_md: string | null;
  seo_json: unknown;
  published_at: string;
  updated_at: string | null;
};

function createContentClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Supabase 공개 환경변수가 설정되지 않았습니다.");
  }

  return createSupabaseClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * 요약 목록.
 *
 * 설명이 비어 있으면 **본문 첫 문단에서 만든다** — 검색 결과의 설명이 비면 그
 * 자리에 엉뚱한 조각이 들어간다. 지어내는 것이 아니라 **글쓴이가 쓴 첫 문장**이다.
 */
function toSummary(row: Row): ContentSummary {
  const seo = parseSeo(row.seo_json);

  return {
    slug: row.slug,
    type: row.type as ContentType,
    title: row.title,
    description: seo.description ?? excerpt(parseMarkdown(row.body_md)),
    publishedAt: row.published_at,
  };
}

export async function listContent(type?: ContentType): Promise<ContentSummary[]> {
  const { data, error } = await createContentClient().rpc("published_content", {
    p_type: type ?? null,
  });

  // **목록이 없는 것과 못 읽은 것을 같게 다루지 않는다.** 호출부가 빈 목록을
  // "아직 글이 없어요" 로 그리므로, 조회 실패를 빈 배열로 삼키면 화면이 거짓을 말한다.
  if (error) throw new Error(`콘텐츠 목록을 읽지 못했습니다: ${error.code}`);

  return ((data ?? []) as Row[]).map(toSummary);
}

/** 유형별로 갈라 담는다. 화면이 한 번의 조회로 세 묶음을 그린다. */
export async function listContentByType(): Promise<Record<ContentType, ContentSummary[]>> {
  const all = await listContent();

  // **유형을 빠뜨리지 않는다.** 어휘를 돌며 빈 배열을 먼저 깔아 두면 글이 없는
  // 유형도 키가 있어, 화면이 "왜 아직 없는지" 를 적을 수 있다(가격 리포트가 그렇다).
  const grouped: Record<ContentType, ContentSummary[]> = {
    guide: [],
    price_report: [],
    glossary: [],
  };

  for (const item of all) grouped[item.type].push(item);

  return grouped;
}

export async function findContent(slug: string): Promise<ContentDetail | null> {
  // 집합 반환 함수에 조건을 얹는다 — 목록을 전부 받아 와서 고르지 않는다.
  const { data, error } = await createContentClient()
    .rpc("published_content", { p_type: null })
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw new Error(`콘텐츠를 읽지 못했습니다: ${error.code}`);

  const row = (data ?? null) as Row | null;
  if (row === null) return null;

  const blocks = parseMarkdown(row.body_md);
  const seo = parseSeo(row.seo_json);
  const { ctas, unknown } = resolveCtas(seo.tools);

  return {
    ...toSummary(row),
    updatedAt: row.updated_at,
    blocks,
    toc: tableOfContents(blocks),
    seo,
    ctas,
    unknownCtas: unknown,
  };
}

/**
 * 사이트맵·정적 생성이 쓰는 슬러그 목록.
 *
 * **같은 함수(`published_content`)를 본다.** 사이트맵이 자기 조회를 따로 쓰면
 * "발행됐다" 의 판정이 둘로 갈리고, 그러면 **사이트맵에는 있는데 열면 404** 인
 * 경로가 생긴다 — 검색엔진에 있다고 신고해 놓고 없는 페이지를 주는 셈이다.
 */
export async function publishedSlugs(): Promise<{ slug: string; publishedAt: string }[]> {
  const list = await listContent();

  return list.map((item) => ({ slug: item.slug, publishedAt: item.publishedAt }));
}
