import { describe, expect, it } from "vitest";

import {
  ANOMALY_ACTIONS,
  ANOMALY_OPEN_ISSUE,
  type AnomalyThresholds,
  AnomalyActionSchema,
  aboveQuoteBp,
  anomalyProblem,
  belowMedianBp,
  detectAddonExcess,
  detectBaitPrices,
  sortFlags,
} from "./anomaly";
import {
  CURATION_ACTIONS,
  CurationActionSchema,
  RecalculateSchema,
  type SourceRow,
  canCurate,
  curationProblem,
  includedSamples,
  previewCuration,
} from "./curation";
import { PRICE_INDEX_MIN_SAMPLE } from "./price-index";

const UUID = "00000000-0000-0000-0000-0000000000a1";
const OPEN: AnomalyThresholds = { baitGapBp: 4_000, addonExcessBp: 2_500 };
const UNDECIDED: AnomalyThresholds = { baitGapBp: null, addonExcessBp: null };

const product = (over: Partial<Parameters<typeof detectBaitPrices>[0][number]> = {}) => ({
  productId: "p1",
  vendorId: "v1",
  price: 10_000_000,
  hasBooking: false,
  ...over,
});

// ══ 임계값이 없으면 탐지하지 않는다 (O-19) ═════════════════════════════════

describe("detectBaitPrices — 기준이 없으면 돌지 않는다", () => {
  it("**임계값이 미결이면 탐지하지 않는다 — 빈 결과가 아니라 blocked 다**", () => {
    const scan = detectBaitPrices([product({ price: 1 })], 30_000_000, UNDECIDED);

    expect(scan.status).toBe("blocked");
    expect(scan.status === "blocked" && scan.blocked.reason).toBe("threshold_undecided");
  });

  it("blocked 는 어느 미결 이슈인지 밝힌다", () => {
    const scan = detectBaitPrices([], 30_000_000, UNDECIDED);

    expect(
      scan.status === "blocked" && scan.blocked.reason === "threshold_undecided"
        ? scan.blocked.openIssue
        : null,
    ).toBe(ANOMALY_OPEN_ISSUE);
  });

  it("**'기준 없음' 과 '이상 없음' 이 같은 값이 아니다**(함정 2)", () => {
    const blocked = detectBaitPrices([product()], 30_000_000, UNDECIDED);
    const clean = detectBaitPrices([product({ price: 30_000_000 })], 30_000_000, OPEN);

    expect(blocked.status).toBe("blocked");
    expect(clean.status).toBe("scanned");
    expect(blocked).not.toEqual(clean);
  });

  it("**지수가 없으면 탐지하지 않는다** — 표본 부족을 '가격이 없다' 로 읽지 않는다", () => {
    const scan = detectBaitPrices([product()], null, OPEN);

    expect(scan.status === "blocked" && scan.blocked.reason).toBe("no_index");
  });

  it("중앙값이 0이어도 나누지 않는다", () => {
    expect(detectBaitPrices([product()], 0, OPEN).status).toBe("blocked");
  });
});

describe("belowMedianBp", () => {
  it("절반이면 5000bp", () => {
    expect(belowMedianBp(15_000_000, 30_000_000)).toBe(5_000);
  });

  it("같으면 0", () => {
    expect(belowMedianBp(30_000_000, 30_000_000)).toBe(0);
  });

  it("비싸면 음수다 — 자르지 않는다", () => {
    expect(belowMedianBp(36_000_000, 30_000_000)).toBe(-2_000);
  });

  it("정수만 낸다", () => {
    expect(Number.isInteger(belowMedianBp(11_111_111, 30_000_000))).toBe(true);
  });

  it("중앙값이 0 이하면 던진다", () => {
    expect(() => belowMedianBp(1, 0)).toThrow(RangeError);
  });
});

describe("detectBaitPrices — 두 조건을 다 만족해야 한다 (§5.7)", () => {
  const p50 = 30_000_000;

  it("임계보다 낮고 성사 건이 없으면 플래그", () => {
    const scan = detectBaitPrices([product({ price: 15_000_000 })], p50, OPEN);

    expect(scan.status === "scanned" && scan.flags).toHaveLength(1);
  });

  it("**성사 건이 있으면 플래그하지 않는다** — 싸다는 것만으로는 미끼가 아니다", () => {
    const scan = detectBaitPrices(
      [product({ price: 15_000_000, hasBooking: true })],
      p50,
      OPEN,
    );

    expect(scan.status === "scanned" && scan.flags).toHaveLength(0);
  });

  it("임계에 못 미치면 플래그하지 않는다", () => {
    // 30% 낮음 < 40% 임계
    const scan = detectBaitPrices([product({ price: 21_000_000 })], p50, OPEN);

    expect(scan.status === "scanned" && scan.flags).toHaveLength(0);
  });

  it("정확히 임계면 플래그다 — 경계는 잡는 쪽에 둔다", () => {
    const scan = detectBaitPrices([product({ price: 18_000_000 })], p50, OPEN);

    expect(scan.status === "scanned" && scan.flags).toHaveLength(1);
  });

  it("검사한 개수를 함께 낸다 — 0건이 '아무것도 안 봤다' 로 읽히지 않게", () => {
    const scan = detectBaitPrices([product({ price: p50 }), product({ productId: "p2" })], p50, OPEN);

    expect(scan.status === "scanned" && scan.checked).toBe(2);
  });

  it("플래그에 근거가 붙는다 — 운영자가 다시 세어 볼 수 있어야 한다", () => {
    const scan = detectBaitPrices([product({ price: 15_000_000 })], p50, OPEN);
    const flag = scan.status === "scanned" ? scan.flags[0] : null;

    expect(flag?.basis).toContain("15,000,000");
    expect(flag?.basis).toContain("30,000,000");
    expect(flag?.thresholdBp).toBe(4_000);
  });
});

