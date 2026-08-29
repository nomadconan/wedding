import type { Metadata } from "next";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { loadPlatformCoupons } from "@/lib/coupons/admin";
import { ISSUE_CONDITION_LABEL, type IssueCondition } from "@/lib/core/coupon/coupon";
import { discountAtMinOrder, maxExposure } from "@/lib/core/coupon/issue";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { measured } from "@/lib/core/stats/metric";
import { requireOperator } from "@/lib/supabase/auth";

import { PlatformCouponForm } from "./PlatformCouponForm";

export const metadata: Metadata = {
  title: "플랫폼 쿠폰 — 웨딩클리어",
};

/**
 * /admin/coupons — 플랫폼 쿠폰 관리 (F-A-19 · §6.4 · S5-14)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **업체 쿠폰은 여기서 만들지 않는다**(T-00e). 남의 정산에서 깎는 쿠폰을 운영자가
 *    만들면 **부담 주체가 만든 사람과 갈린다**(FIX-45 와 같은 자리). 이 화면은
 *    `issuer_type='platform'` 만 읽고 쓰며, 그 경계는 화면이 아니라 **정책**이 지킨다.
 * 2. **비용이 전액 플랫폼 손익이라는 사실을 적는다**(F-A-19). 업체 정산에 닿지 않는다.
 * 3. **소진 현황은 셈한 값이다**(D-124) — 수량과 시계로 볼 때마다 다시 센다.
 * 4. **대상 세그먼트를 만들지 않았다**(D-143 계열) — 발급 경로 자체가 없어(FIX-46)
 *    지정해도 읽는 코드가 없다. 그 사실을 적는다.
 * 5. **발급이 시작되면 돈에 관한 조건이 얼어붙는다**(D-159) — 업체 면과 같은 규칙이다.
 * 6. **캐시하지 않는다.**
 */
export const dynamic = "force-dynamic";

