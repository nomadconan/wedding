"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import { ContactPathGuide } from "@/components/domain/ContactPathGuide";
import { formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Separator } from "@/components/ui/separator";
import {
  INQUIRIES_EMPTY_DESCRIPTION,
  INQUIRIES_EMPTY_TITLE,
  INQUIRY_STATUS_LABEL,
  QUOTE_EXPIRED_NOTE,
  SLA_LEVEL_LABEL,
  TARGET_STATUS_LABEL,
  TARGET_STATUS_NOTE,
  canAccept,
  declineReasonLabel,
  discountRateBp,
  formatDuration,
  isExpired,
  type InquiryStatus,
  type SlaLevel,
  type TargetStatus,
} from "@/lib/core/inquiry/inquiry";
import type { InquiryView } from "@/lib/inquiry/loader";
import type { QuoteView } from "@/lib/core/schemas/inquiry";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";
import { cn } from "@/lib/utils";

/**
 * 문의함 (F-C-13, §6.2 `/inquiries`)
 *
 * **비교가 목적이다.** 같은 문의에 붙은 업체별 응답을 한 화면에 나란히 둔다 —
 * 항목 이름과 구성이 같으므로(0024 가 스키마로 강제) 금액을 그대로 견줄 수 있다.
 *
 * **미응답과 거절을 다르게 그린다.** "아직 답이 없다" 는 기다리는 상태이고
 * "받지 않겠다" 는 끝난 상태다. 같은 회색 배지로 뭉치면 고객이 기다려야 할지
 * 다른 곳을 알아봐야 할지 알 수 없다.
 */
