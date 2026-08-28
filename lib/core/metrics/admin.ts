// 운영자 지표 계산 (S8-01 · F-A-07 · 명세서 §6.4 `/admin`)
//
// **DB 는 세기만 하고 판단은 여기서 한다.** SQL 이 돌려주는 것은 원시 개수·합계뿐이고,
// "이 값을 보여도 되는가 / 무엇을 근거로 0인가 / 비율의 분모가 있는가" 는 전부 이 파일의
// 순수 함수가 정한다. 화면에만 있으면 로그인이 막힌 동안 아무도 검증하지 못한다(FIX-24).
//
// **금액은 basis point 정수다.** 비율은 전부 bp(10000 = 100%)로 다루고 부동소수점을 쓰지
// 않는다(CLAUDE.md 공통 제약). 화면이 `bpToPercent` 로 내릴 때만 반올림한다.

import { type MetricValue, measured, noBasis, notYet, undecided } from "@/lib/core/stats/metric";

/** 대시보드 기본 조회 기간(일). 짧으면 주간 리듬이 안 보이고 길면 최근 변화가 묻힌다. */
export const DEFAULT_PERIOD_DAYS = 30;

/** 고를 수 있는 기간. 임의 숫자를 받지 않는다 — 비교 기준이 흩어진다. */
export const PERIOD_DAY_OPTIONS = [7, 30, 90] as const;

export type PeriodDays = (typeof PERIOD_DAY_OPTIONS)[number];

export type Period = { days: PeriodDays; from: string; to: string };

/**
 * 조회 기간을 정한다.
 *
 * 목록에 없는 값은 **거절하지 않고 기본값으로 좁힌다** — 운영자가 주소창을 손으로 고쳐도
 * 화면이 깨지지 않아야 하고, 여기서 던지면 대시보드가 통째로 에러가 된다.
 */
export function resolvePeriod(rawDays: unknown, now: Date): Period {
  const parsed = Number(rawDays);
  const days = (PERIOD_DAY_OPTIONS as readonly number[]).includes(parsed)
    ? (parsed as PeriodDays)
    : DEFAULT_PERIOD_DAYS;

  const to = new Date(now.getTime());
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  return { days, from: from.toISOString(), to: to.toISOString() };
}

/**
 * 비율을 bp 로 만든다.
 *
 * **분모가 0이면 0% 가 아니다.** "문의 0건 중 0건 예약" 을 0% 로 적으면 "문의는 왔는데
 * 아무도 예약하지 않았다" 로 읽힌다 — 운영자가 내릴 판단이 정반대가 된다.
 */
export function ratioBp(
  numerator: number,
  denominator: number,
  basisLabel: string,
): MetricValue<number> {
  if (denominator <= 0) {
    return noBasis(`${basisLabel} 0건이라 비율을 계산할 수 없습니다.`, basisLabel);
  }

  return measured(Math.round((numerator * 10_000) / denominator));
}

// ── 원시 집계 (SQL 이 돌려주는 모양) ────────────────────────────────────────
export type RawMetrics = {
  signups: number;
  consumerSignups: number;
  mau: number;
  reportsRequested: number;
  reportsSucceeded: number;
  inquiries: number;
  consultations: number;
  bookings: number;
  contracts: number;
  gmvAmount: number;
  feeAmount: number;
  settlementRows: number;
  membershipsStarted: number;
  membershipsCanceled: number;
  membershipsExpired: number;
  membershipsActive: number;
  onboardedCouples: number;
  couplesWithCart: number;
};

export type MetricCard = {
  key: string;
  label: string;
  metric: MetricValue<number>;
  unit: string;
  /** 측정값일 때 "무엇을 세었나". 근거 없는 0을 만들지 않기 위해 필수다. */
  basis: string;
  /** 비율 지표면 막대로 그린다. */
  asBar?: boolean;
};

export type FunnelStep = {
  key: string;
  label: string;
  count: MetricValue<number>;
  /**
   * 직전 단계 대비 비(bp). 첫 단계는 없다.
   *
   * **잔존율이 아니다.** 각 칸은 같은 사람을 따라간 코호트가 아니라 **기간 내 건수**라,
   * 석 달 전에 가입한 사람이 이번 달에 예약하면 뒷 칸이 앞 칸보다 커진다. 이름을
   * `retentionBp` 로 두면 읽는 사람이 코호트 잔존율로 읽고 이탈을 잘못 진단한다.
   */
  vsPreviousBp: MetricValue<number> | null;
  /** 이 단계를 세는 근거. */
  basis: string;
};

/** 수수료 기준(O-15) 상태. `settlement.fee_basis` 를 읽은 결과를 그대로 넘긴다. */
export type FeeBasis = { basis: string | null };

