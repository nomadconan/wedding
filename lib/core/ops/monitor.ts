// 모니터링·장애 대응 (S8-13 · 명세서 §7.4 · §4.5)
//
// ══════════════════════════════════════════════════════════════════════════
// **"만들었다" 와 "돈다" 와 "돌았다" 는 다른 상태다.**
// ══════════════════════════════════════════════════════════════════════════
//
// §4.5 는 배치 열 종을 주기와 함께 적는다. 지금 상태를 세어 보면 셋으로 갈린다.
//
//   코드 없음      라우트 자체가 없다 — 주기가 와도 부를 것이 없다
//   등록 안 됨     라우트는 있는데 `vercel.json` 의 `crons` 에 없다 — **아무도 안 부른다**
//   실행 없음      등록됐는데 `job_runs` 에 한 번도 안 남았다 — 배포 전이거나 인증이 막혔다
//
// 셋을 한 얼굴로 그리면 **"배치가 있다" 로 읽힌다.** 특히 `purge-documents` 는
// 개인정보 24시간 파기(CLAUDE.md §5.1)라 안 도는 것이 곧 규정 위반이고, 화면이
// 그것을 "정상" 으로 보이면 아무도 모른 채 지나간다.

/** 배치 하나의 선언. **명세 §4.5 를 그대로 옮긴다** — 우리가 지어내지 않는다. */
export type BatchSpec = {
  name: string;
  /** §4.5 의 '주기·트리거' 칸 그대로. */
  schedule: string;
  /** cron 식. **명세의 주기를 옮긴 것**이며 `vercel.json` 과 같아야 한다. */
  cron: string | null;
  purpose: string;
  /**
   * 안 돌면 무엇이 깨지는가. **등급이 아니라 결과를 적는다** — "high" 라고 쓰면
   * 읽는 사람이 그 등급의 뜻을 물어야 하지만, 결과를 적으면 바로 판단할 수 있다.
   */
  consequence: string;
  /** 법적 의무에 걸리는가. 파기 배치가 그렇다(§5.1). */
  legalDuty: boolean;
};

/**
 * 명세 §4.5 의 배치 열 종.
 *
 * **`job_runs.job_name` CHECK 과 같은 목록이어야 한다**(0064) — `db:rls` 가 대조한다.
 * 갈리면 배치가 이름을 남기지 못하거나(CHECK 위반) 화면이 그 배치를 모른다.
 */
export const BATCH_SPECS: readonly BatchSpec[] = [
  {
    name: "purge-documents",
    schedule: "매시간",
    cron: "0 * * * *",
    purpose: "파기 예정 시각이 지난 계약서 원문·Storage 객체를 지운다",
    consequence:
      "업로드 원문이 24시간 넘게 남는다. 개인정보 파기 의무(CLAUDE.md §5.1)를 지키지 못하는 상태이며, 그 사실이 화면 어디에도 안 뜬다.",
    legalDuty: true,
  },
  {
    name: "dday-notifications",
    schedule: "매일 09:00 KST",
    cron: "0 0 * * *",
    purpose: "D-day·일정·계약 단계 알림을 보낸다",
    consequence: "사용자가 기한을 놓친다. 알림 자체가 스텁이라 지금은 발송도 스텁이다(D-28).",
    legalDuty: false,
  },
  {
    name: "price-index-refresh",
    schedule: "주 1회",
    cron: "0 1 * * 1",
    purpose: "참가격 지수를 다시 계산한다",
    consequence: "참가격이 낡는다. 표본이 늘어도 사분위가 그대로라 화면이 옛 시세를 말한다.",
    legalDuty: false,
  },
  {
    name: "price-anomaly-scan",
    schedule: "매일",
    cron: "0 2 * * *",
    purpose: "미끼가격·추가금 과다를 센다(§5.7)",
    consequence: "이상 탐지 큐가 갱신되지 않는다. 임계값이 미결이라(O-19) 지금은 어차피 막혀 있다.",
    legalDuty: false,
  },
  {
    name: "sla-escalation",
    schedule: "1시간",
    cron: "30 * * * *",
    purpose: "문의·채팅 미응답·심사 지연을 올린다",
    consequence: "미응답이 쌓여도 아무도 모른다.",
    legalDuty: false,
  },
  {
    name: "consultation-confirm-request",
    schedule: "1시간",
    cron: "15 * * * *",
    purpose: "예정 시각이 지난 상담의 이행 확인을 양측에 요청한다",
    consequence: "확인 요청이 안 나가 다음 배치(판정)가 무응답만 보게 된다.",
    legalDuty: false,
  },
  {
    name: "consultation-resolve",
    schedule: "1시간",
    cron: "45 * * * *",
    purpose: "이행 확인 기한이 지난 건을 판정한다 — 일치는 환불·몰취, 불일치는 분쟁 전환",
    consequence: "보증금이 묶인 채 남는다. 돈이 걸린 상태가 풀리지 않는다.",
    legalDuty: false,
  },
  {
    name: "settlement-aggregate",
    schedule: "월 2회",
    cron: null,
    purpose: "정산 기간을 집계하고 명세를 만든다",
    consequence: "업체 정산이 밀린다. 지금은 라우트가 없어 수동 실행(`/admin/settlements`)뿐이다.",
    legalDuty: false,
  },
  {
    name: "planner-payout-due",
    schedule: "매일",
    // S6-05 가 라우트를 만들고 `vercel.json` 에 등록했다.
    cron: "0 3 * * *",
    purpose: "유예 기간이 지난 플래너 정산을 지급 대상으로 넘긴다",
    consequence:
      "지급 대상 전환이 늦는다. 다만 화면은 `payable_at` 과 시계로 판정하므로(D-21) 표시는 맞다.",
    legalDuty: false,
  },
  {
    name: "escrow-release",
    schedule: "매일",
    // FIX-14 가 라우트를 만들고 `vercel.json` 에 등록했다. **예식일 경과가 조건이라
    // 날짜 경계가 가장 이른 의미 있는 시점**이다 — 시간마다 돌 이유가 없다.
    cron: "0 4 * * *",
    purpose: "이행 확인이 끝났거나 확인 기한·예식일이 모두 지난 안전거래 홀드를 정리한다",
    consequence:
      "잔금이 보관된 채 남는다. 게다가 열린 홀드가 있는 예약은 정산에서 빠지므로(settlementEligible) 그 돈은 업체에게 가지도 않고 정산에도 들어오지 않는다.",
    legalDuty: false,
  },
  {
    name: "wishlist-price-watch",
    schedule: "매일",
    cron: null,
    purpose: "찜한 상품의 가격 변동을 감지해 알린다(F-C-26)",
    consequence: "가격이 내려도 알림이 안 간다.",
    legalDuty: false,
  },
];

