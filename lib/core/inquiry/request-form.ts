import { INQUIRY_NOTE_MAX, isPastDate, requestProblem, targetCountProblem } from "./inquiry";

/**
 * 표준 요청 폼 (FIX-66 · F-C-13 · §6.2 반영 제안)
 *
 * ── 사슬의 첫 칸에 화면이 없었다 ───────────────────────────────────────────
 * `POST /api/inquiries` 의 `action:"create"` 를 부르는 클라이언트가 리포에 **하나도
 * 없었다.** `InquiriesView` 는 `close`·`decide_quote` 만 보내고, 업체 상세의
 * '문의하기' 는 **채팅을 연다.** 빈 문의함은 "업체 둘러보기" 로 보내는데 그쪽에도
 * 문의를 보내는 자리가 없었다 — **안내문이 없는 것을 가리키고 있었다.**
 *
 * 그래서 `chain:walk`·`vendor:walk` 둘 다 이 칸을 **세션 fetch 로 우회**했다.
 * **실주행이 우회하는 단계는 실주행이 지키지 못한다.**
 *
 * ── 판정을 서버와 **같은 함수**로 한다 ─────────────────────────────────────
 * `requestProblem`·`targetCountProblem`·`isPastDate` 는 S4-12 가 이미 만들어 두었고
 * **`app/api/inquiries/route.ts` 가 그대로 쓴다.** 화면이 제 판정을 따로 쓰면
 * "화면은 통과인데 서버가 422" 가 생긴다 — 그래서 여기서는 **순서만 정하고 판정은
 * 그 셋에 넘긴다.** 이 파일에 새 규칙이 없는 것이 요점이다.
 *
 * ── 왜 1:N 인가 (채팅과 갈리는 지점) ───────────────────────────────────────
 * `CONTACT_PATHS`(S4-01)가 셋을 갈라 놓았다 — 문의는 "**여러 업체에서 같은 조건으로**
 * 견적을 받아 비교하고 싶을 때" 이고 남는 것은 **업체별 표준 견적서**다. 채팅은
 * 한 업체와의 대화다. 그래서 업체 상세에 1:1 '문의 보내기' 를 두지 않는다 —
 * 두면 채팅과 구분이 사라지고, **비교하려고 만든 경로가 대화 경로가 된다.**
 * 업체 상세에서 오는 길은 **그 업체가 미리 골라진 1:N 폼**으로 잇는다.
 */

/** 화면이 들고 있는 값. 문자열인 것은 `<input>` 이 문자열을 주기 때문이다. */
export type InquiryFormState = {
  vendorIds: string[];
  eventDate: string;
  guestCount: string;
  regionCode: string;
  budgetTotal: string;
  categories: string[];
  note: string;
};

export const EMPTY_INQUIRY_FORM: InquiryFormState = {
  vendorIds: [],
  eventDate: "",
  guestCount: "",
  regionCode: "",
  budgetTotal: "",
  categories: [],
  note: "",
};

/**
 * 빈 칸은 `null` 이다. **0 으로 접지 않는다** — 하객 0명과 "아직 모른다" 는 다르고,
 * 예산 0원과 "아직 안 정했다" 도 다르다. 숫자가 아니면 `null` 로 둔다(서버가 422 로
 * 막는 것보다 화면이 먼저 비워 두는 편이 낫다 — 지어낸 0 이 견적 조건이 된다).
 */
export function optionalCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const value = Number(trimmed);

  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** 폼 → `POST /api/inquiries` 본문. */
export function inquiryDraftOf(form: InquiryFormState): {
  action: "create";
  vendorIds: string[];
  eventDate: string;
  guestCount: number | null;
  regionCode: string | null;
  budgetTotal: number | null;
  categories: string[];
  note: string | null;
} {
  return {
    action: "create",
    // **중복을 여기서 걷는다.** 서버도 걷지만(`new Set`), 화면이 "3곳" 이라고 세어
    // 놓고 서버가 2곳으로 줄이면 상한 판정이 둘 사이에서 갈린다.
    vendorIds: [...new Set(form.vendorIds)],
    eventDate: form.eventDate,
    guestCount: optionalCount(form.guestCount),
    regionCode: form.regionCode.trim() === "" ? null : form.regionCode.trim(),
    budgetTotal: optionalCount(form.budgetTotal),
    categories: [...new Set(form.categories)],
    note: form.note.trim() === "" ? null : form.note.trim(),
  };
}

