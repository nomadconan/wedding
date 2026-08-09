"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  ADD_ONS_POLICY_NOTICE,
  PRODUCT_OPTION_MAX,
  needsRedeclaration,
} from "@/lib/core/schemas/product-option";
import type { ProductOption } from "@/lib/vendor/product-options";

/**
 * 추가금 사전 등록 (F-V-04, §6.3 `/vendor/products/[id]`)
 *
 * **'추가금 없음'과 '아직 안 적음'을 화면에서도 구분한다.**
 * 0건이어도 확정 버튼을 눌러야 "없다"는 진술이 되고, 그전까지는 미등록이다.
 * 항목을 추가·수정·삭제하면 확정이 풀린다 — 목록이 바뀌었으니 다시 확인해야 한다.
 *
 * 등록하지 않은 항목은 계약 이후 청구할 수 없다는 정책을 상시 표시한다.
 */
export type ProductOptionsProps = {
  productId: string;
  options: ProductOption[];
  declaredAt: string | null;
  canEdit: boolean;
};

const EMPTY_DRAFT = { name: "", price: "", isMandatory: false, conditionDescription: "" };

export function ProductOptions({ productId, options, declaredAt, canEdit }: ProductOptionsProps) {
  const router = useRouter();
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stale = needsRedeclaration(declaredAt, options);
  const total = options.reduce((sum, option) => sum + option.price, 0);

  async function call(path: string, init: RequestInit) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const body = await response.json();

      if (!response.ok || !body.ok) {
        const detail = Array.isArray(body.error?.details) ? body.error.details[0]?.message : null;
        setError(detail ?? body.error?.message ?? "처리하지 못했어요.");

        return false;
      }

      router.refresh();

      return true;
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");

      return false;
    } finally {
      setPending(false);
    }
  }

  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const price = Number(draft.price);
    const okDone = await call(`/api/vendor/products/${productId}/options`, {
      method: "POST",
      body: JSON.stringify({
        name: draft.name,
        price: Number.isInteger(price) ? price : Number.NaN,
        isMandatory: draft.isMandatory,
        conditionDescription: draft.conditionDescription || null,
      }),
    });

    if (okDone) setDraft(EMPTY_DRAFT);
  }

  return (
    <div className="space-y-4" data-testid="product-options">
      <p className="rounded-lg border border-warning bg-warning-surface p-3 text-sm text-warning-foreground">
        {ADD_ONS_POLICY_NOTICE}
      </p>

      {/* 확정 상태 — '없음'과 '미등록'을 구분해 적는다. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="declaration-state">
        {!declaredAt ? (
          <Badge variant="destructive">미등록</Badge>
        ) : stale ? (
          <Badge variant="destructive">재확정 필요</Badge>
        ) : options.length === 0 ? (
          <Badge>추가금 없음 (확정)</Badge>
        ) : (
          <Badge>
            {options.length}건 확정 · 최대 {formatKrw(total)}원
          </Badge>
        )}

        <span className="text-caption text-muted-foreground">
          {!declaredAt
            ? "확정하기 전에는 상품을 게시할 수 없습니다."
            : stale
              ? "항목이 바뀌었습니다. 다시 확정해 주세요."
              : "고객 화면에 이 상태로 표시됩니다."}
        </span>
      </div>

      {options.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          등록된 추가금이 없습니다. 정말 없다면 아래에서 &apos;추가금 없음&apos;으로 확정하세요.
        </p>
      ) : (
        <ul className="space-y-2">
          {options.map((option) => (
            <li
              key={option.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{option.name}</span>
                  {option.isMandatory ? (
                    <Badge variant="secondary">필수</Badge>
                  ) : (
                    <Badge variant="outline">조건부</Badge>
                  )}
                </div>
                <p className="text-caption text-muted-foreground">
                  {option.isMandatory
                    ? "항상 발생"
                    : (option.conditionDescription ?? "발생 조건 미기재")}
                </p>
              </div>

              <span data-amount="" className="text-unit font-medium">
                {formatKrw(option.price)}원
              </span>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canEdit || pending}
                onClick={() =>
                  call(`/api/vendor/products/${productId}/options/${option.id}`, {
                    method: "DELETE",
                  })
                }
              >
                삭제
              </Button>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Separator />

      {canEdit ? (
        <>
          <form onSubmit={add} className="space-y-3" data-testid="option-form">
            <p className="text-sm font-medium">항목 추가</p>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="option-name">항목 이름</Label>
                <Input
                  id="option-name"
                  required
                  maxLength={60}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="예: 원판 촬영, 주말 할증"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="option-price">금액 (원)</Label>
                <Input
                  id="option-price"
                  type="number"
                  min={0}
                  step={1}
                  required
                  value={draft.price}
                  onChange={(event) => setDraft({ ...draft, price: event.target.value })}
                  placeholder="300000"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="option-mandatory"
                checked={draft.isMandatory}
                onCheckedChange={(checked) =>
                  setDraft({ ...draft, isMandatory: checked === true, conditionDescription: "" })
                }
              />
              <Label htmlFor="option-mandatory" className="font-normal">
                항상 발생하는 필수 추가금입니다
              </Label>
            </div>

            {!draft.isMandatory ? (
              <div className="space-y-1.5">
                <Label htmlFor="option-condition">발생 조건</Label>
                <Input
                  id="option-condition"
                  required
                  maxLength={200}
                  value={draft.conditionDescription}
                  onChange={(event) =>
                    setDraft({ ...draft, conditionDescription: event.target.value })
                  }
                  placeholder="예: 토요일·공휴일 예식 시 / 하객 250명 초과 시"
                />
                <p className="text-caption text-muted-foreground">
                  언제 내는 돈인지 적어야 사전 등록으로 인정됩니다.
                </p>
              </div>
            ) : null}

            <Button type="submit" variant="outline" disabled={pending || options.length >= PRODUCT_OPTION_MAX}>
              {pending ? "처리 중…" : "추가금 등록"}
            </Button>
          </form>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={pending || (Boolean(declaredAt) && !stale)}
              data-testid="declare-button"
              onClick={() =>
                call(`/api/vendor/products/${productId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ declareAddOns: true }),
                })
              }
            >
              {options.length === 0 ? "'추가금 없음'으로 확정" : "이 목록으로 확정"}
            </Button>

            {declaredAt ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  call(`/api/vendor/products/${productId}`, {
                    method: "PATCH",
                    body: JSON.stringify({ declareAddOns: false }),
                  })
                }
              >
                확정 해제
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          추가금은 업체 대표 계정만 등록·수정할 수 있습니다.
        </p>
      )}
    </div>
  );
}

export default ProductOptions;
