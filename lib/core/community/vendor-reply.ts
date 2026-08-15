import { commentProblem } from "./community";

/**
 * 업체의 커뮤니티 대응 (S7-16 · 명세서 §2.2 F-V-18 · D-24 · D-26)
 *
 * **당사자가 말할 자리를 준다.** 플랫폼은 판정자가 아니라 조율자이므로(D-24) 태그된
 * 업체가 자기 말을 남길 수 있어야 한다. 다만 자리를 주는 것과 자리를 내주는 것은
 * 다르다 — 아래 세 가지가 그 경계다.
 *
 *  1. **답변만 한다.** 본문 수정 수단이 없다(RLS 가 지킨다 — 업체에게 `community_posts`
 *     UPDATE 정책이 없다). 남의 글을 고치는 권한은 어디에도 없다.
 *  2. **글당 한 번이다**(아래 근거).
 *  3. **내리는 것은 운영자의 일이다.** 업체는 신고까지이고 그 다음은 F-A-18 이다.
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

/**
 * **글당 공식 답변 한 번.**
 *
 * §2.2 는 횟수를 적지 않았고(“답변 작성” 까지다) 그래서 이 태스크가 정한다.
 *
 * 근거 —
 *  · **댓글난이 업체의 자리가 되면 다른 회원이 말하기 어려워진다.** 경험담 글에서
 *    업체가 반복해 반박하면 그 글은 논쟁장이 되고, 다음 사람은 쓰기를 그만둔다.
 *    커뮤니티가 있는 이유가 그 다음 사람이므로 그것을 잃는 쪽이 손해가 크다.
 *  · **말할 자리는 한 번으로 충분하다.** 사실관계를 바로잡는 데 필요한 것은 반복이
 *    아니라 한 번의 정확한 설명이며, 그것이 '공식 답변' 이라는 말의 뜻이다.
 *  · **더 필요하면 신고가 있다.** 반박이 아니라 판단이 필요한 상황이라면 그것은
 *    조율자에게 가져올 일이다(F-A-18) — 업체가 스스로 여러 번 반박하는 것보다
 *    사유를 남긴 처리가 양쪽에 낫다.
 *
 * **고치는 것은 막지 않는다.** 자기가 쓴 답변을 다듬는 일은 새 답변을 다는 것과
 * 다르며, 그 권한은 이미 작성자에게 있다(0038 `community_comments_update_author`).
 */
export const VENDOR_REPLY_LIMIT_PER_POST = 1;

export const VENDOR_REPLY_LIMIT_NOTE =
  "글마다 공식 답변은 한 번이에요. 쓴 답변은 고칠 수 있고, 더 다뤄야 할 일이면 신고로 알려 주세요.";

export const VENDOR_REPLY_SCOPE_NOTE =
  "답변만 남길 수 있어요. 글 내용은 작성자만 고칠 수 있고, 내리는 일은 운영자가 합니다.";

export type VendorReplyProblem = { field: "body" | "limit" | "target"; message: string };

/**
 * 이 답변을 지금 달 수 있는가.
 *
 * `targetStatus` 를 보는 이유 — 가려지거나 지워진 글에 답변을 달면 **아무도 읽지
 * 않는 말**이 남는다. 업체에게는 답한 것처럼 보이고 실제로는 보이지 않는다.
 */
export function vendorReplyProblem(input: {
  body: string;
  /** 이 업체가 이 글에 이미 단 공식 답변 수. */
  existingReplies: number;
  targetStatus: "published" | "hidden" | "deleted";
}): VendorReplyProblem | null {
  if (input.targetStatus !== "published") {
    return {
      field: "target",
      message:
        input.targetStatus === "deleted"
          ? "작성자가 지운 글이에요. 답변을 남길 수 없습니다."
          : "지금 비공개인 글이에요. 공개되면 답변할 수 있습니다.",
    };
  }

  const problem = commentProblem(input.body);
  if (problem !== null) return { field: "body", message: problem };

  if (input.existingReplies >= VENDOR_REPLY_LIMIT_PER_POST) {
    return { field: "limit", message: VENDOR_REPLY_LIMIT_NOTE };
  }

  return null;
}

/**
 * 답변도 커뮤니티 글이다 — **모더레이션 대상이다.**
 *
 * 업체가 남긴 말이라고 예외를 두면, 신고할 수 없는 글이 하나 생긴다. 그 예외는
 * 곧 "업체는 무엇이든 쓸 수 있다" 가 되고 §7.7 의 표현 원칙이 한쪽에만 적용된다.
 * 그래서 답변은 `community_comments` 의 보통 행이며 신고 대상 유형에 `comment` 가
 * 이미 있다(0038). S7-17 의 큐가 그 유형을 다룬다.
 */
export const VENDOR_REPLY_MODERATED_NOTE =
  "업체 답변도 커뮤니티 글이라 신고와 운영자 확인의 대상이 됩니다.";

/** 화면이 목록에서 쓰는 상태. **답변 여부가 이 화면의 유일한 진행 상태**다. */
export type TaggedPostState = "needs_reply" | "replied" | "unavailable";

export const TAGGED_POST_STATE_LABEL: Record<TaggedPostState, string> = {
  needs_reply: "답변 전",
  replied: "답변함",
  unavailable: "답변할 수 없음",
};

export function taggedPostState(input: {
  existingReplies: number;
  targetStatus: "published" | "hidden" | "deleted";
}): TaggedPostState {
  if (input.targetStatus !== "published") return "unavailable";

  return input.existingReplies > 0 ? "replied" : "needs_reply";
}
