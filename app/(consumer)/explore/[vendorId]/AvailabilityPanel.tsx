"use client";

import { useState } from "react";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bpToPercentText } from "@/lib/core/pricing/dynamic";
import {
  AVAILABILITY_LABEL,
  AVAILABILITY_NOTE,
  DYNAMIC_PRICE_NEEDS_DATE,
  type AvailabilityState,
} from "@/lib/core/schemas/explore";

/**
 * 날짜별 잔여 슬롯 + 그날 가격 (F-C-11 · F-C-12, §6.2 `/explore/[vendorId]`)
 *
 * **날짜를 고르기 전에는 최종가를 만들어 내지 않는다.** 날짜가 없으면 시즌·리드타임
 * 룰의 조건 자체가 성립하지 않으므로, 서버가 임의의 날짜를 넣어 계산한 값은 고객이
 * 실제로 낼 금액이 아니다. 그래서 정가를 그대로 보여주고 이유를 적는다.
 *
 * 계산 근거(`asOf`·남은 일수·잔여율)를 화면에 함께 적는다 — 같은 금액을 나중에
 * 다시 확인할 수 있어야 한다는 S2-06 의 판단을 고객 화면에서 지키는 방법이다.
 */
type PricedProduct = {
  productId: string;
  name: string;
  priceIncludesVat: boolean;
  price: {
    basePrice: number;
    finalPrice: number;
    discountRateBp: number;
    reasons: { ruleType: string; label: string; before: number; after: number }[];
    context: { asOf: string; eventDate: string; leadTimeDays: number; occupancyRatioBp: number | null };
  } | null;
};

type Payload = {
  availability: AvailabilityState;
  slots: { time: string | null; capacity: number; remaining: number; status: string }[];
  products: PricedProduct[];
};

export function AvailabilityPanel({ vendorId }: { vendorId: string }) {
  const [date, setDate] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<Payload | null>(null);

  async function check() {
    if (date === "") return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/vendors/${vendorId}/availability?date=${encodeURIComponent(date)}`,
      );
      const body = await response.json();

      if (!response.ok || !body.ok) {
        setError(body.error?.message ?? "확인하지 못했어요.");
        setPayload(null);

        return;
      }

      setPayload(body.data as Payload);
    } catch {
      setError("확인하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="availability-panel">
      <div className="space-y-1.5">
        <Label htmlFor="check-date">예식일로 확인하기</Label>
        <div className="flex gap-2">
          <Input
            id="check-date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <Button type="button" onClick={check} disabled={pending || date === ""}>
            {pending ? "확인 중…" : "확인"}
          </Button>
        </div>
        {/* 날짜 전에는 할인을 지어내지 않는다는 사실을 미리 밝힌다. */}
        <p className="text-caption text-muted-foreground">{DYNAMIC_PRICE_NEEDS_DATE}</p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {payload ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-border p-3" data-testid="availability-result">
            <p className="text-sm font-medium text-foreground" data-state={payload.availability.kind}>
              {AVAILABILITY_LABEL[payload.availability.kind]}
              {payload.availability.kind === "available"
                ? ` · 남은 자리 ${payload.availability.remaining}`
                : ""}
            </p>
            <p className="text-caption text-muted-foreground">
              {AVAILABILITY_NOTE[payload.availability.kind]}
            </p>

            {payload.slots.length > 0 ? (
              <ul className="mt-2 space-y-1" data-testid="slot-list">
                {payload.slots.map((slot, index) => (
                  <li
                    key={`${slot.time ?? "all-day"}-${index}`}
                    className="flex justify-between text-caption text-muted-foreground"
                  >
                    <span>{slot.time ? slot.time.slice(0, 5) : "시간 미지정"}</span>
                    <span>
                      {slot.status === "open" ? `${slot.remaining} / ${slot.capacity}자리` : "휴무"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {payload.products.map((product) => (
            <div
              key={product.productId}
              className="rounded-lg border border-border p-3"
              data-testid="dated-price"
            >
              <p className="text-sm font-medium text-foreground">{product.name}</p>

              {product.price ? (
                <>
                  <p className="flex items-baseline gap-1 pt-1">
                    <span data-amount="" className="text-amount-sm text-foreground">
                      {formatKrw(product.price.finalPrice)}
                    </span>
                    <span className="text-sm text-muted-foreground">원</span>
                  </p>

                  {product.price.finalPrice !== product.price.basePrice ? (
                    <p className="text-caption text-muted-foreground" data-testid="discount-rate">
                      정가 {formatKrw(product.price.basePrice)}원 ·{" "}
                      {product.price.discountRateBp > 0
                        ? `${bpToPercentText(product.price.discountRateBp)} 할인`
                        : `${bpToPercentText(-product.price.discountRateBp)} 할증`}
                    </p>
                  ) : (
                    <p className="text-caption text-muted-foreground">
                      그날은 정가와 같습니다.
                    </p>
                  )}

                  {/* 사유 라벨은 F-C-12 가 요구하는 항목이다. 룰 내용은 내보내지 않는다. */}
                  {product.price.reasons.length > 0 ? (
                    <ul className="pt-1" data-testid="price-reasons">
                      {product.price.reasons.map((reason, index) => (
                        <li key={`${reason.ruleType}-${index}`} className="text-caption text-muted-foreground">
                          {reason.label} · {formatKrw(reason.before)}원 → {formatKrw(reason.after)}원
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {/* 계산 근거. 이게 있어야 같은 금액을 나중에 다시 확인할 수 있다. */}
                  <p className="pt-1 text-caption text-muted-foreground" data-testid="price-context">
                    {product.price.context.eventDate} 기준 · 조회일{" "}
                    {product.price.context.asOf} · 남은 일수{" "}
                    {product.price.context.leadTimeDays}일 · 잔여율{" "}
                    {product.price.context.occupancyRatioBp === null
                      ? "정보 없음"
                      : bpToPercentText(product.price.context.occupancyRatioBp)}
                  </p>
                </>
              ) : (
                <p className="text-caption text-muted-foreground">
                  그날 가격을 계산하지 못했습니다.
                </p>
              )}

              <p className="text-caption text-muted-foreground">
                부가세 {product.priceIncludesVat ? "포함" : "별도"}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default AvailabilityPanel;
