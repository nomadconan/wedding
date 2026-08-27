import { readIntSetting } from "@/lib/app-settings";
import { recordEvent } from "@/lib/audit/record";
import {
  type AnomalyFlag,
  type AnomalyScan,
  type AnomalyThresholds,
  type ContractSample,
  type ProductSample,
  detectAddonExcess,
  detectBaitPrices,
} from "@/lib/core/pricing/anomaly";
import {
  type CurationAction,
  type CurationPreview,
  type SourceRow,
  canCurate,
  includedSamples,
  previewCuration,
} from "@/lib/core/pricing/curation";
import { PRICE_INDEX_ALL, buildPriceIndex } from "@/lib/core/pricing/price-index";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 가격 큐레이션·이상 탐지 로더 (S8-10 · F-A-02 · F-A-14)
 *
 * **읽는 방식을 셋으로 가른다**(D-120).
 *
 * | 대상 | 방식 | 왜 |
 * |---|---|---|
 * | `price_index` | 세션 + RLS(공개) | 공개 데이터다 |
 * | `price_sources` | 세션 + **운영자 정책** | 행이 목적이고 운영자에게는 보여 준다(0056) |
 * | 이상 탐지 큐 | **계산** | 저장하지 않는다 — 원본이 바뀌면 큐가 낡는다 |
 *
 * 탐지 큐를 표로 만들지 않은 것이 이 파일의 요점이다. 배치와 화면이 **같은 순수 함수**를
 * 부르므로 둘의 답이 갈릴 수 없다.
 */
export type IndexCell = {
  id: string;
  regionCode: string;
  category: string;
  guestBucket: string;
  season: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  sampleSize: number | null;
  sourceType: string | null;
  collectedAt: string | null;
  version: string;
};

export type CurationCell = IndexCell & {
  sources: SourceRow[];
  preview: CurationPreview;
};

export async function readAnomalyThresholds(): Promise<AnomalyThresholds> {
  // **`readIntSetting` 이 `null` 을 0 으로 읽지 않는다**(S7-17 이 물린 자리).
  // 0bp 임계는 "모든 상품이 미끼" 라는 뜻이라 미결과 정반대다.
  const [bait, addon] = await Promise.all([
    readIntSetting("pricing.bait_gap_bp", "value"),
    readIntSetting("pricing.addon_excess_bp", "value"),
  ]);

  return { baitGapBp: bait, addonExcessBp: addon };
}

/** 지수 칸 목록. 표본이 없는 칸도 그대로 낸다 — 없는 것과 못 센 것을 가른다. */
export async function loadIndexCells(): Promise<IndexCell[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("price_index")
    .select("id, region_code, category, guest_bucket, season, p25, p50, p75, sample_size, source_type, collected_at, version")
    .order("region_code")
    .limit(200);

  if (error) throw new Error("PRICE_LOAD_FAILED");

  type Raw = {
    id: string; region_code: string; category: string; guest_bucket: string; season: string;
    p25: number | null; p50: number | null; p75: number | null; sample_size: number | null;
    source_type: string | null; collected_at: string | null; version: string;
  };

  return ((data ?? []) as Raw[]).map((row) => ({
    id: row.id,
    regionCode: row.region_code,
    category: row.category,
    guestBucket: row.guest_bucket,
    season: row.season,
    p25: row.p25,
    p50: row.p50,
    p75: row.p75,
    sampleSize: row.sample_size,
    sourceType: row.source_type,
    collectedAt: row.collected_at,
    version: row.version,
  }));
}

/**
 * 한 칸의 원천 표본.
 *
 * **PostgREST 임베드를 쓰지 않는다**(함정 1). `price_sources` 에는 `vendor_id` 가 없고
 * 상품을 거쳐야 하는데, `products` 정책이 운영자를 모르면 **업체 id 가 조용히 사라져**
 * 지수가 업체당 한 건을 못 세게 된다(그러면 재계산이 원래 값과 달라진다).
 * 그래서 업체 id 는 **`source_name` 규약**으로 담는다 — 재계산 배치가 그렇게 쓴다.
 */
