-- =============================================================================
-- 0021 · 채팅 · 문의게시판 (S4-01 — 마이그레이션 3차)
-- 근거: docs/07_개발명세서.md §2.1 F-C-27·F-C-28, §2.2 F-V-15·F-V-16,
--       §3.7 chat_rooms·chat_messages·qna_posts·qna_answers, §3.9 RLS(채팅·문의),
--       §3.10 Storage 버킷, §7.3(채팅 내용), D-19·D-23·D-24
-- =============================================================================
-- **화면·API 는 이번 범위가 아니다**(S4-04 채팅 · S4-05 문의게시판). 여기서는 스키마 ·
-- RLS · 인덱스까지만 만든다. 상태 변경 기록은 `lib/audit/record.ts` 의 recordEvent()
-- 를 쓰며, 이 파일은 그에 맞춰 `entity_events` 열람 정책 4종을 함께 넣는다(0019 가
-- "새 도메인을 만들 때 열람 정책을 함께 추가한다" 고 못박았다).
--
-- ── O-11(실시간 전송 계층)과의 관계 ────────────────────────────────────────
-- Supabase Realtime 이냐 별도 웹소켓이냐는 아직 정해지지 않았다. **이 파일은 그
-- 결정과 무관하다** — 어느 쪽이든 같은 테이블을 읽고, 같은 RLS 를 통과한다.
--
-- **publication 은 지금 열지 않는다.** 근거는 파일 끝에 적었다.
--
-- ── 이 파일이 정한 것 — 판단이 필요했던 지점과 근거 ────────────────────────
--
--  1. **방은 커플·업체 조합당 하나다. 상품별로 나뉘지 않는다.**
--     §3.7 은 "고객-업체 **1:1** 채팅방" 이라고 쓰고 "커플 양측이 같은 방을 공유한다"
--     고 덧붙인다. 방의 정체성은 **두 당사자** 이며 상품이 아니다.
--     상품별로 쪼개면 (가) 같은 홀의 A플랜·B플랜을 견주는 대화가 두 방으로 찢어지고,
--     (나) F-V-15 의 담당자 배정이 방마다 따로 생겨 한 고객에게 담당자가 여럿 붙는다.
--     제약은 **UNIQUE (couple_id, vendor_id)** 다. 겹침(범위)이 아니라 **한 점**의
--     중복이므로 EXCLUDE 가 아니라 UNIQUE — S2-05·S3-04 가 세운 기준 그대로다.
--
--     S3-04 의 장바구니와 갈리는 지점: 장바구니는 `status='active'` **부분** 유니크였다.
--     장바구니에는 '계약으로 넘어가 닫힌 장바구니' 라는 자연스러운 세대 구분이 있어서
--     같은 커플에 여러 행이 정상이다. 채팅에는 그런 경계가 없다 — 방을 닫았다 다시
--     열면 **같은 실을 이어야** 한다. 대화를 세대로 쪼개면 분쟁에서 재구성해야 할
--     이력이 조각난다(D-23). 그래서 `status` 는 방의 **세대**가 아니라 **상태**이고,
--     유니크는 부분이 아니라 전체다.
--
--  2. **sender_type 은 sender_id 로 대체할 수 없다.** 세 가지 이유다.
--     · `system` 메시지에는 보낸 사람이 없다. 상담 일정 제안 카드가 그것이다(§3.7).
--       sender_id 가 null 인 행에서 역할을 유도할 방법은 없다.
--     · **역할은 읽는 시점이 아니라 쓰는 시점의 사실**이다. sender_id 로 역할을 되찾으려면
--       읽을 때마다 `couple_members`·`vendor_members` 를 조인해야 하는데, 그 멤버십은
--       변한다. 업체 staff 가 퇴사해 `vendor_members` 행이 지워지면(S2-07) 그 사람이
--       과거에 남긴 말이 **어느 편의 말인지 알 수 없게 된다.** 증적이 나중의 인사
--       변동으로 바뀌면 증적이 아니다(D-23).
--     · 말풍선을 좌우로 나누는 데 메시지마다 조인 두 번을 쓸 이유가 없다.
--
--     **업체 측에 owner·staff 여럿이 들어오는 문제**: 방은 *조직* 단위 1:1 이고 *사람*
--     단위 1:1 이 아니다. 그래서 vendor 쪽 참여자는 여럿이며 전원이 같은 방에 쓴다.
--       - `sender_type` = **어느 편인가** (couple | vendor | system)
--       - `sender_id`   = **그 편의 누가** (staff 개인 식별)
--       - `assigned_to` = **그 편의 누가 책임지는가** (F-V-15 담당자 배정)
--     세 값의 역할이 겹치지 않는다. 그리고 RLS 가 `sender_type` 을 **거짓으로 적지
--     못하게** 막는다 — 커플 당사자는 'vendor' 로, 업체 멤버는 'couple' 로 쓸 수 없고,
--     'system' 은 어느 쪽도 쓸 수 없다(서비스롤 전용).
--
--  3. **읽음은 두 층이다 — 메시지의 read_at 과 참여자의 last_read_at.**
--     "누가 읽었는가" 는 한 컬럼에 안 담긴다. 커플은 둘, 업체는 여럿이다.
--     그래서 서로 다른 두 질문에 서로 다른 자리를 준다.
--       · `chat_messages.read_at` — **상대 편이 처음 읽은 시각**. F-C-27 의 '읽음 표시'
--         가 필요한 것은 체크 하나이며, 상대 조직의 누가 몇 시에 봤는지가 아니다.
--         단조 증가이고 한 번만 채워진다.
--       · `chat_room_reads` — **참여자별 마지막 읽은 시점**. /chat 의 안읽음 배지와
--         "여기까지 읽었습니다" 구분선이 이 값에서 나온다. 사람마다 한 행이다.
--     `read_at` 을 서버가 손으로 채우면 두 층이 어긋날 수 있으므로 **트리거가
--     `chat_room_reads` 로부터 유도**한다. 그래서 클라이언트는 `chat_messages` 에
--     UPDATE 권한이 아예 필요 없고(아래 5번), 읽음 표시는 위조할 수 없다.
--
--     대안으로 `chat_rooms` 에 `read_by jsonb` 를 두는 안을 버렸다 — 동시 갱신에서
--     서로의 쓰기를 덮어쓰고, 인덱스를 걸 수 없어 안읽음 집계가 전수 스캔이 된다.
--
--  4. **본문은 평문으로 저장한다. D-23 의 "참조 ID와 해시만" 은 채팅에 적용하지 않는다.**
--     §7.3 의 '증적 최소화' 행은 대상을 **`entity_events`·`notifications`** 로 못박는다.
--     그 둘은 *사실의 기록*이라 내용이 필요 없다 — 필요한 것은 "언제 어떤 상태였는가"다.
--     채팅은 그 반대다. **내용 자체가 서비스**이고(F-C-27), 분쟁에서 재구성해야 하는
--     사실이 바로 "업체가 무엇을 약속했는가" 다(§7.4 D-23·D-24: 기록되지 않은 사실은
--     분쟁에서 주장할 수 없다). 해시만 남기면 서비스도 증적도 함께 잃는다.
--     그리고 §7.3 은 채팅에 별도 행을 두어 **"본문은 필요한 기간만 보관하고 보관 기간·
--     삭제 정책을 이용약관에 명시한다"** 고 쓴다 — 저장을 전제한 문장이다.
--
--     **대신 경계를 셋 긋는다.**
--       (가) 보관 기간 **값**은 코드에 박지 않는다. `app_settings` 파라미터로 다루고
--            (§7.4 가변 파라미터 원칙) 파기 배치가 `idx_chat_messages_created_at` 을
--            훑는다. 값은 운영 정책이므로 여기서 확정하지 않는다(CLAUDE.md §7.6).
--       (나) **증적 테이블로 본문이 새지 않게** 한다. recordEvent() 의 memo 에 채팅
--            본문을 넣지 않는다 — 그 함수는 애초에 본문을 담을 자리를 두지 않았다.
--            알림도 마찬가지로 `payload_json` 에 참조 ID만 담는다(0019·0020).
--       (다) **마스킹은 AI 경계에서만** 한다(§5.2). 채팅 본문이 AI 플래너 문맥으로
--            들어가는 경로가 생기면 `lib/core/masking` 을 그 앞에 세운다. 사람끼리
--            주고받는 말을 저장 시점에 마스킹하면 연락처를 주고받는 정상 대화가
--            깨진다 — 채팅은 원문 최소화의 대상이 아니라 **보관 기간 통제**의 대상이다.
--     본문 해시 컬럼은 두지 않았다. 메시지는 어떤 역할도 UPDATE·DELETE 할 수 없어
--     (아래 5번) 위조 방지는 이미 DB 가 하고 있고, 해시로 더 막을 수 있는 것은
--     서비스롤 자신뿐인데 그 손에서는 해시도 함께 고쳐진다.
--
--  5. **메시지 수정·삭제는 어떤 역할에도 허용하지 않는다.** 대신 '회수' 를 준다.
--     대화 기록을 당사자가 고칠 수 있으면 그것은 증적이 아니다(0019 가 `entity_events`
--     에 대해 쓴 문장과 같은 이유다). UPDATE·DELETE 는 **정책의 부재가 아니라 권한의
--     회수**로 막는다 — 정책만 없으면 실패가 오류가 아니라 **조용한 0행**이라 "지웠다"
--     고 믿는 코드가 생긴다.
--       · `retracted_at` · `retracted_by` — 서버(서비스롤)가 세우는 **묘비**다.
--         본문은 지우지 않는다. 지우면 분쟁에서 회수된 약속을 재구성할 수 없다.
--       · 그러면 상대가 본문을 계속 읽을 수 있다는 문제가 남는다. RLS 는 컬럼을 조건부로
--         가리지 못하므로 **뷰**로 가린다 — `chat_messages_visible` 은 회수된 행의
--         body·attachments 를 null·빈 배열로 내보낸다. `security_invoker = true` 라
--         밑에 깔린 RLS 를 그대로 통과하므로 뷰가 우회로가 되지 않는다.
--         화면·API(S4-04)는 뷰를 읽고, 운영자는 분쟁 조율 때 서비스롤로 표를 읽는다.
--       · 회수도 사건이므로 recordEvent('chat_message', 'chat_message_retracted') 로
--         남긴다. 원본 · 회수 시각 · 회수한 사람이 모두 보존된다.
--
--  6. **첨부는 버킷 객체 키만 담는다.** §3.10 에 `chat-attachments` 가 이미 정의돼
--     있다(비공개 · 서명 URL + 대화방 참여자만). 이 파일이 그 버킷을 만든다.
--     `storage.objects` 에 정책을 두지 않는다 — "대화방 참여자" 조건은 객체 **경로
--     문자열**을 파싱해 방을 찾아야 하고, 정책 안에서 문자열을 쪼개는 판정은 경로
--     규칙이 바뀌는 순간 조용히 무너진다. 서버가 방 참여를 확인한 뒤 서명 URL 을
--     발급하는 경로 하나로 좁히는 편이 §3.10 문장("서명 URL + 대화방 참여자만")에
--     그대로 맞고, `vendor-documents`(0008) 에서 이미 쓴 방식이다.
--     **서명 URL 을 컬럼에 저장하지 않는다** — 만료되며, 저장하면 접근권이 새어 나간다.
--
--  7. **updated_at 은 chat_messages 에만 두지 않는다.** `entity_events` 와 같은 이유다.
--     메시지에 허용된 변경은 `read_at`(읽힘)과 `retracted_at`(회수) 둘뿐이고, 둘 다
--     **자기 시각 컬럼을 이미 갖고 있다.** 그 위에 "뭔가 바뀌었다" 는 값을 하나 더
--     얹으면 무엇이 바뀌었는지는 말하지 못하면서 기록이 하나 늘어난다. 나머지 네
--     테이블(chat_rooms · chat_room_reads · qna_posts · qna_answers)은 상태를 들고
--     사는 표이므로 updated_at + 트리거를 붙인다.
-- =============================================================================

