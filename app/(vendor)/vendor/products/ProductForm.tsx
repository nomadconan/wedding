"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { PriceDisplay, formatKrw } from "@/components/domain/PriceDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { calculateSettlement } from "@/lib/core/pricing/rates";
import {
  VENDOR_PRICING_NOTICE,
  productPublishBlockers,
  type IncludedItem,
} from "@/lib/core/schemas/product";
import {
  VENDOR_CATEGORIES,
  VENDOR_CATEGORY_LABEL,
  type VendorCategory,
} from "@/lib/core/schemas/vendor";

/**
 * 상품 등록·수정 폼 (F-V-03, §6.3 `/vendor/products`)
 *
 * **총액 표기 강제의 UI 층이다.**
 *  - 판매가 입력은 `type="number"` + 필수 + 최소 1원이다. 자유 텍스트 가격 칸이 없다.
 *  - "별도 문의" 를 상품명·포함 항목으로 우회하면 서버가 422 로 막고 그 메시지를 여기 띄운다.
 *  - 게시 체크리스트를 **입력 중에 실시간**으로 보여준다. 저장 후에야 알려주면
 *    업체는 무엇이 모자란지 모른 채 게시 버튼만 누르게 된다.
 *
 * **예상 정산액**은 `lib/core/pricing` 의 순수 함수로 계산한다.
 * 요율(bp)은 서버가 `resolveRate` 로 해석해 넘겨준 값이며 **화면에 숫자를 박지 않는다**(O-02).
 * 요율이 없으면 금액을 만들지 않고 "요율 미설정" 으로 적는다.
 */
export type RateInfo =
  | { available: true; feeRateBp: number; scopeType: string }
  | { available: false; reason: string; detail: string };

export type ProductFormProps = {
  /** 수정 대상. 없으면 신규 등록이다. */
  product?: {
    id: string;
    name: string;
    category: string;
    basePriceTotal: number;
    includedItems: IncludedItem[];
    capacityMin: number | null;
    capacityMax: number | null;
    priceIncludesVat: boolean;
  };
  rate: RateInfo;
  /** 업체 기본 카테고리. 신규 등록의 초기값이다. */
  defaultCategory: string;
  canEdit: boolean;
};

const SCOPE_LABEL: Record<string, string> = {
  vendor: "업체별 요율",
  category: "카테고리 요율",
  global: "전역 요율",
};

