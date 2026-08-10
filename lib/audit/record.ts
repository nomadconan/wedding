import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 증적 기록 (S4-03 · D-23 · §7.3)
 *
 * D-11 은 "평가 헬퍼·기록 래퍼는 **소비처 생성 시점에** 만든다" 고 정했다. 지금
 * 소비처가 24곳이라 그 시점이 왔다 — 같은 일을 24번 손으로 적으면 한 곳만 빠뜨려도
 * 그 사실은 분쟁에서 없는 일이 된다.
 *
 * **이 함수가 지키는 것**
 *  1. `entity_type` 은 **테이블 이름**이다. 타입으로 좁혀 두면 'cart' 와 'cart_item'
 *     처럼 서로 다른 테이블을 같은 이름으로 적는 실수를 컴파일 시점에 막는다.
 *     RLS 열람 정책이 이 전제 위에 서 있다(0019).
 *  2. **원문을 남기지 않는다.** 넘길 수 있는 것은 상태 문자열과 짧은 메모뿐이고,
 *     본문·경로·개인식별정보를 담을 자리를 아예 두지 않았다(§7.3 증적 최소화).
 *  3. **적재 실패가 본 작업을 깨뜨리지 않는다.** 증적을 못 남겼다고 사용자의 저장을
 *     되돌리면 더 나쁘다. 대신 실패 사실을 남긴다 — 조용히 삼키지 않는다.
 *
 * **서비스롤로 적는다.** `entity_events` 에는 INSERT 정책이 없다(insert-only 이자
 * 서버 전용). 정책이 없다는 것이 곧 "클라이언트는 못 쓴다" 는 뜻이다.
 */
export type EntityType =
  | "vendor"
  | "vendor_application"
  | "vendor_member"
  | "product"
  | "product_option"
  | "price_rule"
  | "inventory_slot"
  | "couple"
  | "cart"
  | "cart_item"
  | "wishlist"
  // S4-01. 채팅 본문·첨부 경로는 memo 에 넣지 않는다 — 아래 3번 원칙 그대로다.
  // 채팅에서 남길 사실은 "무엇을 말했는가" 가 아니라 "방이 열렸다·회수됐다·담당자가
  // 바뀌었다" 같은 상태 전이다. 말한 내용은 chat_messages 가 이미 들고 있다.
  | "chat_room"
  | "chat_message"
  | "qna_post"
  | "qna_answer"
  | "profile"
  | "data_deletion_request";

export type EventSource = "web" | "app" | "system" | "admin";

export type RecordEventInput = {
  entityType: EntityType;
  /** 그 테이블 행의 id. `profile` 만 예외로 auth 사용자 id 다(0019 정책과 같은 전제). */
  entityId: string;
  /** 무슨 일이 있었는지. `<도메인>_<동사 과거형>` 으로 적는다. */
  eventType: string;
  actor: { id: string; role?: string | null };
  /** 상태 전이. 값 자체를 적고 설명을 적지 않는다. */
  beforeState?: string | null;
  afterState?: string | null;
  source?: EventSource;
  /** 요약만. 원문·경로·개인식별정보를 넣지 않는다(§7.3). */
  memo?: string | null;
};

export async function recordEvent(input: RecordEventInput): Promise<void> {
  const admin = createAdminClient();

  const { error } = await admin.from("entity_events").insert({
    entity_type: input.entityType,
    entity_id: input.entityId,
    event_type: input.eventType,
    actor_id: input.actor.id,
    actor_role: input.actor.role ?? null,
    before_state: input.beforeState ?? null,
    after_state: input.afterState ?? null,
    source: input.source ?? "web",
    memo: input.memo ?? null,
  });

  if (error) {
    // 증적을 남기지 못한 것 자체가 사건이다. 다만 사용자의 작업을 되돌리지는 않는다 —
    // "저장은 됐는데 기록이 없다" 가 "저장도 안 됐다" 보다 낫다.
    // **식별자만 남긴다.** 행 내용을 로그에 실으면 §7.3 을 어긴다.
    console.error("[entity_events] insert failed", {
      entityType: input.entityType,
      eventType: input.eventType,
      code: error.code,
    });
  }
}