/**
 * 보낼 수 있는가. **못 보내는 이유를 하나만** 돌려준다(없으면 `null`).
 *
 * 서버가 보는 순서와 **같은 순서**로 본다 — 서버는 `requestProblem` → 지난 날짜 →
 * 업체 수 순으로 막는다. 화면이 다른 순서로 말하면 같은 폼에서 **다른 문장**이 나온다.
 *
 * `today` 를 인자로 받는다. 안에서 `new Date()` 를 부르면 이 함수가 시각에 의존해
 * 테스트가 자정에 깨진다(`isPastDate` 가 같은 이유로 그렇게 생겼다).
 */
export function inquiryFormProblem(
  form: InquiryFormState,
  input: { maxTargets: number; today: string },
): string | null {
  const draft = inquiryDraftOf(form);

  const problem = requestProblem({
    eventDate: draft.eventDate === "" ? null : draft.eventDate,
    guestCount: draft.guestCount,
    categories: draft.categories,
    note: draft.note,
  });
  if (problem) return problem;

  if (isPastDate(draft.eventDate, input.today)) {
    return "지난 날짜로는 견적을 요청할 수 없어요.";
  }

  return targetCountProblem(draft.vendorIds.length, input.maxTargets);
}

/**
 * 보낸 뒤 **정직하게 세는 문장**.
 *
 * 서버가 **승인된 업체만 남긴다**(`createInquiry` — 심사 중·정지된 업체는 아직 거래
 * 상대가 아니다). 화면이 고른 수만 말하면 **간 적 없는 곳에 갔다고 적는다.**
 * 그래서 고른 수와 실제로 간 수를 **둘 다** 받아 다를 때만 그 사실을 덧붙인다.
 */
export function sentSummary(input: { selected: number; targetCount: number }): string {
  if (input.targetCount >= input.selected) {
    return `${input.targetCount}곳에 문의를 보냈어요. 업체가 답하면 문의함에 쌓입니다.`;
  }

  return (
    `고른 ${input.selected}곳 가운데 ${input.targetCount}곳에 보냈어요. ` +
    "나머지는 지금 승인된 업체가 아니라 보내지 못했습니다."
  );
}

/** 폼 문구. 화면과 검사가 같은 문장을 쓴다. */
export const INQUIRY_NEW_TITLE = "견적 요청하기";
export const INQUIRY_NEW_DESCRIPTION =
  "같은 조건을 여러 업체에 한 번에 보냅니다. 업체는 표준 양식으로만 답할 수 있어서 받은 견적을 나란히 비교할 수 있어요.";

/** 업체를 한 곳도 안 고른 상태에서 쓰는 안내. **없는 길을 가리키지 않는다.** */
export const INQUIRY_NO_CANDIDATE_NOTE =
  "찜하거나 장바구니에 담은 업체가 여기 후보로 올라와요. 먼저 둘러보고 마음에 드는 곳을 담아 주세요.";

/**
 * 문의 후보 업체. **타입과 라벨이 `lib/core` 에 있는 이유**(FIX-66):
 *
 * 처음에는 `lib/inquiry/candidates.ts`(서버 로더)에 함께 두었는데, 폼은 클라이언트
 * 컴포넌트라 거기서 라벨을 가져오는 순간 **`lib/supabase/server.ts` 를 통해
 * `next/headers` 가 클라이언트 번들로 끌려왔다.** `tsc` 는 이 경계를 못 본다 —
 * 타입은 다 맞고 **Next 가 런타임에 500 을 낸다.** 실주행에서 잡혔다.
 *
 * 값과 문구는 프레임워크를 모르는 자리에 둔다(CLAUDE.md §3.1).
 */
export type InquiryCandidateReason = "wishlist" | "cart" | "viewing";

export type InquiryCandidate = {
  id: string;
  name: string;
  category: string;
  /** 왜 후보인가. 화면이 그대로 적는다 — '찜' 과 '장바구니' 는 다른 정보다. */
  reason: InquiryCandidateReason;
};

export const CANDIDATE_REASON_LABEL: Record<InquiryCandidateReason, string> = {
  viewing: "지금 보던 곳",
  wishlist: "찜",
  cart: "장바구니",
};

/** 목록 순서. 지금 보던 곳이 맨 위다. */
export const CANDIDATE_REASON_ORDER: Record<InquiryCandidateReason, number> = {
  viewing: 0,
  wishlist: 1,
  cart: 2,
};

export { INQUIRY_NOTE_MAX };
