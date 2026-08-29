import type { Metadata } from "next";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { loadVendorCoupons, vendorContext } from "@/lib/coupons/vendor";
import { ISSUE_CONDITION_LABEL, type IssueCondition } from "@/lib/core/coupon/coupon";
import { conditionsWithheldFromVendor, discountAtMinOrder, maxExposure } from "@/lib/core/coupon/issue";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { measured, restricted } from "@/lib/core/stats/metric";
import { requireUser } from "@/lib/supabase/auth";

import { CouponForm } from "./CouponForm";

export const metadata: Metadata = {
  title: "쿠폰 — 웨딩클리어",
};

/**
 * /vendor/coupons — 업체 쿠폰 발행·관리 (F-V-19 · §6.3 · S5-13)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **할인액이 어디서 나가는지 숨기지 않는다.** 업체 쿠폰의 할인은 **그 업체의
 *    정산에서 빠진다**(D-27). 발행 전에 **최악의 금액**(상한 × 남은 수량)을 보여 준다.
 * 2. **정산 차감액은 대표 전용이다**(§3.9). 스태프에게는 **0 이 아니라 '못 봄'** 으로
 *    적는다 — 둘을 같게 적으면 "안 빠졌다" 로 읽힌다(함정 2).
 * 3. **리뷰 관련 조건은 선택지에 없다**(§7.7 · D-03). 왜 없는지도 적는다.
 * 4. **발급이 시작되면 돈에 관한 조건이 얼어붙는다.** 받은 사람이 본 약속과 달라지면
 *    안 되기 때문이며, 얼어 있는 칸은 폼이 잠근다.
 * 5. **발급 실행 경로가 아직 없다는 사실을 적는다**(FIX-46) — 안 적으면 업체는 만든
 *    쿠폰이 고객에게 갔다고 믿는다.
 * 6. **소진·만료를 저장된 상태에서 읽지 않는다**(D-124). 수량과 시계로 센다.
 * 7. **캐시하지 않는다.**
 */
export const dynamic = "force-dynamic";