export async function loadSources(indexId: string): Promise<SourceRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("price_sources")
    .select("id, source_name, source_url, raw_value, verified_by, excluded_reason")
    .eq("index_id", indexId)
    .order("raw_value")
    .limit(500);

  if (error) return [];

  type Raw = {
    id: string; source_name: string; source_url: string | null;
    raw_value: number | null; verified_by: string | null; excluded_reason: string | null;
  };

  return ((data ?? []) as Raw[]).map((row) => {
    // `source_url` 에 `vendor:<id>/product:<id>` 를 담는다(재계산 배치가 쓴다).
    const vendorId = row.source_url?.match(/vendor:([0-9a-f-]{36})/i)?.[1] ?? row.id;
    const productId = row.source_url?.match(/product:([0-9a-f-]{36})/i)?.[1] ?? null;

    return {
      id: row.id,
      sourceName: row.source_name,
      rawValue: row.raw_value ?? 0,
      excludedReason: row.excluded_reason,
      verifiedBy: row.verified_by,
      vendorId,
      productId,
    };
  });
}

export async function loadCurationCell(indexId: string): Promise<CurationCell | null> {
  const cells = await loadIndexCells();
  const cell = cells.find((row) => row.id === indexId);
  if (!cell) return null;

  const sources = await loadSources(indexId);

  return { ...cell, sources, preview: previewCuration(sources) };
}

// ── 이상 탐지 ───────────────────────────────────────────────────────────────

export type AnomalyPayload = {
  thresholds: AnomalyThresholds;
  bait: AnomalyScan;
  addon: AnomalyScan;
  flags: AnomalyFlag[];
};

/**
 * 지금 큐에 있는 것.
 *
 * **저장하지 않고 볼 때마다 센다.** 배치도 같은 함수를 부르므로 둘의 답이 갈릴 수 없다.
 * 서비스롤로 읽는 이유: `products`·`contracts`·`bookings` 에 운영자 정책이 없고,
 * 여기서 필요한 것은 **집계에 가까운 표본**이다 — 반환하는 것도 플래그뿐이다.
 */
export async function loadAnomalies(): Promise<AnomalyPayload> {
  const thresholds = await readAnomalyThresholds();
  const admin = createAdminClient();

  // 미끼 의심: 공개된 상품 + 그 업체의 지역·카테고리 + 성사 여부.
  // 재계산과 같은 조건이다 — 심사 중인 업체의 상품은 고객에게 안 보이므로
  // **미끼로 의심할 대상도 아니다.** 두 곳의 조건이 갈리면 화면이 지수에 없는 상품을
  // 지수와 견주게 된다.
  const { data: productRows } = await admin
    .from("products")
    .select("id, vendor_id, base_price_total, status, vendors!inner(region_code, category, status)")
    .eq("status", "published")
    .eq("vendors.status", "active")
    .limit(500);

  const { data: bookingRows } = await admin
    .from("bookings")
    .select("product_id")
    .in("status", ["confirmed", "fulfilled"])
    .limit(2_000);

  const booked = new Set(
    ((bookingRows ?? []) as { product_id: string | null }[])
      .map((row) => row.product_id)
      .filter((id): id is string => Boolean(id)),
  );

  type RawProduct = {
    id: string; vendor_id: string; base_price_total: number;
    vendors: { region_code: string; category: string } | null;
  };

  const products = ((productRows ?? []) as unknown as RawProduct[]).map((row) => ({
    productId: row.id,
    vendorId: row.vendor_id,
    price: row.base_price_total,
    hasBooking: booked.has(row.id),
    regionCode: row.vendors?.region_code ?? "",
    category: row.vendors?.category ?? "",
  }));

  // 지수는 지역·카테고리별이다. 상품이 속한 칸의 중앙값과 견준다.
  const cells = await loadIndexCellsAsAdmin(admin);
  const bait = detectBaitAcrossCells(products, cells, thresholds);

  // 추가금 과다: 계약 총액 vs 견적 총액.
  const { data: contractRows } = await admin
    .from("contracts")
    .select("id, total_amount, quote_id, bookings!inner(vendor_id)")
    .in("status", ["issued", "active"])
    .limit(500);

  type RawContract = {
    id: string; total_amount: number | null; quote_id: string | null;
    bookings: { vendor_id: string } | null;
  };

  const rawContracts = (contractRows ?? []) as unknown as RawContract[];
  const quoteIds = rawContracts.map((row) => row.quote_id).filter((id): id is string => Boolean(id));

  const { data: quoteRows } = quoteIds.length
    ? await admin.from("quotes").select("id, total_amount").in("id", quoteIds)
    : { data: [] };

  const quoteTotals = new Map(
    ((quoteRows ?? []) as { id: string; total_amount: number | null }[]).map((row) => [
      row.id,
      row.total_amount,
    ]),
  );

  const contracts: ContractSample[] = rawContracts.map((row) => ({
    contractId: row.id,
    vendorId: row.bookings?.vendor_id ?? "",
    quoteTotal: row.quote_id ? (quoteTotals.get(row.quote_id) ?? null) : null,
    contractTotal: row.total_amount ?? 0,
  }));

  const addon = detectAddonExcess(contracts, thresholds);

  const flags = [
    ...(bait.status === "scanned" ? bait.flags : []),
    ...(addon.status === "scanned" ? addon.flags : []),
  ];

  return { thresholds, bait, addon, flags };
}

