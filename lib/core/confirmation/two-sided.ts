/**
 * 양측 확인 판정 (S5-09 가 뽑아냈다 · S4-07 · S5-08 · D-23 · D-24)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다.
 *
 * ── 왜 공통으로 뽑았는가 ────────────────────────────────────────────────────
 * 같은 모양의 판정이 세 곳에 있다.
 *  1. **S4-07 상담 이행 확인** — 양측이 `fulfilled`·`no_show_*` 를 각각 답한다.
 *  2. **S5-08 해지 확인** — 양측이 동의/이의를 답한다.
 *  3. **S5-09 에스크로 이행 확인** — 양측이 이행됐다/아니다를 답한다.
 *
 * 셋의 **뼈대는 같다**: 양측 응답을 모아 `대기 / 일치 / 불일치 / 기한 경과` 를 가른다.
 * 그런데 **기한 경과의 뜻은 도메인마다 다르다** — S4-07 은 환불, S5-08 은 조율,
 * S5-09 는 릴리즈다. 그래서 **판정만 공통이고 해석은 호출부가 한다.**
 *
 * ── S4-07 을 옮기지 않은 이유 ───────────────────────────────────────────────
 * 그쪽은 불리언이 아니라 **4값 outcome 대조**(누가 안 왔는가까지 가른다)라 뼈대가
 * 실제로 다르다. 억지로 합치면 두 도메인 모두 어색해진다. **S5-08·S5-09 만** 이
 * 함수를 쓰고, S4-07 은 자기 `resolveVerdict` 를 유지한다.
 */

/** 입력이 규약을 벗어날 때 던진다. */
export class ConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationError";
  }
}

/**
 * 양측 확인의 결과.
 *
 * **`timeout` 을 결론으로 두지 않는다.** "기한이 지났다" 는 사실일 뿐이고 그것이
 * 환불인지 릴리즈인지 조율인지는 도메인이 정한다 — 여기서 정하면 한 도메인의 판단이
 * 다른 도메인으로 새어 들어간다.
 */
export const TWO_SIDED_OUTCOMES = ["waiting", "agreed", "rejected", "timeout"] as const;
export type TwoSidedOutcome = (typeof TWO_SIDED_OUTCOMES)[number];

export type TwoSidedInput = {
  /** 한쪽의 응답. null 이면 아직 답하지 않았다. */
  partyA: boolean | null;
  partyB: boolean | null;
  /** 응답 기한. null 이면 기한 없이 기다린다. */
  dueAt: string | null;
  now: Date;
};

/**
 * 양측 응답을 판정한다.
 *
 * **순서가 규칙이다.**
 *  1. **한쪽이라도 '아니다' 면 즉시 `rejected`.** 기다릴 이유가 없다 — 이의는
 *     그 자체로 결론이고, 기한을 채우게 하면 분쟁 처리만 늦어진다.
 *  2. **둘 다 '그렇다' 면 `agreed`.**
 *  3. **기한이 지났으면 `timeout`.** 무응답을 어느 쪽으로 읽을지는 호출부가 정한다.
 *  4. 그 외는 `waiting`.
 *
 * 경계는 **기한 당일 그 시각을 포함**한다 — `now >= dueAt` 이면 지난 것으로 본다.
 * 돈이 걸린 판정에서 경계를 열어 두면 "아직 하루 남았다" 는 주장이 가능해진다.
 */
export function twoSidedOutcome(input: TwoSidedInput): TwoSidedOutcome {
  if (input.partyA === false || input.partyB === false) return "rejected";
  if (input.partyA === true && input.partyB === true) return "agreed";

  if (input.dueAt !== null) {
    const due = Date.parse(input.dueAt);

    if (Number.isNaN(due)) {
      throw new ConfirmationError(`응답 기한을 읽을 수 없습니다: ${input.dueAt}`);
    }

    if (input.now.getTime() >= due) return "timeout";
  }

  return "waiting";
}

/** 아직 답하지 않은 쪽이 있는가. 화면이 "누구를 기다리는가" 를 적을 때 쓴다. */
export function pendingParties(input: {
  partyA: boolean | null;
  partyB: boolean | null;
  labelA: string;
  labelB: string;
}): string[] {
  const pending: string[] = [];

  if (input.partyA === null) pending.push(input.labelA);
  if (input.partyB === null) pending.push(input.labelB);

  return pending;
}

/** 응답 기한. 일수는 설정이 갖는다(§7.4) — 코드에 박지 않는다. */
export function confirmDueAt(startedAt: Date, days: number | null): string | null {
  if (days === null) return null;

  if (!Number.isInteger(days) || days < 0) {
    throw new ConfirmationError(`확인 기한 일수가 규약을 벗어났습니다: ${days}`);
  }

  return new Date(startedAt.getTime() + days * 86_400_000).toISOString();
}
