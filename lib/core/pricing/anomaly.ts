// 가격 이상 탐지 (S8-10 · F-A-14 · 명세서 §5.7)
//
// ══════════════════════════════════════════════════════════════════════════
// **기준이 없으면 탐지하지 않는다.**
// ══════════════════════════════════════════════════════════════════════════
//
// §5.7 은 임계값을 적어 두었지만 **본문이 스스로 "(가정)" 이라 밝히고** "임계값은
// app_settings 로 관리하여 데이터 축적 후 조정한다" 고 이어 쓴다. 그 숫자는 명세가
// 정한 값이 아니라 **자리표시**다(O-19).
//
// 지금 `price_index` 는 표본이 대부분 부족해 사분위 자체가 없고, 그 위에서 "-40% 면
// 미끼" 를 돌리면 **없는 기준으로 업체를 의심 목록에 올리는 일**이 된다. 광고를 받지
// 않는 대신 공정함으로 신뢰를 사는 구조(D-03)에서 가장 하면 안 되는 실수다.
//
// **그리고 이것은 판정이 아니라 큐다**(D-24). 플래그가 붙었다고 아무 일도 자동으로
// 일어나지 않는다 — 운영자가 보고 정한다. 자동 제재·자동 비공개를 만들지 않았다.

import { z } from "zod";

/** 임계값이 정해질 때까지 기다리는 자리. */
export const ANOMALY_OPEN_ISSUE = "O-19";

/**
 * `app_settings` 에서 읽은 임계값. **미결이면 `null`** 이다.
 * `readIntSetting` 이 `null` 을 0 으로 읽지 않는다(S7-17 이 물린 자리).
 */
export type AnomalyThresholds = {
  /** 미끼 의심: 지수 중앙값 대비 이만큼 낮으면(bp). */
  baitGapBp: number | null;
  /** 추가금 과다: 견적 대비 이만큼 넘으면(bp). */
  addonExcessBp: number | null;
};

export const ANOMALY_KINDS = ["bait_price", "addon_excess"] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

export const ANOMALY_KIND_LABEL: Record<AnomalyKind, string> = {
  bait_price: "미끼 의심",
  addon_excess: "추가금 과다",
};

/**
 * 탐지 결과 한 건. **판정이 아니라 "봐 달라" 는 표시**다.
 *
 * `basis` 는 무엇과 무엇을 비교했는지 그대로 담는다 — 운영자가 그 숫자를 다시 세어
 * 볼 수 있어야 큐가 근거가 된다(0 에 근거를 붙이는 것과 같은 규칙).
 */
export type AnomalyFlag = {
  kind: AnomalyKind;
  /** 대상. 미끼는 상품, 추가금은 계약이다. */
  targetType: "product" | "contract";
  targetId: string;
  vendorId: string;
  /** 얼마나 벗어났는가(bp). 부호는 종류마다 뜻이 다르다 — 라벨이 설명한다. */
  gapBp: number;
  thresholdBp: number;
  basis: string;
};

/** 탐지를 아예 못 하는 이유. **"이상 없음" 과 구분한다**(함정 2). */
export type AnomalyBlocked =
  | { reason: "threshold_undecided"; openIssue: string; missing: string[] }
  | { reason: "no_index"; note: string };

export type AnomalyScan =
  | { status: "scanned"; flags: AnomalyFlag[]; checked: number }
  | { status: "blocked"; blocked: AnomalyBlocked };

export const THRESHOLD_UNDECIDED_NOTICE =
  "이상 탐지 임계값이 아직 정해지지 않아 탐지를 돌리지 않았습니다. 기준 없이 업체를 의심 목록에 올리지 않습니다.";

export const NO_INDEX_NOTICE =
  "비교할 참가격 지수가 없습니다. 표본이 모이지 않은 구간을 '가격이 없다'로 읽지 마세요 — 아직 세지 않은 것입니다.";

// ── 미끼 의심 ───────────────────────────────────────────────────────────────

export type ProductSample = {
  productId: string;
  vendorId: string;
  price: number;
  /** 이 상품으로 실제 성사된 건이 있는가. §5.7 이 요구하는 두 번째 조건이다. */
  hasBooking: boolean;
};

/**
 * 등록가가 지수 중앙값보다 얼마나 낮은가(bp). 낮을수록 큰 양수.
 *
 * **정수만 쓴다.** `(p50 - price) * 10000 / p50` 을 정수 나눗셈으로 계산한다.
 */
export function belowMedianBp(price: number, p50: number): number {
  if (p50 <= 0) throw new RangeError("중앙값은 0보다 커야 합니다.");

  return Math.round(((p50 - price) * 10_000) / p50);
}

/**
 * 미끼 의심을 고른다.
 *
 * §5.7 의 조건 **둘 다** 만족해야 한다: (가) 지수 대비 임계 이상 낮고
 * (나) **실제 성사 건이 없다**. 싸다는 것만으로는 미끼가 아니다 — 정말 싸게 파는
 * 업체가 있고, 그 업체를 의심 목록에 올리는 것이 이 서비스가 없애려는 종류의 신호다.
 */