async function loadIndexCellsAsAdmin(
  admin: ReturnType<typeof createAdminClient>,
): Promise<{ regionCode: string; category: string; p50: number | null }[]> {
  const { data } = await admin
    .from("price_index")
    .select("region_code, category, p50")
    .eq("guest_bucket", PRICE_INDEX_ALL)
    .limit(500);

  return ((data ?? []) as { region_code: string; category: string; p50: number | null }[]).map(
    (row) => ({ regionCode: row.region_code, category: row.category, p50: row.p50 }),
  );
}

/**
 * 칸마다 따로 돌린다.
 *
 * **지수가 없는 칸의 상품은 검사에서 빠진다** — 비교 기준이 없으면 판단할 수 없고,
 * 없는 기준으로 의심 목록에 올리는 것이 이 태스크가 가장 피하려는 일이다.
 */
function detectBaitAcrossCells(
  products: (ProductSample & { regionCode: string; category: string })[],
  cells: { regionCode: string; category: string; p50: number | null }[],
  thresholds: AnomalyThresholds,
): AnomalyScan {
  if (thresholds.baitGapBp === null) {
    return detectBaitPrices([], null, thresholds);
  }

  const flags: AnomalyFlag[] = [];
  let checked = 0;

  for (const cell of cells) {
    if (cell.p50 === null || cell.p50 <= 0) continue;

    const inCell = products.filter(
      (row) => row.regionCode === cell.regionCode && row.category === cell.category,
    );
    if (inCell.length === 0) continue;

    const scan = detectBaitPrices(inCell, cell.p50, thresholds);
    if (scan.status !== "scanned") continue;

    checked += scan.checked;
    flags.push(...scan.flags);
  }

  return { status: "scanned", flags, checked };
}

// ── 재계산 ──────────────────────────────────────────────────────────────────

export type RecalculateResult =
  | { ok: true; indexId: string; sampleSize: number; p50: number | null; blocked: string | null }
  | { ok: false; status: number; code: string; message: string };

/**
 * 지수 한 칸을 다시 센다 (F-A-02).
 *
 * **산출은 S3-08 의 `buildPriceIndex` 가 한다** — 여기서는 표본을 모으고 제외된 것을
 * 빼고 결과를 쓰는 일만 한다. 사분위 계산을 다시 구현하면 소비자 화면과 운영자 화면이
 * 다른 값을 낼 수 있다.
 *
 * **표본이 하한에 못 미치면 사분위를 비운다**(null). 옛 값을 남겨 두면 화면이
 * 낡은 시세를 계속 보여준다.
 */
