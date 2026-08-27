import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadAuditTimeline } from "@/lib/admin/audit";
import { REDACTED_PLACEHOLDER, isNarrowed, parseAuditQuery } from "@/lib/core/audit/audit";
import { requireOperator } from "@/lib/supabase/auth";

import { AuditFilters } from "./AuditFilters";

export const metadata: Metadata = {
  title: "감사 로그 — 웨딩클리어",
};

/**
 * /admin/audit — 감사 로그·증적 타임라인 (F-A-09, §6.4 — 8단계 · S8-02)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **두 표를 한 줄로 세운다.** `audit_logs`(누가 무엇을 했다)와
 *    `entity_events`(무엇이 어떤 상태가 됐다)는 조사할 때 나눠 볼 이유가 없다.
 * 2. **값이 아니라 바뀐 칸을 보여준다.** `before_json`/`after_json` 에는 각 라우트가
 *    자유롭게 담은 객체가 들어 있어 개인정보가 섞일 수 있다(§7.3).
 * 3. **비어 있음과 못 읽음을 구분한다.** 조건을 좁혀서 비었는지, 아직 아무 일도 없었는지,
 *    조회가 실패했는지가 화면에서 갈린다.
 * 4. **캐시하지 않는다**(FIX-22 계열).
 *
 * ── 왜 SECURITY DEFINER 가 아닌가 ──────────────────────────────────────────
 * S8-01 의 지표는 **합계**라 행을 열 이유가 없어 함수로 감쌌다. 여기는 **행을 읽는 것이
 * 목적**이므로 경계가 RLS 여야 한다(0053 의 `audit_logs_select_operator`).
 * 행위자 **이름만** 예외로 함수를 쓴다 — `profiles` 정책이 운영자를 모르기 때문이며,
 * 그 함수도 `display_name`·`role` 두 칸만 돌려준다.
 */
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<Record<string, string | undefined>> };

function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : "—";
}