export default async function VendorCouponsPage() {
  const user = await requireUser("/vendor/coupons");
  const context = await vendorContext(user.id);

  if (context === null) {
    return (
      <AdminShell role="vendor" title="쿠폰">
        <ErrorState
          code="VENDOR_NOT_MEMBER"
          title="업체 계정이 아니에요"
          description="업체로 등록하고 승인을 받은 뒤에 쿠폰을 발행할 수 있어요."
        />
      </AdminShell>
    );
  }

  let payload: Awaited<ReturnType<typeof loadVendorCoupons>>;
  try {
    payload = await loadVendorCoupons({ ...context, now: new Date() });
  } catch {
    return (
      <AdminShell role="vendor" title="쿠폰">
        <ErrorState
          code="VENDOR_COUPON_LOAD_FAILED"
          title="쿠폰을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  const { rows, summary, canSeeMoney, platformRateCapBp } = payload;
  const withheld = conditionsWithheldFromVendor();

  return (
    <AdminShell
      role="vendor"
      title="쿠폰"
      description="자사 쿠폰 발행과 현황. 할인액은 우리 정산에서 빠집니다."
    >
      <div className="space-y-6">
        {/* ── 발급 경로 고지 (FIX-46) ───────────────────────────────────── */}
        <p
          className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground"
          data-testid="coupon-issuance-notice"
        >
          <strong>지금은 쿠폰이 자동으로 발급되지 않습니다.</strong> 여기서 만든 것은
          <strong> 쿠폰의 정의</strong>이고, 조건이 맞는 고객에게 실제로 꽂아 주는 경로는 아직
          연결돼 있지 않습니다. 만들어 두면 그 경로가 생길 때 그대로 쓰입니다 —
          <strong> 지금 만들었다고 고객이 받은 것은 아닙니다.</strong>
        </p>

        {/* ── 요약 ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="summary-heading">
          <Card>
            <CardHeader>
              <CardTitle id="summary-heading" className="text-base">
                지금 상태
              </CardTitle>
              <CardDescription>
                <strong>업체 쿠폰의 할인액은 우리 정산에서 빠집니다</strong>(D-27). 플랫폼
                쿠폰은 플랫폼이 부담하며 우리 정산에 닿지 않습니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-4">
                <MetricTile label="발행한 쿠폰" metric={measured(summary.total)} unit="종" />
                <MetricTile
                  label="살아 있는 쿠폰"
                  metric={measured(summary.active)}
                  unit="종"
                  hint="중단·소진·만료를 뺀 수입니다. 상태만 보지 않고 수량·시계로 셉니다."
                />
                <MetricTile label="발급" metric={measured(summary.issued)} unit="장" />
                <MetricTile
                  label="정산 차감액"
                  // **못 보는 값을 0 으로 적지 않는다**(함정 2).
                  metric={
                    summary.deducted === null
                      ? restricted("대표만 볼 수 있습니다(§3.9). RLS 가 행을 주지 않습니다.")
                      : measured(summary.deducted)
                  }
                  unit={summary.deducted === null ? "" : "원"}
                  hint="실제로 쓰인 쿠폰이 정산에서 데려간 금액입니다."
                />
              </div>

              {!canSeeMoney ? (
                <p
                  className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground"
                  data-testid="coupon-owner-only"
                >
                  <strong>정산 차감액은 대표만 볼 수 있습니다</strong>(§3.9). 화면이 가리는
                  것이 아니라 <strong>데이터베이스가 주지 않습니다</strong> — 그래서 0원이
                  아니라 &apos;못 봄&apos;으로 적습니다.
                </p>
              ) : null}

              <p className="text-caption text-muted-foreground">
                {platformRateCapBp === null ? (
                  <>
                    <strong>플랫폼 최대 할인율이 설정돼 있지 않습니다.</strong> 지금은 정률
                    상한을 검사하지 않습니다 — 값이 없는 것이지 제한이 없는 것이 아닙니다.
                  </>
                ) : (
                  <>
                    정률 쿠폰의 할인율은 최대 <strong>{platformRateCapBp / 100}%</strong> 입니다.
                  </>
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
                <strong>후기·평점 작성을 조건으로 하는 쿠폰은 만들 수 없습니다.</strong> 돈이
                평가에 개입하면 검증 후기의 근거가 무너지기 때문입니다(§7.7). 선택지에도
                없고, 보내도 거절되며, 데이터베이스가 마지막으로 막습니다.
                {withheld.length > 0 ? (
                  <>
                    {" "}
                    <span data-testid="coupon-withheld">
                      운영 재량 지급(
                      {withheld.map((value) => ISSUE_CONDITION_LABEL[value]).join(", ")})은 업체
                      선택지에 없습니다 — 플랫폼이 쓰는 조건입니다.
                    </span>
                  </>
                ) : null}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {canSeeMoney ? (
                <CouponForm platformRateCapBp={platformRateCapBp} />
              ) : (
                <p className="text-caption text-muted-foreground">
                  쿠폰 발행은 대표만 할 수 있습니다. 발행하면 할인액이 우리 정산에서 빠지기
                  때문입니다.
                </p>
              )}
            </CardContent>
          </Card>
        </section>

        {/* ── 목록 ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="list-heading">
          <Card>
            <CardHeader>
              <CardTitle id="list-heading" className="text-base">
                발행한 쿠폰 {rows.length}종
              </CardTitle>
              <CardDescription>
                <strong>소진·만료는 저장된 값이 아니라 셈한 값입니다</strong> — 수량과 시계로
                볼 때마다 다시 셉니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? (
                <EmptyState
                  title="아직 발행한 쿠폰이 없어요"
                  description="위 폼에서 발행 조건과 할인 방식을 정해 만들 수 있습니다."
                />
              ) : (
                <ul className="space-y-3" data-testid="vendor-coupon-list">
                  {rows.map((row) => {
                    const exposure = maxExposure(row);
                    const atMin = discountAtMinOrder(row);

                    return (
                      <li
                        key={row.id}
                        className="rounded-lg border border-border p-4"
                        data-testid="vendor-coupon-row"
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
                          {row.remaining === null ? " (수량 제한 없음)" : ` · 남은 ${row.remaining}장`}
                          {" · 사용 "}
                          {row.usedCount}장
                          {" · 정산 차감 "}
                          {/* **못 보는 값을 0 으로 적지 않는다.** */}
                          {row.deductedAmount === null
                            ? "대표만 볼 수 있음"
                            : `${row.deductedAmount.toLocaleString("ko-KR")}원`}
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
                              <strong>{exposure.toLocaleString("ko-KR")}원</strong>이 정산에서
                              빠질 수 있습니다.
                            </>
                          )}
                        </p>

                        {row.validTo !== null ? (
                          <p className="mt-1 text-caption text-muted-foreground">
                            <time dateTime={dateTimeAttr(row.validTo)}>
                              {formatTimestamp(row.validTo)}
                            </time>
                            까지
                          </p>
                        ) : null}

                        {row.frozen ? (
                          <p className="mt-2 text-caption text-muted-foreground">
                            <strong>이미 발급된 쿠폰입니다.</strong> 할인 조건은 바꿀 수 없고
                            이름·수량·종료일·중단만 고칠 수 있습니다 — 받은 사람이 본 약속과
                            달라지면 안 되기 때문입니다.
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
