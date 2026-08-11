"use client";

import { useCallback, useEffect, useState } from "react";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  DECLINE_REASONS,
  OVER_CAP_NOTE,
  SLA_LEVEL_LABEL,
  STANDARD_QUOTE_NOTE,
  TARGET_STATUS_LABEL,
  VENDOR_INQUIRIES_EMPTY_DESCRIPTION,
  VENDOR_INQUIRIES_EMPTY_TITLE,
  declineReasonLabel,
  formatDuration,
  type SlaLevel,
  type TargetStatus,
} from "@/lib/core/inquiry/inquiry";
import type { VendorInquiryView } from "@/lib/inquiry/loader";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";
import { cn } from "@/lib/utils";

const ENDPOINT = "/api/vendor/quotes";

type QuotableProduct = {
  id: string;
  name: string;
  category: string;
  basePrice: number;
  options: { id: string; name: string; price: number; isMandatory: boolean }[];
};

/**
 * 업체 문의·견적 (F-V-07, §6.3 `/vendor/inquiries`)
 *
 * ── 이 화면에 **없는 것**이 요점이다 ────────────────────────────────────────
 * 항목 이름을 적는 칸이 없고, 파일을 붙이는 칸이 없고, 총액을 직접 쓰는 칸이 없다.
 * 고를 수 있는 것은 **등록된 상품과 그 추가금**이고, 적을 수 있는 것은 **각 항목을
 * 얼마로 할지**뿐이다. 총액은 합계로 계산되고, 상한은 서버가 프라이싱 룰로 정한다.
 *
 * 화면이 막는 것은 실수를 줄이기 위한 것이고, **경계는 API 와 DB 다**(0024).
 */