export function InquiriesView({
  initialInquiries,
  maxTargets,
}: {
  initialInquiries: InquiryView[];
  maxTargets: number;
}) {
  const [inquiries, setInquiries] = useState(initialInquiries);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/inquiries");
      const payload = await response.json();

      if (response.ok && payload.ok) setInquiries(payload.data.inquiries as InquiryView[]);
    } catch {
      // 목록은 이미 그려져 있다. 다음 조작에서 다시 맞춘다.
    }
  }, []);

  async function call(body: unknown, key: string) {
    setPending(key);
    setError(null);

    try {
      const response = await fetch("/api/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return;
      }

      await refresh();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(null);
    }
  }

  if (inquiries.length === 0) {
    return (
      <div className="space-y-4">
        <ContactPathGuide current="inquiry" />

        <EmptyState
          assetId="explore.empty"
          title={INQUIRIES_EMPTY_TITLE}
          description={INQUIRIES_EMPTY_DESCRIPTION}
          action={
            <Link href="/explore" className="text-sm font-medium text-brand-600">
              업체 둘러보기
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="inquiries">
      <ContactPathGuide current="inquiry" />

      <p className="text-caption text-muted-foreground">
        한 번에 {maxTargets}곳까지 같은 조건으로 보낼 수 있어요.
      </p>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {inquiries.map((inquiry) => (
        <Card key={inquiry.id} data-testid="inquiry" data-status={inquiry.status}>
          <CardContent className="space-y-3 pt-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  {inquiry.eventDate ?? "날짜 미정"}
                  {inquiry.guestCount !== null ? ` · 하객 ${inquiry.guestCount}명` : ""}
                </p>
                <p className="text-caption text-muted-foreground">
                  {inquiry.categories
                    .map((code) => VENDOR_CATEGORY_LABEL[code as VendorCategory] ?? code)
                    .join(" · ")}
                  {inquiry.regionCode ? ` · ${inquiry.regionCode}` : ""}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={inquiry.status === "open" ? "default" : "secondary"}>
                  {INQUIRY_STATUS_LABEL[inquiry.status as InquiryStatus] ?? inquiry.status}
                </Badge>

                {inquiry.status === "open" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending === inquiry.id}
                    onClick={() => void call({ action: "close", inquiryId: inquiry.id }, inquiry.id)}
                  >
                    마감
                  </Button>
                ) : null}
              </div>
            </div>

            {inquiry.note ? (
              <p className="whitespace-pre-wrap rounded-md bg-secondary/50 p-2.5 text-caption text-foreground">
                {inquiry.note}
              </p>
            ) : null}

            <Separator />

            <ul className="space-y-3" data-testid="inquiry-targets">
              {inquiry.targets.map((target) => (
                <li key={target.id} data-testid="inquiry-target" data-target-status={target.status}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`/explore/${target.vendorId}`}
                      className="truncate text-sm font-medium text-foreground"
                    >
                      {target.vendorName}
                    </Link>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <StatusBadge status={target.status} />
                      {target.status === "pending" && target.sla ? (
                        <SlaBadge level={target.sla.level} elapsed={target.sla.elapsedMinutes} />
                      ) : null}
                    </div>
                  </div>

                  <p className="mt-0.5 text-caption text-muted-foreground">
                    {TARGET_STATUS_NOTE[target.status]}
                    {target.status === "declined" && target.declineReasonCode
                      ? ` (${declineReasonLabel(target.declineReasonCode)})`
                      : ""}
                  </p>

                  {target.quotes.map((quote) => (
                    <QuoteCard
                      key={quote.id}
                      quote={quote}
                      now={now}
                      pending={pending === quote.id}
                      onDecide={(decision) =>
                        void call(
                          { action: "decide_quote", quoteId: quote.id, decision },
                          quote.id,
                        )
                      }
                    />
                  ))}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * 미응답·거절을 색으로 가른다.
 *
 * 거절은 위험(danger)이 아니라 **끝난 상태**다 — 업체가 잘못한 것이 아니라 사정이
 * 맞지 않은 것이므로 붉게 칠하지 않는다(§2.3 — 업체에 대한 평가적 표현 금지).
 */
function StatusBadge({ status }: { status: TargetStatus }) {
  const variant =
    status === "responded" ? "default" : status === "pending" ? "outline" : "secondary";

  return <Badge variant={variant}>{TARGET_STATUS_LABEL[status]}</Badge>;
}

function SlaBadge({ level, elapsed }: { level: SlaLevel; elapsed: number | null }) {
  const tone: Record<SlaLevel, string> = {
    clear: "bg-success-surface text-success-foreground",
    waiting: "bg-secondary text-secondary-foreground",
    due: "bg-warning-surface text-warning-foreground",
    overdue: "bg-danger-surface text-danger-foreground",
  };

  return (
    <span
      data-testid="sla-badge"
      data-level={level}
      className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-caption", tone[level])}
    >
      {SLA_LEVEL_LABEL[level]}
      {elapsed !== null ? ` · ${formatDuration(elapsed)}` : ""}
    </span>
  );
}

/**
 * 견적서.
 *
 * **상한 대비 얼마나 깎였는지를 함께 보여준다.** 금액만 보면 그 값이 비싼지 싼지
 * 알 수 없다. 상한은 고객이 탐색·장바구니에서 이미 본 가격이므로 비교 기준이 된다.
 */
function QuoteCard({
  quote,
  now,
  pending,
  onDecide,
}: {
  quote: QuoteView;
  now: Date;
  pending: boolean;
  onDecide: (decision: "accepted" | "declined") => void;
}) {
  const expired = isExpired(
    { status: quote.status as never, validUntil: quote.validUntil },
    now,
  );
  const rateBp = discountRateBp(quote.capTotal, quote.totalAmount);

  return (
    <div
      className="mt-2 rounded-lg border border-border p-3"
      data-testid="quote"
      data-quote-status={quote.status}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{quote.productName ?? "상품"}</p>
        <p className="text-base font-semibold text-foreground" data-amount="">
          {formatKrw(quote.totalAmount)}
        </p>
      </div>

      {quote.discountTotal > 0 ? (
        <p className="text-caption text-success-foreground" data-testid="quote-discount">
          정가 {formatKrw(quote.capTotal)}에서 {formatKrw(quote.discountTotal)} 할인 (
          {(rateBp / 100).toFixed(1)}%)
        </p>
      ) : (
        <p className="text-caption text-muted-foreground">등록가 그대로예요.</p>
      )}

      <ul className="mt-2 space-y-0.5">
        {quote.items.map((item) => (
          <li key={item.id} className="flex justify-between gap-2 text-caption">
            <span className="truncate text-muted-foreground">
              {item.label}
              {item.isOption ? " (추가금)" : ""}
            </span>
            <span className="shrink-0 text-foreground">{formatKrw(item.amount)}</span>
          </li>
        ))}
      </ul>

      {quote.vendorMemo ? (
        <p className="mt-2 whitespace-pre-wrap text-caption text-muted-foreground">
          {quote.vendorMemo}
        </p>
      ) : null}

      {quote.validUntil ? (
        <p className="mt-2 text-caption text-muted-foreground">
          유효기간 {new Date(quote.validUntil).toLocaleDateString("ko-KR")}
        </p>
      ) : null}

      {expired ? (
        <p className="mt-2 text-caption text-warning-foreground" data-testid="quote-expired">
          {QUOTE_EXPIRED_NOTE}
        </p>
      ) : null}

      {canAccept({ status: quote.status as never, validUntil: quote.validUntil }, now) ? (
        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => onDecide("accepted")}
            data-testid="accept-quote"
          >
            이 견적으로 진행
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => onDecide("declined")}
          >
            보류
          </Button>
        </div>
      ) : null}

      {/* 수락해도 계약이 되지는 않는다 — 계약·결제는 5단계다(S5-04·S5-06). */}
      {quote.status === "accepted" ? (
        <p className="mt-2 text-caption text-muted-foreground">
          진행하기로 표시했어요. 계약서 작성과 결제는 준비 중이에요(S5-04·S5-06).
        </p>
      ) : null}
    </div>
  );
}
