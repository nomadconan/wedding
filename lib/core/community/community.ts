/**
 * 커뮤니티 도메인 (S7-14 · 명세서 §3.7 · D-26)
 *
 * **세 면이 같은 판정을 쓴다.** 소비자 게시판(S7-15)·업체 태그 대응(S7-16)·운영자
 * 모더레이션(S7-17)이 각자 판정을 만들면 한쪽만 고쳐지는 날이 온다 — 그래서 상태
 * 전이·업체명 필터·신고 사유가 전부 여기 있다.
 *
 * **업체 언급은 태그로만 한다**(D-26). 그 규칙을 지키는 층이 셋이다 —
 *  1) **본문 필터**(이 파일). 등록 업체명과 그 변형을 찾아 태그로 바꾸라고 말한다.
 *  2) **신고·모더레이션**(S7-15·S7-17). 필터가 놓친 것을 사람이 잡는다.
 *  3) **라벨링**(화면). 태그된 글은 '미검증 경험담' 으로 표시된다.
 *
 * **완전 차단을 약속하지 않는다.** 한글 업체명은 띄어쓰기·조사·약칭으로 무한히
 * 변형되고, 정규식으로 그것을 다 잡을 수 있다고 말하는 순간 나머지 두 층을 만들 이유가
 * 사라진다. 필터는 **첫 층**이며 그 사실을 화면 문구가 그대로 말한다.
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

// =============================================================================
// 게시판·상태
// =============================================================================

export const BOARD_TYPES = ["free", "experience", "qna"] as const;
export type BoardType = (typeof BOARD_TYPES)[number];

export const BOARD_LABEL: Record<BoardType, string> = {
  free: "자유",
  experience: "경험담",
  qna: "질문",
};

export const BOARD_DESCRIPTION: Record<BoardType, string> = {
  free: "준비하며 나누고 싶은 이야기",
  experience: "직접 겪은 일. 업체를 말하려면 태그로 붙여 주세요",
  qna: "먼저 겪은 사람에게 묻기",
};

export const POST_STATUSES = ["published", "hidden", "deleted"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const POST_STATUS_LABEL: Record<PostStatus, string> = {
  published: "공개",
  hidden: "운영자 비공개",
  deleted: "작성자 삭제",
};

/**
 * 상태 전이.
 *
 * **누가 옮기는지가 다르다.** 작성자는 자기 글을 지울 수 있고(`deleted`), 운영자는
 * 가릴 수 있다(`hidden`). **되돌리기는 운영자만** 한다 — 가려진 글을 작성자가 스스로
 * 되살릴 수 있으면 모더레이션이 성립하지 않는다.
 */
export const POST_ACTORS = ["author", "operator"] as const;
export type PostActor = (typeof POST_ACTORS)[number];

const ALLOWED_TRANSITIONS: Record<PostActor, Record<PostStatus, PostStatus[]>> = {
  author: {
    published: ["deleted"],
    hidden: [],
    deleted: [],
  },
  operator: {
    published: ["hidden"],
    hidden: ["published"],
    // **삭제된 글은 운영자도 되살리지 않는다.** 작성자가 지운 것을 남이 되돌리면
    // 그것은 모더레이션이 아니라 게시 강요다.
    deleted: [],
  },
};

export function canTransition(input: {
  actor: PostActor;
  from: PostStatus;
  to: PostStatus;
}): boolean {
  return ALLOWED_TRANSITIONS[input.actor][input.from].includes(input.to);
}

/** 지워졌거나 가려진 글의 본문은 화면에서 가린다. **행은 남는다**(D-23). */
export const TOMBSTONE_TEXT: Record<Exclude<PostStatus, "published">, string> = {
  hidden: "운영자가 비공개 처리한 글이에요.",
  deleted: "작성자가 지운 글이에요.",
};

export function visibleBody(input: { status: PostStatus; body: string }): string {
  return input.status === "published" ? input.body : TOMBSTONE_TEXT[input.status];
}

// =============================================================================
// 업체명 필터 — 첫 층 (D-26)
// =============================================================================

/**
 * 본문에서 등록 업체명을 찾는다.
 *
 * **변형을 어디까지 잡는가.** 띄어쓰기 제거·조사 뒤따름·괄호 표기까지 본다. 그 이상
 * (초성·오타·약칭)은 잡지 않는다 — 잡으려 할수록 **오탐**이 늘고, 오탐은 사용자가
 * 쓰지도 않은 업체명을 지우라고 요구하는 화면이 된다.
 *
 * 반환은 **막는 목록이 아니라 제안**이다. 호출부가 "태그로 붙이시겠어요?" 를 묻는다 —
 * 자동으로 지우거나 태그로 바꾸지 않는다. 사용자가 말한 것을 우리가 고쳐 쓰면 그것은
 * 그 사람의 글이 아니게 된다.
 */
