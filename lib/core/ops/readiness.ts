// 오픈 준비 점검 — 값이 없어서 거래가 서지 않는 자리 (FIX-11 · S5-03 · O-02)
//
//  * **순수 함수다.** DB 에 접근하지 않고 센 값을 인자로 받는다.
//  * **값을 정하지 않는다.** 여기서 하는 일은 "없다" 를 말하는 것뿐이며, 무엇을 넣을지는
//    운영 결정이다(O-02). 기본값을 만들면 미결정이 조용히 확정된다.
//
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
// `commission_rates` 가 0행이면 **계약 발행이 통째로 막힌다**(`CONTRACT_RATE_UNRESOLVED`).
// 로컬은 `seed:accounts` 가 데모 요율을 넣어 가려져 있었지만 **배포 환경에는 그 장치가
// 없다.** 그리고 지금까지 그 상태를 **아무 데서도 알 수 없었다** — 재현해 확인했다:
// 요율을 전부 없애도 `job_runs` 에도 `client_events` 에도 신호가 없다. 업체는 계약을
// 눌렀을 때 "운영자에게 문의해 주세요" 를 보고, 운영자는 문의를 받을 때까지 모른다.
//
// **여기서 만드는 것은 그 신호다.** 첫 계약이 실패하기 전에 화면이 먼저 말한다.

import type { Alert } from "./monitor";

/** 오픈 전에 값이 들어가야 하는 자리. 늘어나면 여기에 행을 더한다. */
export const READINESS_KEYS = ["commission_rate", "planner_fee_rate"] as const;
export type ReadinessKey = (typeof READINESS_KEYS)[number];

export type ReadinessRow = {
  key: ReadinessKey;
  label: string;
  /** 지금 살아 있는 값의 수. **무효화된 행은 세지 않는다**(FIX-12). */
  liveCount: number;
  ready: boolean;
  /** 없으면 무슨 일이 나는가. 화면이 그대로 적는다. */
  consequence: string;
  /** 값을 넣는 화면. */
  href: string;
  /** 값 자체가 미결이면 그 오픈 이슈 번호. **값을 코드가 고르지 않는다는 표시**다. */
  openIssue: string | null;
};

/**
 * 오픈 준비 상태.
 *
 * **`liveCount` 는 무효화되지 않은 행만 센다.** 무효화된 요율은 해석에서 빠지므로
 * (FIX-12) 그것만 남아 있으면 **요율이 하나도 없는 것과 같다.** 전체 행 수를 세면
 * "요율이 있다" 고 답하면서 계약은 계속 막히는, 가장 나쁜 종류의 거짓말이 된다.
 */
export function buildReadinessRows(input: {
  liveCommissionRates: number;
  livePlannerFeeRates: number;
}): ReadinessRow[] {
  return [
    {
      key: "commission_rate",
      label: "수수료 요율",
      liveCount: input.liveCommissionRates,
      ready: input.liveCommissionRates > 0,
      consequence:
        "요율이 하나도 없으면 계약 발행이 CONTRACT_RATE_UNRESOLVED 로 막힙니다. 거래 흐름 전체가 서고, 업체에게는 '운영자에게 문의해 주세요' 만 보입니다.",
      href: "/admin/commission-rates",
      // 값은 O-02 미결이다. **이 화면이 값을 고르지 않는다** — 없다는 사실만 말한다.
      openIssue: "O-02",
    },
    {
      key: "planner_fee_rate",
      label: "플래너 요율",
      liveCount: input.livePlannerFeeRates,
      ready: input.livePlannerFeeRates > 0,
      consequence:
        "플래너를 낀 계약이 막힙니다. 플래너를 쓰지 않는 거래는 영향이 없지만, 고객이 플래너를 고른 카테고리는 계약이 서지 않습니다.",
      href: "/admin/commission-rates",
      openIssue: "O-02",
    },
  ];
}

/**
 * 준비되지 않은 자리를 경보로 올린다.
 *
 * **`critical` 이다.** 배치가 안 도는 것과 같은 무게다 — 오히려 더 즉각적이다:
 * 배치는 밀리지만 이쪽은 **첫 거래에서 바로 막힌다.**
 *
 * **준비된 자리는 경보를 만들지 않는다.** 다 갖춰졌을 때 아무 줄도 안 나오는 것이
 * 맞고, 그래야 이 목록에 줄이 뜨는 것이 곧 신호가 된다.
 */
export function readinessAlerts(rows: readonly ReadinessRow[]): Alert[] {
  return rows
    .filter((row) => !row.ready)
    .map((row) => ({
      key: `readiness_missing:${row.key}`,
      severity: "critical" as const,
      title: `${row.label} 이(가) 하나도 설정되지 않았습니다`,
      detail: row.consequence,
      href: row.href,
    }));
}

/** 화면이 목록 위에 그대로 적는 문장. */
export const READINESS_NOTICE =
  "오픈 전에 값이 들어가야 하는 자리입니다. 값 자체는 운영 결정이라 이 화면이 고르지 않고(O-02), 비어 있다는 사실만 말합니다.";

/** 다 갖춰졌을 때. **'문제 없음' 이 아니라 '이 목록 기준으로는' 이라고 적는다.** */
export const READINESS_ALL_SET =
  "이 목록의 값은 모두 들어가 있습니다. 목록에 없는 설정까지 확인한 것은 아닙니다.";
