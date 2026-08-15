import { z } from "zod";

import {
  BOARD_TYPES,
  COMMENT_BODY_MAX_LENGTH,
  COMMUNITY_SORTS,
  POST_BODY_MAX_LENGTH,
  POST_TAG_MAX_COUNT,
  POST_TITLE_MAX_LENGTH,
  REPORT_REASONS,
} from "../community/community";

/**
 * 커뮤니티 입출력 스키마 (S7-15 · 명세서 §4.2 · CLAUDE.md §6)
 *
 * **상한을 도메인에서 가져온다.** 화면(`postProblem`)과 서버(이 스키마)가 다른 숫자를
 * 쓰면 화면이 통과시킨 글을 서버가 거절한다.
 */

export const PostCreateSchema = z
  .object({
    boardType: z.enum(BOARD_TYPES),
    title: z.string().trim().min(1, "제목을 적어 주세요.").max(POST_TITLE_MAX_LENGTH),
    body: z.string().trim().min(1, "내용을 적어 주세요.").max(POST_BODY_MAX_LENGTH),
    /** 태그할 업체. **승인된 업체만** 붙는다(0038 트리거). */
    vendorIds: z.array(z.string().uuid()).max(POST_TAG_MAX_COUNT).default([]),
  })
  .strict();

export type PostCreateInput = z.infer<typeof PostCreateSchema>;

export const PostUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(POST_TITLE_MAX_LENGTH).optional(),
    body: z.string().trim().min(1).max(POST_BODY_MAX_LENGTH).optional(),
  })
  .strict();

export const CommentCreateSchema = z
  .object({
    body: z.string().trim().min(1, "댓글을 적어 주세요.").max(COMMENT_BODY_MAX_LENGTH),
    /** 최상위 댓글이면 생략한다. 답글의 답글은 DB 트리거가 막는다. */
    parentId: z.string().uuid().optional(),
  })
  .strict();

export const ReportCreateSchema = z
  .object({
    targetType: z.enum(["post", "comment"]),
    targetId: z.string().uuid(),
    reasonCode: z.enum(REPORT_REASONS),
  })
  .strict();

export const PostListQuerySchema = z
  .object({
    board: z.enum(BOARD_TYPES).nullable().default(null),
    sort: z.enum(COMMUNITY_SORTS).default("recent"),
  })
  .strict();