export type VendorMention = {
  vendorId: string;
  name: string;
  /** 본문에서 찾은 표기 그대로. 화면이 어디를 가리키는지 보여준다. */
  matched: string;
};

/** 이름 대조용 정규화. 공백·괄호·가운뎃점을 지우고 소문자로 맞춘다. */
export function normalizeVendorName(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\s()（）[\]·・.]/g, "")
    .toLowerCase();
}

/** 너무 짧은 이름은 대조하지 않는다 — '더', 'A홀' 같은 이름이 본문 전체에 걸린다. */
export const VENDOR_NAME_MIN_LENGTH = 3;

export function findVendorMentions(
  body: string,
  vendors: readonly { id: string; name: string }[],
): VendorMention[] {
  const flat = normalizeVendorName(body);
  const found: VendorMention[] = [];

  for (const vendor of vendors) {
    const needle = normalizeVendorName(vendor.name);

    if (needle.length < VENDOR_NAME_MIN_LENGTH) continue;
    if (!flat.includes(needle)) continue;

    found.push({ vendorId: vendor.id, name: vendor.name, matched: vendor.name });
  }

  return found;
}

export const VENDOR_MENTION_PROMPT =
  "글에 등록된 업체 이름이 보여요. 태그로 붙이면 그 업체가 답변할 수 있고, 읽는 사람도 어느 업체인지 정확히 압니다.";

/**
 * **완전 차단을 약속하지 않는다**(D-26). 화면이 이 문장을 그대로 쓴다.
 */
export const VENDOR_FILTER_LIMIT_NOTE =
  "이름 검사는 등록된 업체명만 찾아요. 놓치는 표기가 있을 수 있어 신고와 운영자 확인이 함께 있습니다.";

// =============================================================================
// 라벨링 — 태그된 글은 검증 후기가 아니다
// =============================================================================

/**
 * **`verified_purchase` 가 참이어도 검증 후기가 아니다**(§3.7).
 *
 * 검증 후기(`reviews` · F-C-17)는 결제·계약 이력자만 쓰고 운영자 검수를 거친다.
 * 커뮤니티 글은 누구나 쓴다 — 그 차이가 화면에서 사라지면 두 신뢰 근거가 뒤섞인다.
 * 그래서 라벨은 **거래 이력과 무관하게** 항상 '미검증 경험담' 이다.
 */
export const UNVERIFIED_LABEL = "미검증 경험담";

export const UNVERIFIED_NOTE =
  "커뮤니티 글은 회원이 직접 쓴 경험담이에요. 결제 이력을 확인한 검증 후기와는 다릅니다.";

export const VERIFIED_PURCHASE_HINT = "거래 이력이 확인된 회원의 글";

export function mentionLabel(tag: { verifiedPurchase: boolean }): {
  label: string;
  hint: string | null;
} {
  return {
    // 거래 이력이 있어도 라벨은 그대로다.
    label: UNVERIFIED_LABEL,
    hint: tag.verifiedPurchase ? VERIFIED_PURCHASE_HINT : null,
  };
}

// =============================================================================
// 정렬 — 조회수·좋아요를 쓰지 않는다 (D-03)
// =============================================================================

export const COMMUNITY_SORTS = ["recent", "active"] as const;
export type CommunitySort = (typeof COMMUNITY_SORTS)[number];

export const COMMUNITY_SORT_LABEL: Record<CommunitySort, string> = {
  recent: "최신 순",
  active: "댓글 활동 순",
};

/**
 * **조회수·좋아요를 순위에 넣지 않는다**(§3.7 NOTE · D-03).
 *
 * 둘 다 조작 비용이 낮다 — 계정 몇 개면 순위가 바뀐다. 그것을 순위에 넣으면
 * "돈이 평가에 개입하지 않는다" 를 다른 방식으로 무너뜨린다. 정렬 기준은 **시간과
 * 대화량**이며, 대화량도 사람이 답해야 오르므로 조작 비용이 다르다.
 */
export const COMMUNITY_SORT_BASIS_NOTICE =
  "글 순서는 최신순과 댓글 활동으로만 정합니다. 조회수·좋아요는 순서에 반영되지 않아요.";

export type SortablePost = {
  id: string;
  createdAt: string;
  lastCommentAt: string | null;
  commentCount: number;
  isPinned: boolean;
};

export function sortPosts<T extends SortablePost>(posts: readonly T[], sort: CommunitySort): T[] {
  const pinnedFirst = (a: T, b: T) => Number(b.isPinned) - Number(a.isPinned);

  if (sort === "active") {
    return [...posts].sort(
      (a, b) =>
        pinnedFirst(a, b) ||
        (b.lastCommentAt ?? b.createdAt).localeCompare(a.lastCommentAt ?? a.createdAt) ||
        b.commentCount - a.commentCount,
    );
  }

  return [...posts].sort((a, b) => pinnedFirst(a, b) || b.createdAt.localeCompare(a.createdAt));
}

