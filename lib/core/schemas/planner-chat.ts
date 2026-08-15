import { z } from "zod";

import { PLANNER_MESSAGE_MAX_LENGTH } from "../ai/conversation";

/**
 * 플래너 대화 입출력 (S7-06 · 명세서 §4.2 `POST /api/ai/planner` · CLAUDE.md §6)
 *
 * **SSE 라 응답 포맷이 다르다.** `{ ok, data, error }` 는 한 덩어리 JSON 을 전제하는데
 * 이 라우트는 이벤트를 흘려보낸다. 그래서 **본문 검증 실패까지는 표준 포맷(422)** 으로
 * 답하고, 스트림이 시작된 뒤의 실패는 `event: error` 로 나간다 — 스트림이 열린 뒤에는
 * 상태 코드를 바꿀 수 없다.
 *
 * 이벤트 종류를 **스키마로 못 박는 이유**는 화면과 서버가 문자열로 약속하면 한쪽만
 * 고쳐지는 날이 오기 때문이다.
 */

export const PlannerTurnSchema = z
  .object({
    /** 이어서 말하는 대화. 없으면 새로 만든다. */
    conversationId: z.string().uuid("대화 id 형식이 아닙니다.").optional(),
    message: z
      .string()
      .trim()
      .min(1, "하고 싶은 말을 적어 주세요.")
      .max(PLANNER_MESSAGE_MAX_LENGTH, `${PLANNER_MESSAGE_MAX_LENGTH}자까지 보낼 수 있어요.`),
  })
  .strict();

export type PlannerTurnInput = z.infer<typeof PlannerTurnSchema>;

/** SSE 이벤트 이름. 화면과 서버가 이 목록만 쓴다. */
export const PLANNER_EVENTS = [
  /** 대화 id·모드·남은 턴. 스트림의 첫 이벤트다. */
  "meta",
  /** 검사를 통과한 본문 조각. */
  "delta",
  /** 툴 결과 카드. */
  "card",
  /** 지금까지 내보낸 본문을 지우라는 신호(전체 본문 검사 실패). */
  "discard",
  /** 사용자에게 보일 실패 문장. 스트림은 여기서 끝난다. */
  "error",
  /** 정상 종료. */
  "done",
] as const;

export type PlannerEvent = (typeof PLANNER_EVENTS)[number];

export const PLANNER_MODES = [
  /** 모델이 답한다. */
  "model",
  /** 키가 없어 룰만으로 답한다(D-28 계열). */
  "rules_only",
] as const;

export type PlannerMode = (typeof PLANNER_MODES)[number];