/**
 * MAU 정의를 값과 함께 낸다.
 *
 * **"활동" 의 정의를 화면이 지어내지 못하게 한다.** 여기서 세는 것은 `entity_events` 에
 * 행위가 남은 사용자이며, 열람만 한 방문은 들어오지 않는다. 정의를 옆에 적지 않으면
 * 다음 사람이 다른 정의로 다시 세고 두 숫자가 갈린다.
 */
export const MAU_DEFINITION =
  "최근 30일 안에 기록이 남는 행위를 한 번 이상 한 사용자 수입니다. 열람만 한 방문은 세지 않습니다.";

/**
 * 수수료 수익.
 *
 * **`settlement.fee_basis` 가 없으면 금액을 만들지 않는다.** 할인 전 판매가에서 떼느냐
 * 할인 후 실수금에서 떼느냐가 정해지지 않았고(O-15), 그 상태에서 낸 숫자는 둘 중 하나를
 * 조용히 고른 결과다. **0원으로 적는 것은 더 나쁘다** — "기준은 정해졌고 수익이 없었다"
 * 로 읽힌다(CLAUDE.md §7.6 — 값이 없으면 코드가 고르지 않는다).
 */
export function feeRevenue(raw: RawMetrics, feeBasis: FeeBasis): MetricCard {
  if (!feeBasis.basis) {
    return {
      key: "fee_revenue",
      label: "수수료 수익",
      unit: "원",
      basis: "",
      metric: undecided(
        "수수료를 할인 전 판매가에서 뗄지 할인 후 실수금에서 뗄지가 정해지지 않았습니다. 기준이 정해지면 같은 정산 행에서 그대로 계산됩니다.",
        "O-15",
      ),
    };
  }

  return {
    key: "fee_revenue",
    label: "수수료 수익",
    unit: "원",
    metric: measured(raw.feeAmount),
    basis: `기간 내 정산 ${raw.settlementRows.toLocaleString("en-US")}건의 수수료 합계 (기준: ${feeBasis.basis})`,
  };
}

export function buildCards(raw: RawMetrics, feeBasis: FeeBasis): MetricCard[] {
  return [
    {
      key: "signups",
      label: "가입",
      unit: "명",
      metric: measured(raw.signups),
      basis: "기간 내 새로 만들어진 프로필 수",
    },
    {
      key: "mau",
      label: "MAU",
      unit: "명",
      metric: measured(raw.mau),
      basis: MAU_DEFINITION,
    },
    {
      key: "reports",
      label: "리포트 생성",
      unit: "건",
      metric: measured(raw.reportsSucceeded),
      basis: `기간 내 분석 요청 ${raw.reportsRequested.toLocaleString("en-US")}건 중 완료된 건`,
    },
    {
      key: "report_success",
      label: "리포트 성공률",
      unit: "%",
      asBar: true,
      metric: ratioBp(raw.reportsSucceeded, raw.reportsRequested, "분석 요청이"),
      basis: "완료 ÷ 요청",
    },
    {
      key: "inquiries",
      label: "문의",
      unit: "건",
      metric: measured(raw.inquiries),
      basis: "기간 내 생성된 문의 수",
    },
    {
      key: "bookings",
      label: "예약",
      unit: "건",
      metric: measured(raw.bookings),
      basis: "기간 내 확정·이행된 예약 수",
    },
    {
      key: "inquiry_to_booking",
      label: "문의 → 예약 전환",
      unit: "%",
      asBar: true,
      metric: ratioBp(raw.bookings, raw.inquiries, "문의가"),
      basis: "예약 ÷ 문의",
    },
    {
      key: "gmv",
      label: "GMV",
      unit: "원",
      metric: measured(raw.gmvAmount),
      basis: "기간 내 확정·이행 예약의 총액 합계. 취소·보류 건은 빼고 셉니다",
    },
    feeRevenue(raw, feeBasis),
    {
      key: "membership_started",
      label: "멤버십 전환",
      unit: "명",
      metric: measured(raw.membershipsStarted),
      basis: "기간 내 프리미엄으로 시작한 구독 수",
    },
    {
      key: "membership_conversion",
      label: "멤버십 전환율",
      unit: "%",
      asBar: true,
      // 분모는 **소비자 가입**이다. 멤버십은 소비자 상품이라 운영자·업체 계정을
      // 분모에 넣으면 전환율이 계정 관리 사정에 따라 흔들린다.
      metric: ratioBp(raw.membershipsStarted, raw.consumerSignups, "기간 내 소비자 가입이"),
      basis: "기간 내 구독 시작 ÷ 기간 내 소비자 가입",
    },
    {
      key: "membership_churn",
      label: "멤버십 이탈",
      unit: "명",
      metric: measured(raw.membershipsCanceled + raw.membershipsExpired),
      basis: `해지 ${raw.membershipsCanceled.toLocaleString("en-US")}건 + 만료 ${raw.membershipsExpired.toLocaleString("en-US")}건`,
    },
    {
      key: "membership_churn_rate",
      label: "멤버십 이탈률",
      unit: "%",
      asBar: true,
      // 분모는 **기간 말 활성 + 기간 내 이탈** — 기간 안에 한 번이라도 활성이었던 모수다.
      // 활성만으로 나누면 전원이 이탈한 달에 분모가 0이 되어 이탈률이 사라진다.
      metric: ratioBp(
        raw.membershipsCanceled + raw.membershipsExpired,
        raw.membershipsActive + raw.membershipsCanceled + raw.membershipsExpired,
        "활성·이탈 구독이",
      ),
      basis: "이탈 ÷ (기간 말 활성 + 기간 내 이탈)",
    },
  ];
}