export default async function AdminCouponsPage() {
  await requireOperator("/admin/coupons");

  let payload: Awaited<ReturnType<typeof loadPlatformCoupons>>;
  try {
    payload = await loadPlatformCoupons(new Date());
  } catch {
    return (
      <AdminShell role="admin" title="플랫폼 쿠폰">
        <ErrorState
          code="ADMIN_COUPON_LOAD_FAILED"
          title="쿠폰을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  const { rows, summary, platformRateCapBp, periodCost, segmentTargeting } = payload;

  return (
    <AdminShell
      role="admin"
      title="플랫폼 쿠폰"
      description="플랫폼이 부담하는 쿠폰. 업체 정산에 닿지 않습니다."
    >
      <div className="space-y-6">
        {/* ── 부담 주체 · 발급 경로 고지 ─────────────────────────────────── */}
        <div className="space-y-2">
          <p
            className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground"
            data-testid="admin-coupon-bearer"
          >
            <strong>여기서 만드는 쿠폰의 비용은 전부 플랫폼이 집니다.</strong> 업체 정산액에
            영향을 주지 않으므로 할인액이 그대로 플랫폼 손익입니다. <strong>업체 쿠폰은 이
            화면에서 발행하지 않습니다</strong> — 남의 정산에서 깎는 쿠폰을 운영자가 만들면
            부담 주체가 만든 사람과 갈립니다(T-00e).
          </p>
          <p
            className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground"
            data-testid="admin-coupon-issuance"
          >
            <strong>지금은 쿠폰이 자동으로 발급되지 않습니다.</strong> 여기서 만든 것은 쿠폰의
            정의이고, 조건이 맞는 고객에게 실제로 꽂아 주는 경로는 아직 연결돼 있지 않습니다 —
            <strong> 만들었다고 고객이 받은 것은 아닙니다.</strong>
          </p>
          <p
            className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground"
            data-testid="admin-coupon-segment"
          >
            <strong>대상 세그먼트 지정은 없습니다.</strong> {segmentTargeting.reason}
          </p>
        </div>

        {/* ── 비용 집계 ─────────────────────────────────────────────────── */}
        <section aria-labelledby="cost-heading">
          <Card>
            <CardHeader>
              <CardTitle id="cost-heading" className="text-base">
                비용 집계
              </CardTitle>
              <CardDescription>
                최근 30일 · 기준{" "}
                <time dateTime={dateTimeAttr(periodCost.from)}>
                  {formatTimestamp(periodCost.from)}
                </time>{" "}
                이후. <strong>저장하지 않고 볼 때마다 다시 셉니다.</strong>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-4">
                <MetricTile label="발행한 쿠폰" metric={measured(summary.total)} unit="종" />
                <MetricTile
                  label="살아 있는 쿠폰"
                  metric={measured(summary.active)}
                  unit="종"
                  hint="중단·소진·만료를 뺀 수입니다."
                />
                <MetricTile label="발급 / 사용" metric={measured(summary.issued)} unit={`/ ${summary.used}장`} />
                <MetricTile
                  label="플랫폼 부담액 (30일)"
                  metric={measured(periodCost.amount)}
                  unit="원"
                  hint="전액 플랫폼 손익입니다. 업체 정산에서 빠지지 않습니다."
                />
              </div>

              <p className="text-caption text-muted-foreground">
                누적 부담액 <strong>{(summary.deducted ?? 0).toLocaleString("ko-KR")}원</strong>
                {platformRateCapBp === null ? (
                  <>
                    {" · "}
                    <strong>플랫폼 최대 할인율이 설정돼 있지 않습니다</strong> — 값이 없는
                    것이지 제한이 없는 것이 아닙니다.
                  </>
                ) : (
                  <> · 정률 상한 {platformRateCapBp / 100}%</>
                )}
              </p>
            </CardContent>
          </Card>
        </section>

        {/* ── 발행 폼 ───────────────────────────────────────────────────── */}
        <section aria-labelledby="form-heading">
          <Card>
            <CardHeader>
              <CardTitle id="form-heading" className="text-base">
                쿠폰 발행
              </CardTitle>
              <CardDescription>
                <strong>후기·평점 작성을 조건으로 하는 쿠폰은 만들 수 없습니다</strong>(§7.7 ·
                D-03). 선택지에도 없고, 보내도 거절되며, 데이터베이스가 마지막으로 막습니다.
                발행 주체는 언제나 <strong>플랫폼</strong>이며 입력으로 받지 않습니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PlatformCouponForm platformRateCapBp={platformRateCapBp} />
            </CardContent>
          </Card>
        </section>

        {/* ── 소진 현황 ─────────────────────────────────────────────────── */}
        <section aria-labelledby="list-heading">
          <Card>
            <CardHeader>
              <CardTitle id="list-heading" className="text-base">
                발행한 쿠폰 {rows.length}종
              </CardTitle>
              <CardDescription>
                발행 수량 대비 발급·사용입니다. <strong>소진·만료는 저장된 값이 아니라 셈한
                값입니다.</strong>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? (
                <EmptyState
                  title="아직 발행한 플랫폼 쿠폰이 없어요"
                  description="위 폼에서 발행 조건과 할인 방식을 정해 만들 수 있습니다."
                />
              ) : (
                <ul className="space-y-3" data-testid="admin-coupon-list">
                  {rows.map((row) => {
                    const exposure = maxExposure(row);
                    const atMin = discountAtMinOrder(row);

                    return (
                      <li
                        key={row.id}
                        className="rounded-lg border border-border p-4"
                        data-testid="admin-coupon-row"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{row.name}</span>
                          <Badge variant={row.status === "active" ? "secondary" : "outline"}>
                            {row.status === "active"
                              ? "발행 중"
                              : row.status === "paused"
                                ? "중단"
                                : "종료"}
                          </Badge>
                          {row.soldOut ? <Badge variant="default">소진</Badge> : null}
                          {row.expired ? <Badge variant="default">기간 만료</Badge> : null}
                          {row.frozen ? <Badge variant="outline">조건 확정</Badge> : null}
                        </div>

                        <p className="mt-1 text-sm text-foreground">
                          {row.discountType === "amount"
                            ? `${row.discountValue.toLocaleString("ko-KR")}원 할인`
                            : `${row.discountValue / 100}% 할인 (최대 ${(row.maxDiscountAmount ?? 0).toLocaleString("ko-KR")}원)`}
                          {row.minOrderAmount > 0
                            ? ` · ${row.minOrderAmount.toLocaleString("ko-KR")}원 이상`
                            : ""}
                          {" · "}
                          {ISSUE_CONDITION_LABEL[row.issueCondition as IssueCondition] ??
                            row.issueCondition}
                        </p>

                        <p className="mt-1 text-caption text-muted-foreground">
                          발급 {row.issuedCount}장
                          {row.remaining === null
                            ? " (수량 제한 없음)"
                            : ` / ${row.totalQuantity}장 · 남은 ${row.remaining}장`}
                          {" · 사용 "}
                          {row.usedCount}장 · 플랫폼 부담{" "}
                          {(row.deductedAmount ?? 0).toLocaleString("ko-KR")}원
                        </p>

                        <p className="mt-1 text-caption text-muted-foreground">
                          {atMin !== null ? (
                            <>
                              최소 주문에서 <strong>{atMin.toLocaleString("ko-KR")}원</strong> 할인
                              ·{" "}
                            </>
                          ) : null}
                          {exposure === null ? (
                            <>
                              <strong>남은 수량이 제한 없음</strong>이라 앞으로 나갈 금액을 셀 수
                              없습니다.
                            </>
                          ) : (
                            <>
                              앞으로 최대{" "}
                              <strong>{exposure.toLocaleString("ko-KR")}원</strong>이 플랫폼
                              손익에서 나갈 수 있습니다.
                            </>
                          )}
                        </p>

                        {row.frozen ? (
                          <p className="mt-2 text-caption text-muted-foreground">
                            <strong>이미 발급된 쿠폰입니다.</strong> 할인 조건은 바꿀 수 없고
                            이름·수량·종료일·중단만 고칠 수 있습니다.
                          </p>
                        ) : null}
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
