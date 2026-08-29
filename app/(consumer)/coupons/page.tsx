import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadWallet } from "@/lib/coupons/read";
import { COUPON_EMPTY_TITLE, COUPON_STACKING_NOTICE } from "@/lib/core/coupon/coupon";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { requireUser } from "@/lib/supabase/auth";

export const metadata: Metadata = {
  title: "내 쿠폰 — 웨딩클리어",
};

/**
 * /coupons — 쿠폰함 (F-C-35·36 · §6.2 · S5-12)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **못 쓰는 쿠폰을 감추지 않는다**(F-C-36). 사유를 함께 적는다 — 감추면 고객은
 *    "쿠폰이 없다" 로 이해하고, 최소 주문 금액을 조금 넘기면 쓸 수 있다는 사실을
 *    영영 모른다.
 * 2. **여기서는 판정하지 않는다.** 특정 결제를 놓고 보는 화면이 아니므로 주문 금액이
 *    없고, 0원으로 재면 전부 "못 쓴다" 가 된다 — **틀린 답을 확신 있게 적는 일**이다
 *    (함정 2). 실제 사용 가능 여부는 결제 화면이 회차 금액을 놓고 답한다.
 * 3. **할인 조건을 그대로 적는다.** 정률이면 상한까지 — 상한을 감추면 "10% 할인" 이
 *    고액 계약에서 얼마가 되는지 아무도 모른다.
 * 4. **하단 탭을 늘리지 않는다**(D-55). 진입은 `/me` 와 결제 화면이다.
 * 5. **캐시하지 않는다** — 만료가 시계로 판정되는 화면이다.
 */
export const dynamic = "force-dynamic";

export default async function CouponsPage() {
  await requireUser("/coupons");

  return (
    <ConsumerShell title="내 쿠폰">
      <Suspense fallback={<LoadingState label="쿠폰을 불러오는 중" rows={3} variant="block" />}>
        <Wallet />
      </Suspense>
    </ConsumerShell>
  );
}

async function Wallet() {
  let wallet: Awaited<ReturnType<typeof loadWallet>>;
  try {
    // **주문 금액을 주지 않는다** — 이 화면은 특정 결제를 놓고 보는 자리가 아니다.
    wallet = await loadWallet({ orderAmount: null, now: new Date() });
  } catch {
    return (
      <ErrorState
        code="COUPON_LOAD_FAILED"
        title="쿠폰을 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }

  if (wallet.entries.length === 0) {
    return (
      <EmptyState
        title={COUPON_EMPTY_TITLE}
        description="계약을 마치거나 이벤트에 참여하면 쿠폰을 받으실 수 있어요. 받은 쿠폰은 결제 화면에서 바로 쓸 수 있습니다."
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="coupon-wallet">
      <section className="rounded-lg border border-border p-4">
        <p className="text-sm font-medium text-foreground">
          받은 쿠폰 {wallet.summary.total}장
        </p>
        <p className="mt-1 text-caption text-muted-foreground">
          {wallet.summary.expiringSoon > 0
            ? `이 중 ${wallet.summary.expiringSoon}장이 7일 안에 만료돼요.`
            : "7일 안에 만료되는 쿠폰은 없어요."}
        </p>
        {/* **여기서 '쓸 수 있는 수' 를 적지 않는다** — 결제 금액을 모르기 때문이다.
            0 으로 적으면 쓸 수 있는 쿠폰이 없다는 뜻이 되어 버린다(함정 2). */}
        <p className="mt-2 text-caption text-muted-foreground" data-testid="coupon-judged-note">
          <strong>사용 가능 여부는 결제 화면에서 확인됩니다.</strong> 쿠폰마다 최소 결제
          금액이 달라서, 어떤 결제냐에 따라 쓸 수 있는 쿠폰이 달라져요.
        </p>
        <p className="mt-1 text-caption text-muted-foreground">{COUPON_STACKING_NOTICE}</p>
      </section>

      <ul className="space-y-3">
        {wallet.entries.map((entry) => (
          <li
            key={entry.issueId}
            className="rounded-lg border border-border p-4"
            data-testid="coupon-row"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{entry.name}</span>
              <Badge variant="outline">
                {entry.issuerType === "vendor" ? (entry.issuerName ?? "업체 발행") : "웨딩클리어"}
              </Badge>
              {entry.issueStatus !== "issued" ? (
                <Badge variant="default">
                  {entry.issueStatus === "used"
                    ? "사용함"
                    : entry.issueStatus === "expired"
                      ? "기간 만료"
                      : "회수됨"}
                </Badge>
              ) : null}
            </div>

            <p className="mt-1 text-sm text-foreground">
              {entry.discountType === "amount"
                ? `${entry.discountValue.toLocaleString("ko-KR")}원 할인`
                : `${entry.discountValue / 100}% 할인`}
              {entry.discountType === "rate" && entry.maxDiscountAmount !== null
                ? ` (최대 ${entry.maxDiscountAmount.toLocaleString("ko-KR")}원)`
                : ""}
            </p>

            <p className="mt-0.5 text-caption text-muted-foreground">
              {entry.minOrderAmount > 0
                ? `${entry.minOrderAmount.toLocaleString("ko-KR")}원 이상 결제에 사용 · `
                : ""}
              {entry.expiresAt === null ? (
                "사용 기한 없음"
              ) : (
                <>
                  <time dateTime={dateTimeAttr(entry.expiresAt)}>
                    {formatTimestamp(entry.expiresAt)}
                  </time>
                  까지
                </>
              )}
            </p>

            {entry.issuerType === "vendor" ? (
              <p className="mt-1 text-caption text-muted-foreground">
                이 업체와의 결제에만 쓸 수 있는 것은 아니지만, 할인액은 발행한 업체가
                부담합니다.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