-- §3.7 chat_messages.sender_type — 명세가 값 집합을 명시했으므로 ENUM 이다(0001 원칙).
create type public.chat_sender_type as enum ('couple', 'vendor', 'system');

comment on type public.chat_sender_type is
  '메시지가 어느 편의 것인가(§3.7). couple|vendor 는 사람, system 은 서버가 남기는 카드(상담 일정 제안 등)다.';

-- =============================================================================
-- 공통 판정 헬퍼
-- -----------------------------------------------------------------------------
-- 전부 security definer + stable 이다. 정책 안에서 다른 표를 읽을 때 그 표의 RLS 가
-- 다시 평가되면 재귀·성능 사고가 나므로 0005 가 세운 방식을 그대로 쓴다.
-- =============================================================================

-- 승인된 업체인가. 심사 중·정지된 업체와는 대화도 문의도 시작할 수 없다.
create or replace function public.is_active_vendor(p_vendor_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.vendors v where v.id = p_vendor_id and v.status = 'active'
  );
$$;

comment on function public.is_active_vendor(uuid) is
  '승인(active) 업체 여부. 채팅방 개설·문의 작성의 전제다 — 심사 중 업체는 아직 거래 상대가 아니다.';

-- =============================================================================
-- chat_rooms — 커플 ↔ 업체 대화방
-- =============================================================================
create table public.chat_rooms (
  id                    uuid primary key default gen_random_uuid(),
  couple_id             uuid not null references public.couples (id) on delete cascade,
  vendor_id             uuid not null references public.vendors (id) on delete cascade,
  status                text not null default 'active',
  assigned_to           uuid references auth.users (id) on delete set null,
  last_message_at       timestamptz,
  awaiting_vendor_since timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint chat_rooms_status_chk check (status in ('active', 'archived', 'blocked')),
  -- 커플·업체 조합당 방 하나. 위 1번 근거.
  constraint uq_chat_rooms_couple_vendor unique (couple_id, vendor_id)
);