export default async function AdminAuditPage({ searchParams }: PageProps) {
  await requireOperator("/admin/audit");

  const params = await searchParams;
  const query = parseAuditQuery(params);

  let payload: Awaited<ReturnType<typeof loadAuditTimeline>>;
  try {
    payload = await loadAuditTimeline(query);
  } catch {
    return (
      <AdminShell role="admin" title="감사 로그">
        <ErrorState
          code="AUDIT_LOAD_FAILED"
          title="감사 로그를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요."
        />
      </AdminShell>
    );
  }

  const narrowed = isNarrowed(query);
  const exportHref = `/api/admin/audit-logs?${new URLSearchParams({
    ...Object.fromEntries(
      Object.entries(params).filter(([, value]) => Boolean(value)) as [string, string][],
    ),
    format: "csv",
  })}`;

  return (
    <AdminShell
      role="admin"
      title="감사 로그"
      description="전 주체의 상태 변경 기록입니다. 값이 아니라 바뀐 칸을 보여줍니다."
      action={
        <Button asChild variant="outline">
          {/* 서버가 파일로 내려 준다. 화면이 들고 있는 것을 다시 만들지 않는다. */}
          <a href={exportHref} download>
            CSV 내보내기
          </a>
        </Button>
      }
    >
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">조건</CardTitle>
            <CardDescription>
              선택지는 <strong>실제로 쌓인 값</strong>에서 만듭니다. 목록을 코드에 적어 두면 새
              액션이 생겼을 때 그것만 고를 수 없게 됩니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<LoadingState variant="block" rows={1} />}>
              <AuditFilters facets={payload.facets} />
            </Suspense>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">증적 타임라인</CardTitle>
            <CardDescription>
              행위(<Badge variant="secondary">행위</Badge>)와 상태 전이(
              <Badge variant="outline">전이</Badge>)를 시간순으로 함께 세웁니다. 개인정보가 담길
              수 있는 칸은 <strong>{REDACTED_PLACEHOLDER}</strong>으로 두고 <strong>바뀌었다는
              사실만</strong> 남깁니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {payload.entries.length === 0 ? (
              <EmptyState
                title={narrowed ? "이 조건에 맞는 기록이 없어요" : "아직 기록이 없어요"}
                description={
                  narrowed
                    ? "조건을 지우면 최근 기록부터 보입니다. 조회는 정상입니다."
                    : "상태를 바꾸는 일이 일어나면 여기에 쌓입니다. 조회는 정상입니다."
                }
              />
            ) : (
              <ol className="space-y-3" data-testid="audit-timeline">
                {payload.entries.map((entry) => {
                  const actor = entry.actorId ? payload.actors[entry.actorId] : undefined;

                  return (
                    <li
                      key={`${entry.kind}-${entry.id}`}
                      className="rounded-lg border border-border p-4"
                      data-testid="audit-entry"
                      data-kind={entry.kind}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <Badge variant={entry.kind === "action" ? "secondary" : "outline"}>
                            {entry.kind === "action" ? "행위" : "전이"}
                          </Badge>
                          <span className="text-sm font-medium text-foreground">{entry.label}</span>
                        </span>
                        <time className="text-caption text-muted-foreground" dateTime={entry.at}>
                          {entry.at.replace("T", " ").slice(0, 19)}
                        </time>
                      </div>

                      <p className="mt-1 text-caption text-muted-foreground">
                        {/* 이름을 못 찾으면 id 앞자리로 대신한다 — 빈칸이면 '누가' 가 사라진다. */}
                        {actor?.displayName ?? shortId(entry.actorId)}
                        {entry.actorRole ? ` · ${entry.actorRole}` : null}
                        {" → "}
                        {entry.targetType}
                        {entry.targetId ? ` · ${shortId(entry.targetId)}` : null}
                      </p>

                      {entry.transition ? (
                        <p className="mt-1.5 text-sm text-foreground">
                          <span className="text-muted-foreground">{entry.transition.before ?? "—"}</span>
                          {" → "}
                          <span className="font-medium">{entry.transition.after ?? "—"}</span>
                        </p>
                      ) : null}

                      {entry.changes.length > 0 ? (
                        <ul className="mt-1.5 space-y-0.5">
                          {entry.changes.map((change) => (
                            <li key={change.field} className="text-caption text-muted-foreground">
                              <span className="font-medium text-foreground">{change.field}</span>
                              {`: ${change.before} → ${change.after}`}
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      {entry.memo ? (
                        <p className="mt-1.5 text-caption text-muted-foreground">{entry.memo}</p>
                      ) : null}

                      {entry.resolutionBasis.length > 0 ? (
                        <p className="mt-1.5 text-caption text-muted-foreground">
                          근거 이벤트 {entry.resolutionBasis.length}건 ·{" "}
                          {entry.resolutionBasis.map((id) => shortId(id)).join(" ")}
                        </p>
                      ) : null}

                      {/* 이 대상만 따라가기 — 분쟁 조사는 늘 대상 하나를 좇는 일이다. */}
                      {entry.targetId ? (
                        <Link
                          href={`/admin/audit?targetType=${encodeURIComponent(entry.targetType)}&targetId=${entry.targetId}`}
                          className="mt-2 inline-block text-caption font-medium text-brand-700 hover:underline"
                        >
                          이 대상만 보기
                        </Link>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}

            {payload.hasMore && payload.nextBefore ? (
              <div className="mt-4 flex justify-center">
                <Button asChild variant="outline">
                  <Link
                    href={`/admin/audit?${new URLSearchParams({
                      ...Object.fromEntries(
                        Object.entries(params).filter(([key, value]) =>
                          Boolean(value) && key !== "before",
                        ) as [string, string][],
                      ),
                      before: payload.nextBefore,
                    })}`}
                  >
                    이전 기록 더 보기
                  </Link>
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}