export function VendorInquiriesView({
  initialTargets,
  products,
  slaConfigured,
}: {
  initialTargets: VendorInquiryView[];
  products: QuotableProduct[];
  slaConfigured: boolean;
}) {
  const [targets, setTargets] = useState(initialTargets);
  const [activeId, setActiveId] = useState<string | null>(initialTargets[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const active = targets.find((target) => target.id === activeId) ?? null;

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(ENDPOINT);
      const payload = await response.json();

      if (response.ok && payload.ok) setTargets(payload.data.targets as VendorInquiryView[]);
    } catch {
      // 목록은 이미 그려져 있다.
    }
  }, []);

  // 문의를 열면 "봤다" 를 남긴다 — "못 봤다" 와 "보고도 안 답했다" 를 가른다(D-23).
  useEffect(() => {
    if (!active || active.firstViewedAt !== null) return;

    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "view", inquiryTargetId: active.id }),
    });
  }, [active]);

  async function call(body: unknown) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return false;
      }

      await refresh();

      return true;
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");

      return false;
    } finally {
      setPending(false);
    }
  }

  if (targets.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <EmptyState
            assetId="vendor.dashboard.empty"
            title={VENDOR_INQUIRIES_EMPTY_TITLE}
            description={VENDOR_INQUIRIES_EMPTY_DESCRIPTION}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="vendor-inquiries">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        {/* ── 인박스 ─────────────────────────────────────────────────────── */}
        <Card className="h-fit">
          <CardContent className="p-0">
            <ul className="divide-y divide-border" data-testid="vendor-inquiry-inbox">
              {targets.map((target) => (
                <li key={target.id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(target.id)}
                    aria-current={target.id === activeId ? "true" : undefined}
                    className={cn(
                      "w-full px-4 py-3 text-left transition-colors hover:bg-secondary/60",
                      target.id === activeId && "bg-brand-50",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {target.eventDate ?? "날짜 미정"}
                        {target.guestCount !== null ? ` · ${target.guestCount}명` : ""}
                      </span>
                      <Badge
                        variant={target.status === "pending" ? "outline" : "secondary"}
                        className="shrink-0"
                      >
                        {TARGET_STATUS_LABEL[target.status as TargetStatus]}
                      </Badge>
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {slaConfigured && target.sla && target.status === "pending" ? (
                        <SlaBadge level={target.sla.level} elapsed={target.sla.elapsedMinutes} />
                      ) : null}
                      <span className="text-caption text-muted-foreground">
                        {target.categories
                          .map((code) => VENDOR_CATEGORY_LABEL[code as VendorCategory] ?? code)
                          .join(" · ")}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* ── 상세 + 견적 폼 ─────────────────────────────────────────────── */}
        <Card>
          <CardContent className="space-y-4 pt-5">
            {active ? (
              <>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">
                    {active.eventDate ?? "날짜 미정"}
                    {active.guestCount !== null ? ` · 하객 ${active.guestCount}명` : ""}
                    {active.regionCode ? ` · ${active.regionCode}` : ""}
                  </p>
                  {active.budgetTotal !== null ? (
                    <p className="text-caption text-muted-foreground">
                      희망 예산 {formatKrw(active.budgetTotal)}
                    </p>
                  ) : null}
                  {active.note ? (
                    <p className="whitespace-pre-wrap rounded-md bg-secondary/50 p-2.5 text-caption text-foreground">
                      {active.note}
                    </p>
                  ) : null}
                </div>

                {active.quotes.length > 0 ? (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-foreground">보낸 견적</p>
                      {active.quotes.map((quote) => (
                        <div
                          key={quote.id}
                          className="rounded-lg border border-border p-3"
                          data-testid="sent-quote"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm text-foreground">{quote.productName}</span>
                            <span className="text-sm font-semibold text-foreground">
                              {formatKrw(quote.totalAmount)}
                            </span>
                          </div>
                          <p className="text-caption text-muted-foreground">
                            상한 {formatKrw(quote.capTotal)} · 할인 {formatKrw(quote.discountTotal)}{" "}
                            · {quote.status}
                          </p>

                          {quote.status === "sent" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              onClick={() =>
                                void call({ action: "withdraw", quoteId: quote.id })
                              }
                            >
                              견적 거두기
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}

                {active.status === "pending" ? (
                  <>
                    <Separator />
                    <QuoteForm
                      key={active.id}
                      targetId={active.id}
                      products={products}
                      pending={pending}
                      onSend={(body) => call(body)}
                    />
                    <Separator />
                    <DeclinePanel
                      targetId={active.id}
                      pending={pending}
                      onDecline={(reasonCode) =>
                        void call({
                          action: "decline",
                          inquiryTargetId: active.id,
                          reasonCode,
                        })
                      }
                    />
                  </>
                ) : (
                  <p className="text-caption text-muted-foreground">
                    {active.status === "declined"
                      ? `받지 않기로 한 문의예요 (${declineReasonLabel(active.declineReasonCode ?? "")}).`
                      : "이미 응답했거나 마감된 문의예요."}
                  </p>
                )}
              </>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                왼쪽에서 문의를 골라 주세요.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * 표준 견적 폼.
 *
 * **상품과 추가금을 고르고 금액만 적는다.** 항목 이름 칸도, 파일 첨부도, 총액 입력도
 * 없다. 상한은 서버가 프라이싱 룰로 계산하므로 화면은 **등록가**를 기준으로 보여주고,
 * 최종 상한은 보낸 뒤 응답에서 확인한다 — 화면이 룰을 다시 계산하면 서버와 갈린다.
 */
function QuoteForm({
  targetId,
  products,
  pending,
  onSend,
}: {
  targetId: string;
  products: QuotableProduct[];
  pending: boolean;
  onSend: (body: unknown) => Promise<boolean>;
}) {
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [baseAmount, setBaseAmount] = useState<string>("");
  const [optionIds, setOptionIds] = useState<string[]>([]);
  const [optionAmounts, setOptionAmounts] = useState<Record<string, string>>({});
  const [validUntil, setValidUntil] = useState("");
  const [memo, setMemo] = useState("");

  const product = products.find((item) => item.id === productId) ?? null;

  if (products.length === 0) {
    return (
      <p className="rounded-md bg-warning-surface p-3 text-caption text-warning-foreground">
        게시된 상품이 없어 견적을 만들 수 없어요. 상품을 등록하고 추가금을 확정한 뒤
        게시해 주세요 — 등록된 항목만 견적에 넣을 수 있습니다.
      </p>
    );
  }

  async function send() {
    const lines: { itemType: "base" | "option"; productOptionId: string | null; amount: number | null }[] = [
      {
        itemType: "base",
        productOptionId: null,
        amount: baseAmount.trim() === "" ? null : Number(baseAmount),
      },
      ...optionIds.map((id) => ({
        itemType: "option" as const,
        productOptionId: id,
        amount: (optionAmounts[id] ?? "").trim() === "" ? null : Number(optionAmounts[id]),
      })),
    ];

    const sent = await onSend({
      action: "send",
      inquiryTargetId: targetId,
      productId,
      lines,
      validUntil: validUntil === "" ? null : new Date(`${validUntil}T23:59:59Z`).toISOString(),
      vendorMemo: memo.trim() === "" ? null : memo.trim(),
    });

    if (sent) {
      setBaseAmount("");
      setOptionIds([]);
      setOptionAmounts({});
      setMemo("");
    }
  }

  return (
    <div className="space-y-3" data-testid="quote-form">
      <div>
        <p className="text-sm font-medium text-foreground">표준 견적서</p>
        <p className="text-caption text-muted-foreground">{STANDARD_QUOTE_NOTE}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="quote-product">상품</Label>
        <select
          id="quote-product"
          value={productId}
          onChange={(event) => {
            setProductId(event.target.value);
            setOptionIds([]);
            setOptionAmounts({});
          }}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          {products.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({formatKrw(item.basePrice)})
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="quote-base">
          상품 금액 (등록가 {product ? formatKrw(product.basePrice) : "-"})
        </Label>
        <input
          id="quote-base"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={baseAmount}
          placeholder="비워 두면 등록가 그대로"
          onChange={(event) => setBaseAmount(event.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        />
        <p className="text-caption text-muted-foreground">{OVER_CAP_NOTE}</p>
      </div>

      {product && product.options.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-foreground">추가금 (사전 등록된 것만)</legend>

          {product.options.map((option) => {
            const checked = optionIds.includes(option.id);

            return (
              <div key={option.id} className="flex items-center gap-2">
                <Checkbox
                  id={`opt-${option.id}`}
                  checked={checked}
                  onCheckedChange={(next) =>
                    setOptionIds((current) =>
                      next === true
                        ? [...current, option.id]
                        : current.filter((id) => id !== option.id),
                    )
                  }
                />
                <Label htmlFor={`opt-${option.id}`} className="flex-1 text-sm font-normal">
                  {option.name} ({formatKrw(option.price)})
                  {option.isMandatory ? " · 필수" : ""}
                </Label>

                {checked ? (
                  <input
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    aria-label={`${option.name} 금액`}
                    value={optionAmounts[option.id] ?? ""}
                    placeholder={String(option.price)}
                    onChange={(event) =>
                      setOptionAmounts((current) => ({
                        ...current,
                        [option.id]: event.target.value,
                      }))
                    }
                    className="h-8 w-32 rounded-md border border-input bg-background px-2 text-sm"
                  />
                ) : null}
              </div>
            );
          })}
        </fieldset>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="quote-valid">유효기간 (선택)</Label>
        <input
          id="quote-valid"
          type="date"
          value={validUntil}
          onChange={(event) => setValidUntil(event.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="quote-memo">메모 (선택)</Label>
        <textarea
          id="quote-memo"
          rows={2}
          value={memo}
          maxLength={1000}
          placeholder="항목·금액이 아닌 안내 사항만 적어 주세요"
          onChange={(event) => setMemo(event.target.value)}
          className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
        />
      </div>

      <Button type="button" disabled={pending} onClick={() => void send()} data-testid="send-quote">
        견적 보내기
      </Button>
    </div>
  );
}

/**
 * 거절.
 *
 * **사유는 코드로 고른다.** 자유 텍스트로 두면 고객마다 다른 문장을 받아 비교가 안
 * 되고, 다른 업체를 깎아내리는 말을 쓸 자리가 된다(§2.2).
 */
function DeclinePanel({
  targetId,
  pending,
  onDecline,
}: {
  targetId: string;
  pending: boolean;
  onDecline: (reasonCode: string) => void;
}) {
  const [reason, setReason] = useState(DECLINE_REASONS[0].code as string);

  return (
    <div className="space-y-2" data-testid="decline-panel">
      <p className="text-sm font-medium text-foreground">이번 요청을 받지 않기</p>
      <p className="text-caption text-muted-foreground">
        거절도 응답이에요. 사유를 남기면 고객이 다른 곳을 알아볼 수 있고, 응답 기한
        타이머도 멈춥니다.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`decline-${targetId}`} className="sr-only">
          거절 사유
        </Label>
        <select
          id={`decline-${targetId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          {DECLINE_REASONS.map((item) => (
            <option key={item.code} value={item.code}>
              {item.label}
            </option>
          ))}
        </select>

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onDecline(reason)}
          data-testid="decline-inquiry"
        >
          받지 않기
        </Button>
      </div>
    </div>
  );
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
