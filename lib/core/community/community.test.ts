import { describe, expect, it } from "vitest";

import {
  BOARD_TYPES,
  COMMUNITY_SORT_BASIS_NOTICE,
  POST_TAG_MAX_COUNT,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
  RESOLUTION_MIN_LENGTH,
  UNVERIFIED_LABEL,
  VENDOR_FILTER_LIMIT_NOTE,
  VENDOR_NAME_MIN_LENGTH,
  canTransition,
  commentProblem,
  findVendorMentions,
  isReportClosed,
  mentionLabel,
  normalizeVendorName,
  postProblem,
  reportSla,
  resolutionProblem,
  sortPosts,
  visibleBody,
} from "./community";

const vendors = [
  { id: "v1", name: "로컬 데모 웨딩홀" },
  { id: "v2", name: "그랜드 컨벤션" },
  { id: "v3", name: "AB" },
];

describe("게시판", () => {
  it("§3.7 이 정한 세 가지다", () => {
    expect([...BOARD_TYPES]).toEqual(["free", "experience", "qna"]);
  });
});

describe("상태 전이 — 누가 옮기는지가 다르다", () => {
  it("작성자는 자기 글을 지울 수 있다", () => {
    expect(canTransition({ actor: "author", from: "published", to: "deleted" })).toBe(true);
  });

  it("**작성자가 스스로 비공개로 옮길 수 없다** — 그건 모더레이션이다", () => {
    expect(canTransition({ actor: "author", from: "published", to: "hidden" })).toBe(false);
  });

  it("**가려진 글을 작성자가 되살릴 수 없다** — 되살릴 수 있으면 모더레이션이 성립하지 않는다", () => {
    expect(canTransition({ actor: "author", from: "hidden", to: "published" })).toBe(false);
    expect(canTransition({ actor: "operator", from: "hidden", to: "published" })).toBe(true);
  });

  it("**지운 글은 운영자도 되살리지 않는다** — 그건 게시 강요다", () => {
    expect(canTransition({ actor: "operator", from: "deleted", to: "published" })).toBe(false);
  });

  it("가려진 글의 본문은 화면에서 가리되 행은 남는다 (D-23)", () => {
    expect(visibleBody({ status: "hidden", body: "원문" })).not.toContain("원문");
    expect(visibleBody({ status: "deleted", body: "원문" })).toContain("작성자가 지운");
    expect(visibleBody({ status: "published", body: "원문" })).toBe("원문");
  });
});

describe("업체명 필터 — 첫 층일 뿐이다 (D-26)", () => {
  it("본문에 등록 업체명이 있으면 찾아낸다", () => {
    const found = findVendorMentions("어제 로컬 데모 웨딩홀 다녀왔어요", vendors);

    expect(found.map((item) => item.vendorId)).toEqual(["v1"]);
  });

  it("띄어쓰기가 달라도 찾는다", () => {
    expect(findVendorMentions("로컬데모웨딩홀 좋았어요", vendors)).toHaveLength(1);
  });

  it("조사가 붙어도 찾는다", () => {
    expect(findVendorMentions("그랜드 컨벤션은 어땠나요", vendors)).toHaveLength(1);
  });

  it("**너무 짧은 이름은 대조하지 않는다** — 본문 전체에 걸린다", () => {
    expect(findVendorMentions("AB 라고 적었어요", vendors)).toHaveLength(0);
    expect(VENDOR_NAME_MIN_LENGTH).toBe(3);
  });

  it("등록되지 않은 이름은 찾지 못한다 — 그게 이 필터의 한계다", () => {
    expect(findVendorMentions("이름없는웨딩홀 다녀왔어요", vendors)).toHaveLength(0);
  });

  it("**완전 차단을 약속하지 않는다**는 문장을 코드가 갖는다", () => {
    expect(VENDOR_FILTER_LIMIT_NOTE).toContain("놓치는 표기가 있을 수 있");
    expect(VENDOR_FILTER_LIMIT_NOTE).toContain("신고");
  });

  it("정규화가 괄호·가운뎃점을 지운다", () => {
    expect(normalizeVendorName("로컬(데모)·웨딩홀")).toBe("로컬데모웨딩홀");
  });
});

