// 분쟁 조율 큐 (S8-03 · F-A-12 · F-A-16 · 명세서 §6.4 `/admin/disputes`)
//
// ══════════════════════════════════════════════════════════════════════════
// **읽기는 하나로, 집행은 각자.** 이것이 이 파일의 전제다.
// ══════════════════════════════════════════════════════════════════════════
//
// 분쟁이 쌓이는 자리가 넷이다.
//   `disputes`               예약 분쟁 (F-A-12)
//   `consultation_deposits`  노쇼 보증금 (S4-07 · F-A-16)
//   `contract_cancellations` 취소·위약금 (S5-06·S5-08 · F-A-17)
//   `escrow_holds`           안전거래 이의 (S5-09)
//
// **S5-09 의 경고를 지킨다** — "형태가 닮았다고 묶으면 규칙이 하나로 수렴하고, 그때
// 어느 한쪽의 기본값이 조용히 바뀐다". 실제로 넷의 기본값은 서로 **반대**다:
// 보증금은 무응답이면 **환불**(방치가 이득이 되면 안 된다 · D-22), 에스크로는 무응답 +
// 예식일 경과면 **릴리즈**(서비스는 이미 이행됐다). 하나로 묶는 순간 둘 중 하나가 뒤집힌다.
//
// 그래서 **상태 어휘를 수렴시키지 않는다.** 각 출처는 자기 어휘를 그대로 들고 오고,
// 큐는 "지금 열려 있는가" 하나만 공통으로 판정한다. 화면에는 **출처 배지 + 원 상태
// 라벨**이 함께 뜬다 — 운영자가 보는 것은 통합된 상태가 아니라 **한 목록에 모인 네 종류**다.
//
// **그런데도 큐는 합쳤다.** 화면이 넷이면 운영자가 그 중 하나를 안 본다. 실제로
// 안전거래 이의는 **화면 자체가 없어서**(FIX-15) 이의를 받아 놓고 처리할 자리가 없었다.
// 보는 곳을 합치는 것과 집행 규칙을 합치는 것은 다른 일이다.

export const DISPUTE_SOURCES = ["booking", "consultation", "cancellation", "escrow"] as const;
export type DisputeSource = (typeof DISPUTE_SOURCES)[number];

export const SOURCE_LABEL: Record<DisputeSource, string> = {
  booking: "예약 분쟁",
  consultation: "노쇼 보증금",
  cancellation: "취소·위약금",
  escrow: "안전거래 이의",
};

/**
 * 이 건을 **어디서 처리하는가**.
 *
 * `console` 은 이 화면 안에서, `penalties` 는 `/admin/penalties` 로 넘긴다.
 * **위약금을 여기로 가져오지 않은 이유**: 그쪽 화면은 밴드 계산·산정 근거·정산 연계가
 * 붙어 있고(S5-08), 그것을 큐 안에 다시 그리면 **두 벌**이 된다. 큐는 "여기 이런 건이
 * 있다" 까지 하고 넘긴다.
 */
export type HandledAt = "console" | "penalties";

export const HANDLED_AT: Record<DisputeSource, HandledAt> = {
  booking: "console",
  consultation: "console",
  escrow: "console",
  cancellation: "penalties",
};

/**
 * **각 출처의 '열림' 규칙.** 하나의 어휘로 합치지 않는다.
 *
 * 여기서 하는 일은 번역이 아니라 **판정**이다 — "이 건이 아직 운영자의 손을 기다리는가".
 * 같은 `disputed` 라도 표마다 뜻이 조금씩 다르고, 그 차이를 지우지 않으려고 표를 나눠 둔다.
 */
const OPEN_STATUSES: Record<DisputeSource, readonly string[]> = {
  // 접수됨·조율 중. 종결(agreed·unresolved·withdrawn)은 닫힌 것이다.
  booking: ["open", "mediating"],
  // 보증금은 `disputed` 일 때만 운영자를 기다린다. held 는 정상 보관이다.
  consultation: ["disputed"],
  // 해지는 양측 확인이 갈렸을 때(`disputed`) 조율로 온다.
  cancellation: ["disputed"],
  // 안전거래도 이의가 걸린 것만. held 는 정상 보관이다.
  escrow: ["disputed"],
};

export function isOpenFor(source: DisputeSource, status: string): boolean {
  return OPEN_STATUSES[source].includes(status);
}

export type QueueItem = {
  source: DisputeSource;
  id: string;
  /** 원 상태 문자열. **번역하지 않는다** — 화면이 출처와 함께 보여준다. */
  status: string;
  openedAt: string;
  /** 걸린 금액(원). 모르면 null 이다 — **0 이 아니다**(0원은 '걸린 돈이 없다' 는 뜻이다). */
  amountKrw: number | null;
  reasonCode: string | null;
  /** 이 건이 매달린 예약. 타임라인을 여는 열쇠다. */
  bookingId: string | null;
  isOpen: boolean;
  handledAt: HandledAt;
};

/**
 * 큐 정렬. **열린 것 먼저, 그 안에서 오래된 것부터**.
 *
 * 출처·금액별 가중치를 두지 않는다 — 무엇이 더 급한지는 **운영 정책이지 코드의
 * 판단이 아니고** 지금 그 정책이 없다(S7-17·S8-04 가 같은 자리에서 내린 결론).
 * 금액으로 줄을 세우면 **큰 건이 늘 먼저**가 되는데, 작은 건이 오래 방치되는 것이
 * 분쟁에서는 더 나쁘다.
 */
export function sortDisputeQueue(items: QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
    if (a.openedAt !== b.openedAt) return a.openedAt < b.openedAt ? -1 : 1;

    // 같은 시각이면 출처·id 로 갈라 **순서를 고정한다** — 흔들리면 같은 화면을 두 번
    // 열었을 때 순서가 달라지고, 조율 기록에서 그것은 신뢰의 문제가 된다(D-114 와 같다).
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type QueueSummary = {
  source: DisputeSource;
  label: string;
  open: number;
  total: number;
};

/**
 * 출처별 개수.
 *
 * **0 건도 줄을 남긴다.** 없는 출처를 화면에서 빼면 "이 종류는 분쟁이 없다" 와
 * "이 종류는 큐에 안 붙어 있다" 가 겹쳐 읽힌다 — FIX-15 가 정확히 후자였고,
 * 화면에 줄이 없어서 아무도 눈치채지 못했다.
 */
export function queueSummary(items: QueueItem[]): QueueSummary[] {
  return DISPUTE_SOURCES.map((source) => {
    const rows = items.filter((item) => item.source === source);

    return {
      source,
      label: SOURCE_LABEL[source],
      open: rows.filter((item) => item.isOpen).length,
      total: rows.length,
    };
  });
}

/** 경과 시간(시간 단위). 기한 판정은 하지 않는다 — 조율 기한은 약관 소관이다. */
export function elapsedHours(openedAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(openedAt)) / 3_600_000));
}
