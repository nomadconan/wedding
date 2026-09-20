"use client";

import { REGIONS, SIDO_CODES, SIDO_LABEL } from "@/lib/core/region/regions";

/**
 * 지역 선택 (C-2f · F-C-10 · F-C-09 · F-C-13)
 *
 * **자유 입력을 없앤 자리다.** 그전에는 온보딩·문의·입점·탐색이 각자 `<input>` 이었고,
 * 같은 강남을 네 가지로 적었다("서울 강남" · "강남구" · "서울시 강남구" · "강남").
 * 어휘가 하나가 됐으니 **입력 수단도 하나**여야 한다 — 고를 수 없는 값은 애초에 못 적는다.
 *
 * 카테고리 셀렉트와 **같은 네이티브 `<select>`** 다(같은 화면에서 두 가지 조작법을
 * 쓰지 않는다). 73개가 평평하게 늘어서면 못 찾으므로 **시도로 묶는다** — 시도 자체도
 * 고를 수 있는 값이라 그룹 첫 항목으로 둔다("서울 전체").
 */
export type RegionSelectProps = {
  id: string;
  name?: string;
  /** 제어 컴포넌트로 쓸 때. 비우면 `defaultValue` 로 비제어 폼이 된다. */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** 빈 값을 고를 수 있는가. 탐색 필터·선택 입력은 `true`, 필수 입력은 `false`. */
  emptyLabel?: string;
  required?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
};

const FIELD =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function RegionSelect({
  id,
  name,
  value,
  defaultValue,
  onChange,
  emptyLabel,
  required,
  disabled,
  "aria-label": ariaLabel,
}: RegionSelectProps) {
  const controlled = value !== undefined;

  return (
    <select
      id={id}
      name={name}
      data-testid="region-select"
      aria-label={ariaLabel}
      required={required}
      disabled={disabled}
      className={FIELD}
      {...(controlled ? { value } : { defaultValue: defaultValue ?? "" })}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {emptyLabel === undefined ? null : <option value="">{emptyLabel}</option>}
      {SIDO_CODES.map((sido) => (
        <optgroup key={sido} label={SIDO_LABEL[sido]}>
          {REGIONS.filter((region) => region.sido === sido).map((region) => (
            <option key={region.code} value={region.code}>
              {region.code === sido ? `${region.label} 전체` : region.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