describe("detectAddonExcess", () => {
  const contract = (over = {}) => ({
    contractId: "c1",
    vendorId: "v1",
    quoteTotal: 10_000_000,
    contractTotal: 13_000_000,
    ...over,
  });

  it("임계값이 미결이면 돌지 않는다", () => {
    expect(detectAddonExcess([contract()], UNDECIDED).status).toBe("blocked");
  });

  it("견적 대비 초과하면 플래그", () => {
    const scan = detectAddonExcess([contract()], OPEN);

    expect(scan.status === "scanned" && scan.flags[0].gapBp).toBe(3_000);
  });

  it("임계 미만이면 플래그하지 않는다", () => {
    const scan = detectAddonExcess([contract({ contractTotal: 11_000_000 })], OPEN);

    expect(scan.status === "scanned" && scan.flags).toHaveLength(0);
  });

  it("**견적이 없으면 세지 않는다** — 0 으로 두면 모든 계약이 무한대 초과가 된다", () => {
    const scan = detectAddonExcess([contract({ quoteTotal: null })], OPEN);

    expect(scan.status === "scanned" && scan.flags).toHaveLength(0);
    expect(scan.status === "scanned" && scan.checked).toBe(0);
  });

  it("견적이 0 이어도 나누지 않는다", () => {
    expect(() => aboveQuoteBp(1, 0)).toThrow(RangeError);
    expect(detectAddonExcess([contract({ quoteTotal: 0 })], OPEN).status).toBe("scanned");
  });
});

describe("sortFlags — 순서가 고정이다", () => {
  const flag = (over = {}) => ({
    kind: "bait_price" as const,
    targetType: "product" as const,
    targetId: "a",
    vendorId: "v",
    gapBp: 1_000,
    thresholdBp: 500,
    basis: "",
    ...over,
  });

  it("편차가 큰 것부터", () => {
    const sorted = sortFlags([flag({ targetId: "a", gapBp: 100 }), flag({ targetId: "b", gapBp: 900 })]);

    expect(sorted.map((f) => f.targetId)).toEqual(["b", "a"]);
  });

  it("같은 입력이면 같은 출력이다", () => {
    const rows = [flag({ targetId: "a" }), flag({ targetId: "b" })];

    expect(sortFlags(rows)).toEqual(sortFlags([...rows].reverse()));
  });

  it("입력을 바꾸지 않는다", () => {
    const rows = [flag({ targetId: "z", gapBp: 1 }), flag({ targetId: "a", gapBp: 9 })];
    sortFlags(rows);

    expect(rows[0].targetId).toBe("z");
  });
});

describe("조치 — 판정 어휘를 쓰지 않는다 (D-24)", () => {
  it("셋뿐이고 전부 **기록하는** 일이다", () => {
    expect([...ANOMALY_ACTIONS]).toEqual(["warn", "revoke_badge", "no_action"]);
  });

  it("**자동 제재·비공개 조치가 없다**", () => {
    for (const forbidden of ["suspend", "hide", "delist", "ban", "penalize", "auto_hide"]) {
      expect(ANOMALY_ACTIONS as readonly string[]).not.toContain(forbidden);
    }
  });

  it.each(ANOMALY_ACTIONS)("**%s 에도 사유가 필수다** — '조치 없음' 도 설명해야 한다", (action) => {
    expect(() =>
      AnomalyActionSchema.parse({
        kind: "bait_price", targetType: "product", targetId: UUID, vendorId: UUID,
        action, reason: "   ",
      }),
    ).toThrow();
  });

  it("모르는 조치는 받지 않는다", () => {
    expect(() =>
      AnomalyActionSchema.parse({
        kind: "bait_price", targetType: "product", targetId: UUID, vendorId: UUID,
        action: "suspend", reason: "x",
      }),
    ).toThrow();
  });

  it("anomalyProblem 이 화면을 막는다", () => {
    expect(anomalyProblem({ action: null, reason: "x" })).not.toBeNull();
    expect(anomalyProblem({ action: "warn", reason: " " })).toBe("사유를 적어 주세요.");
    expect(anomalyProblem({ action: "no_action", reason: "확인했고 정상" })).toBeNull();
  });
});

// ══ 큐레이션 ════════════════════════════════════════════════════════════════

