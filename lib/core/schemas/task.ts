import { z } from "zod";

import { TASK_CATEGORIES } from "../schedule/templates";
import { TASK_STATUSES } from "../schedule/graph";

/**
 * 체크리스트 입출력 (S7-08 · 명세서 §4.2 `GET/POST/PATCH /api/tasks` · CLAUDE.md §6)
 *
 * **기한은 날짜다.** `YYYY-MM-DD` 만 받는다 — 등록·기한 변경은 캘린더 형식이라는
 * 전제(§6.2)와 맞물린다. 시각을 받으면 달력이 고를 수 없는 값이 API 에 생긴다.
 */
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다.");

export const TASK_TITLE_MAX_LENGTH = 60;

export const TaskCreateSchema = z
  .object({
    category: z.enum(TASK_CATEGORIES),
    title: z.string().trim().min(1, "할 일을 적어 주세요.").max(TASK_TITLE_MAX_LENGTH),
    /** 미정으로 둘 수 있다. **오늘로 채우지 않는다** — 사용자가 정한 적 없는 날짜다. */
    dueDate: DateSchema.nullable().default(null),
    assigneeId: z.string().uuid().nullable().default(null),
  })
  .strict();

export const TaskUpdateSchema = z
  .object({
    taskId: z.string().uuid(),
    title: z.string().trim().min(1).max(TASK_TITLE_MAX_LENGTH).optional(),
    dueDate: DateSchema.nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    assigneeId: z.string().uuid().nullable().optional(),
  })
  .strict();

/**
 * **선행 관계 편집은 여기 없다.** 커버리지 표가 `POST/DELETE /api/tasks/[id]/dependencies`
 * 를 **S7-19** 에 배정했다(F-C-37). S7-08 이 간선을 쓰는 자리는 **자동 생성 하나**이며
 * (템플릿 순서 이관 · §3.2), 손으로 잇는 화면·API 는 표현을 만드는 태스크가 갖는다.
 */

/**
 * 자동 생성 요청.
 *
 * **사용자가 누른다.** 온보딩에서 조용히 만들면 자기가 만들지 않은 목록을 받게 되고,
 * 그때 지우는 일이 첫 경험이 된다(S7-19 가 걱정하는 '안 쓰이는 화면' 과 같은 뿌리다).
 */
export const TaskGenerateSchema = z.object({}).strict();

export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>;
