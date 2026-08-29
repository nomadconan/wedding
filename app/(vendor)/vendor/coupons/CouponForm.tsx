"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ISSUE_CONDITION_LABEL } from "@/lib/core/coupon/coupon";
import {
  COUPON_FORM_MESSAGE,
  type CouponForm as CouponFormValues,
  type CouponFormError,
  VENDOR_CONDITION_CHOICES,
  maxExposure,
  validateCouponForm,
} from "@/lib/core/coupon/issue";

/**
 * 쿠폰 발행 폼 (S5-13 · F-V-19)
 *
 * ── 이 폼이 지키는 규칙 ─────────────────────────────────────────────────────
 * 1. **누르기 전에 얼마가 나갈 수 있는지 보여 준다.** 업체 쿠폰의 할인액은 그 업체의
 *    정산에서 빠진다(D-27) — "10% 할인" 만 보고 정하면 고액 계약에서 무슨 일이
 *    벌어지는지 모른다.
 * 2. **판정은 순수 함수 하나가 한다.** 화면과 API 가 다른 답을 내면 버튼이 살아
 *    있는데 눌리지 않는다 — `validateCouponForm` 을 둘 다 쓴다.
 * 3. **리뷰 관련 조건은 선택지에 없다**(§7.7 · D-03). 목록 자체가 첫 번째 경계다.
 * 4. **정률에는 상한 칸이 필수로 뜬다.** 상한 없는 정률은 만들 수 없고, 그 사실을
 *    칸이 생기는 것으로 말한다.
 * 5. **서버가 막으면 그 문장을 그대로 보여준다** — 화면이 자기 말로 바꾸면 왜 막혔는지
 *    흐려진다.
 */