const source = (over: Partial<SourceRow> = {}): SourceRow => ({
  id: "s1",
  sourceName: "등록가",
  rawValue: 10_000_000,
  excludedReason: null,
  verifiedBy: null,
  vendorId: "v1",
  productId: "p1",
  ...over,
});

const many = (n: number, price = 10_000_000) =>
  Array.from({ length: n }, (_, i) =>
    source({ id: `s${i}`, vendorId: `v${i}`, productId: `p${i}`, rawValue: price + i }),
  );

describe("includedSamples", () => {
  it("제외된 표본은 계산에 안 들어간다", () => {
    const rows = [source({ id: "a" }), source({ id: "b", excludedReason: "중복 수집", verifiedBy: "u" })];

    expect(includedSamples(rows)).toHaveLength(1);
  });

  it("업체 id 를 그대로 넘긴다 — 지수는 업체당 한 건만 센다", () => {
    expect(includedSamples([source({ vendorId: "vX" })])[0].vendorId).toBe("vX");
  });
});

describe("previewCuration — 표본이 모자라면 값을 만들지 않는다", () => {
  it("하한 미만이면 사분위가 **null 이다 — 0 이 아니다**", () => {
    const preview = previewCuration(many(PRICE_INDEX_MIN_SAMPLE - 1));

    expect(preview.p50).toBeNull();
    expect(preview.blockedReason).not.toBeNull();
  });

  it("하한을 채우면 사분위가 나온다", () => {
    const preview = previewCuration(many(PRICE_INDEX_MIN_SAMPLE));

    expect(preview.p50).not.toBeNull();
    expect(preview.blockedReason).toBeNull();
    expect(preview.vendorCount).toBe(PRICE_INDEX_MIN_SAMPLE);
  });

  it("**제외가 지수를 어떻게 움직이는지 미리 보여준다**", () => {
    const rows = many(PRICE_INDEX_MIN_SAMPLE + 1);
    const before = previewCuration(rows);
    const after = previewCuration([
      ...rows.slice(1),
      { ...rows[0], excludedReason: "이상치", verifiedBy: "u" },
    ]);

    expect(after.excludedCount).toBe(1);
    expect(after.p50).not.toBe(before.p50);
  });

  it("제외해서 하한이 깨지면 값이 사라진다 — 그 사실을 미리 안다", () => {
    const rows = many(PRICE_INDEX_MIN_SAMPLE);
    const after = previewCuration([
      ...rows.slice(1),
      { ...rows[0], excludedReason: "이상치", verifiedBy: "u" },
    ]);

    expect(after.p50).toBeNull();
    expect(after.blockedReason).not.toBeNull();
  });

  it("**업체당 한 건만 센다** — 한 업체가 열 개 올려도 표본은 하나다", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      source({ id: `s${i}`, vendorId: "v-same", productId: `p${i}` }),
    );

    expect(previewCuration(rows).vendorCount).toBe(1);
  });
});

describe("큐레이션 조치", () => {
  it("셋뿐이다", () => {
    expect([...CURATION_ACTIONS]).toEqual(["exclude", "restore", "verify"]);
  });

  it("이미 제외된 것을 또 제외할 수 없다", () => {
    expect(canCurate({ excludedReason: "x" }, "exclude")).toBe(false);
    expect(canCurate({ excludedReason: null }, "exclude")).toBe(true);
  });

  it("제외되지 않은 것을 해제할 수 없다", () => {
    expect(canCurate({ excludedReason: null }, "restore")).toBe(false);
  });

  it("확인 표시는 언제든 남길 수 있다 — 다시 봤다는 사실도 기록이다", () => {
    expect(canCurate({ excludedReason: null }, "verify")).toBe(true);
    expect(canCurate({ excludedReason: "x" }, "verify")).toBe(true);
  });

  it.each(CURATION_ACTIONS)("**%s 에도 사유가 필수다** — 왜 지웠는지 답할 수 있어야 한다", (action) => {
    expect(() =>
      CurationActionSchema.parse({ sourceId: UUID, action, reason: "  " }),
    ).toThrow();
  });

  it("curationProblem 이 이유를 밝히며 막는다", () => {
    expect(
      curationProblem({ row: { excludedReason: "x" }, action: "exclude", reason: "y" }),
    ).toContain("이미 제외");
  });

  it("모르는 키를 끼워 넣을 수 없다", () => {
    expect(() =>
      CurationActionSchema.parse({ sourceId: UUID, action: "verify", reason: "x", verifiedBy: UUID }),
    ).toThrow();
  });
});

describe("RecalculateSchema — 재계산에도 사유가 필요하다", () => {
  it("정상 입력", () => {
    expect(
      RecalculateSchema.parse({ regionCode: "서울 강남", category: "hall", reason: "이상치 제외 후" })
        .category,
    ).toBe("hall");
  });

  it("사유 없이 재계산할 수 없다 — 지수를 움직이는 일이다", () => {
    expect(() =>
      RecalculateSchema.parse({ regionCode: "서울 강남", category: "hall", reason: "" }),
    ).toThrow();
  });
});