export function ProductForm({ product, rate, defaultCategory, canEdit }: ProductFormProps) {
  const router = useRouter();
  const isEdit = Boolean(product);

  const [name, setName] = useState(product?.name ?? "");
  const [category, setCategory] = useState<VendorCategory>(
    (product?.category ?? defaultCategory) as VendorCategory,
  );
  const [price, setPrice] = useState(product ? String(product.basePriceTotal) : "");
  const [items, setItems] = useState<IncludedItem[]>(product?.includedItems ?? []);
  const [capacityMin, setCapacityMin] = useState(
    product?.capacityMin === null || product?.capacityMin === undefined ? "" : String(product.capacityMin),
  );
  const [capacityMax, setCapacityMax] = useState(
    product?.capacityMax === null || product?.capacityMax === undefined ? "" : String(product.capacityMax),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const priceNumber = Number(price);
  const priceValid = price.trim() !== "" && Number.isInteger(priceNumber) && priceNumber > 0;

  const blockers = productPublishBlockers({
    name,
    basePriceTotal: priceValid ? priceNumber : 0,
    includedItems: items,
  });

  // 요율이 있을 때만 금액을 만든다. 없으면 계산 자체를 하지 않는다.
  const settlement =
    rate.available && priceValid
      ? calculateSettlement({ salePrice: priceNumber, feeRateBp: rate.feeRateBp })
      : null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setFieldErrors({});

    const payload = {
      name,
      category,
      basePriceTotal: priceValid ? priceNumber : Number.NaN,
      includedItems: items.filter((item) => item.label.trim().length > 0),
      capacityMin: capacityMin.trim() === "" ? null : Number(capacityMin),
      capacityMax: capacityMax.trim() === "" ? null : Number(capacityMax),
    };

    try {
      const response = await fetch(
        isEdit ? `/api/vendor/products/${product!.id}` : "/api/vendor/products",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      const body = await response.json();

      if (!response.ok || !body.ok) {
        if (Array.isArray(body.error?.details)) {
          setFieldErrors(
            Object.fromEntries(
              body.error.details
                .filter((d: { field?: string }) => typeof d.field === "string")
                .map((d: { field: string; message: string }) => [d.field, d.message]),
            ),
          );
        }
        setError(body.error?.message ?? "저장하지 못했어요.");

        return;
      }

      router.push(`/vendor/products/${body.data.product.id}`);
      router.refresh();
    } catch {
      setError("저장하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6" data-testid="product-form">
      {/* F-V-03 — 등록 화면에 상시 표시한다. 접거나 숨기지 않는다. */}
      <p
        data-testid="pricing-notice"
        className="rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm text-brand-700"
      >
        {VENDOR_PRICING_NOTICE}
      </p>

      <fieldset disabled={!canEdit || pending} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">상품명</Label>
            <Input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={100}
              placeholder="예: 단독홀 대관 패키지"
            />
            {fieldErrors.name ? <p className="text-caption text-danger">{fieldErrors.name}</p> : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="category">카테고리</Label>
            <Select value={category} onValueChange={(value) => setCategory(value as VendorCategory)}>
              <SelectTrigger id="category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VENDOR_CATEGORIES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {VENDOR_CATEGORY_LABEL[code]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="basePriceTotal">총액 (원)</Label>
            <Input
              id="basePriceTotal"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              required
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              placeholder="12500000"
            />
            <p className="text-caption text-muted-foreground">
              숫자만 입력합니다. &apos;별도 문의&apos;·&apos;협의&apos;로는 등록할 수 없습니다.
            </p>
            {fieldErrors.basePriceTotal ? (
              <p className="text-caption text-danger">{fieldErrors.basePriceTotal}</p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="capacityMin">수용 인원 (최소)</Label>
              <Input
                id="capacityMin"
                inputMode="numeric"
                value={capacityMin}
                onChange={(event) => setCapacityMin(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="capacityMax">수용 인원 (최대)</Label>
              <Input
                id="capacityMax"
                inputMode="numeric"
                value={capacityMax}
                onChange={(event) => setCapacityMax(event.target.value)}
              />
              {fieldErrors.capacityMax ? (
                <p className="text-caption text-danger">{fieldErrors.capacityMax}</p>
              ) : null}
            </div>
          </div>
        </div>

        {/* ── 포함 항목 ─────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <Label>포함 항목</Label>
              <p className="text-caption text-muted-foreground">
                총액에 무엇이 들어 있는지 밝힙니다. 게시하려면 1개 이상 필요합니다.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setItems((prev) => [...prev, { label: "", note: null }])}
            >
              항목 추가
            </Button>
          </div>

          {items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              등록된 포함 항목이 없습니다.
            </p>
          ) : (
            <ul className="space-y-2">
              {items.map((item, index) => (
                <li key={index} className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label={`포함 항목 ${index + 1}`}
                    value={item.label}
                    maxLength={60}
                    placeholder="예: 홀 대관 4시간"
                    className="max-w-xs"
                    onChange={(event) =>
                      setItems((prev) =>
                        prev.map((row, i) => (i === index ? { ...row, label: event.target.value } : row)),
                      )
                    }
                  />
                  <Input
                    aria-label={`포함 항목 ${index + 1} 부연`}
                    value={item.note ?? ""}
                    maxLength={120}
                    placeholder="부연 (선택)"
                    className="max-w-xs"
                    onChange={(event) =>
                      setItems((prev) =>
                        prev.map((row, i) =>
                          i === index ? { ...row, note: event.target.value || null } : row,
                        ),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                  >
                    삭제
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {fieldErrors["includedItems.0.label"] ? (
            <p className="text-caption text-danger">{fieldErrors["includedItems.0.label"]}</p>
          ) : null}
        </div>

        <Separator />

        {/* ── 고객 노출가와 예상 정산액 ──────────────────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-border p-4">
            <p className="mb-2 text-sm font-medium">고객에게 보이는 가격</p>
            <PriceDisplay
              label="총액"
              amount={priceValid ? priceNumber : "unknown"}
              basePrice={priceValid ? priceNumber : "unknown"}
              taxIncluded={product?.priceIncludesVat ?? true}
              // 추가금 사전 등록은 S2-04 다. 아직 등록하지 않았다는 사실을 그대로 적는다.
              addOns={{ kind: "unknown" }}
              // 업체 화면은 플래너 선택 맥락이 아니다.
              plannerFee={{ kind: "unavailable" }}
              size="md"
            />
          </div>

          <div className="rounded-lg border border-border p-4" data-testid="settlement-estimate">
            <p className="mb-2 text-sm font-medium">예상 정산액</p>

            {!rate.available ? (
              <div className="space-y-1">
                <p className="text-amount-sm text-muted-foreground" data-testid="rate-unavailable">
                  요율 미설정
                </p>
                <p className="text-caption text-warning">
                  적용 요율이 아직 등록되지 않아 정산액을 계산할 수 없습니다. 운영자가 요율을
                  등록하면 이 자리에 표시됩니다.
                </p>
              </div>
            ) : settlement === null ? (
              <p className="text-sm text-muted-foreground">총액을 입력하면 계산됩니다.</p>
            ) : (
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-unit text-muted-foreground">판매가</dt>
                  <dd data-amount="" className="font-medium">
                    {formatKrw(settlement.salePrice)}원
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-unit text-muted-foreground">
                    수수료 ({SCOPE_LABEL[rate.scopeType] ?? rate.scopeType})
                  </dt>
                  <dd data-amount="" className="font-medium text-muted-foreground">
                    -{formatKrw(settlement.feeAmount)}원
                  </dd>
                </div>
                <div className="flex justify-between border-t border-border pt-1">
                  <dt className="text-unit text-muted-foreground">예상 정산액</dt>
                  <dd data-amount="" className="text-amount-sm text-foreground">
                    {formatKrw(settlement.netAmount)}원
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </div>

        {/* ── 게시 체크리스트 ───────────────────────────────────────────── */}
        <div className="space-y-1.5" data-testid="publish-checklist">
          <p className="text-sm font-medium">게시 조건</p>
          {blockers.length === 0 ? (
            <p className="text-sm text-success">· 게시 조건을 모두 채웠습니다.</p>
          ) : (
            <ul className="space-y-0.5">
              {blockers.map((blocker) => (
                <li key={blocker.code} className="text-sm text-warning">
                  · {blocker.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {canEdit ? (
        <Button type="submit" size="touch" disabled={pending}>
          {pending ? "저장 중…" : isEdit ? "상품 저장" : "상품 등록"}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          상품·가격은 업체 대표 계정만 등록·수정할 수 있습니다.
        </p>
      )}
    </form>
  );
}

export default ProductForm;