export function CouponForm({ platformRateCapBp }: { platformRateCapBp: number | null }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [form, setForm] = useState<CouponFormValues>({
    name: "",
    discountType: "amount",
    discountValue: 0,
    maxDiscountAmount: null,
    minOrderAmount: 0,
    issueCondition: VENDOR_CONDITION_CHOICES[0],
    validFrom: null,
    validTo: null,
    totalQuantity: null,
  });

  const errors: CouponFormError[] = validateCouponForm(form, platformRateCapBp);
  const ready = errors.length === 0 && !pending;
  const exposure = maxExposure({ ...form, issuedCount: 0 });

  function set<K extends keyof CouponFormValues>(key: K, value: CouponFormValues[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    setPending(true);
    setServerErrors([]);

    try {
      const response = await fetch("/api/vendor/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: { message?: string; details?: { reasons?: { message: string }[] } };
      };

      if (!response.ok || !payload.ok) {
        const reasons = payload.error?.details?.reasons ?? [];
        setServerErrors(
          reasons.length > 0
            ? reasons.map((reason) => reason.message)
            : [payload.error?.message ?? "쿠폰을 만들지 못했습니다."],
        );

        return;
      }

      setForm((prev) => ({ ...prev, name: "", discountValue: 0, totalQuantity: null }));
      router.refresh();
    } catch {
      setServerErrors(["네트워크 문제로 처리하지 못했어요. 잠시 후 다시 시도해 주세요."]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="coupon-form">
      <div className="space-y-1.5">
        <Label htmlFor="coupon-name">쿠폰 이름</Label>
        <Input
          id="coupon-name"
          value={form.name}
          maxLength={120}
          onChange={(event) => set("name", event.target.value)}
          placeholder="예) 가을 계약 고객 감사 쿠폰"
        />
        <p className="text-caption text-muted-foreground">고객이 쿠폰함에서 보는 이름입니다.</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="coupon-condition">발행 조건</Label>
        <select
          id="coupon-condition"
          value={form.issueCondition}
          onChange={(event) => set("issueCondition", event.target.value)}
          className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground"
          data-testid="coupon-condition"
        >
          {/* **리뷰 관련 값이 목록에 없다.** 화면이 첫 번째 경계다(§7.7 · D-03). */}
          {VENDOR_CONDITION_CHOICES.map((value) => (
            <option key={value} value={value}>
              {ISSUE_CONDITION_LABEL[value]}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-caption font-medium text-foreground">할인 방식</legend>
        <div className="flex gap-3">
          {(["amount", "rate"] as const).map((type) => (
            <label key={type} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="discountType"
                checked={form.discountType === type}
                onChange={() =>
                  setForm((prev) => ({
                    ...prev,
                    discountType: type,
                    // 방식을 바꾸면 상한도 함께 맞춘다 — 정액에 상한이 남아 있으면 막힌다.
                    maxDiscountAmount: type === "rate" ? (prev.maxDiscountAmount ?? 100_000) : null,
                    discountValue: 0,
                  }))
                }
              />
              {type === "amount" ? "정액(원)" : "정률(%)"}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="coupon-value">
            {form.discountType === "amount" ? "할인 금액(원)" : "할인율(%)"}
          </Label>
          <Input
            id="coupon-value"
            type="number"
            min={0}
            value={
              form.discountType === "amount"
                ? (form.discountValue || "")
                : (form.discountValue ? form.discountValue / 100 : "")
            }
            onChange={(event) => {
              const raw = Number(event.target.value);
              // **정률은 basis point 정수로만 다룬다**(부동소수점 금지 · CLAUDE.md §6).
              set(
                "discountValue",
                form.discountType === "amount" ? Math.trunc(raw) : Math.round(raw * 100),
              );
            }}
          />
        </div>

        {form.discountType === "rate" ? (
          <div className="space-y-1.5">
            <Label htmlFor="coupon-cap">할인 상한(원)</Label>
            <Input
              id="coupon-cap"
              type="number"
              min={1}
              value={form.maxDiscountAmount ?? ""}
              onChange={(event) =>
                set("maxDiscountAmount", event.target.value === "" ? null : Math.trunc(Number(event.target.value)))
              }
            />
            <p className="text-caption text-muted-foreground">
              <strong>정률에는 상한이 필요합니다.</strong> 없으면 고액 계약에서 정산이 통째로
              지워집니다.
            </p>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="coupon-min">최소 주문 금액(원)</Label>
          <Input
            id="coupon-min"
            type="number"
            min={0}
            value={form.minOrderAmount || ""}
            onChange={(event) => set("minOrderAmount", Math.trunc(Number(event.target.value) || 0))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="coupon-qty">발행 수량</Label>
          <Input
            id="coupon-qty"
            type="number"
            min={1}
            value={form.totalQuantity ?? ""}
            placeholder="비우면 제한 없음"
            onChange={(event) =>
              set("totalQuantity", event.target.value === "" ? null : Math.trunc(Number(event.target.value)))
            }
          />
        </div>
      </div>

      {/* ── 얼마가 나갈 수 있는가 ────────────────────────────────────────── */}
      <p
        className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground"
        data-testid="coupon-exposure"
      >
        {exposure === null ? (
          <>
            <strong>수량 제한을 비워 두면 앞으로 나갈 금액을 셀 수 없습니다.</strong> 무제한
            발행은 정산에서 얼마가 빠질지 아무도 답할 수 없다는 뜻입니다.
          </>
        ) : (
          <>
            이 설정이면 앞으로 최대{" "}
            <strong>{exposure.toLocaleString("ko-KR")}원</strong>이 우리 정산에서 빠질 수
            있습니다.
          </>
        )}
      </p>

      {errors.length > 0 ? (
        <ul className="space-y-1" data-testid="coupon-form-errors">
          {errors.map((code) => (
            <li key={code} className="text-caption text-warning">
              {COUPON_FORM_MESSAGE[code]}
            </li>
          ))}
        </ul>
      ) : null}

      {serverErrors.length > 0 ? (
        <ul className="space-y-1" role="alert">
          {serverErrors.map((message) => (
            <li key={message} className="text-caption text-warning">
              {message}
            </li>
          ))}
        </ul>
      ) : null}

      <Button type="button" disabled={!ready} onClick={submit}>
        {pending ? "발행 중…" : "쿠폰 발행"}
      </Button>
    </div>
  );
}
