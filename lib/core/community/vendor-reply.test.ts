import { describe, expect, it } from "vitest";

import { COMMENT_BODY_MAX_LENGTH } from "./community";
import {
  TAGGED_POST_STATE_LABEL,
  VENDOR_REPLY_LIMIT_NOTE,
  VENDOR_REPLY_LIMIT_PER_POST,
  VENDOR_REPLY_MODERATED_NOTE,
  VENDOR_REPLY_SCOPE_NOTE,
  taggedPostState,
  vendorReplyProblem,
} from "./vendor-reply";

const body = "문의 주시면 자세히 안내드리겠습니다.";

describe("답변 — 글당 한 번", () => {
  it("아직 답변하지 않았으면 통과한다", () => {
    expect(
      vendorReplyProblem({ body, existingReplies: 0, targetStatus: "published" }),
    ).toBeNull();
  });

  it("**두 번째 답변을 막는다** — 댓글난이 업체의 자리가 되면 다른 회원이 말하기 어렵다", () => {
    const problem = vendorReplyProblem({ body, existingReplies: 1, targetStatus: "published" });

    expect(problem?.field).toBe("limit");
    expect(problem?.message).toBe(VENDOR_REPLY_LIMIT_NOTE);
  });

  it("상한이 1이다", () => {
    expect(VENDOR_REPLY_LIMIT_PER_POST).toBe(1);
  });

  it("**고치는 것은 막지 않는다** — 안내 문구가 그 사실을 말한다", () => {
    expect(VENDOR_REPLY_LIMIT_NOTE).toContain("고칠 수 있고");
  });
});

describe("답변 내용", () => {
  it("빈 답변을 막는다", () => {
    expect(
      vendorReplyProblem({ body: "  ", existingReplies: 0, targetStatus: "published" })?.field,
    ).toBe("body");
  });

  it("댓글과 같은 길이 상한을 쓴다 — 두 벌이면 한쪽만 고쳐진다", () => {
    expect(
      vendorReplyProblem({
        body: "가".repeat(COMMENT_BODY_MAX_LENGTH + 1),
        existingReplies: 0,
        targetStatus: "published",
      })?.field,
    ).toBe("body");
  });
});

describe("대상 상태 — 아무도 읽지 않는 말을 남기지 않는다", () => {
  it("지워진 글에는 답변할 수 없다", () => {
    const problem = vendorReplyProblem({ body, existingReplies: 0, targetStatus: "deleted" });

    expect(problem?.field).toBe("target");
    expect(problem?.message).toContain("지운 글");
  });

  it("가려진 글에는 답변할 수 없되 공개되면 가능하다고 말한다", () => {
    const problem = vendorReplyProblem({ body, existingReplies: 0, targetStatus: "hidden" });

    expect(problem?.field).toBe("target");
    expect(problem?.message).toContain("공개되면");
  });

  it("**상태를 내용보다 먼저 본다** — 못 쓸 글에 글자 수를 따지지 않는다", () => {
    expect(
      vendorReplyProblem({ body: "", existingReplies: 0, targetStatus: "deleted" })?.field,
    ).toBe("target");
  });
});

describe("목록 상태", () => {
  it("답변 여부가 유일한 진행 상태다", () => {
    expect(taggedPostState({ existingReplies: 0, targetStatus: "published" })).toBe("needs_reply");
    expect(taggedPostState({ existingReplies: 1, targetStatus: "published" })).toBe("replied");
    expect(taggedPostState({ existingReplies: 0, targetStatus: "hidden" })).toBe("unavailable");
  });

  it("상태마다 사람이 읽는 말이 있다", () => {
    for (const label of Object.values(TAGGED_POST_STATE_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("경계를 화면이 말한다 (D-24 · F-V-18)", () => {
  it("**본문을 고치지 못하고 내리는 것은 운영자의 일**임을 적는다", () => {
    expect(VENDOR_REPLY_SCOPE_NOTE).toContain("작성자만 고칠 수");
    expect(VENDOR_REPLY_SCOPE_NOTE).toContain("운영자");
  });

  it("**답변도 모더레이션 대상**임을 적는다 — 예외를 두면 한쪽에만 원칙이 적용된다", () => {
    expect(VENDOR_REPLY_MODERATED_NOTE).toContain("신고");
  });
});