/**
 * 단계별 전환 퍼널 (§6.4 "단계별 전환 퍼널").
 *
 * **소비자 여정 하나로 잡는다** — 가입 → 온보딩 → 장바구니 → 문의 → 상담 → 예약 → 계약.
 * 모수가 다른 지표를 한 줄에 세우면(예: 업체 노출) 잔존율이 100% 를 넘고, 그 숫자는
 * 아무 뜻도 없다.
 */
export function buildFunnel(raw: RawMetrics): FunnelStep[] {
  const steps: { key: string; label: string; value: number; basis: string }[] = [
    {
      key: "signup",
      label: "소비자 가입",
      value: raw.consumerSignups,
      basis: "기간 내 새로 만들어진 소비자 프로필. 운영자·업체·플래너 계정은 빼고 셉니다",
    },
    {
      key: "onboarded",
      label: "온보딩 완료",
      value: raw.onboardedCouples,
      basis: "기간 내 만들어진 커플 중 온보딩을 마친 수",
    },
    {
      key: "cart",
      label: "장바구니 담기",
      value: raw.couplesWithCart,
      basis: "기간 내 장바구니에 상품을 담은 커플 수",
    },
    { key: "inquiry", label: "문의", value: raw.inquiries, basis: "기간 내 생성된 문의" },
    {
      key: "consultation",
      label: "상담",
      value: raw.consultations,
      basis: "기간 내 확정된 상담",
    },
    { key: "booking", label: "예약", value: raw.bookings, basis: "기간 내 확정·이행 예약" },
    { key: "contract", label: "계약", value: raw.contracts, basis: "기간 내 발행된 계약" },
  ];

  return steps.map((step, index) => {
    const previous = index === 0 ? null : steps[index - 1];

    return {
      key: step.key,
      label: step.label,
      count: measured(step.value),
      basis: step.basis,
      vsPreviousBp: previous ? ratioBp(step.value, previous.value, `${previous.label}이(가)`) : null,
    };
  });
}

/**
 * 아직 셀 수단이 없는 지표.
 *
 * **여기를 비워 두면 다음 사람이 0을 넣는다.** 무엇이 왜 없는지와 어느 태스크가 채우는지를
 * 코드에 남긴다 — 화면이 그대로 읽어 "집계 대상 없음 · 연결 예정 S8-xx" 로 그린다.
 */
export function pendingCards(): MetricCard[] {
  return [
    {
      key: "impressions",
      label: "노출 → 조회 전환",
      unit: "%",
      basis: "",
      metric: notYet(
        "노출·조회를 세는 수집 경로가 아직 없습니다. 지금 셀 수 있는 것은 행이 남는 행위뿐입니다.",
        "S8-05",
      ),
    },
    {
      key: "ai_cost",
      label: "AI 호출 비용",
      unit: "원",
      basis: "",
      // S8-07 이 두 군데를 바로잡았다.
      //
      //  1. **담당이 틀렸다** — `S8-04`(개인정보 감사)로 적혀 있었다. AI 비용은
      //     F-A-04(S8-07)의 것이고, 잘못 적힌 담당은 그 태스크가 끝나도 아무도
      //     걷지 않는다(FIX-29 가 같은 이유로 생겼다).
      //  2. **사실이 틀렸다** — 그때 `ai_call_logs` 에는 **토큰 칸이 없었다.**
      //     토큰은 `document_analyses` 에만 있었고 그마저 리포트 전용이었다.
      //     0059 가 로그에 토큰 칸을 만들고 플래너까지 계측한 뒤에야 이 문장이 참이 된다.
      //
      // **여전히 `notYet` 이 아니라 미결이다** — 이제 토큰은 실제로 쌓이고 단가만
      // 비어 있다. 기능이 없는 것과 기준이 없는 것은 다른 상태다(D-108).
      metric: undecided(
        "토큰 사용량은 ai_call_logs 에 쌓입니다. 단가가 운영 파라미터로 들어와야 금액이 됩니다.",
        "O-21",
      ),
    },
  ];
}
