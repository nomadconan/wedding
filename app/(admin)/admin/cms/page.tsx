import type { Metadata } from "next";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  CONTENT_STATUS_HINT,
  CONTENT_STATUS_LABEL,
  REVISION_FIELD_LABEL,
} from "@/lib/core/content/cms";
import { CONTENT_TYPE_LABEL, parseSeo } from "@/lib/core/content/content";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { measured } from "@/lib/core/stats/metric";
import { loadCmsPosts } from "@/lib/content/admin";
import { requireOperator } from "@/lib/supabase/auth";

import { EditorPanel } from "./EditorPanel";

export const metadata: Metadata = {
  title: "콘텐츠 — 웨딩클리어",
};

/**
 * /admin/cms — 콘텐츠 CMS (F-A-05, §6.4 — 8단계 · S8-08)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **발행 상태를 저장하지 않는다.** 공개 시각 하나에서 계산되고 공개 판정은 RLS
 *    하나다 — 그래서 '발행' 버튼이 따로 없고, 예약에 배치도 없다(시각이 지나면
 *    조회 조건이 스스로 참이 된다).
 * 2. **글을 지우는 버튼이 없다.** 발행된 글의 URL 은 색인되고 밖에서 링크된다 —
 *    '내리기' 는 공개만 거두고 행과 리비전은 남는다(D-129 와 같은 판단).
 * 3. **판본을 목록에 본문 없이 보여준다** — 무엇이 바뀌었는지(칸 이름)와 사유만.
 *    마크다운 문자 단위 diff 는 목록 화면에서 아무도 안 읽는다.
 * 4. **미발행 글이 보인다** — 운영자 SELECT 정책이 있어야 자기 초안을 편집할 수 있다.
 *    공개 정책은 그대로 발행된 것만 보여준다.
 * 5. **캐시하지 않는다**(FIX-22 계열).
 */
export const dynamic = "force-dynamic";

