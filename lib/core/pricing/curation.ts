// 참가격 원천 데이터 큐레이션 (S8-10 · F-A-02 · 명세서 §6.4 `/admin/prices`)
//
// **지수를 새로 만들지 않는다.** 산출은 S3-08 의 `buildPriceIndex` 가 이미 한다
// (업체당 한 건 · 보간 없는 nearest-rank · 표본 하한 5곳). 여기서 하는 일은
// **어떤 표본을 넣고 뺄지 정하고, 뺀 이유를 남기는 것**이다.
//
// F-A-02 가 요구하는 것: 수집 원천 데이터 검증 · 이상치 표시·제외 · 지수 재계산 실행 ·
// 출처·표본수 관리.

import { z } from "zod";

import { PRICE_INDEX_MIN_SAMPLE, type PriceSample, buildPriceIndex } from "./price-index";

/** 원천 표본 한 줄. `price_sources` 행 그대로다. */
export type SourceRow = {
  id: string;
  sourceName: string;
  rawValue: number;
  /** 있으면 이 표본은 지수 계산에서 빠진다. */
  excludedReason: string | null;
  verifiedBy: string | null;
  /** 이 값을 낸 업체. 지수는 업체당 한 건만 세므로 필요하다. */
  vendorId: string;
  productId: string | null;
};

/** 지금 계산에 들어가는 표본만. */
export function includedSamples(rows: readonly SourceRow[]): PriceSample[] {
  return rows
    .filter((row) => row.excludedReason === null)
    .map((row) => ({
      vendorId: row.vendorId,
      price: row.rawValue,
      productId: row.productId ?? undefined,
    }));
}

/**
 * 제외가 지수를 어떻게 움직이는가.
 *
 * **재계산을 누르기 전에 보여준다.** 표본 하나를 빼는 것은 지수를 움직이는 일이고,
 * 운영자가 그 영향을 모른 채 누르면 큐레이션이 아니라 손장난이 된다.
 *
 * 표본이 하한에 못 미치면 **값을 만들지 않는다** — `buildPriceIndex` 의 규칙 그대로다.
 */
export type CurationPreview = {
  includedCount: number;
  excludedCount: number;
  /** 계산에 실제로 들어가는 **업체 수**. 상품 수가 아니다. */
  vendorCount: number;
  minSample: number;
  /** 표본이 모자라면 `null` 이다. **0 이 아니다** — 0원 중앙값은 사실이 아니다. */
  p25: number | null;
  p50: number | null;
  p75: number | null;
  /** 왜 값이 없는지. 값이 있으면 `null`. */
  blockedReason: string | null;
};

export const INSUFFICIENT_FOR_CURATION =
  `계산에 들어간 업체가 ${PRICE_INDEX_MIN_SAMPLE}곳에 못 미쳐 사분위를 만들지 않았습니다. 적은 표본으로 낸 값은 시세가 아니라 우연입니다.`;

export function previewCuration(rows: readonly SourceRow[]): CurationPreview {
  const included = includedSamples(rows);
  const result = buildPriceIndex(included);
  const excludedCount = rows.length - included.length;

  if (!result.ok) {
    return {
      includedCount: included.length,
      excludedCount,
      vendorCount: result.sampleSize,
      minSample: PRICE_INDEX_MIN_SAMPLE,
      p25: null,
      p50: null,
      p75: null,
      blockedReason: INSUFFICIENT_FOR_CURATION,
    };
  }

  return {
    includedCount: included.length,
    excludedCount,
    vendorCount: result.sampleSize,
    minSample: PRICE_INDEX_MIN_SAMPLE,
    p25: result.p25,
    p50: result.p50,
    p75: result.p75,
    blockedReason: null,
  };
}

// ── 조치 ────────────────────────────────────────────────────────────────────
//
// **판정 어휘를 쓰지 않는다.** 표본을 빼는 것은 "이 값은 틀렸다" 는 선언이 아니라
// "이 값을 지수에 넣지 않기로 했다" 는 기록이다. 그래서 사유가 필수다 —
// **지워진 값이 왜 지워졌는지 답할 수 있어야 한다**(F-A-02).

export const CURATION_ACTIONS = ["exclude", "restore", "verify"] as const;
export type CurationAction = (typeof CURATION_ACTIONS)[number];

export const CURATION_ACTION_LABEL: Record<CurationAction, string> = {
  exclude: "지수에서 제외",
  restore: "제외 해제",
  verify: "확인함으로 표시",
};

export const CurationActionSchema = z
  .object({
    sourceId: z.string().uuid(),
    action: z.enum(CURATION_ACTIONS),
    /**
     * **제외에는 사유가 필수다**(DB CHECK 이 한 번 더 본다).
     * 해제·확인에도 받는다 — 되돌린 이유 역시 답할 수 있어야 한다.
     */
    reason: z.string().trim().min(1, "사유를 적어 주세요.").max(1_000),
  })
  .strict();

export type CurationActionInput = z.infer<typeof CurationActionSchema>;

/** 지금 이 조치를 할 수 있는가. */
export function canCurate(row: { excludedReason: string | null }, action: CurationAction): boolean {
  if (action === "exclude") return row.excludedReason === null;
  if (action === "restore") return row.excludedReason !== null;

  // 확인 표시는 언제든 다시 남길 수 있다 — 다른 사람이 다시 봤다는 사실도 기록이다.
  return true;
}

export function curationProblem(input: {
  row: { excludedReason: string | null };
  action: CurationAction | null;
  reason: string;
}): string | null {
  if (!input.action) return "조치를 선택해 주세요.";
  if (!canCurate(input.row, input.action)) {
    return input.action === "exclude"
      ? "이미 제외된 표본입니다."
      : "제외되지 않은 표본입니다.";
  }
  if (input.reason.trim().length === 0) return "사유를 적어 주세요.";

  return null;
}

/** 재계산 대상 한 칸. 지역·카테고리로 지정한다. */
export const RecalculateSchema = z
  .object({
    regionCode: z.string().trim().min(1, "지역을 지정해 주세요.").max(40),
    category: z.string().trim().min(1, "카테고리를 지정해 주세요.").max(40),
    reason: z.string().trim().min(1, "재계산 사유를 적어 주세요.").max(1_000),
  })
  .strict();

export type RecalculateInput = z.infer<typeof RecalculateSchema>;
