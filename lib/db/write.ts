/**
 * 상태 표 쓰기의 결과를 **반드시 보게 만드는 자리** (FIX-73 · D-237)
 *
 * ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
 * FIX-72 가 증적(`audit_logs`)을 닫는 동안 리포 전체를 훑었더니 **쓰기 여든세 자리가
 * 결과를 안 보고 있었다.** 많은 곳이 `payments`·`consultation_deposits`·
 * `payment_webhook_events`·`contract_cancellations` 처럼 **돈과 계약**이다.
 *
 *     await admin.from("payments").update({ status: "failed" }).eq("id", id);
 *
 * 이 줄이 조용히 실패하면 **결제는 실패했는데 표에는 실패로 안 적힌다.** 재시도
 * 배치는 그 행을 '아직 시도 전' 으로 보고 다시 긁고, 사용자는 두 번 청구된다.
 *
 * ── 증적과 성격이 다르다 (D-204 와 갈리는 지점) ─────────────────────────────
 * 증적 쓰기는 **본 작업이 이미 커밋된 뒤**에 일어나므로 던져 봐야 "상태는 바뀌었는데
 * 사용자만 500 을 본다" 가 된다 — 그래서 D-204 는 **던지지 않고 boolean 을 돌려주기로**
 * 했다.
 *
 * **상태 표는 반대다.** 그 쓰기가 **본 작업 자체**다. 실패했는데 진행하면 **표가
 * 틀어진 채로 굴러간다** — 증적처럼 "나중에 못 되살린다" 가 아니라 **지금 틀린 값으로
 * 다음 판단이 내려진다.** 그래서 기본은 **던진다**.
 *
 * ── 한 자리씩 고치지 않는다 ─────────────────────────────────────────────────
 * D-204 가 증적에서 배운 것을 그대로 쓴다 — 자리를 하나로 모으고 **검사가 새 자리를
 * 막는다**(`scripts/check-writes.mjs`). 여든세 자리를 각각 고치면 **여든네 번째가
 * 생기는 날 같은 일이 반복된다.**
 *
 * ── 로그에 값을 남기지 않는다 (§5.3) ────────────────────────────────────────
 * `where` 는 **호출부가 적는 고정 문자열**이고 PG 오류는 **코드만** 남긴다.
 * `error.message` 에는 위반한 값이 실려 나올 수 있다(유니크 위반의 상세가 그렇다) —
 * 결제·계약 표라 그 값이 곧 개인정보이자 금액이다.
 */

/** Supabase 쓰기 응답 중 우리가 보는 부분. 행 내용은 보지 않는다. */
export type WriteOutcome = {
  error: { code?: string | null; message?: string } | null;
};

export class WriteFailedError extends Error {
  readonly where: string;
  readonly code: string | null;

  constructor(where: string, code: string | null) {
    // **메시지에 값이 들어가지 않는다** — 자리 이름과 PG 코드뿐이다.
    super(`DB_WRITE_FAILED ${where}${code === null ? "" : ` (${code})`}`);
    this.name = "WriteFailedError";
    this.where = where;
    this.code = code;
  }
}

const codeOf = (outcome: WriteOutcome): string | null =>
  outcome.error === null ? null : (outcome.error.code ?? "unknown");

/**
 * 상태 표에 쓴다. **실패하면 던진다.**
 *
 * `where` 는 `"payments.update:mark-paid"` 처럼 **무엇을 하려던 자리인지**를 적는다 —
 * 표 이름만 적으면 같은 표를 여러 번 쓰는 함수에서 어느 줄인지 알 수 없다.
 *
 * 돌려주는 값은 원래 응답 그대로다. `.select()` 를 붙였으면 `data` 를 그대로 쓴다.
 */
export async function mustWrite<T extends WriteOutcome>(
  where: string,
  run: PromiseLike<T>,
): Promise<T> {
  const outcome = await run;

  if (outcome.error !== null) throw new WriteFailedError(where, codeOf(outcome));

  return outcome;
}

/**
 * 던지면 **더 많이 잃는** 자리에서 쓴다. 실패를 **값으로** 돌려준다.
 *
 * 쓰는 자리는 둘뿐이다:
 *  · **웹훅 수신 기록** — 던지면 PG 가 재전송하고, 재전송이 같은 이유로 또 실패하면
 *    무한 재시도가 된다. 처리 자체는 이미 끝났을 수 있다.
 *  · **배치 한 건** — 한 건이 실패했다고 나머지 전부를 멈추지 않는다.
 *
 * **삼키는 것이 아니다.** `false` 를 돌려주므로 부르는 쪽이 세어서 남겨야 하고,
 * 안 세면 `check:writes` 가 잡는다(반환값을 안 받는 호출은 미확인으로 센다).
 */
export async function tryWrite(where: string, run: PromiseLike<WriteOutcome>): Promise<boolean> {
  const outcome = await run;

  if (outcome.error === null) return true;

  // 값이 아니라 **자리와 코드만** 남긴다(§5.3).
  console.error(`[db] write failed: ${where} (${codeOf(outcome)})`);

  return false;
}