export async function recalculateIndex(input: {
  regionCode: string;
  category: string;
  reason: string;
  operatorId: string;
  operatorRole: string | null;
}): Promise<RecalculateResult> {
  const admin = createAdminClient();

  // 이 칸의 표본: 공개된 상품의 등록가.
  // **승인된 업체의 상품만 표본이다.** 심사 중인 업체의 상품은 게시 상태여도 탐색에
  // 노출되지 않는다(`is_active_vendor` · S4-01) — 고객이 살 수 없는 가격을 참가격에
  // 넣으면 지수가 **시장이 아닌 것**을 말하게 된다. `db:rls` 가 표본 수를 그 칸의
  // 승인 업체 수와 대조해 이 조건을 붙잡는다(처음 빠뜨렸다가 그 검사에 걸렸다).
  const { data: productRows, error: productError } = await admin
    .from("products")
    .select("id, vendor_id, base_price_total, vendors!inner(region_code, category, status)")
    .eq("status", "published")
    .eq("vendors.status", "active")
    .eq("vendors.region_code", input.regionCode)
    .eq("vendors.category", input.category)
    .limit(1_000);

  if (productError) {
    return { ok: false, status: 500, code: "PRICE_RECALC_FAILED", message: "표본을 읽지 못했습니다." };
  }

  type RawProduct = { id: string; vendor_id: string; base_price_total: number };
  const rows = (productRows ?? []) as unknown as RawProduct[];

  // 기존 칸과 그 칸의 제외 표시를 읽어 **제외를 유지한다** — 재계산이 큐레이션을
  // 지워 버리면 운영자가 뺀 이상치가 다음 실행에 되살아난다.
  const { data: existing } = await admin
    .from("price_index")
    .select("id")
    .eq("region_code", input.regionCode)
    .eq("category", input.category)
    .eq("guest_bucket", PRICE_INDEX_ALL)
    .eq("season", PRICE_INDEX_ALL)
    .maybeSingle();

  const indexId = (existing as { id: string } | null)?.id ?? null;

  const excluded = new Set<string>();
  if (indexId) {
    const { data: sourceRows } = await admin
      .from("price_sources")
      .select("source_url, excluded_reason")
      .eq("index_id", indexId);

    for (const row of (sourceRows ?? []) as { source_url: string | null; excluded_reason: string | null }[]) {
      if (!row.excluded_reason) continue;
      const productId = row.source_url?.match(/product:([0-9a-f-]{36})/i)?.[1];
      if (productId) excluded.add(productId);
    }
  }

  const samples = rows
    .filter((row) => !excluded.has(row.id))
    .map((row) => ({ vendorId: row.vendor_id, price: row.base_price_total, productId: row.id }));

  const result = buildPriceIndex(samples);
  const now = new Date().toISOString();

  const patch = {
    region_code: input.regionCode,
    category: input.category,
    guest_bucket: PRICE_INDEX_ALL,
    season: PRICE_INDEX_ALL,
    // 하한 미달이면 **비운다**. 옛 값을 남기면 낡은 시세가 계속 나간다.
    p25: result.ok ? result.p25 : null,
    p50: result.ok ? result.p50 : null,
    p75: result.ok ? result.p75 : null,
    sample_size: result.ok ? result.sampleSize : result.sampleSize,
    source_type: "registered_price",
    collected_at: now,
    version: now.slice(0, 10),
  };

  const { data: saved, error: saveError } = indexId
    ? await admin.from("price_index").update(patch).eq("id", indexId).select("id").maybeSingle()
    : await admin.from("price_index").insert(patch).select("id").maybeSingle();

  if (saveError || !saved) {
    return { ok: false, status: 500, code: "PRICE_RECALC_FAILED", message: "지수를 저장하지 못했습니다." };
  }

  const savedId = (saved as { id: string }).id;

  // 표본 흔적을 다시 깐다. **제외 표시는 유지**한다.
  if (result.ok) {
    await admin.from("price_sources").delete().eq("index_id", savedId).is("excluded_reason", null);

    const sourceRows = result.representatives.map((sample) => ({
      index_id: savedId,
      source_name: "등록 판매가",
      // 업체·상품 id 를 여기 담는다 — 임베드 없이 재계산이 업체당 한 건을 셀 수 있다.
      source_url: `vendor:${sample.vendorId}/product:${sample.productId ?? ""}`,
      raw_value: sample.price,
    }));

    if (sourceRows.length > 0) await admin.from("price_sources").insert(sourceRows);
  }

  // 지수를 움직인 것은 상태 변경이다. 증적과 감사 로그에 남긴다.
  await recordEvent({
    entityType: "price_index",
    entityId: savedId,
    eventType: "price_index_recalculated",
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: null,
    afterState: result.ok ? "published" : "insufficient_sample",
    source: "admin",
    // **사유 본문을 담지 않는다**(§7.3). 남길 사실은 표본 수다.
    memo: `samples:${result.ok ? result.sampleSize : result.sampleSize}`,
  });

  const { data: basisRows } = await admin
    .from("entity_events")
    .select("id")
    .eq("entity_type", "price_index")
    .eq("entity_id", savedId)
    .order("occurred_at", { ascending: false })
    .limit(10);

  const basis = ((basisRows ?? []) as { id: string }[]).map((row) => row.id);

  await admin.from("audit_logs").insert({
    actor_id: input.operatorId,
    actor_role: input.operatorRole,
    action: "price_index_recalculated",
    target_type: "price_index",
    target_id: savedId,
    before_json: { region: input.regionCode, category: input.category },
    after_json: { sampleSize: patch.sample_size, hasIndex: result.ok },
    resolution_basis: basis.length > 0 ? basis : null,
  });

  return {
    ok: true,
    indexId: savedId,
    sampleSize: result.ok ? result.sampleSize : result.sampleSize,
    p50: result.ok ? result.p50 : null,
    blocked: result.ok ? null : "insufficient_sample",
  };
}

