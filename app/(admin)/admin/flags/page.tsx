import type { Metadata } from "next";
import Link from "next/link";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/ErrorState";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { measured } from "@/lib/core/stats/metric";
import { loadFlagConsole } from "@/lib/flags/admin";
import { requireOperator } from "@/lib/supabase/auth";

import { FlagPanel } from "./FlagPanel";

export const metadata: Metadata = {
  title: "피처 플래그 — 웨딩클리어",
};

/**
 * /admin/flags — 피처 플래그 (F-A-10, §6.4 — 8단계 · S8-12)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **D-15 의 경계를 깨지 않는다.** `feature_flags` 는 테이블 GRANT 자체가 회수된
 *    유일한 표다(키 목록 = 미공개 기능 로드맵). 정책 대신 **SECURITY DEFINER 함수**
 *    하나를 문으로 쓴다 — 경계는 여전히 DB 안이고, 클라이언트로 나가는 것은 이 서버
 *    컴포넌트가 그린 HTML 뿐이다.
 * 2. **조건 미충족 상태로 켜는 것을 막지 않는다**(D-145). 긴급 롤백이 정의된 용도이고
 *    조건은 기계가 판정할 수 있는 형태가 아니다 — 대신 조건을 **누르기 전에 보여주고**
 *    사유를 요구한다. D-70 의 "어긋나면 다음 사람이 무엇을 믿어야 할지 모른다" 는
 *    막는 대신 **보이게** 해서 지킨다.
 * 3. **되돌릴 수 없는 것을 먼저 말한다.** 플래그는 되돌릴 수 있지만 켜져 있던 동안
 *    벌어진 일은 되돌릴 수 없다.
 * 4. **어긋난 곳을 감추지 않는다.** 코드가 모르는 키(아무도 안 읽는 행)와 코드에는
 *    있는데 행이 없는 키(= 꺼짐)를 둘 다 적는다.
 * 5. **집행되지 않는 조치를 만들지 않는다.** 지역·세그먼트 부분 공개는 그것을 읽는
 *    코드가 없어 설정 칸을 두지 않고 그 사실을 적는다(S8-09 의 D-143 과 같은 판단).
 * 6. **캐시하지 않는다**(FIX-22 계열 — 스위치가 캐시되면 스위치가 아니다).
 */
export const dynamic = "force-dynamic";