// =============================================================================
// 신고 (F-C-34 · F-A-18)
// =============================================================================

export const REPORT_REASONS = [
  "spam",
  "abuse",
  "commercial",
  "personal_info",
  "false_info",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  spam: "도배·광고",
  abuse: "욕설·비방",
  commercial: "상업적 홍보",
  personal_info: "개인정보 노출",
  false_info: "허위 정보",
  other: "기타",
};

export const REPORT_STATUSES = ["open", "reviewing", "resolved", "rejected"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  open: "접수됨",
  reviewing: "확인 중",
  resolved: "처리 완료",
  rejected: "조치 없음",
};

export function isReportClosed(status: ReportStatus): boolean {
  return status === "resolved" || status === "rejected";
}

export type ResolutionProblem = { field: "resolution"; message: string };

/**
 * 신고 처리 검사.
 *
 * **사유가 필수다.** 비공개·삭제는 되돌릴 수 없고, 사유 없는 처리는 나중에 설명할 수
 * 없다(F-A-18). DB CHECK 가 같은 것을 막지만 화면이 먼저 말해 준다 — 제약 위반
 * 메시지를 사용자에게 보이고 싶지 않다.
 */
export const RESOLUTION_MIN_LENGTH = 5;

export function resolutionProblem(input: {
  status: ReportStatus;
  resolution: string;
}): ResolutionProblem | null {
  if (!isReportClosed(input.status)) return null;

  if (input.resolution.trim().length < RESOLUTION_MIN_LENGTH) {
    return { field: "resolution", message: "처리 사유를 적어 주세요. 사유 없는 처리는 남길 수 없어요." };
  }

  return null;
}

/**
 * **기준·SLA 는 O-14 대기다**(§7.6). 값이 없으면 판정하지 않는다 — 지어낸 기한으로
 * 운영자를 재촉하지 않는다.
 */
export type SlaVerdict =
  | { kind: "unconfigured"; openIssue: "O-14" }
  | { kind: "within"; remainingHours: number }
  | { kind: "overdue"; overdueHours: number };

export function reportSla(input: {
  createdAt: string;
  now: number;
  slaHours: number | null;
}): SlaVerdict {
  if (input.slaHours === null || !Number.isFinite(input.slaHours)) {
    return { kind: "unconfigured", openIssue: "O-14" };
  }

  const elapsed = (input.now - Date.parse(input.createdAt)) / 3_600_000;
  const remaining = input.slaHours - elapsed;

  return remaining >= 0
    ? { kind: "within", remainingHours: Math.floor(remaining) }
    : { kind: "overdue", overdueHours: Math.ceil(-remaining) };
}

// =============================================================================
// 작성 검사
// =============================================================================

export const POST_TITLE_MAX_LENGTH = 60;
export const POST_BODY_MAX_LENGTH = 5_000;
export const COMMENT_BODY_MAX_LENGTH = 1_000;
/** 한 글에 붙일 수 있는 업체 태그 수. 열 곳을 넘기면 태그가 아니라 목록이 된다. */
export const POST_TAG_MAX_COUNT = 10;

export type PostProblem = { field: "title" | "body" | "tags"; message: string };

export function postProblem(input: {
  title: string;
  body: string;
  tagCount: number;
}): PostProblem | null {
  if (input.title.trim() === "") return { field: "title", message: "제목을 적어 주세요." };
  if (input.title.trim().length > POST_TITLE_MAX_LENGTH) {
    return { field: "title", message: `제목은 ${POST_TITLE_MAX_LENGTH}자까지예요.` };
  }

  if (input.body.trim() === "") return { field: "body", message: "내용을 적어 주세요." };
  if (input.body.trim().length > POST_BODY_MAX_LENGTH) {
    return { field: "body", message: `내용은 ${POST_BODY_MAX_LENGTH}자까지예요.` };
  }

  if (input.tagCount > POST_TAG_MAX_COUNT) {
    return { field: "tags", message: `업체 태그는 ${POST_TAG_MAX_COUNT}곳까지 붙일 수 있어요.` };
  }

  return null;
}

export function commentProblem(body: string): string | null {
  if (body.trim() === "") return "댓글을 적어 주세요.";
  if (body.trim().length > COMMENT_BODY_MAX_LENGTH) {
    return `댓글은 ${COMMENT_BODY_MAX_LENGTH}자까지예요.`;
  }

  return null;
}

/**
 * 업체는 **답변만** 한다(F-V-18).
 *
 * 자사가 태그된 글에 댓글을 달 수 있고 **본문을 고칠 수는 없다.** 그 경계는 RLS 가
 * 지키지만(0038 — 업체에게 posts UPDATE 정책이 없다) 화면도 같은 말을 해야 한다.
 */
export const VENDOR_REPLY_ONLY_NOTE =
  "태그된 글에는 답변만 남길 수 있어요. 글 내용은 작성자만 고칠 수 있습니다.";
