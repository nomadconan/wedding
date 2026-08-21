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
  // S4-12. 문의 본문·연락처는 memo 에 넣지 않는다 — 남길 사실은 "보냈다·응답했다·
  // 거절했다·수락했다" 라는 상태 전이와 셀 수 있는 값(대상 수·금액)이다.
  | "inquiry"
  | "inquiry_target"
  | "quote"
  // S4-07. 예약·보증금은 **금전과 일정**이라 상태 전이가 곧 분쟁의 근거다(D-23).
  // memo 에는 금액·사유 코드만 넣는다 — 장소·연락처 같은 식별정보는 넣지 않는다.
  | "consultation"
  | "consultation_deposit"
  // S4-14 · S2-09. 설정 변경과 초대는 **권한이 움직이는 일**이라 기록이 필요하다 —
  // "누가 우리 업체에 들어왔나" 는 분쟁에서 실제로 묻는 질문이다(D-23).
  // memo 에 토큰·이메일을 넣지 않는다.
  | "vendor_settings"
  | "vendor_invite"
  // S5-01 잔여분. 결제·정산은 **상태 전이가 곧 분쟁의 근거**다(D-23).
  // memo 에 카드·구매자 정보를 넣지 않는다 — 남길 사실은 "청구했다·받았다·환불했다·
  // 지급 대상이 됐다" 라는 전이와 셀 수 있는 값(금액·회차)뿐이다(§7.3).
  | "payment"
  | "payment_schedule"
  | "settlement"
  | "planner_settlement"
  // S5-04·S5-05. 계약·서명은 **무엇에 서명했는가** 가 쟁점이라 전이를 남긴다(D-23).
  // memo 에 조항 본문·해시 전체·본인확인 참조를 넣지 않는다 — 남길 사실은
  // "발행됐다·서명됐다·확정됐다" 와 셀 수 있는 값(금액·요율·서명 수)이다.
  | "contract"
  | "contract_signature"
  // S5-08. 해지·위약금은 **누가 언제 무엇에 동의했는가** 가 곧 분쟁의 근거다(D-23).
  // memo 에는 사유 **코드**·금액·구간만 넣는다 — 보충 설명 원문은 넣지 않는다(§7.3).
  | "contract_cancellation"
  // S5-07. 지급은 **돈이 나가는 사건**이라 시도·성공·실패가 전부 남아야 한다(D-23).
  // memo 에 계좌·예금주를 넣지 않는다 — 남길 사실은 금액과 결과다(§7.3).
  | "settlement_payout"
  // S5-11. 쿠폰 발급·사용. memo 에 코드·개인 식별정보를 넣지 않는다.
  | "coupon_issue"
  // S5-03. 요율 변경은 **누가 언제 무엇을 바꿨는지가 곧 정산 분쟁의 근거**다(D-23).
  // memo 에 업체명을 넣지 않는다 — 범위·요율·기간이면 재현에 충분하다(§7.3).
  | "commission_rate"
  | "planner_fee_rate"
  // S5-09. 에스크로는 **"언제 이행이 확인됐는가"** 가 곧 분쟁의 쟁점이다(D-23).
  // memo 에 금액·상태·사유 코드만 넣는다 — 이행 내용 서술은 넣지 않는다(§7.3).
  | "escrow_hold"
  // S6-01. 카테고리별 플래너 선택·해제. **"언제부터 언제까지 썼는가"** 가 정산
  // 분쟁의 질문이다(D-23). memo 에 카테고리·상태만 넣는다 — 금액은 계약이 갖는다.
  | "planner_scope"
  // S6-02. 플래너 등록·프로필·공개 상태. memo 에 소개 본문을 넣지 않는다 —
  // 남길 사실은 "등록했다·신청했다·내렸다" 와 셀 수 있는 값(카테고리 수)이다(§7.3).
  | "planner"
  // S5-06. 결제 전 고지·동의(F-C-14). memo 에는 **종류와 판본만** 넣는다 —
  // 문구 자체는 코드가 판본과 함께 갖는다(§7.3).
  | "payment_consent"
  // S7-06. 플래너 대화. **본문을 memo 에 넣지 않는다** — 말한 내용은 `ai_messages` 가
  // 갖고, 여기 남길 사실은 "대화가 열렸다"·"상한에 막혔다" 라는 전이와 사유 코드다.
  // `entity_events` 에 이 타입의 열람 정책은 두지 않는다(서버·운영 전용 · ai_call_logs 와 같다).
  | "ai_conversation"
  // S7-03. 계약서 원문과 분석. **본문·경로·잔존 값을 memo 에 넣지 않는다**(§5.3) —
  // 남길 사실은 "올렸다·마스킹이 막았다·분석이 끝났다·원문을 지웠다" 라는 전이와
  // 셀 수 있는 값(finding 수·폐기 수)·사유 코드다. 파기 증적은 개인정보 감사
  // (F-A-08 · S8-04)가 읽는 자리이기도 하다.
  | "document"
  | "document_analysis"
  // S7-14. 커뮤니티. **본문을 memo 에 넣지 않는다** — 남길 사실은 "썼다·가렸다·
  // 지웠다·신고가 처리됐다" 라는 전이와 **사유 코드**다(D-23 · §7.3). 특히 모더레이션은
  // 되돌릴 수 없는 권한이라 처리 이력이 곧 설명의 근거가 된다(F-A-18).
  | "community_post"
  | "community_comment"
  | "community_report"
  // S7-08. 체크리스트. **제목·메모를 memo 에 넣지 않는다**(§7.3) — 남길 사실은
  // "자동 생성했다"·"선행 미완인 채 완료했다" 라는 전이와 셀 수 있는 값이다.
  // `checklist_generated` 의 entity_id 는 커플 id 다(태스크 하나가 아니라 한 벌이다).
  | "task"
  // S7-04. 위약금 시뮬레이션. **금액을 memo 에 넣지 않는다**(§7.3) — 행이 이미 갖고
  // 있고 옮겨 적으면 두 곳이 갈린다. 남길 사실은 **어떤 기준으로 계산했는가**
  // (등록 기준인가 가정치인가)이며, 기준이 바뀐 뒤 "그때 무엇으로 냈나" 를 답한다.
  | "penalty_simulation"
  // S7-12. 공유 링크. **토큰을 memo 에 넣지 않는다**(§7.3) — 증적에 적으면 증적을
  // 읽을 수 있는 사람이 그 링크를 열 수 있게 된다. 남길 사실은 "무엇을 밖으로
  // 보냈고 언제 거뒀나" 이며, 그것이 D-23 이 말하는 증거다.
  | "share_link"
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