export function detectBaitPrices(
  products: readonly ProductSample[],
  p50: number | null,
  thresholds: AnomalyThresholds,
): AnomalyScan {
  if (thresholds.baitGapBp === null) {
    return {
      status: "blocked",
      blocked: {
        reason: "threshold_undecided",
        openIssue: ANOMALY_OPEN_ISSUE,
        missing: ["pricing.bait_gap_bp"],
      },
    };
  }

  if (p50 === null || p50 <= 0) {
    return { status: "blocked", blocked: { reason: "no_index", note: NO_INDEX_NOTICE } };
  }

  const threshold = thresholds.baitGapBp;
  const flags: AnomalyFlag[] = [];

  for (const product of products) {
    if (product.hasBooking) continue;

    const gapBp = belowMedianBp(product.price, p50);
    if (gapBp < threshold) continue;

    flags.push({
      kind: "bait_price",
      targetType: "product",
      targetId: product.productId,
      vendorId: product.vendorId,
      gapBp,
      thresholdBp: threshold,
      basis: `등록가 ${product.price.toLocaleString("en-US")}원 · 지수 중앙값 ${p50.toLocaleString("en-US")}원 · 성사 건 없음`,
    });
  }

  return { status: "scanned", flags: sortFlags(flags), checked: products.length };
}

// ── 추가금 과다 ─────────────────────────────────────────────────────────────

export type ContractSample = {
  contractId: string;
  vendorId: string;
  /** 견적 총액. 없으면 비교할 것이 없다. */
  quoteTotal: number | null;
  contractTotal: number;
};

/** 계약 총액이 견적보다 얼마나 넘었는가(bp). */
export function aboveQuoteBp(contractTotal: number, quoteTotal: number): number {
  if (quoteTotal <= 0) throw new RangeError("견적 총액은 0보다 커야 합니다.");

  return Math.round(((contractTotal - quoteTotal) * 10_000) / quoteTotal);
}

export function detectAddonExcess(
  contracts: readonly ContractSample[],
  thresholds: AnomalyThresholds,
): AnomalyScan {
  if (thresholds.addonExcessBp === null) {
    return {
      status: "blocked",
      blocked: {
        reason: "threshold_undecided",
        openIssue: ANOMALY_OPEN_ISSUE,
        missing: ["pricing.addon_excess_bp"],
      },
    };
  }

  const threshold = thresholds.addonExcessBp;
  const flags: AnomalyFlag[] = [];
  let checked = 0;

  for (const contract of contracts) {
    // **견적이 없으면 세지 않는다.** 0 으로 두면 모든 계약이 무한대 초과가 된다.
    if (contract.quoteTotal === null || contract.quoteTotal <= 0) continue;

    checked += 1;
    const gapBp = aboveQuoteBp(contract.contractTotal, contract.quoteTotal);
    if (gapBp < threshold) continue;

    flags.push({
      kind: "addon_excess",
      targetType: "contract",
      targetId: contract.contractId,
      vendorId: contract.vendorId,
      gapBp,
      thresholdBp: threshold,
      basis: `견적 ${contract.quoteTotal.toLocaleString("en-US")}원 → 계약 ${contract.contractTotal.toLocaleString("en-US")}원`,
    });
  }

  return { status: "scanned", flags: sortFlags(flags), checked };
}

/**
 * 큰 편차부터. 같으면 id 로 갈라 **순서를 고정한다** — 같은 큐를 두 번 열었을 때
 * 순서가 달라지면 읽는 사람이 목록을 의심한다(S8-02·S8-03 과 같은 규칙).
 */
export function sortFlags(flags: readonly AnomalyFlag[]): AnomalyFlag[] {
  return [...flags].sort((a, b) => {
    if (a.gapBp !== b.gapBp) return b.gapBp - a.gapBp;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;

    return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
  });
}

// ── 운영자 조치 ─────────────────────────────────────────────────────────────
//
// **판정 어휘를 쓰지 않는다**(S8-03 이 테스트로 고정한 규칙). 여기서 하는 일은
// 경고를 보냈다·배지를 회수했다·보고 아무것도 하지 않기로 했다 를 **기록**하는 것이다.
// 자동 제재·자동 비공개가 없으므로 이 기록이 곧 조치의 전부다.

export const ANOMALY_ACTIONS = ["warn", "revoke_badge", "no_action"] as const;
export type AnomalyAction = (typeof ANOMALY_ACTIONS)[number];

export const ANOMALY_ACTION_LABEL: Record<AnomalyAction, string> = {
  warn: "업체에 안내함",
  revoke_badge: "배지 회수함",
  no_action: "조치 없음으로 종결",
};

export const AnomalyActionSchema = z
  .object({
    kind: z.enum(ANOMALY_KINDS),
    targetType: z.enum(["product", "contract"]),
    targetId: z.string().uuid(),
    vendorId: z.string().uuid(),
    action: z.enum(ANOMALY_ACTIONS),
    /** **'조치 없음' 에도 사유가 필수다**(S7-17) — 안 한 것도 설명해야 한다. */
    reason: z.string().trim().min(1, "사유를 적어 주세요.").max(1_000),
  })
  .strict();

export type AnomalyActionInput = z.infer<typeof AnomalyActionSchema>;

/** 화면이 저장을 막는 이유. 없으면 `null`. */
export function anomalyProblem(input: {
  action: AnomalyAction | null;
  reason: string;
}): string | null {
  if (!input.action) return "조치를 선택해 주세요.";
  if (input.reason.trim().length === 0) return "사유를 적어 주세요.";

  return null;
}