// =============================================================================
// 상태 판정
// =============================================================================

export const BATCH_STATES = ["no_route", "not_scheduled", "never_ran", "ran"] as const;
export type BatchState = (typeof BATCH_STATES)[number];

export const BATCH_STATE_LABEL: Record<BatchState, string> = {
  no_route: "코드 없음",
  not_scheduled: "등록 안 됨",
  never_ran: "실행 기록 없음",
  ran: "실행됨",
};

export const BATCH_STATE_HINT: Record<BatchState, string> = {
  no_route: "라우트가 없습니다. 주기가 와도 부를 것이 없습니다.",
  not_scheduled: "라우트는 있는데 스케줄에 없습니다 — 아무도 부르지 않습니다.",
  never_ran: "등록은 됐는데 한 번도 남지 않았습니다. 배포 전이거나 인증이 막혔을 수 있습니다.",
  ran: "실행 기록이 있습니다.",
};

export type BatchRun = {
  name: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  processedCount: number;
  errorSummary: string | null;
};

export type BatchRow = BatchSpec & {
  state: BatchState;
  hasRoute: boolean;
  scheduled: boolean;
  lastRun: BatchRun | null;
  /** 최근 실패. **성공이 뒤따랐어도 남긴다** — 실패가 있었다는 사실이 신호다. */
  recentFailures: number;
};

/**
 * 배치 상태를 센다.
 *
 * **넷을 한 얼굴로 그리지 않는다.** 특히 `not_scheduled` 와 `never_ran` 은 원인이
 * 달라 할 일이 다르다 — 앞은 설정이고 뒤는 배포·인증이다.
 */
export function buildBatchRows(input: {
  routes: readonly string[];
  scheduled: readonly string[];
  runs: readonly BatchRun[];
}): BatchRow[] {
  const routes = new Set(input.routes);
  const scheduled = new Set(input.scheduled);

  return BATCH_SPECS.map((spec) => {
    const mine = input.runs.filter((run) => run.name === spec.name);
    // 가장 최근 실행. `started_at` 은 NOT NULL 이라 정렬이 흔들리지 않는다(D-128).
    const lastRun =
      [...mine].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null;

    const hasRoute = routes.has(spec.name);
    const isScheduled = scheduled.has(spec.name);

    const state: BatchState = !hasRoute
      ? "no_route"
      : !isScheduled
        ? "not_scheduled"
        : lastRun === null
          ? "never_ran"
          : "ran";

    return {
      ...spec,
      state,
      hasRoute,
      scheduled: isScheduled,
      lastRun,
      recentFailures: mine.filter((run) => run.status === "failed").length,
    };
  });
}

