"use client";

import { useEffect, useRef, useState } from "react";

import { POLL_INTERVAL_MS, RECONCILE_INTERVAL_MS } from "@/lib/core/chat/chat";
import { createClient } from "@/lib/supabase/client";

/**
 * 대화 변경 신호 구독 (S4-04 · O-11 결정)
 *
 * ── 규칙 하나: **소켓은 신호이고, 진실은 다시 조회한다.** ────────────────────
 * 이 훅은 데이터를 돌려주지 않는다. `onSignal()` 을 부를 뿐이고, 화면은 그때
 * `/api/chat/*` 를 다시 조회한다. 그렇게 하는 이유가 셋이다.
 *
 *  1. **회수 가림막을 지킨다.** postgres_changes 는 표에서 바로 나오므로
 *     `chat_messages_visible` 뷰를 거치지 않는다. payload 를 그대로 그리면 회수된
 *     본문이 화면에 뜬다. 그래서 애초에 `chat_messages` 를 구독하지 않는다 —
 *     publication 에는 `chat_rooms` 만 들어 있다(0022).
 *  2. **본문이 소켓을 타지 않는다.** `chat_rooms` 행에는 본문이 없다. 실시간을
 *     켠 대가로 대화 내용이 전송 계층에 흐르는 일이 없다.
 *  3. **폴백이 동작상 같아진다.** 소켓이 끊겨도 같은 조회를 주기적으로 하면 되므로
 *     화면 코드가 갈리지 않는다.
 *
 * `chat_rooms` 만으로 새 메시지를 알 수 있는 이유: 0021 의 `chat_room_touch()`
 * 트리거가 메시지가 들어올 때마다 `last_message_at` 을 갱신한다. 담당자 배정·SLA
 * 시계 변화도 같은 구독으로 온다.
 *
 * ── 연결이 안 될 때 ─────────────────────────────────────────────────────────
 * 붙지 않거나 끊기면 `POLL_INTERVAL_MS` 로 폴링한다. 붙어 있을 때도
 * `RECONCILE_INTERVAL_MS` 로 한 번씩 맞춰 본다 — 신호를 놓친 구간을 메운다.
 * 두 경우 모두 화면이 **어느 상태인지 사용자에게 밝힌다**(S3-05 가 장바구니에서
 * 반영 시점을 화면에 적은 것과 같은 이유).
 */
export type RoomSignalState = "connecting" | "live" | "polling";

export function useRoomSignal(options: {
  /** 특정 방만 볼 때. 생략하면 내가 접근 가능한 모든 방(목록 화면). */
  roomId?: string;
  onSignal: () => void;
  enabled?: boolean;
}): RoomSignalState {
  const { roomId, enabled = true } = options;
  const [state, setState] = useState<RoomSignalState>("connecting");

  // 콜백이 매 렌더 새로 만들어져도 구독을 다시 걸지 않는다.
  const onSignal = useRef(options.onSignal);
  onSignal.current = options.onSignal;

  useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();
    let disposed = false;

    const channel = supabase
      .channel(roomId ? `chat-room-${roomId}` : "chat-rooms")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_rooms",
          // 방 하나를 볼 때만 좁힌다. 목록은 RLS 가 이미 내 방으로 좁혀 준다 —
          // 구독 필터는 성능 최적화이지 보안 경계가 아니다(경계는 RLS다).
          ...(roomId ? { filter: `id=eq.${roomId}` } : {}),
        },
        () => onSignal.current(),
      )
      .subscribe((status) => {
        if (disposed) return;

        if (status === "SUBSCRIBED") {
          setState("live");
          // 구독이 붙기 전에 벌어진 변경을 놓쳤을 수 있다. 한 번 맞춘다.
          onSignal.current();

          return;
        }

        // 남는 것은 CHANNEL_ERROR · TIMED_OUT · CLOSED 뿐이다. 어느 쪽이든 신호를
        // 믿을 수 없으므로 폴링으로 내려가고, 그 사실을 화면이 사용자에게 밝힌다.
        setState("polling");
      });

    return () => {
      disposed = true;
      void supabase.removeChannel(channel);
    };
  }, [roomId, enabled]);

  // 주기적 확인. live 면 느슨하게(놓친 구간 메우기), polling 이면 촘촘하게.
  useEffect(() => {
    if (!enabled) return;

    const interval = state === "live" ? RECONCILE_INTERVAL_MS : POLL_INTERVAL_MS;
    const timer = setInterval(() => onSignal.current(), interval);

    return () => clearInterval(timer);
  }, [state, enabled]);

  return state;
}