export default async function AdminFlagsPage() {
  await requireOperator("/admin/flags");

  let payload: Awaited<ReturnType<typeof loadFlagConsole>>;
  try {
    payload = await loadFlagConsole();
  } catch {
    return (
      <AdminShell role="admin" title="피처 플래그">
        <ErrorState
          code="FLAG_LOAD_FAILED"
          title="플래그를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요."
        />
      </AdminShell>
    );
  }

  const { flags, unknownInDatabase, missingInDatabase, enabledCount, segmentRollout } = payload;
  const known = flags.filter((flag) => flag.inCode);

  return (
    <AdminShell
      role="admin"
      title="피처 플래그"
      description="부분 공개와 긴급 롤백. 릴리즈 스위치 용도는 폐기됐습니다(§1.3)."
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
                <strong>플래그는 기능을 빼는 수단이 아닙니다.</strong> 원칙은
                &apos;나중에 만든다&apos;가 아니라 <strong>&apos;만들어 두고 켜지
                않는다&apos;</strong>입니다(CLAUDE.md §2.1). 지금 남은 용도는 둘 —
                부분 공개와 긴급 롤백입니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <MetricTile
                  label="켜져 있는 기능"
                  metric={measured(enabledCount)}
                  unit="개"
                  hint="코드가 아는 플래그만 셉니다 — 아무도 안 읽는 행은 '열린 기능'이 아닙니다."
                />
                <MetricTile
                  label="선언된 플래그"
                  metric={measured(known.length)}
                  unit="개"
                  hint="코드가 존재를 정하고 DB 가 켬/끔을 정합니다."
                />
                <MetricTile
                  label="어긋난 키"
                  metric={measured(unknownInDatabase.length + missingInDatabase.length)}
                  unit="개"
                />
              </div>

              {unknownInDatabase.length > 0 || missingInDatabase.length > 0 ? (
                <ul className="space-y-0.5 rounded-md border border-border bg-muted p-3">
                  {unknownInDatabase.length > 0 ? (
                    <li className="text-caption text-muted-foreground">
                      <strong>코드가 모름 {unknownInDatabase.join(", ")}</strong> — 이 키를 읽는
                      코드가 없어 켜 두어도 아무 일도 일어나지 않습니다.
                    </li>
                  ) : null}
                  {missingInDatabase.length > 0 ? (
                    <li className="text-caption text-muted-foreground">
                      <strong>행 없음 {missingInDatabase.join(", ")}</strong> — 행이 없으면 꺼진
                      것입니다. 켜려면 마이그레이션으로 행을 만들어야 합니다.
                    </li>
                  ) : null}
                </ul>
              ) : null}

              {/* 집행되지 않는 조치를 화면에 만들지 않는다 — 그 사실을 적는다. */}
              <p
                className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground"
                data-testid="flag-segment-note"
              >
                <strong>지역·사용자 세그먼트 부분 공개는 없습니다.</strong>{" "}
                {segmentRollout.reason}
              </p>
            </CardContent>
          </Card>
        </section>

        {/* ── 플래그 ────────────────────────────────────────────────────── */}
        <section aria-labelledby="flags-heading">
          <Card>
            <CardHeader>
              <CardTitle id="flags-heading" className="text-base">
                플래그 {flags.length}개
              </CardTitle>
              <CardDescription>
                <strong>조건이 안 채워졌어도 켜는 것을 막지 않습니다.</strong> 긴급 롤백이
                이 스위치의 용도이고, 개방 조건은 사람이 읽는 서술이라 기계가 충족 여부를
                판정하는 척하면 그 판정이 사실처럼 굳습니다. 대신 조건을 누르기 전에
                보여드립니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {flags.map((flag) => (
                  <li key={flag.key} className="rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-caption font-medium text-foreground">{flag.key}</code>
                      <span className="font-medium text-foreground">{flag.label}</span>
                      <Badge variant={flag.enabled ? "secondary" : "outline"}>
                        {flag.enabled ? "켜짐" : "꺼짐"}
                      </Badge>
                      {!flag.inCode ? <Badge variant="default">코드가 모름</Badge> : null}
                      {!flag.inDatabase ? <Badge variant="default">행 없음</Badge> : null}
                      {flag.partials.length > 0 ? (
                        <Badge variant="outline">
                          부분 {flag.partials.filter((partial) => partial.on).length}/
                          {flag.partials.length}
                        </Badge>
                      ) : null}
                    </div>

                    <p className="mt-2 text-caption text-muted-foreground">{flag.effect}</p>

                    {flag.partials.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {flag.partials.map((partial) => (
                          <li key={partial.key}>
                            <Badge variant={partial.on ? "secondary" : "outline"}>
                              {partial.label} {partial.on ? "켜짐" : "꺼짐"}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {Object.keys(flag.conditions).length > 0 ? (
                      <details className="mt-2 rounded-md border border-border p-2">
                        <summary className="cursor-pointer text-caption font-medium text-foreground">
                          개방 조건 · {flag.conditionSource}
                        </summary>
                        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-caption text-muted-foreground">
                          {JSON.stringify(flag.conditions, null, 2)}
                        </pre>
                      </details>
                    ) : flag.inCode ? (
                      <p className="mt-2 text-caption text-warning">
                        개방 조건이 행에 적혀 있지 않습니다 — 다음 사람이 무엇을 채워야 열리는지
                        알 수 없습니다(D-67).
                      </p>
                    ) : null}

                    <p className="mt-2 text-caption text-muted-foreground">
                      {flag.updatedAt === null ? (
                        "변경 기록 없음"
                      ) : (
                        <>
                          마지막 변경{" "}
                          <time dateTime={dateTimeAttr(flag.updatedAt)}>
                            {formatTimestamp(flag.updatedAt)}
                          </time>
                        </>
                      )}
                      {" · "}
                      <Link href="/admin/audit?targetType=feature_flag" className="underline">
                        전환 이력
                      </Link>
                    </p>

                    <div className="mt-3">
                      <FlagPanel flag={flag} />
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