/** 이 칸의 표본을 계산에 넣고 빼는 기록. */
export function summarizeSources(sources: SourceRow[]): { included: number; excluded: number } {
  const included = includedSamples(sources).length;

  return { included, excluded: sources.length - included };
}

// ── 표본 조치 (F-A-02) ──────────────────────────────────────────────────────

export type CurationResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

/**
 * 표본 하나를 빼거나 되돌리거나 확인 표시한다.
 *
 * **변경은 서비스롤 경유다**(D-62). 조회는 RLS(`price_sources_select_operator`)가
 * 경계이지만, 표본을 빼는 것은 **지수를 움직이는 일**이라 그 권한을 클라이언트 번들이
 * 닿는 자리에 두지 않는다.
 *
 * `excluded_reason` 과 `verified_by` 는 **DB CHECK 이 짝으로 요구한다**(0056) —
 * 사유 없이 제외하거나 누가 뺐는지 없이 제외할 수 없다.
 */
export async function applyCuration(input: {
  sourceId: string;
  action: CurationAction;
  reason: string;
  operatorId: string;
  operatorRole: string | null;
}): Promise<CurationResult> {
  const admin = createAdminClient();

  const { data: current, error: loadError } = await admin
    .from("price_sources")
    .select("id, index_id, excluded_reason")
    .eq("id", input.sourceId)
    .maybeSingle();

  if (loadError) {
    return { ok: false, status: 500, code: "PRICE_LOAD_FAILED", message: "표본을 불러오지 못했습니다." };
  }
  if (!current) {
    return { ok: false, status: 404, code: "PRICE_NOT_FOUND", message: "표본을 찾을 수 없습니다." };
  }

  const row = current as { id: string; index_id: string; excluded_reason: string | null };

  if (!canCurate({ excludedReason: row.excluded_reason }, input.action)) {
    return {
      ok: false,
      status: 409,
      code: "PRICE_INVALID_TRANSITION",
      message: input.action === "exclude" ? "이미 제외된 표본입니다." : "제외되지 않은 표본입니다.",
    };
  }

  const patch =
    input.action === "exclude"
      ? { excluded_reason: input.reason, verified_by: input.operatorId }
      : input.action === "restore"
        ? { excluded_reason: null, verified_by: input.operatorId }
        : { verified_by: input.operatorId };

  const { error: updateError } = await admin
    .from("price_sources")
    .update(patch)
    .eq("id", input.sourceId);

  if (updateError) {
    return { ok: false, status: 500, code: "PRICE_UPDATE_FAILED", message: "기록하지 못했습니다." };
  }

  await recordEvent({
    entityType: "price_index",
    entityId: row.index_id,
    eventType: `price_source_${input.action}`,
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: row.excluded_reason === null ? "included" : "excluded",
    afterState: input.action === "exclude" ? "excluded" : input.action === "restore" ? "included" : "verified",
    source: "admin",
    // **사유 본문도 금액도 담지 않는다**(§7.3) — 행이 이미 갖고 있다.
    memo: `source:${input.sourceId.slice(0, 8)}`,
  });

  await writeAuditLog(admin, {
    actorId: input.operatorId,
    actorRole: input.operatorRole,
    action: `price_source_${input.action}`,
    targetType: "price_index",
    targetId: row.index_id,
    before: { excluded: row.excluded_reason !== null },
    after: { excluded: input.action === "exclude" },
  });

  return { ok: true };
}

