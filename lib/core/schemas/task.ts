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
 * 선행 관계 편집 (S7-19 · 명세서 §4.2 `POST/DELETE /api/tasks/[id]/dependencies`)
 *
 * S7-08 은 이 스키마를 두지 않았다 — 커버리지 표가 편집 API 를 **S7-19** 에
 * 배정했기 때문이다(D-74). 표현을 만드는 태스크가 순서를 고치는 수단도 갖는다.
 *
 * **여기서 순환을 판정하지 않는다.** zod 가 볼 수 있는 것은 이 요청 하나뿐이고
 * 순환은 **그래프 전체의 성질**이다 — 최종 판정은 DB 트리거이며(D-71 · 0042)
 * 라우트는 그 거절을 §4.2 가 정한 코드로 옮기기만 한다.
 */
export const TaskDependencySchema = z
  .object({
    /** 이 태스크보다 **먼저** 끝나야 하는 태스크. */
    dependsOn: z.string().uuid(),
  })
  .strict();

export type TaskDependencyInput = z.infer<typeof TaskDependencySchema>;

/**
 * §4.2 가 정한 거절 코드. **DB 제약 이름과 짝을 이룬다**(0042).
 *
 * 이름을 여기 적어 두는 이유는, 트리거가 붙인 `constraint` 이름을 라우트가 문자열로
 * 비교하기 때문이다 — 한쪽만 바뀌면 조용히 500 이 된다.
 */
export const TASK_DEPENDENCY_ERRORS = {
  task_cycle: { code: "TASK_CYCLE", message: "순서가 돌고 돌아요. 다른 일을 먼저로 골라 주세요." },
  task_foreign_couple: {
    code: "TASK_FOREIGN_COUPLE",
    message: "다른 커플의 일정은 먼저 할 일로 둘 수 없어요.",
  },
  task_depth_exceeded: {
    code: "TASK_DEPTH_EXCEEDED",
    message: "순서가 너무 깊어요. 중간 단계를 줄여 주세요.",
  },
  task_depth_unconfigured: {
    code: "TASK_DEPTH_UNCONFIGURED",
    message: "순서 설정이 아직 준비되지 않았어요.",
  },
} as const;

export type TaskDependencyErrorKey = keyof typeof TASK_DEPENDENCY_ERRORS;

/**
 * DB 오류에서 거절 사유를 읽는다.
 *
 * **모르는 오류를 아는 척하지 않는다** — 짝이 없으면 `null` 을 주고 라우트가 500 으로
 * 답한다. 아무 코드에나 넣으면 화면이 틀린 이유를 말하게 된다.
 */
export function taskDependencyErrorOf(input: {
  constraint?: string | null;
  message?: string | null;
}): TaskDependencyErrorKey | null {
  const keys = Object.keys(TASK_DEPENDENCY_ERRORS) as TaskDependencyErrorKey[];

  const byConstraint = keys.find((key) => key === input.constraint);
  if (byConstraint) return byConstraint;

  // 트리거가 `constraint` 를 싣지 못하는 경로(PostgREST 가 메시지만 넘기는 경우)를 위한
  // 두 번째 문. 메시지 본문에 제약 이름이 실려 오면 그것으로 읽는다.
  return keys.find((key) => (input.message ?? "").includes(key)) ?? null;
}

/**
 * 자동 생성 요청.
 *
 * **사용자가 누른다.** 온보딩에서 조용히 만들면 자기가 만들지 않은 목록을 받게 되고,
 * 그때 지우는 일이 첫 경험이 된다(S7-19 가 걱정하는 '안 쓰이는 화면' 과 같은 뿌리다).
 */
export const TaskGenerateSchema = z.object({}).strict();

export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>;
