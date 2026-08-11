import { z } from "zod";

/**
 * 문의게시판 스키마 (S4-05 · 명세서 §2.1 F-C-28, §2.2 F-V-16, §3.7 qna_posts·qna_answers)
 *
 * 표와 RLS 는 S4-01(0021)이 만들었다. 여기는 화면·API 가 쓰는 값과 검증이다.
 *
 * **공개 설정의 방향은 S4-01 이 트리거로 못박았다** — 업체는 공개글을 내릴 수만 있고
 * 비공개글을 올릴 수는 없다(비공개 질문을 공개로 바꾸는 것은 설정 변경이 아니라 유출).
 * 이 파일은 그 규칙을 화면에 설명하는 문구를 함께 갖는다.
 */

const uuid = z.string().uuid();

export const QNA_STATUSES = ["open", "answered", "hidden", "withdrawn"] as const;
export type QnaStatus = (typeof QNA_STATUSES)[number];

export const QNA_STATUS_LABEL: Record<QnaStatus, string> = {
  open: "답변 대기",
  answered: "답변 완료",
  hidden: "업체가 내림",
  withdrawn: "작성자가 내림",
};

export const QNA_TITLE_MAX = 120;
export const QNA_BODY_MAX = 2000;

// =============================================================================
// 소비자 (/api/qna)
// =============================================================================

export const CreateQnaPostSchema = z.object({
  // 판별 유니온의 판별자라 기본값을 줄 수 없다(판별이 파싱보다 먼저다).
  action: z.literal("create"),
  vendorId: uuid,
  title: z.string().trim().min(2).max(QNA_TITLE_MAX),
  body: z.string().trim().min(2).max(QNA_BODY_MAX),
  /** 작성 시 고객이 고른다(F-C-28). 기본은 공개 — 공개 질문이 다음 사람을 돕는다. */
  isPublic: z.boolean().default(true),
});

/** 작성자만 한다. 공개 전환도 여기로만 가능하다(S4-01 트리거가 강제). */
export const UpdateQnaPostSchema = z.object({
  action: z.literal("update"),
  postId: uuid,
  title: z.string().trim().min(2).max(QNA_TITLE_MAX).optional(),
  body: z.string().trim().min(2).max(QNA_BODY_MAX).optional(),
  isPublic: z.boolean().optional(),
});

/** 질문을 내린다. **지우지 않는다** — 업체 답변이 달린 질문은 공개 기록이다(S4-01). */
export const WithdrawQnaPostSchema = z.object({
  action: z.literal("withdraw"),
  postId: uuid,
});

export const QnaActionSchema = z.discriminatedUnion("action", [
  CreateQnaPostSchema,
  UpdateQnaPostSchema,
  WithdrawQnaPostSchema,
]);

export type QnaAction = z.infer<typeof QnaActionSchema>;

// =============================================================================
// 업체 (/api/vendor/qna)
// =============================================================================

export const AnswerQnaSchema = z.object({
  action: z.literal("answer"),
  postId: uuid,
  body: z.string().trim().min(2).max(QNA_BODY_MAX),
});

/** 답변 수정. 답변은 **게시된 문서**라 고칠 수 있다 — 대화 기록(채팅)과 갈리는 지점이다. */
export const UpdateAnswerSchema = z.object({
  action: z.literal("update_answer"),
  answerId: uuid,
  body: z.string().trim().min(2).max(QNA_BODY_MAX),
});

/**
 * 업체의 공개 설정 변경(F-V-16).
 *
 * **내리는 방향만 받는다.** 스키마가 `false` 만 허용하는 것이 아니라, `true` 를 보내도
 * S4-01 트리거가 작성자가 아니면 거절한다. 여기서 굳이 `boolean` 을 받는 이유는
 * 업체가 자기가 내렸던 것을 되돌릴 수 있어야 하기 때문이다 — 그때는 원래 공개였던
 * 글이므로 유출이 아니다. 판정은 DB 가 한다.
 */
export const SetQnaVisibilitySchema = z.object({
  action: z.literal("set_visibility"),
  postId: uuid,
  isPublic: z.boolean(),
});

export const VendorQnaActionSchema = z.discriminatedUnion("action", [
  AnswerQnaSchema,
  UpdateAnswerSchema,
  SetQnaVisibilitySchema,
]);

export type VendorQnaAction = z.infer<typeof VendorQnaActionSchema>;

// =============================================================================
// 유사 질문 (F-C-28 — 중복 문의를 줄인다)
// =============================================================================

/**
 * 유사 판정 임계값 — **포함도** 기준이다(자카드가 아니다).
 *
 * "내가 쓰려는 질문의 3-gram 중 몇 %가 저 글에 이미 있는가" 를 본다. 0.5 는 절반이
 * 겹치는 정도이고, 한국어에서 그 정도면 같은 것을 묻는 질문이다.
 *
 * 자카드(pg_trgm 의 `similarity()`)를 쓰지 않는 이유는 `lib/qna/loader.ts` 의
 * `trigramContainment` 주석에 적었다 — 짧은 질의가 긴 글과 견줄 때 분모가 글 길이에
 * 끌려가 구조적으로 낮은 점수가 나온다.
 *
 * 값을 코드에 두는 이유 — 이건 운영 파라미터가 아니라 검색 품질의 일부이고, 바꾸면
 * 인덱스 사용 방식까지 함께 본다.
 */
export const SIMILAR_THRESHOLD = 0.5;
export const SIMILAR_LIMIT = 3;

export const SIMILAR_HINT = "비슷한 질문이 이미 있어요. 먼저 확인해 보세요.";

export const QNA_EMPTY_TITLE = "아직 등록된 질문이 없어요";
export const QNA_EMPTY_DESCRIPTION =
  "궁금한 점을 남기면 업체가 답변해요. 공개로 남기면 다음 사람도 같은 답을 볼 수 있어요.";
export const QNA_PRIVATE_NOTE = "비공개 질문은 작성자와 해당 업체만 볼 수 있어요.";
export const QNA_VENDOR_VISIBILITY_NOTE =
  "공개 질문은 내릴 수 있지만, 비공개 질문을 공개로 바꾸는 것은 작성자만 할 수 있어요.";

export const QnaPostViewSchema = z.object({
  id: uuid,
  vendorId: uuid,
  authorId: uuid,
  title: z.string(),
  body: z.string(),
  isPublic: z.boolean(),
  status: z.string(),
  answeredAt: z.string().nullable(),
  createdAt: z.string(),
  isMine: z.boolean(),
  answers: z.array(
    z.object({
      id: uuid,
      body: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});

export type QnaPostView = z.infer<typeof QnaPostViewSchema>;