// =============================================================================
// 경보
// =============================================================================

/**
 * 경보 한 줄.
 *
 * **저장하지 않는다**(D-124) — `job_runs`·`documents`·`client_events` 에서 계산된다.
 * 저장하면 배치가 다시 성공한 뒤에도 경보가 남고 지우는 규칙을 또 만들어야 한다.
 */
export type Alert = {
  key: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
  href: string | null;
};

/**
 * §7.4 가 이름으로 요구하는 것 — **"배치 실패는 job_runs 에 기록하고 파기 배치 실패는
 * 즉시 경보"**.
 *
 * **'즉시 경보' 를 발송으로 만들지 않았다**(D-147). 외부 발송이 전부 스텁이라(D-28)
 * 보내는 시늉을 하면 **"경보가 안 온 것" 과 "스텁이라 안 온 것" 이 구분되지 않는다** —
 * 그 둘이 겹치는 순간 경보 체계 전체를 믿을 수 없게 된다. 지금 경보는 **화면이
 * 보여주는 것까지**이고 화면이 그 사실을 적는다.
 */
export function buildAlerts(input: {
  batches: readonly BatchRow[];
  purgeOverdue: number;
  loginFailures: { code: string; count: number }[];
}): Alert[] {
  const alerts: Alert[] = [];

  for (const batch of input.batches) {
    // **법적 의무가 걸린 배치가 안 도는 것이 가장 나쁘다.** 실패보다 먼저 본다 —
    // 실패는 흔적이라도 남지만 안 도는 것은 아무 흔적이 없다.
    if (batch.legalDuty && batch.state !== "ran") {
      alerts.push({
        key: `batch_not_running:${batch.name}`,
        severity: "critical",
        title: `${batch.name} 이 돌지 않고 있습니다 (${BATCH_STATE_LABEL[batch.state]})`,
        detail: batch.consequence,
        href: "/admin/privacy",
      });
      continue;
    }

    if (batch.lastRun?.status === "failed") {
      alerts.push({
        key: `batch_failed:${batch.name}`,
        severity: batch.legalDuty ? "critical" : "warning",
        title: `${batch.name} 의 마지막 실행이 실패했습니다`,
        detail: batch.lastRun.errorSummary ?? batch.consequence,
        href: batch.legalDuty ? "/admin/privacy" : null,
      });
    }
  }

  // **파기 잔존은 배치 상태와 별도 신호다.** 배치가 성공으로 남아도 남은 문서가
  // 있으면 그것이 사실이다(S8-04 가 세운 규칙 그대로).
  if (input.purgeOverdue > 0) {
    alerts.push({
      key: "purge_overdue",
      severity: "critical",
      title: `파기 기한이 지난 문서가 ${input.purgeOverdue}건 남아 있습니다`,
      detail: "업로드 원문은 분석 완료 후 24시간 내 파기해야 합니다(CLAUDE.md §5.1).",
      href: "/admin/privacy",
    });
  }

  // 인프라 계열 로그인 실패만 경보로 올린다. **자격증명 실패는 경보가 아니다** —
  // 비밀번호를 틀리는 것은 정상이고, 그것을 경보로 올리면 경보가 소음이 된다.
  const infra = input.loginFailures
    .filter((row) => row.code !== "AUTH_INVALID_CREDENTIALS" && row.code !== "AUTH_EMAIL_NOT_CONFIRMED")
    .reduce((sum, row) => sum + row.count, 0);

  if (infra > 0) {
    alerts.push({
      key: "login_infra_failures",
      severity: "warning",
      title: `로그인이 인프라 문제로 ${infra}번 실패했습니다`,
      detail:
        "자격증명 오류가 아닌 실패입니다(타임아웃·설정·서비스 불가). FIX-24 는 이 신호가 없어 몇 주 동안 안 잡혔습니다.",
      href: null,
    });
  }

  // **심각도 순으로 고정한다** — 순서가 흔들리면 읽는 사람이 목록을 의심한다(S8-02).
  return alerts.sort((a, b) =>
    a.severity === b.severity ? a.key.localeCompare(b.key) : a.severity === "critical" ? -1 : 1,
  );
}

/** 경보 발송 경로의 상태. **화면이 이 문장을 그대로 적는다.** */
export const ALERT_DELIVERY = {
  available: false,
  reason:
    "경보를 보내는 경로가 없습니다. 외부 발송(알림톡·메일)이 전부 스텁이라(D-28) 보내는 시늉을 하면 '경보가 안 온 것'과 '스텁이라 안 온 것'이 구분되지 않습니다. 지금 경보는 이 화면을 여는 것으로만 확인됩니다.",
  openIssue: "D-28",
} as const;