describe("라벨링 — verified_purchase 가 참이어도 검증 후기가 아니다", () => {
  it("거래 이력이 있어도 라벨은 미검증 경험담이다", () => {
    expect(mentionLabel({ verifiedPurchase: true }).label).toBe(UNVERIFIED_LABEL);
    expect(mentionLabel({ verifiedPurchase: false }).label).toBe(UNVERIFIED_LABEL);
  });

  it("거래 이력은 라벨이 아니라 힌트로만 붙는다", () => {
    expect(mentionLabel({ verifiedPurchase: true }).hint).not.toBeNull();
    expect(mentionLabel({ verifiedPurchase: false }).hint).toBeNull();
  });
});

describe("정렬 — 조회수·좋아요를 쓰지 않는다 (D-03)", () => {
  const posts = [
    { id: "a", createdAt: "2026-08-01", lastCommentAt: null, commentCount: 0, isPinned: false },
    { id: "b", createdAt: "2026-08-03", lastCommentAt: "2026-08-04", commentCount: 5, isPinned: false },
    { id: "c", createdAt: "2026-08-02", lastCommentAt: "2026-08-10", commentCount: 1, isPinned: false },
    { id: "d", createdAt: "2026-07-01", lastCommentAt: null, commentCount: 0, isPinned: true },
  ];

  it("최신 순", () => {
    expect(sortPosts(posts, "recent").map((post) => post.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("댓글 활동 순", () => {
    expect(sortPosts(posts, "active").map((post) => post.id)).toEqual(["d", "c", "b", "a"]);
  });

  it("고정 글이 먼저 온다", () => {
    expect(sortPosts(posts, "recent")[0].id).toBe("d");
  });

  it("**정렬 기준에 조회수·좋아요가 없다**는 사실을 화면이 말한다", () => {
    expect(COMMUNITY_SORT_BASIS_NOTICE).toContain("조회수·좋아요는 순서에 반영되지 않아요");
  });
});

describe("신고", () => {
  it("사유 코드가 집합으로 고정돼 있다 — 자유 텍스트면 통계가 안 선다", () => {
    expect(REPORT_REASONS).toHaveLength(6);
    for (const reason of REPORT_REASONS) {
      expect(REPORT_REASON_LABEL[reason].length).toBeGreaterThan(0);
    }
  });

  it("끝난 신고를 구분한다", () => {
    expect(isReportClosed("resolved")).toBe(true);
    expect(isReportClosed("open")).toBe(false);
  });

  it("**처리에는 사유가 필수다** — 되돌릴 수 없는 처리라 근거를 남긴다", () => {
    expect(resolutionProblem({ status: "resolved", resolution: "" })).not.toBeNull();
    expect(resolutionProblem({ status: "resolved", resolution: "가".repeat(RESOLUTION_MIN_LENGTH) })).toBeNull();
  });

  it("접수·확인 중에는 사유를 요구하지 않는다", () => {
    expect(resolutionProblem({ status: "open", resolution: "" })).toBeNull();
  });

  it("**SLA 값이 없으면 판정하지 않는다** (O-14 대기)", () => {
    const verdict = reportSla({ createdAt: "2026-08-15T00:00:00Z", now: Date.now(), slaHours: null });

    expect(verdict).toEqual({ kind: "unconfigured", openIssue: "O-14" });
  });

  it("값이 있으면 남은 시간·초과 시간을 센다", () => {
    const now = Date.parse("2026-08-15T12:00:00Z");

    expect(reportSla({ createdAt: "2026-08-15T00:00:00Z", now, slaHours: 24 })).toEqual({
      kind: "within",
      remainingHours: 12,
    });
    expect(reportSla({ createdAt: "2026-08-14T00:00:00Z", now, slaHours: 24 }).kind).toBe("overdue");
  });
});

describe("작성 검사", () => {
  it("제목·내용이 비면 막는다", () => {
    expect(postProblem({ title: " ", body: "내용", tagCount: 0 })?.field).toBe("title");
    expect(postProblem({ title: "제목", body: " ", tagCount: 0 })?.field).toBe("body");
  });

  it("태그 상한을 넘기면 막는다 — 열 곳을 넘기면 태그가 아니라 목록이다", () => {
    expect(postProblem({ title: "제목", body: "내용", tagCount: POST_TAG_MAX_COUNT + 1 })?.field).toBe(
      "tags",
    );
  });

  it("정상 입력은 통과한다", () => {
    expect(postProblem({ title: "제목", body: "내용", tagCount: 2 })).toBeNull();
  });

  it("댓글도 같은 규칙이다", () => {
    expect(commentProblem("  ")).not.toBeNull();
    expect(commentProblem("답변드립니다")).toBeNull();
  });
});