comment on table public.chat_rooms is
  '고객-업체 1:1 대화방(F-C-27·F-V-15). 커플 양측이 같은 방을 공유하고, 업체 측은 owner·staff 여럿이 같은 방에 들어온다 — 방은 조직 단위 1:1 이다.';
comment on column public.chat_rooms.status is
  'active(대화 가능) | archived(보관 — 읽기만) | blocked(신고·차단으로 발신 정지). 값 집합은 명세 미확정이므로 text + CHECK 다(0001 원칙). 어느 상태에서도 방과 메시지를 지우지 않는다 — 지우면 분쟁 이력이 사라진다(D-23).';
comment on column public.chat_rooms.assigned_to is
  '업체 측 담당자(F-V-15). 그 업체의 vendor_members 여야 하고, 배정은 업체만 할 수 있다 — 둘 다 트리거가 강제한다. 담당자가 빠지면(멤버 행 삭제) null 로 풀린다: 없는 사람에게 배정된 방보다 미배정이 정직하다.';
comment on column public.chat_rooms.last_message_at is
  '마지막 메시지 시각(§3.7). 목록 정렬과 S3-11 홈의 최근 대화가 쓴다. **트리거가 채운다** — 클라이언트는 UPDATE 권한이 없다(정렬 근거를 당사자가 손대면 안 된다).';
comment on column public.chat_rooms.awaiting_vendor_since is
  '고객이 물었는데 업체가 아직 답하지 않은 **최초** 시각. 업체 답변이 오면 null 로 풀린다. F-V-15 응답 SLA 타이머와 sla-escalation 배치(S4-13)가 이 한 컬럼만 보면 된다. 최초 시각을 유지하는 이유 — 고객이 세 번 더 물어도 SLA 시계는 첫 질문에서 흘러야 한다.';

-- 목록·정렬 경로. 양쪽 인박스가 서로 다른 선행 컬럼을 쓴다.
create index if not exists idx_chat_rooms_couple_recent
  on public.chat_rooms (couple_id, last_message_at desc nulls last);
create index if not exists idx_chat_rooms_vendor_recent
  on public.chat_rooms (vendor_id, last_message_at desc nulls last);

-- 미응답 방만 훑는 경로(SLA 에스컬레이션). 대부분 null 이라 부분 인덱스다.
create index if not exists idx_chat_rooms_awaiting_vendor
  on public.chat_rooms (awaiting_vendor_since)
  where awaiting_vendor_since is not null;

-- "내가 담당한 방" (F-V-15 인박스 필터).
create index if not exists idx_chat_rooms_assigned_to
  on public.chat_rooms (assigned_to)
  where assigned_to is not null;

select public.attach_set_updated_at('chat_rooms');

-- =============================================================================
-- chat_messages — 메시지
-- =============================================================================
create table public.chat_messages (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.chat_rooms (id) on delete cascade,
  -- on delete restrict: 사람을 지운다고 그 사람이 한 말이 사라지면 안 된다. 계정 삭제는
  -- data_deletion_requests 절차(F-A-08)를 밟으며 그 자리에서 의도적으로 다뤄야 한다.
  -- (cart_items.added_by 와 같은 판단이다.)
  sender_id     uuid references auth.users (id) on delete restrict,
  sender_type   public.chat_sender_type not null,
  body          text,
  attachments   jsonb not null default '[]'::jsonb,
  read_at       timestamptz,
  retracted_at  timestamptz,
  retracted_by  uuid references auth.users (id) on delete restrict,
  created_at    timestamptz not null default now(),
  -- system 메시지에만 보낸 사람이 없다. 그 짝이 어긋나면 어느 편의 말인지 알 수 없다.
  constraint chat_messages_sender_pair_chk
    check ((sender_type = 'system') = (sender_id is null)),
  -- 배열이 아니면 jsonb_array_length 가 터진다. 형태를 컬럼에서 못박는다.
  constraint chat_messages_attachments_array_chk
    check (jsonb_typeof(attachments) = 'array'),
  -- 본문도 첨부도 없는 메시지는 대화가 아니다(공백만 있는 본문도 같다).
  constraint chat_messages_not_empty_chk
    check (coalesce(btrim(body), '') <> '' or jsonb_array_length(attachments) > 0),
  constraint chat_messages_retraction_pair_chk
    check ((retracted_at is null) = (retracted_by is null))
);

comment on table public.chat_messages is
  '대화 메시지(F-C-27). **어떤 역할도 UPDATE·DELETE 할 수 없다**(권한 자체를 회수했다). 회수는 retracted_at 묘비로 하고 본문은 보존한다 — 대화 기록은 분쟁의 1차 증거다(D-23·D-24).';
comment on column public.chat_messages.sender_type is
  '어느 편의 말인가. **쓰는 시점에 굳는다** — sender_id 로 되찾으려 하면 멤버십 변동(퇴사 등) 뒤에 과거 메시지의 편이 흔들린다. system 은 서버가 남기는 카드(상담 일정 제안, §3.7)이며 서비스롤만 쓸 수 있다.';
comment on column public.chat_messages.sender_id is
  '그 편의 누가 썼는가. 업체 측은 owner·staff 여럿이 같은 방에 쓰므로 sender_type 만으로는 사람을 특정할 수 없다. RLS 가 auth.uid() 와 일치하도록 강제한다.';
comment on column public.chat_messages.body is
  '본문 평문(§7.3 채팅 내용 행). 증적 최소화(§7.3)의 "참조 ID와 해시만" 은 entity_events·notifications 를 가리키며 채팅에는 적용하지 않는다 — 채팅은 내용 자체가 서비스이자 증거다. 대신 보관 기간으로 통제하고 그 값은 app_settings 파라미터다.';
comment on column public.chat_messages.attachments is
  '[{path, name, mime, size}] 배열. **chat-attachments 버킷의 객체 키만** 담고 서명 URL 은 담지 않는다 — URL 은 만료되며 저장하면 접근권이 새어 나간다(§3.10, CLAUDE.md §5.5).';
comment on column public.chat_messages.read_at is
  '**상대 편이 처음 읽은 시각.** 참여자별 읽음은 chat_room_reads 가 따로 들고, 이 컬럼은 F-C-27 의 읽음 표시(체크 하나)를 위한 것이다. chat_room_reads 트리거가 유도하므로 클라이언트가 위조할 수 없다.';
comment on column public.chat_messages.retracted_at is
  '회수(사용자의 "삭제") 시각. 본문은 지우지 않는다 — chat_messages_visible 뷰가 화면에서 가리고, 운영자는 분쟁 조율 때 서비스롤로 원본을 본다. 서버만 세운다(클라이언트는 UPDATE 권한이 없다).';
