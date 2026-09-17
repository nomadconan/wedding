import {
  CONTRACT_STATUS_LABEL,
  SIGNER_ROLE_LABEL,
  SIGNING_STATE_LABEL,
  type ClauseSlot,
  type ContractStatus,
  type SignerRole,
  type SigningState,
  canSign,
  requiredSignerRoles,
  signingProgress,
  signingState,
} from "@/lib/core/contract/contract";
import { createClient } from "@/lib/supabase/server";

/**
 * 계약서 열람 (FIX-57 · F-C-15 · §6.2 `/contracts/[id]`)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * **화면 없이 링크만 있었다**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 소비자 예약 상세(`entryPoints`)와 `/vendor/bookings` **둘 다** `/contracts/[id]` 로
 * 링크하는데 그 화면이 없었다 — `docs/ROUTES.md` 가 리포의 **유일한 죽은 링크**로
 * 세고 있었고 FIX-57 로 기록돼 있었다. 계약 데이터·서명 API·정본 해시는 전부
 * 만들어져 있었고 **볼 자리만** 없었다.
 *
 * ── 세션으로 읽는다 ────────────────────────────────────────────────────────
 * `contracts_select` 가 커플·업체·플래너를 가른다(0029). 서비스롤로 읽으면 그 경계를
 * 우회해 "화면에서만 감추는" 상태가 된다.
 *
 * ── Storage 경로를 내보내지 않는다 (§5.3) ──────────────────────────────────
 * `contracts.pdf_path` 는 **조회 컬럼에 넣지 않는다.** 경로는 로그·응답 어디에도
 * 남기지 않기로 한 값이고, PDF 가 필요해지는 날 서명 URL(유효 5분)로 따로 연다.
 */

/** `ClauseSlot.body` 는 선택(`string | undefined`)이라 "비어 있다" 를 말하지 못한다.
 * 화면은 **문안이 없다는 사실을 적어야** 하므로 여기서는 `null` 로 바꿔 든다. */
export type ContractClause = Omit<ClauseSlot, "body"> & { body: string | null };

export type ContractSignature = {
  role: SignerRole;
  roleLabel: string;
  signedAt: string | null;
};

export type ContractView = {
  id: string;
  bookingId: string;
  status: ContractStatus;
  statusLabel: string;
  state: SigningState;
  stateLabel: string;
  totalAmount: number;
  templateVersion: string | null;
  contentHash: string;
  issuedAt: string | null;
  activatedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  signingDeadlineAt: string | null;
  clauses: ContractClause[];
  signatures: ContractSignature[];
  signedCount: number;
  requiredCount: number;
  /** 지금 이 사람이 서명할 수 있는가. **역할은 서버가 판정한다**(입력으로 받지 않는다). */
  myRole: SignerRole | null;
  canISign: boolean;
  /** 못 하는 이유. 감추면 "그런 기능이 없다" 로 읽힌다. */
  signBlockedReason: string | null;
};

export async function loadContract(
  contractId: string,
  now: Date,
  /** 지금 보고 있는 사람. **역할 판정에 반드시 필요하다**(아래 `roleOf` 주석). */
  actorId: string,
): Promise<ContractView | null> {
  const supabase = await createClient();

  const { data: row } = await supabase
    .from("contracts")
    // **`pdf_path` 를 읽지 않는다**(§5.3 — Storage 경로는 어디에도 남기지 않는다).
    .select(
      "id, booking_id, status, total_amount, template_version, content_hash, clauses_json, issued_at, activated_at, cancelled_at, cancel_reason, signing_deadline_at, planner_id",
    )
    .eq("id", contractId)
    .maybeSingle();

  const contract = row as {
    id: string;
    booking_id: string;
    status: ContractStatus;
    total_amount: number;
    template_version: string | null;
    content_hash: string;
    clauses_json: unknown;
    issued_at: string | null;
    activated_at: string | null;
    cancelled_at: string | null;
    cancel_reason: string | null;
    signing_deadline_at: string | null;
    planner_id: string | null;
  } | null;

  // **없는 것과 못 보는 것을 같게 답한다.**
  if (!contract) return null;

  const { data: signatureRows } = await supabase
    .from("contract_signatures")
    .select("signer_role, signed_at")
    .eq("contract_id", contractId);

  const signed = ((signatureRows ?? []) as { signer_role: SignerRole; signed_at: string | null }[])
    .map((sig) => ({ signerRole: sig.signer_role, signedAt: sig.signed_at }));

  const required = requiredSignerRoles({ plannerParty: contract.planner_id !== null });
  const progress = signingProgress(signed, required);

  const state = signingState({
    status: contract.status,
    deadlineAt: contract.signing_deadline_at,
    complete: progress.complete,
    now,
  });

  const myRole = await roleOf(contract.booking_id, contract.planner_id, actorId);

  const alreadySigned =
    myRole !== null && signed.some((sig) => sig.signerRole === myRole && sig.signedAt !== null);

  return {
    id: contract.id,
    bookingId: contract.booking_id,
    status: contract.status,
    statusLabel: CONTRACT_STATUS_LABEL[contract.status] ?? contract.status,
    state,
    stateLabel: SIGNING_STATE_LABEL[state] ?? state,
    totalAmount: contract.total_amount,
    templateVersion: contract.template_version,
    contentHash: contract.content_hash,
    issuedAt: contract.issued_at,
    activatedAt: contract.activated_at,
    cancelledAt: contract.cancelled_at,
    cancelReason: contract.cancel_reason,
    signingDeadlineAt: contract.signing_deadline_at,
    clauses: toClauses(contract.clauses_json),
    signatures: progress.required.map((role) => ({
      role,
      roleLabel: SIGNER_ROLE_LABEL[role],
      signedAt: signed.find((sig) => sig.signerRole === role)?.signedAt ?? null,
    })),
    signedCount: progress.signed.length,
    requiredCount: progress.required.length,
    myRole,
    canISign: myRole !== null && !alreadySigned && canSign(state),
    signBlockedReason: blockReason({ myRole, alreadySigned, state }),
  };
}