// ── 이상 탐지 조치 (F-A-14) ─────────────────────────────────────────────────

/**
 * 플래그 하나에 대한 조치를 기록한다.
 *
 * **판정이 아니라 기록이다**(D-24). 자동 제재·자동 비공개가 없으므로 이 기록이 조치의
 * 전부다 — `revoke_badge` 도 여기서 배지를 끄지 않는다. 배지는 `vendors` 의 컴플라이언스
 * 스캔 결과가 정하고(S7-13), 그 판정을 이 화면이 덮어쓰면 **두 곳이 배지를 정하게 된다.**
 * 운영자가 배지를 실제로 회수해야 한다면 그 경로는 컴플라이언스 쪽에서 연다.
 */
export async function applyAnomalyAction(input: {
  kind: string;
  targetType: string;
  targetId: string;
  vendorId: string;
  action: string;
  reason: string;
  operatorId: string;
  operatorRole: string | null;
}): Promise<CurationResult> {
  const admin = createAdminClient();

  await recordEvent({
    entityType: "vendor",
    entityId: input.vendorId,
    eventType: `price_anomaly_${input.action}`,
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: "flagged",
    afterState: input.action,
    source: "admin",
    // 사유 본문을 담지 않는다(§7.3). 남길 사실은 **어떤 종류의 플래그였나**다.
    memo: `kind:${input.kind}`,
  });

  await writeAuditLog(admin, {
    actorId: input.operatorId,
    actorRole: input.operatorRole,
    action: `price_anomaly_${input.action}`,
    targetType: input.targetType,
    targetId: input.targetId,
    before: { flag: input.kind },
    after: { action: input.action },
  });

  return { ok: true };
}

/** 운영자 액션은 `audit_logs` 에도 남기고 **근거 이벤트 id 를 함께** 남긴다(§7.2). */
async function writeAuditLog(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    actorId: string;
    actorRole: string | null;
    action: string;
    targetType: string;
    targetId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<void> {
  const { data: basisRows } = await admin
    .from("entity_events")
    .select("id")
    .eq("actor_id", input.actorId)
    .order("occurred_at", { ascending: false })
    .limit(5);

  const basis = ((basisRows ?? []) as { id: string }[]).map((row) => row.id);

  await admin.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_role: input.actorRole,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    before_json: input.before,
    after_json: input.after,
    // 빈 배열은 CHECK 이 막는다.
    resolution_basis: basis.length > 0 ? basis : null,
  });
}