export default async function AdminCmsPage() {
  await requireOperator("/admin/cms");

  const now = new Date();

  let posts: Awaited<ReturnType<typeof loadCmsPosts>>;
  try {
    posts = await loadCmsPosts(now);
  } catch {
    return (
      <AdminShell role="admin" title="콘텐츠">
        <ErrorState
          code="CMS_LOAD_FAILED"
          title="글 목록을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요."
        />
      </AdminShell>
    );
  }

  const counts = {
    published: posts.filter((row) => row.status === "published").length,
    scheduled: posts.filter((row) => row.status === "scheduled").length,
    draft: posts.filter((row) => row.status === "draft").length,
  };

  return (
    <AdminShell
      role="admin"
      title="콘텐츠"
      description="가이드·가격 리포트·용어사전을 쓰고 공개 시각을 정합니다."
    >
      <div className="space-y-6">
        {/* ── 요약 ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="summary-heading">
          <Card>
            <CardHeader>
              <CardTitle id="summary-heading" className="text-base">
                지금 상태
              </CardTitle>
              <CardDescription>
                <strong>발행 상태를 따로 저장하지 않습니다.</strong> 공개 시각 하나가
                초안·예약·발행을 정하고, 공개 여부는 조회 조건(RLS)이 판정합니다 — 예약은
                배치가 아니라 시각이 지나면 스스로 참이 됩니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3">
                <MetricTile
                  label="발행됨"
                  metric={measured(counts.published)}
                  unit="건"
                  hint={CONTENT_STATUS_HINT.published}
                />
                <MetricTile
                  label="발행 예약"
                  metric={measured(counts.scheduled)}
                  unit="건"
                  hint={CONTENT_STATUS_HINT.scheduled}
                />
                <MetricTile
                  label="초안"
                  metric={measured(counts.draft)}
                  unit="건"
                  hint={CONTENT_STATUS_HINT.draft}
                />
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ── 새 글 ─────────────────────────────────────────────────────── */}
        <section aria-labelledby="new-heading">
          <Card>
            <CardHeader>
              <CardTitle id="new-heading" className="text-base">
                새 글
              </CardTitle>
              <CardDescription>
                주소(슬러그)는 공개 URL 그 자체입니다. 발행한 뒤 바꾸면 예전 주소로 걸린 링크가
                죽습니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EditorPanel post={null} now={now.toISOString()} />
            </CardContent>
          </Card>
        </section>

        {/* ── 목록 ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="list-heading">
          <Card>
            <CardHeader>
              <CardTitle id="list-heading" className="text-base">
                글 {posts.length}건
              </CardTitle>
              <CardDescription>
                <strong>지우는 버튼은 없습니다.</strong> &apos;내리기&apos;는 공개만 거두고 행과
                판본은 남습니다 — 다시 올릴 때 같은 주소로 돌아옵니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {posts.length === 0 ? (
                <EmptyState
                  title="아직 글이 없습니다"
                  description="위에서 새 글을 만들면 여기에 쌓입니다."
                />
              ) : (
                <ul className="space-y-3">
                  {posts.map((post) => {
                    const seo = parseSeo(post.seo);

                    return (
                      <li key={post.id} className="rounded-lg border border-border p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{post.title}</span>
                          <Badge
                            variant={
                              post.status === "published"
                                ? "secondary"
                                : post.status === "scheduled"
                                  ? "default"
                                  : "outline"
                            }
                          >
                            {CONTENT_STATUS_LABEL[post.status]}
                          </Badge>
                          <Badge variant="outline">{CONTENT_TYPE_LABEL[post.type]}</Badge>
                          <code className="text-caption text-muted-foreground">/{post.slug}</code>
                        </div>

                        <p className="mt-1 text-caption text-muted-foreground">
                          {post.publishedAt === null ? (
                            "공개 시각 없음"
                          ) : (
                            <>
                              공개 시각{" "}
                              <time dateTime={dateTimeAttr(post.publishedAt)}>
                                {formatTimestamp(post.publishedAt)}
                              </time>
                            </>
                          )}
                          {" · 수정 "}
                          <time dateTime={dateTimeAttr(post.updatedAt)}>
                            {formatTimestamp(post.updatedAt)}
                          </time>
                          {seo.tools.length > 0 ? ` · CTA ${seo.tools.length}개` : ""}
                        </p>

                        {/* ── 판본 ─────────────────────────────────────── */}
                        {post.revisions.length > 0 ? (
                          <details className="mt-2 rounded-md border border-border p-2">
                            <summary className="cursor-pointer text-caption font-medium text-foreground">
                              판본 {post.revisions.length}개
                              {post.lastChanged.length > 0
                                ? ` · 마지막 수정: ${post.lastChanged
                                    .map((field) => REVISION_FIELD_LABEL[field])
                                    .join("·")}`
                                : ""}
                            </summary>
                            <ul className="mt-2 space-y-1">
                              {post.revisions.map((rev) => (
                                <li key={rev.revision} className="text-caption text-muted-foreground">
                                  <strong>v{rev.revision}</strong> · {rev.note} · 본문{" "}
                                  {rev.bodyLength.toLocaleString("ko-KR")}자 ·{" "}
                                  <time dateTime={dateTimeAttr(rev.createdAt)}>
                                    {formatTimestamp(rev.createdAt)}
                                  </time>
                                </li>
                              ))}
                            </ul>
                            <p className="mt-1 text-caption text-muted-foreground">
                              본문은 목록에 싣지 않습니다 — 무엇이 바뀌었는지와 왜 바꿨는지만
                              봅니다.
                            </p>
                          </details>
                        ) : null}

                        <EditorPanel
                          now={now.toISOString()}
                          post={{
                            id: post.id,
                            slug: post.slug,
                            type: post.type,
                            title: post.title,
                            bodyMd: post.bodyMd,
                            publishedAt: post.publishedAt,
                            seo: {
                              description: seo.description,
                              keywords: seo.keywords,
                              tools: seo.tools,
                              regionCode: seo.regionCode,
                              category: seo.category,
                            },
                          }}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
