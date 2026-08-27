import { readSetting } from "@/lib/app-settings";
import {
  type FeeBasis,
  type FunnelStep,
  type MetricCard,
  type Period,
  type RawMetrics,
  buildCards,
  buildFunnel,
  pendingCards,
} from "@/lib/core/metrics/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 운영자 지표 로더 (S8-01 · F-A-07)
 *
 * **세션 클라이언트로 부른다.** `admin_metrics()` 는 SECURITY DEFINER 이지만 경계가
 * 함수 안의 `is_operator()` 이고, 그 판정의 근거는 `auth.uid()` 다 — 서비스롤로 부르면
 * `auth.uid()` 가 없어 **막힌다.** 즉 이 경로에서는 서비스롤이 우회로가 되지 않는다.
 *
 * 수수료 기준(`settlement.fee_basis`)만 서비스롤로 읽는다. `app_settings` 는 운영
 * 파라미터 표이고 기존 `readSetting()` 이 이미 그 경로다.
 */
export type AdminMetricsPayload = {
  period: Period;
  cards: MetricCard[];
  funnel: FunnelStep[];
  pending: MetricCard[];
  feeBasis: FeeBasis;
};

/** `admin_metrics()` 가 돌려주는 jsonb 를 숫자로 좁힌다. */
function toRaw(json: unknown): RawMetrics {
  const row = (json ?? {}) as Record<string, unknown>;
  // **`Number(null)` 은 0 이다.** 키가 통째로 빠졌을 때 0으로 읽히면 "집계했더니 0" 과
  // 구분되지 않는다. 그래서 키가 없으면 값을 지어내지 않고 즉시 실패시킨다.
  const num = (key: string): number => {
    const value = row[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`admin_metrics: ${key} 가 숫자가 아닙니다.`);
    }

    return value;
  };

  return {
    signups: num("signups"),
    consumerSignups: num("consumerSignups"),
    mau: num("mau"),
    reportsRequested: num("reportsRequested"),
    reportsSucceeded: num("reportsSucceeded"),
    inquiries: num("inquiries"),
    consultations: num("consultations"),
    bookings: num("bookings"),
    contracts: num("contracts"),
    gmvAmount: num("gmvAmount"),
    feeAmount: num("feeAmount"),
    settlementRows: num("settlementRows"),
    membershipsStarted: num("membershipsStarted"),
    membershipsCanceled: num("membershipsCanceled"),
    membershipsExpired: num("membershipsExpired"),
    membershipsActive: num("membershipsActive"),
    onboardedCouples: num("onboardedCouples"),
    couplesWithCart: num("couplesWithCart"),
  };
}

/**
 * 수수료 기준(O-15)을 읽는다.
 *
 * `{"basis": null, "status": "undecided"}` 가 지금의 값이다. **null 을 문자열로 만들지
 * 않는다** — `String(null)` 은 `"null"` 이고 그것은 참인 값이라 미결정이 확정으로 뒤집힌다
 * (`readIntSetting` 이 같은 함정을 막고 있는 것과 같은 이유).
 */
export async function readFeeBasis(): Promise<FeeBasis> {
  const raw = (await readSetting("settlement.fee_basis"))?.basis;

  return { basis: typeof raw === "string" && raw.length > 0 ? raw : null };
}

export async function loadAdminMetrics(period: Period): Promise<AdminMetricsPayload> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_metrics", {
    p_from: period.from,
    p_to: period.to,
  });

  if (error) {
    // 권한 실패와 계산 실패를 섞지 않는다 — 화면이 다른 문장을 써야 한다.
    throw new Error(error.code === "42501" ? "ADMIN_METRICS_FORBIDDEN" : "ADMIN_METRICS_FAILED");
  }

  const raw = toRaw(data);
  const feeBasis = await readFeeBasis();

  return {
    period,
    feeBasis,
    cards: buildCards(raw, feeBasis),
    funnel: buildFunnel(raw),
    pending: pendingCards(),
  };
}
