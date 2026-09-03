import {
  COMMISSION_SCOPE_ORDER,
  calculateSettlement,
  resolveRate,
  type RateRecord,
} from "@/lib/core/pricing/rates";

/**
 * 업체 적용 요율 조회 (S2-03 · 명세서 §3.8 요율 해석 규칙, F-V-03, D-16)
 *
 * `lib/core/pricing` 은 DB 를 모른다. 그래서 **레코드를 읽어 주입하는 얇은 층**이 여기 있다.
 *
 *  * **요율 숫자를 여기에 쓰지 않는다.** 값은 `commission_rates` 가 가진다(O-02).
 *  * 요율이 없으면 **금액을 만들어내지 않는다.** `resolveRate` 의 실패를 그대로 올려 보내고
 *    화면은 "요율 미설정" 으로 표기한다. 임의 기본값은 정산 분쟁의 씨앗이다.
 *  * 조회는 **호출자가 넘긴 클라이언트**로 한다. 사용자 세션 클라이언트를 넘기면
 *    RLS 가 "자기에게 적용되는 요율만" 보여준다(§3.9) — 그것이 경계다.
 */
export type VendorRateResult =
  | {
      available: true;
      feeRateBp: number;
      scopeType: string;
      /** 판매가에 적용한 결과. 판매가가 없으면 null. */
      settlement: { feeAmount: number; netAmount: number } | null;
    }
  | { available: false; reason: string; detail: string };

type RateRow = {
  id: string;
  scope_type: string;
  scope_key: string | null;
  fee_rate_bp: number;
  effective_from: string;
  effective_to: string | null;
  voided_at: string | null;
};

/** 최소한의 select 인터페이스만 요구한다 — 세션·서비스롤 클라이언트 양쪽을 받기 위해서다. */
type RateReader = {
  from: (table: string) => {
    select: (columns: string) => PromiseLike<{ data: RateRow[] | null; error: unknown }>;
  };
};

export async function resolveVendorCommission(
  client: RateReader,
  params: { vendorId: string; category: string; at?: string; salePrice?: number | null },
): Promise<VendorRateResult> {
  const { data, error } = await client.from("commission_rates").select(
    // `voided_at` 을 빼면 무효화한 요율이 다시 후보가 된다(FIX-12).
    "id, scope_type, scope_key, fee_rate_bp, effective_from, effective_to, voided_at",
  );

  if (error) {
    return { available: false, reason: "rate_lookup_failed", detail: "요율을 조회하지 못했습니다." };
  }

  const records: RateRecord[] = (data ?? []).map((row) => ({
    id: row.id,
    scopeType: row.scope_type as RateRecord["scopeType"],
    scopeKey: row.scope_key,
    feeRateBp: row.fee_rate_bp,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    voidedAt: row.voided_at,
  }));

  const resolved = resolveRate(records, {
    scopeCandidates: COMMISSION_SCOPE_ORDER,
    scopeKeys: { vendor: params.vendorId, category: params.category },
    at: params.at ?? new Date().toISOString(),
  });

  if (!resolved.ok) {
    return { available: false, reason: resolved.reason, detail: resolved.detail };
  }

  const salePrice = params.salePrice ?? null;

  return {
    available: true,
    feeRateBp: resolved.feeRateBp,
    scopeType: resolved.scopeType,
    settlement:
      salePrice === null || salePrice <= 0
        ? null
        : (() => {
            const result = calculateSettlement({ salePrice, feeRateBp: resolved.feeRateBp });

            return { feeAmount: result.feeAmount, netAmount: result.netAmount };
          })(),
  };
}