/**
 * 조항. **문안이 없으면 없다고 적는다.**
 *
 * 법무 검수(O-03) 전까지 본문은 비어 있고, 그 사실을 화면이 말해야 한다 —
 * 빈 칸을 그리면 "조항이 없는 계약" 으로 읽힌다.
 */
function toClauses(value: unknown): ContractClause[] {
  if (!Array.isArray(value)) return [];

  return (value as Record<string, unknown>[])
    .map((clause) => ({
      code: String(clause.code ?? ""),
      order: Number(clause.order ?? 0),
      title: String(clause.title ?? ""),
      basisNote: String(clause.basisNote ?? clause.basis_note ?? ""),
      body: typeof clause.body === "string" && clause.body.trim() !== "" ? clause.body : null,
    }))
    .sort((a, b) => a.order - b.order);
}

/**
 * 어느 편인가 — **서버가 판정한다.**
 *
 * 서명 API 와 같은 규칙이다(입력으로 받으면 고객이 업체 칸에 서명하는 요청을 만들 수
 * 있다). 여기서는 **보여 줄 버튼을 정하는 데만** 쓰고, 최종 판정은 API 가 다시 한다.
 */
async function roleOf(
  bookingId: string,
  plannerId: string | null,
  actorId: string,
): Promise<SignerRole | null> {
  const supabase = await createClient();

  const { data: bookingRow } = await supabase
    .from("bookings")
    .select("couple_id, vendor_id")
    .eq("id", bookingId)
    .maybeSingle();

  const booking = bookingRow as { couple_id: string; vendor_id: string } | null;
  if (!booking) return null;

  // **`user_id` 로 좁힌다.** 여기가 한 번 틀렸었다 — `member_role='owner'` 로만 물으면
  // **배우자도 소유자 행을 읽어**(같은 커플이라 RLS 가 보여준다) 자기가 소유자인 줄 알고
  // 서명 버튼이 뜬다. 그러면 화면이 **API 가 거부할 일을 시킨다**(§1.4 — 서명은 소유자).
  const { data: ownerRow } = await supabase
    .from("couple_members")
    .select("member_role")
    .eq("couple_id", booking.couple_id)
    .eq("user_id", actorId)
    .maybeSingle();

  const memberRole = (ownerRow as { member_role: string } | null)?.member_role ?? null;

  // 배우자는 **볼 수는 있고 서명하지 않는다.** null 을 돌려주면 화면이
  // `COUPLE_SIGNER_NOTICE` 를 적는다.
  if (memberRole === "owner") return "couple";
  if (memberRole !== null) return null;

  const { data: memberRow } = await supabase
    .from("vendor_members")
    .select("vendor_id")
    .eq("vendor_id", booking.vendor_id)
    .eq("user_id", actorId)
    .maybeSingle();

  if (memberRow !== null) return "vendor";

  // 플래너는 **이 계약의 플래너일 때만** 서명한다.
  return plannerId !== null && plannerId === actorId ? "planner" : null;
}

function blockReason(input: {
  myRole: SignerRole | null;
  alreadySigned: boolean;
  state: SigningState;
}): string | null {
  if (input.myRole === null) {
    return "이 계약의 서명 당사자가 아니에요. 내용은 볼 수 있습니다.";
  }
  if (input.alreadySigned) return "이미 서명했어요. 남은 당사자의 서명을 기다립니다.";
  if (input.state === "active") return "모든 당사자가 서명해 계약이 확정됐어요.";
  if (input.state === "cancelled") return "취소된 계약이에요.";
  if (input.state === "expired") {
    return "서명 기한이 지났어요. 업체에 다시 발행을 요청해 주세요.";
  }
  if (input.state === "draft") return "아직 발행되지 않은 계약이에요.";

  return null;
}