comment on column public.chat_messages.retracted_by is
  '회수한 사람. 누가 내렸는지 없으면 회수 자체가 증적이 되지 못한다.';

-- 방 안의 시간순 조회·페이지네이션(가장 뜨거운 경로).
create index if not exists idx_chat_messages_room_created
  on public.chat_messages (room_id, created_at desc);

-- 안읽음 집계와 읽음 전파 트리거가 함께 쓴다. 오래된 방은 대부분 읽혀서 부분 인덱스가 짧게 유지된다.
create index if not exists idx_chat_messages_unread
  on public.chat_messages (room_id, created_at)
  where read_at is null;

-- 보관 기간 파기 배치가 방을 가로질러 훑는 경로(§7.3). 기간 값은 app_settings 소관이다.
create index if not exists idx_chat_messages_created_at
  on public.chat_messages (created_at);

-- updated_at 을 두지 않는다(위 7번). 그래서 attach_set_updated_at 도 부르지 않는다.

-- =============================================================================
-- chat_room_reads — 참여자별 마지막 읽은 시점
-- =============================================================================
create table public.chat_room_reads (
  id                   uuid primary key default gen_random_uuid(),
  room_id              uuid not null references public.chat_rooms (id) on delete cascade,
  -- 읽음 상태는 증적이 아니라 편의 상태다. 사람이 지워지면 함께 지워도 잃는 사실이 없다
  -- (sender_id 를 restrict 로 둔 것과 정반대 판단이며, 그 차이가 의도다).
  user_id              uuid not null references auth.users (id) on delete cascade,
  last_read_at         timestamptz not null default now(),
  last_read_message_id uuid references public.chat_messages (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint uq_chat_room_reads_participant unique (room_id, user_id)
);

comment on table public.chat_room_reads is
  '방 참여자별 마지막 읽은 시점. 커플은 둘, 업체는 여럿이라 "누가 읽었는가" 가 메시지의 한 컬럼에 담기지 않는다 — 안읽음 배지와 읽음 구분선이 여기서 나온다.';
comment on column public.chat_room_reads.last_read_at is
  '**뒤로 갈 수 없다.** 트리거가 단조 증가로 고정한다 — 되돌릴 수 있으면 "안 읽었다" 를 나중에 만들어 낼 수 있다.';
comment on column public.chat_room_reads.last_read_message_id is
  '"여기까지 읽었습니다" 구분선의 기준점. 메시지가 보관 기간으로 파기되면 null 로 풀린다.';

create index if not exists idx_chat_room_reads_user on public.chat_room_reads (user_id);
select public.attach_set_updated_at('chat_room_reads');

-- =============================================================================
-- 방 판정 헬퍼 (chat_messages·chat_room_reads 정책이 부모 방을 통해 판정한다)
-- -----------------------------------------------------------------------------
-- **플래너는 넣지 않는다.** 그래서 커플 쪽 판정에 is_couple_member 가 아니라
-- is_couple_principal(0015)을 쓴다 — is_couple_member 는 couple_members 의 planner
-- 행도 참으로 보기 때문에 그것을 쓰면 플래너가 조용히 들어온다.
-- 근거는 셋이다.
--   (가) §3.9 의 채팅 행은 "해당 커플 구성원과 해당 업체 멤버**만**" 이라고 쓴다.
--        같은 표의 상담 행은 "해당 커플·업체·**위임 플래너**만" 이라고 플래너를 명시한다.
--        한쪽에 쓰고 한쪽에 안 쓴 것은 누락이 아니라 구분이다.
--   (바) 장바구니(S3-04)에 플래너 **읽기**를 준 것과 갈리는 지점이 여기다. 장바구니는
--        커플이 혼자 만든 목록이라 읽는 사람이 하나 늘어도 커플만의 문제다. 대화에는
--        **상대 당사자**가 있다. 업체는 이 커플과 이야기하기로 한 것이고 커플의 플래너와
--        이야기하기로 한 것이 아니다 — 제3자를 조용히 넣으면 업체가 동의한 범위가 바뀐다.
--   (사) 플래너가 읽을 수 있게 하면 다음 요구는 반드시 '대신 쓰기' 다. 그러면 플래너의
--        말이 sender_type='couple' 로 남아 "누가 약속했는가" 가 틀어진다(D-23).
-- 플래너를 참여시켜야 할 필요가 생기면 그것은 새 의사결정(D-번호)이며, 방에 업체도
-- 볼 수 있는 명시적 동의 표시를 함께 둬야 한다(CLAUDE.md §7.6).
-- =============================================================================
create or replace function public.chat_room_couple_id(p_room_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select r.couple_id from public.chat_rooms r where r.id = p_room_id;
$$;

create or replace function public.chat_room_vendor_id(p_room_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select r.vendor_id from public.chat_rooms r where r.id = p_room_id;
$$;

create or replace function public.is_chat_room_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chat_rooms r
    where r.id = p_room_id
      and (public.is_couple_principal(r.couple_id) or public.is_vendor_member(r.vendor_id))
  );
$$;

comment on function public.is_chat_room_member(uuid) is
  '대화방 참여자 여부(§3.9 채팅 행). 커플 당사자(owner·partner) 또는 그 업체 멤버. **플래너는 제외한다** — 0021 헬퍼 블록의 근거 참조.';

create or replace function public.chat_room_is_open(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chat_rooms r where r.id = p_room_id and r.status = 'active'
  );
$$;

comment on function public.chat_room_is_open(uuid) is
  '발신 가능한 방인가. archived·blocked 방에는 읽기만 남는다 — 차단을 앱에서만 막으면 API 를 직접 부르면 뚫린다.';

-- =============================================================================
-- 트리거 1 — 메시지가 들어오면 방의 정렬 기준과 SLA 시계를 갱신한다
-- =============================================================================
create or replace function public.chat_room_touch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.chat_rooms r
     set last_message_at = new.created_at,
         awaiting_vendor_since = case
           -- 고객이 물었다: 이미 기다리는 중이면 **최초** 시각을 유지한다.
           when new.sender_type = 'couple' then coalesce(r.awaiting_vendor_since, new.created_at)
           -- 업체가 답했다: 시계를 끈다.
           when new.sender_type = 'vendor' then null
           -- system 카드는 응답이 아니다. 시계를 건드리지 않는다.
           else r.awaiting_vendor_since
         end
   where r.id = new.room_id;

  return null;
end;
$$;

comment on function public.chat_room_touch() is
  '메시지 삽입 후 chat_rooms.last_message_at · awaiting_vendor_since 를 갱신한다. 앱이 아니라 DB 가 유지하는 이유 — 어느 경로로 메시지가 들어와도 목록 정렬과 SLA 시계가 같이 움직여야 한다.';

drop trigger if exists trg_chat_messages_touch_room on public.chat_messages;
create trigger trg_chat_messages_touch_room
  after insert on public.chat_messages
  for each row execute function public.chat_room_touch();

-- =============================================================================
-- 트리거 2 — 읽음을 단조 증가로 고정하고, 상대 편 메시지의 read_at 을 유도한다
-- =============================================================================
create or replace function public.chat_reads_apply()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_couple uuid;
  v_vendor uuid;
  v_side   public.chat_sender_type;
begin
  -- 뒤로 가는 읽음은 없다. 되돌릴 수 있으면 "안 읽었다" 를 나중에 만들 수 있다.
  if tg_op = 'UPDATE' and new.last_read_at < old.last_read_at then
    new.last_read_at := old.last_read_at;
    new.last_read_message_id := old.last_read_message_id;
  end if;

  select r.couple_id, r.vendor_id into v_couple, v_vendor
  from public.chat_rooms r where r.id = new.room_id;

  -- 어느 편의 읽음인가. RLS 가 이미 걸러 주지만 서비스롤 경로에도 같은 규칙이 필요하다.
  if exists (
    select 1 from public.couple_members m
    where m.couple_id = v_couple and m.user_id = new.user_id
      and m.member_role in ('owner', 'partner')
  ) then
    v_side := 'couple';
  elsif exists (
    select 1 from public.vendor_members vm
    where vm.vendor_id = v_vendor and vm.user_id = new.user_id
  ) then
    v_side := 'vendor';
  else
    raise exception '대화방 참여자만 읽음을 남길 수 있습니다.'
      using errcode = 'insufficient_privilege';
  end if;

  -- 상대 편(+system) 메시지의 '처음 읽힌 시각' 을 채운다. 이미 채워진 행은 건드리지
  -- 않으므로 최초 열람 시각이 유지되고, 부분 인덱스(idx_chat_messages_unread)를 탄다.
  update public.chat_messages m
     set read_at = new.last_read_at
   where m.room_id = new.room_id
     and m.read_at is null
     and m.created_at <= new.last_read_at
     and m.sender_type <> v_side;

  return new;
end;
$$;

comment on function public.chat_reads_apply() is
  '참여자 읽음을 단조 증가로 고정하고, 그로부터 chat_messages.read_at(상대 편 최초 열람)을 유도한다. 두 층을 앱이 각각 쓰면 서로 어긋날 수 있어 한쪽을 다른 쪽에서 유도한다.';

drop trigger if exists trg_chat_room_reads_apply on public.chat_room_reads;
create trigger trg_chat_room_reads_apply
  before insert or update on public.chat_room_reads
  for each row execute function public.chat_reads_apply();

-- =============================================================================
-- 트리거 3 — 담당자는 그 업체 사람이어야 하고, 배정은 업체가 한다
-- =============================================================================
create or replace function public.assert_chat_assignee()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.assigned_to is not distinct from new.assigned_to then
    return new;
  end if;

  if new.assigned_to is null then
    return new;
  end if;

  if not exists (
    select 1 from public.vendor_members vm
    where vm.vendor_id = new.vendor_id and vm.user_id = new.assigned_to
  ) then
    raise exception '채팅 담당자는 해당 업체의 구성원이어야 합니다.'
      using errcode = 'check_violation';
  end if;

  -- 배정은 업체의 일이다(F-V-15). 고객이 상대 조직의 담당자를 지정할 수는 없다.
  -- auth.uid() 가 없는 경로(서비스롤·배치)는 통과한다 — 운영자 개입 여지는 남긴다.
  if auth.uid() is not null and not exists (
    select 1 from public.vendor_members vm
    where vm.vendor_id = new.vendor_id and vm.user_id = auth.uid()
  ) then
    raise exception '채팅 담당자 배정은 해당 업체만 할 수 있습니다.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.assert_chat_assignee() is
  '담당자 배정의 두 규칙(F-V-15). CHECK 로는 표현할 수 없다 — 다른 표(vendor_members)를 봐야 하고, 누가 바꾸는지도 봐야 한다.';

drop trigger if exists trg_chat_rooms_assignee on public.chat_rooms;
create trigger trg_chat_rooms_assignee
  before insert or update on public.chat_rooms
  for each row execute function public.assert_chat_assignee();

-- =============================================================================
-- qna_posts — 업체별 문의(Q&A)
-- =============================================================================
create table public.qna_posts (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors (id) on delete cascade,
  author_id   uuid not null references auth.users (id) on delete restrict,
  title       text not null,
  body        text not null,
  is_public   boolean not null default true,
  status      text not null default 'open',
  answered_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint qna_posts_status_chk check (status in ('open', 'answered', 'hidden', 'withdrawn')),
  constraint qna_posts_title_chk check (btrim(title) <> ''),
  constraint qna_posts_body_chk check (btrim(body) <> '')
);

comment on table public.qna_posts is
  '업체별 Q&A(F-C-28·F-V-16). is_public=false 면 작성자·해당 업체만 열람한다(§3.9).';
comment on column public.qna_posts.is_public is
  '작성 시 고객이 고른다(F-C-28). **비공개 → 공개 전환은 작성자만** 할 수 있다 — 업체가 남의 비공개 질문을 공개로 올리면 그것은 공개 설정 변경이 아니라 유출이다. 업체는 내리는 방향(공개 → 비공개)만 가능하다. 트리거가 강제한다.';
comment on column public.qna_posts.status is
  'open(미답변 — F-V-16 미답변 큐) | answered | hidden(업체가 내림) | withdrawn(작성자가 내림). **DELETE 는 어느 역할에도 없다** — 업체 답변이 달린 질문은 공개 기록이므로 지우지 않고 상태로 내린다.';
comment on column public.qna_posts.answered_at is
  '첫 답변 시각. 답변 삽입 트리거가 채운다 — 미답변 큐·SLA 표시(F-V-16)가 앱의 성실함에 기대면 안 된다.';

create index if not exists idx_qna_posts_vendor_created
  on public.qna_posts (vendor_id, created_at desc);
create index if not exists idx_qna_posts_author on public.qna_posts (author_id);

-- 공개 목록(/qna/[vendorId]) 경로. 비공개·내린 글을 인덱스에서부터 뺀다.
create index if not exists idx_qna_posts_public
  on public.qna_posts (vendor_id, created_at desc)
  where is_public and status in ('open', 'answered');

-- 미답변 큐(F-V-16). 오래 기다린 것이 앞이므로 오름차순이다.
create index if not exists idx_qna_posts_unanswered
  on public.qna_posts (vendor_id, created_at)
  where status = 'open';

select public.attach_set_updated_at('qna_posts');

-- 유사 질문 노출(F-C-28)의 검색 인덱스는 **여기서 만들지 않는다.** trigram · tsvector ·
-- 임베딩 중 무엇을 쓰느냐가 인덱스의 모양을 정하고, 그 선택은 S4-05 의 것이다.
-- 지금 하나를 고르면 쓰지 않을 인덱스를 미리 만드는 셈이다.

-- =============================================================================
-- qna_answers — 업체 답변
-- =============================================================================
create table public.qna_answers (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.qna_posts (id) on delete cascade,
  responder_id uuid not null references auth.users (id) on delete restrict,
  body         text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint qna_answers_body_chk check (btrim(body) <> '')
);

comment on table public.qna_answers is
  '업체 답변(F-V-16). 답변은 게시된 문서이므로 업체가 고칠 수 있다 — 대화 기록(chat_messages)과 갈리는 지점이다. 다만 지울 수는 없다: 질문자가 본 답변이 흔적 없이 사라지면 안 된다.';
comment on column public.qna_answers.responder_id is
  '답한 업체 구성원. RLS 가 auth.uid() 와 일치하도록 강제한다 — 남의 이름으로 답할 수 없다.';

create index if not exists idx_qna_answers_post on public.qna_answers (post_id, created_at);
select public.attach_set_updated_at('qna_answers');

-- =============================================================================
-- 트리거 4 — 질문 수정 규칙 (본문은 작성자만 · 공개 전환은 작성자만)
-- =============================================================================
create or replace function public.assert_qna_post_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_is_author boolean := (auth.uid() is not null and auth.uid() = old.author_id);
begin
  -- auth.uid() 가 없으면 서비스롤·트리거 경로다(예: 답변 삽입 시 status 갱신).
  if auth.uid() is null then
    return new;
  end if;

  if not v_is_author and (new.title <> old.title or new.body <> old.body) then
    raise exception '질문 본문은 작성자만 수정할 수 있습니다.'
      using errcode = 'insufficient_privilege';
  end if;

  if not v_is_author and new.is_public and not old.is_public then
    raise exception '비공개 질문을 공개로 바꾸는 것은 작성자만 할 수 있습니다.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.assert_qna_post_update() is
  '업체의 "공개 설정 변경"(F-V-16)을 내리는 방향으로만 허용하고, 고객 질문의 본문 수정을 막는다. RLS 는 행을 가르지만 컬럼과 값의 전이 방향은 가르지 못한다.';

drop trigger if exists trg_qna_posts_update_rules on public.qna_posts;
create trigger trg_qna_posts_update_rules
  before update on public.qna_posts
  for each row execute function public.assert_qna_post_update();

-- =============================================================================
-- 트리거 5 — 답변이 달리면 질문은 미답변 큐에서 빠진다
-- =============================================================================
create or replace function public.qna_post_mark_answered()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.qna_posts p
     set status = 'answered',
         answered_at = coalesce(p.answered_at, new.created_at)
   where p.id = new.post_id and p.status = 'open';

  return null;
end;
$$;

comment on function public.qna_post_mark_answered() is
  '첫 답변으로 status 를 answered 로 옮기고 answered_at 을 채운다. hidden·withdrawn 은 건드리지 않는다 — 내린 글이 답변 때문에 되살아나면 안 된다.';

drop trigger if exists trg_qna_answers_mark_answered on public.qna_answers;
create trigger trg_qna_answers_mark_answered
  after insert on public.qna_answers
  for each row execute function public.qna_post_mark_answered();

-- =============================================================================
-- 문의 판정 헬퍼
-- =============================================================================
create or replace function public.qna_post_vendor_id(p_post_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select p.vendor_id from public.qna_posts p where p.id = p_post_id;
$$;

create or replace function public.can_read_qna_post(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.qna_posts p
    join public.vendors v on v.id = p.vendor_id
    where p.id = p_post_id
      and (
        (p.is_public and p.status in ('open', 'answered') and v.status = 'active')
        or p.author_id = auth.uid()
        or exists (
          select 1 from public.vendor_members vm
          where vm.vendor_id = p.vendor_id and vm.user_id = auth.uid()
        )
      )
  );
$$;

comment on function public.can_read_qna_post(uuid) is
  '문의 열람 판정(§3.9 문의 행). 공개글(승인 업체·내려가지 않은 것) 은 누구나, 비공개글은 작성자와 해당 업체만. 답변의 가시성은 질문을 따라간다 — "비공개 질문의 답변은 작성자에게만"(F-V-16).';

-- =============================================================================
-- RLS
-- -----------------------------------------------------------------------------
-- §3.9 채팅·문의 행:
--   "chat_rooms·chat_messages 는 해당 커플 구성원과 해당 업체 멤버만.
--    qna_posts 는 is_public=true 면 anon SELECT 허용, false면 작성자와 해당 업체만"
--
-- **방을 여는 것은 고객뿐이다.** 업체에 INSERT 를 주지 않는다 — 업체가 먼저 말을 걸 수
-- 있으면 채팅이 영업 창구가 된다. 이 플랫폼은 업체의 노출·접근을 돈이나 적극성으로
-- 사게 하지 않는다(§2.2, D-03). 업체는 F-V-15 인박스에서 **응대**한다.
--
-- **운영자**: 클라이언트 정책을 주지 않는다(§3.9). 분쟁 조율(F-A-12)은 서비스롤 경유
-- Route Handler 에서 본다 — 대화 원문을 운영자 세션에 상시로 열어 두지 않는다.
-- =============================================================================

-- ── chat_rooms ──────────────────────────────────────────────────────────────
alter table public.chat_rooms enable row level security;

create policy chat_rooms_select on public.chat_rooms for select to authenticated
  using (public.is_couple_principal(couple_id) or public.is_vendor_member(vendor_id));

create policy chat_rooms_insert on public.chat_rooms for insert to authenticated
  with check (public.is_couple_principal(couple_id) and public.is_active_vendor(vendor_id));

create policy chat_rooms_update on public.chat_rooms for update to authenticated
  using (public.is_couple_principal(couple_id) or public.is_vendor_member(vendor_id))
  with check (public.is_couple_principal(couple_id) or public.is_vendor_member(vendor_id));

comment on policy chat_rooms_insert on public.chat_rooms is
  '방은 고객이 연다. 업체에 INSERT 를 주지 않는 것은 누락이 아니라 판단이다 — 업체가 먼저 말을 걸 수 있으면 채팅이 영업 창구가 된다(§2.2).';

-- 정렬 기준(last_message_at)과 SLA 시계(awaiting_vendor_since)는 트리거의 것이다.
-- 당사자가 손댈 수 있으면 "언제 물었고 언제 답했는가" 가 흔들린다(D-23).
-- RLS 는 컬럼을 가르지 못하므로 0019 와 같이 **GRANT** 로 좁힌다.
revoke update, delete on public.chat_rooms from authenticated, anon;
grant update (status, assigned_to) on public.chat_rooms to authenticated;

-- ── chat_messages ───────────────────────────────────────────────────────────
alter table public.chat_messages enable row level security;

create policy chat_messages_select on public.chat_messages for select to authenticated
  using (public.is_chat_room_member(room_id));

-- 보낸 사람과 **보낸 편** 둘 다 거짓으로 적을 수 없다.
-- sender_type='system' 은 어느 분기도 타지 못하므로 서비스롤 전용이 된다.
create policy chat_messages_insert on public.chat_messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.chat_room_is_open(room_id)
    and (
      (sender_type = 'couple'
        and public.is_couple_principal(public.chat_room_couple_id(room_id)))
      or (sender_type = 'vendor'
        and public.is_vendor_member(public.chat_room_vendor_id(room_id)))
    )
  );

comment on policy chat_messages_insert on public.chat_messages is
  '자기 이름으로, 자기 편으로, 열린 방에만 쓴다. system 카드는 어느 분기도 타지 못해 서비스롤 전용이다(§3.7 상담 일정 제안 카드).';

-- 수정·삭제는 **권한 자체를 회수**한다. 정책만 없으면 실패가 조용한 0행이 되고,
-- 그러면 "지웠다" 고 믿는 코드가 생긴다(0019 가 entity_events 에 쓴 것과 같은 이유).
revoke update, delete on public.chat_messages from authenticated, anon;

-- ── chat_room_reads ─────────────────────────────────────────────────────────
alter table public.chat_room_reads enable row level security;

-- **자기 행만 본다.** 상대 편이 언제 읽었는지는 chat_messages.read_at 이 한 비트로
-- 알려 주면 충분하다. 상대 조직의 누가 몇 시에 봤는지까지 열면 업체 staff 의 근태를
-- 고객이 들여다보는 셈이 된다.
create policy chat_room_reads_select on public.chat_room_reads for select to authenticated
  using (user_id = auth.uid() and public.is_chat_room_member(room_id));

create policy chat_room_reads_insert on public.chat_room_reads for insert to authenticated
  with check (user_id = auth.uid() and public.is_chat_room_member(room_id));

create policy chat_room_reads_update on public.chat_room_reads for update to authenticated
  using (user_id = auth.uid() and public.is_chat_room_member(room_id))
  with check (user_id = auth.uid() and public.is_chat_room_member(room_id));

-- 읽음을 지워 "안 읽었다" 를 만들 수는 없다.
revoke delete on public.chat_room_reads from authenticated, anon;

-- ── qna_posts ───────────────────────────────────────────────────────────────
alter table public.qna_posts enable row level security;

create policy qna_posts_select_public on public.qna_posts for select to anon, authenticated
  using (is_public and status in ('open', 'answered') and public.is_active_vendor(vendor_id));

create policy qna_posts_select_author on public.qna_posts for select to authenticated
  using (author_id = auth.uid());

create policy qna_posts_select_vendor on public.qna_posts for select to authenticated
  using (public.is_vendor_member(vendor_id));

create policy qna_posts_insert on public.qna_posts for insert to authenticated
  with check (author_id = auth.uid() and public.is_active_vendor(vendor_id));

create policy qna_posts_update_author on public.qna_posts for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());

create policy qna_posts_update_vendor on public.qna_posts for update to authenticated
  using (public.is_vendor_member(vendor_id)) with check (public.is_vendor_member(vendor_id));

comment on policy qna_posts_select_public on public.qna_posts is
  '공개글은 비로그인도 읽는다(§3.9). 다만 내려간 글(hidden·withdrawn)과 승인되지 않은 업체의 글은 빠진다 — 탐색 공개 규칙(0005 vendors_select_public)과 같은 경계다.';

-- 업체는 내용을 고칠 수 없고 상태·공개 여부만 만진다. 그 방향은 트리거가 가른다.
-- vendor_id·author_id·answered_at 은 어느 쪽도 만지지 못한다.
revoke update, delete on public.qna_posts from authenticated, anon;
grant update (title, body, is_public, status) on public.qna_posts to authenticated;

-- ── qna_answers ─────────────────────────────────────────────────────────────
alter table public.qna_answers enable row level security;

-- 답변의 가시성은 질문을 따라간다 — "비공개 질문의 답변은 작성자에게만"(F-V-16).
create policy qna_answers_select on public.qna_answers for select to anon, authenticated
  using (public.can_read_qna_post(post_id));

create policy qna_answers_insert on public.qna_answers for insert to authenticated
  with check (
    responder_id = auth.uid()
    and public.is_vendor_member(public.qna_post_vendor_id(post_id))
  );

create policy qna_answers_update on public.qna_answers for update to authenticated
  using (public.is_vendor_member(public.qna_post_vendor_id(post_id)))
  with check (public.is_vendor_member(public.qna_post_vendor_id(post_id)));

revoke update, delete on public.qna_answers from authenticated, anon;
grant update (body) on public.qna_answers to authenticated;

-- =============================================================================
-- chat_messages_visible — 회수된 메시지를 가리는 읽기 경로
-- -----------------------------------------------------------------------------
-- `security_invoker = true` 라 뷰가 아니라 **읽는 사람의 권한**으로 밑의 표를 본다.
-- 즉 chat_messages 의 RLS 를 그대로 통과하며, 뷰가 우회로가 되지 않는다.
-- 화면·API(S4-04)는 이 뷰를 읽고, 운영자는 분쟁 조율 때 서비스롤로 표를 읽는다.
-- =============================================================================
create view public.chat_messages_visible
with (security_invoker = true) as
select
  m.id,
  m.room_id,
  m.sender_id,
  m.sender_type,
  case when m.retracted_at is null then m.body end as body,
  case when m.retracted_at is null then m.attachments else '[]'::jsonb end as attachments,
  m.read_at,
  m.retracted_at,
  m.created_at
from public.chat_messages m;

comment on view public.chat_messages_visible is
  '회수(retracted)된 메시지의 body·attachments 를 가린 읽기 경로. 원본은 chat_messages 에 남는다 — 회수된 약속을 분쟁에서 재구성해야 하기 때문이다(D-23). security_invoker 라 밑의 RLS 가 그대로 적용된다.';

revoke all on public.chat_messages_visible from anon;
grant select on public.chat_messages_visible to authenticated;

-- =============================================================================
-- entity_events — 새 도메인의 당사자 열람 정책 (§3.9, 0019 의 약속)
-- -----------------------------------------------------------------------------
-- 0019: "새 도메인을 만들 때 열람 정책을 함께 추가한다."
-- 여전히 **insert-only** 다 — INSERT·UPDATE·DELETE 정책을 만들지 않고, 권한은 0019 가
-- 이미 회수해 두었다. 적재는 서버가 recordEvent()(lib/audit/record.ts)로만 한다.
-- **memo 에 채팅 본문을 넣지 않는다**(§7.3) — recordEvent 는 본문을 담을 자리가 없다.
-- =============================================================================
create policy entity_events_select_chat_room on public.entity_events
  for select to authenticated
  using (entity_type = 'chat_room' and public.is_chat_room_member(entity_id));

create policy entity_events_select_chat_message on public.entity_events
  for select to authenticated
  using (
    entity_type = 'chat_message'
    and exists (
      select 1 from public.chat_messages m
      where m.id = entity_events.entity_id and public.is_chat_room_member(m.room_id)
    )
  );

create policy entity_events_select_qna_post on public.entity_events
  for select to authenticated
  using (entity_type = 'qna_post' and public.can_read_qna_post(entity_id));

create policy entity_events_select_qna_answer on public.entity_events
  for select to authenticated
  using (
    entity_type = 'qna_answer'
    and exists (
      select 1 from public.qna_answers a
      where a.id = entity_events.entity_id and public.can_read_qna_post(a.post_id)
    )
  );

-- =============================================================================
-- Storage 버킷 (§3.10) — 커버리지 표가 S4-01 에 맡긴 잔여분
-- -----------------------------------------------------------------------------
-- §3.10 은 버킷 6종을 정의한다. `vendor-media`(공개)는 0009 가, `vendor-documents`
-- (비공개)는 0008 이 이미 만들었다. 남은 넷을 여기서 만든다.
--
-- **전부 비공개다. 공개 버킷은 `vendor-media` 하나뿐**이라는 원칙을 지킨다(§3.10 NOTE,
-- CLAUDE.md §5.5). 그리고 넷 모두 `storage.objects` 에 정책을 두지 않는다 — anon ·
-- authenticated 는 직접 접근할 수 없고, 서버가 조건을 확인한 뒤 발급한 **서명 URL**
-- 로만 오간다(0008 이 vendor-documents 에서 쓴 방식과 같다).
--
-- `chat-attachments` 의 "대화방 참여자만" 조건을 정책으로 쓰지 않는 이유는 파일 머리
-- 6번에 적었다 — 객체 경로 문자열에서 방을 되찾는 판정은 경로 규칙이 바뀌면 조용히
-- 무너진다. 서버가 is_chat_room_member() 를 확인하고 서명 URL 을 내주는 편이 안전하다.
--
-- 여기서 만들어 두는 이유: 버킷이 없으면 그 기능을 만드는 태스크가 인프라 생성부터
-- 해야 하고, 그때 공개 여부를 다시 판단하게 된다. 정책 원칙이 흔들릴 자리를 남기지 않는다.
--   contracts-raw    → 계약·견적 원문. **분석 후 24시간 내 파기**(§5.1, purge-documents)
--   reports          → 생성된 리포트 PDF. 소유 커플만
--   contracts-signed → 전자계약 서명본. 당사자만(고객·업체·플래너). 보존기간은 O-03 대기
--   chat-attachments → 채팅 첨부. 대화방 참여자만(§3.10)
-- =============================================================================
insert into storage.buckets (id, name, public)
values
  ('chat-attachments', 'chat-attachments', false),
  ('contracts-raw', 'contracts-raw', false),
  ('reports', 'reports', false),
  ('contracts-signed', 'contracts-signed', false)
on conflict (id) do nothing;

-- =============================================================================
-- Realtime publication — **지금 열지 않는다** (O-11)
-- -----------------------------------------------------------------------------
-- Supabase Realtime 을 쓰려면 `supabase_realtime` publication 에 표를 넣어야 한다.
-- 한 줄이면 되고, 이 파일의 어떤 것도 그것을 전제하지 않는다.
--
--   -- S4-04 가 O-11 을 Supabase Realtime 으로 결론지으면:
--   -- alter publication supabase_realtime add table public.chat_messages;
--
-- **켜지 않는 근거**
--  1. 지금 켜면 **구독자가 없는 송출 경로**가 열린다. Realtime 은 구독마다 RLS 를
--     다시 평가하지만, 그 평가는 S4-04 가 쓸 구독 코드의 필터에 달려 있다. 소비처가
--     생기기 전에 경로를 열어 두면 검증할 대상 없이 열린 문만 남는다.
--  2. 나중에 켜는 비용이 **0** 이다. 표를 다시 쓰지도, 데이터를 옮기지도 않는다 —
--     새 마이그레이션 한 줄이다. 반대로 켜 두고 안 쓰기로 결론이 나면 되돌리는
--     마이그레이션을 또 써야 하고, 그 사이 스테이징에 쓰이지 않는 WAL 스트림이 돈다.
--  3. **결정은 결정한 자리에 남아야 한다.** 지금 켜면 커밋 이력상 O-11 이 이 태스크에서
--     이미 정해진 것처럼 보인다. 미결정을 임의로 확정하지 않는다(CLAUDE.md §7.6).
--
-- **어느 쪽을 택해도 이 파일로 충분하다는 근거**
--  · `chat_messages` 는 클라이언트 UPDATE·DELETE 가 없다. 그래서 Realtime 이
--    `old_record` 를 위해 요구하는 `replica identity full` 이 필요 없고, 기본 replica
--    identity(PK)로 INSERT 송출이 그대로 된다. 표 정의를 바꿀 일이 남지 않는다.
--  · 별도 웹소켓을 택하면 그 서버도 같은 표를 읽고 같은 RLS 를 통과한다. 읽음은
--    `chat_room_reads` 한 행 upsert 이고 나머지는 트리거가 유도하므로, 전송 계층이
--    무엇이든 쓰기 모양이 같다.
-- =============================================================================

-- =============================================================================
-- 이 파일이 한 것
--   테이블 5 — chat_rooms · chat_messages · chat_room_reads · qna_posts · qna_answers
--              (전부 id uuid PK + created_at. updated_at + 트리거는 chat_messages 를
--               제외한 4개 — 메시지는 read_at·retracted_at 이 자기 시각을 갖는다)
--   뷰 1 — chat_messages_visible (security_invoker, 회수 메시지 가림)
--   ENUM 1 — chat_sender_type (couple|vendor|system, §3.7 명시 값 집합)
--   UNIQUE 2 — 커플·업체 조합당 방 1개 / 방·사람당 읽음 행 1개
--   CHECK 9 — 방 상태 / 보낸이 짝 / 첨부 배열 / 빈 메시지 금지 / 회수 짝 /
--             문의 상태 · 제목 · 본문 / 답변 본문
--   인덱스 11 (부분 4 포함)
--   함수 9 — is_active_vendor · chat_room_couple_id · chat_room_vendor_id ·
--            is_chat_room_member · chat_room_is_open · qna_post_vendor_id ·
--            can_read_qna_post + 트리거 함수 5(chat_room_touch · chat_reads_apply ·
--            assert_chat_assignee · assert_qna_post_update · qna_post_mark_answered)
--   트리거 5 + updated_at 트리거 4
--   정책 19 — chat_rooms 3 · chat_messages 2 · chat_room_reads 3 · qna_posts 6 ·
--             qna_answers 3 + entity_events 열람 4  (합 21; DELETE 정책은 하나도 없다)
--   GRANT  chat_rooms UPDATE 를 (status, assigned_to) 로 / qna_posts 를
--          (title, body, is_public, status) 로 / qna_answers 를 (body) 로 좁힘.
--          chat_messages 는 UPDATE·DELETE 권한 전면 회수
--   Storage 버킷 4 — chat-attachments · contracts-raw · reports · contracts-signed
--                    (전부 비공개, storage.objects 정책 없음 = 서명 URL 전용)
--   Realtime publication 변경 없음 (O-11 — 위 근거 참조)
--   기존 마이그레이션 수정 없음
-- =============================================================================
