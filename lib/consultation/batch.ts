import { createAdminClient } from "@/lib/supabase/admin";

import { applyVerdict, openConfirmationWindow } from "./actions";
import { loadConsultationSettings } from "./loader";

/**
 * 이행 확인 배치 (§3.11 · S4-09)
 *
 * 커버리지 표의 배치 둘을 한 파일에 둔다 —
 *   `consultation-confirm-request` (Cron 1시간) : 예정 시각이 지나면 확인을 요청한다
 *   `consultation-resolve`         (Cron 1시간) : 기한이 지나면 규칙대로 마무리한다
 *
 * **로직만 만든다.** 실행 등록(Cron·`job_runs` 기록·실패 경보)은 **S8-13** 소관이다
 * — `dday-notifications`·`sla-escalation` 과 같은 규칙.
 *
 * ── 왜 배치가 필요한가 ─────────────────────────────────────────────────────
 * 이행 확인은 **아무도 화면을 열지 않아도** 진행되어야 한다. 고객이 앱을 안 열면
 * 보증금이 영원히 잡혀 있고, 업체가 안 열면 환불이 안 된다. 시간이 지나면 저절로
 * 벌어져야 하는 일을 화면에 매달면 그것은 규칙이 아니라 운이다.
 *
 * ── '지금' 을 호출자가 넘긴다 ───────────────────────────────────────────────
 * 배치가 스스로 시각을 정하면 같은 입력으로 같은 결과가 나오지 않아 재현할 수 없다
 * (S2-06 이 세운 규칙). 판정 근거를 재현 가능하게 남기라는 이번 제약이 여기서 값을 한다.
 */
export type ConfirmRequestResult = {
  scanned: number;
  opened: number;
  skipped: number;
};

/**
 * 예정 시각이 지난 확정 예약에 **확인 창을 연다**(§3.11 1번).
 *
 * 0025 의 부분 인덱스 `idx_consultations_awaiting_confirm` 를 타는 조회다.
 * 기한(`confirm_due_at`)이 아직 없는 건만 잡히므로 같은 건을 두 번 열지 않는다.
 */
export async function runConfirmRequests(now: string): Promise<ConfirmRequestResult> {
  const admin = createAdminClient();
  const settings = await loadConsultationSettings();
  const result: ConfirmRequestResult = { scanned: 0, opened: 0, skipped: 0 };

  const { data } = await admin
    .from("consultations")
    .select("id, scheduled_at")
    .eq("status", "confirmed")
    .is("confirm_due_at", null)
    .lt("scheduled_at", now);

  const rows = (data ?? []) as { id: string; scheduled_at: string }[];
  result.scanned = rows.length;

  for (const row of rows) {
    const opened = await openConfirmationWindow(
      row.id,
      row.scheduled_at,
      settings.confirmDueHours,
    );

    if (opened) result.opened += 1;
    else result.skipped += 1;
  }

  return result;
}

export type ResolveResult = {
  scanned: number;
  refunded: number;
  forfeited: number;
  disputed: number;
};

/**
 * 확인 기한이 지난 건을 §3.11 규칙대로 마무리한다.
 *
 * **판정은 `resolveVerdict()` 하나가 한다.** 이 함수는 대상을 골라 넘길 뿐이다 —
 * 배치가 자체 규칙을 갖는 순간 화면·API 와 답이 갈린다.
 *
 * 양측 무응답이면 **환불**이 기본값이다(§3.11 NOTE). 그 판단은 순수 함수 안에 있고
 * 여기서 다시 쓰지 않는다.
 */
export async function runResolve(now: string): Promise<ResolveResult> {
  const admin = createAdminClient();
  const result: ResolveResult = { scanned: 0, refunded: 0, forfeited: 0, disputed: 0 };

  const { data } = await admin
    .from("consultations")
    .select("id, couple_outcome, vendor_outcome")
    .eq("status", "confirmed")
    .not("confirm_due_at", "is", null)
    .lt("confirm_due_at", now);

  const rows = (data ?? []) as {
    id: string;
    couple_outcome: "fulfilled" | "no_show_couple" | "no_show_vendor" | "undetermined" | null;
    vendor_outcome: "fulfilled" | "no_show_couple" | "no_show_vendor" | "undetermined" | null;
  }[];

  result.scanned = rows.length;

  for (const row of rows) {
    // 배치가 부르는 판정에는 행위자가 없다 — 사람이 정한 것이 아니라 규칙이 정했다.
    const verdict = await applyVerdict(row.id, row.couple_outcome, row.vendor_outcome, null);

    if (verdict.deposit === "refund") result.refunded += 1;
    else if (verdict.deposit === "forfeit") result.forfeited += 1;
    else result.disputed += 1;
  }

  return result;
}
