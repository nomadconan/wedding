// 예약 분쟁 조율 (S8-03 · F-A-12 · D-24)
//
// ══════════════════════════════════════════════════════════════════════════
// **플랫폼은 판정자가 아니라 조율자다**(D-24). 이 파일이 그 원칙의 시험대다.
// ══════════════════════════════════════════════════════════════════════════
//
// 그래서 조치의 모양이 다르다. 운영자가 할 수 있는 일은
//   · **조율안을 제시한다**(`propose`)   — 제안이지 결정이 아니다
//   · **합의를 기록한다**(`agree`)       — 양측이 동의했다는 **사실의 기록**이다
//   · **합의가 안 됐음을 기록한다**(`unresolved`)
//   · **접수가 거둬졌음을 기록한다**(`withdraw`)
// 이며, **'플랫폼이 이렇게 정한다' 는 조치가 없다.**
//
// `agree` 는 양측 동의 없이는 통과하지 못한다(화면·라우트·DB CHECK 세 층).
// 한쪽만 끄덕인 것을 합의로 적으면 그 기록이 나중에 "합의했잖아요" 의 근거가 된다.

import { z } from "zod";

/** `disputes.status` (0055 CHECK 과 같은 어휘). */
export const DISPUTE_STATUSES = [
  "open",
  "mediating",
  "agreed",
  "unresolved",
  "withdrawn",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, string> = {
  open: "접수됨",
  mediating: "조율 중",
  agreed: "합의 성립",
  unresolved: "합의 불성립",
  withdrawn: "접수 거둠",
};

/** `disputes.reason_code` (0055 CHECK 과 같은 어휘). */
export const DISPUTE_REASON_LABEL: Record<string, string> = {
  no_show: "노쇼",
  quality: "품질",
  schedule: "일정",
  refund: "환불",
  contract_terms: "계약 조건",
  payment: "결제",
  other: "기타",
};

export const DISPUTE_ACTIONS = ["propose", "agree", "unresolved", "withdraw"] as const;
export type DisputeAction = (typeof DISPUTE_ACTIONS)[number];

export const DISPUTE_ACTION_LABEL: Record<DisputeAction, string> = {
  propose: "조율안 제시",
  agree: "합의 성립 기록",
  unresolved: "합의 불성립 기록",
  withdraw: "접수 거둠 기록",
};

const ACTION_TO_STATUS: Record<DisputeAction, DisputeStatus> = {
  propose: "mediating",
  agree: "agreed",
  unresolved: "unresolved",
  withdraw: "withdrawn",
};

export function statusAfter(action: DisputeAction): DisputeStatus {
  return ACTION_TO_STATUS[action];
}

export function isTerminal(status: DisputeStatus): boolean {
  return status === "agreed" || status === "unresolved" || status === "withdrawn";
}

/**
 * 지금 이 조치를 할 수 있는가.
 *
 * **종결된 건은 되돌리지 않는다.** 조율 결과를 되돌리면 "그때 무엇으로 합의했나" 를
 * 답할 수 없게 된다. 다시 다퉈야 하면 **새 건으로 접수**한다.
 */
export function canApply(current: DisputeStatus, action: DisputeAction): boolean {
  if (isTerminal(current)) return false;
  // 조율안은 여러 번 낼 수 있다 — 한 번에 합의되는 분쟁은 드물다.
  if (action === "propose") return true;

  return true;
}

/**
 * **합의 불성립 뒤에 무엇을 하는지 코드가 정하지 않는다.**
 *
 * 화면이 그대로 보여주는 문장이다. 플랫폼이 그 다음 절차(중재 신청·소송·기각)를
 * 코드로 정하면 그것이 곧 약관이 된다 — 그 자리는 §7.7·O-03 이다.
 */
export const UNRESOLVED_NOTICE =
  "합의가 이뤄지지 않은 건입니다. 이후 절차는 이용약관이 정하며 이 화면에서 결정하지 않습니다.";

/** D-24 를 화면에 상시 노출한다. 조율 콘솔의 모든 조치 위에 붙는다. */
export const MEDIATOR_NOTICE =
  "플랫폼은 판정자가 아니라 조율자입니다. 여기서 하는 일은 기록을 제시하고 합의를 돕는 것이며, 어느 쪽의 책임을 확정하지 않습니다.";

export const MediationActionSchema = z
  .object({
    action: z.enum(DISPUTE_ACTIONS),
    note: z.string().trim().min(1, "사유를 적어 주세요.").max(2_000),
    /** `agree` 에만 쓴다. 양측 동의 사실을 운영자가 기록한다. */
    coupleAgreed: z.boolean().optional(),
    vendorAgreed: z.boolean().optional(),
  })
  .strict();

export type MediationActionInput = z.infer<typeof MediationActionSchema>;

/**
 * 화면이 저장을 막는 이유. 없으면 `null`.
 *
 * **'조치 없음' 도 설명해야 한다**(S7-17) — `withdraw` 에도 사유가 필수다.
 */
export function disputeProblem(input: {
  status: DisputeStatus;
  action: DisputeAction | null;
  note: string;
  coupleAgreed: boolean;
  vendorAgreed: boolean;
}): string | null {
  if (!input.action) return "조치를 선택해 주세요.";
  if (!canApply(input.status, input.action)) {
    return "이미 종결된 건입니다. 다시 다퉈야 하면 새 건으로 접수해 주세요.";
  }
  if (input.note.trim().length === 0) return "사유를 적어 주세요.";

  if (input.action === "agree" && !(input.coupleAgreed && input.vendorAgreed)) {
    return "양측이 모두 동의해야 합의로 기록할 수 있습니다. 한쪽만 동의했다면 조율 중으로 두세요.";
  }

  return null;
}

/**
 * 합의 진행 상태를 한 줄로.
 *
 * **"아직 아무도 동의하지 않음" 과 "한쪽만 동의" 를 구분한다** — 둘을 같은 얼굴로
 * 그리면 운영자가 얼마나 진행됐는지 모른다(함정 2 와 같은 결).
 */
export function agreementState(couple: boolean, vendor: boolean): string {
  if (couple && vendor) return "양측 동의";
  if (couple) return "커플만 동의";
  if (vendor) return "업체만 동의";

  return "아직 동의 없음";
}
