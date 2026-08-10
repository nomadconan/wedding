-- =============================================================================
-- 0019 · 증거 보존 완성 (S4-03 · 마이그레이션 5차)
-- 근거: docs/07_개발명세서.md §3.7 notifications, §3.8 audit_logs·entity_events,
--       §3.9 RLS(증거 보존), §7.3(증적 최소화), D-23
-- =============================================================================
-- `entity_events` 는 S2-01 이 앞당겨 만들었고(0008) **이미 코드가 적재 중**이다.
-- 남은 절반이 여기 있다 — `notifications`·`audit_logs` 확장과, 벤더 말고 다른
-- 엔티티의 **당사자 열람 정책**이다(0008 주석이 "S4-03 등에서 추가한다" 고 남겨 뒀다).
--
-- **파괴적 변경은 하지 않는다.** 컬럼을 지우거나 이름을 바꾸지 않으며 전부 추가다.
-- 이미 쓰는 호출부가 24곳이라 이름을 바꾸면 조용히 깨진다.
--
-- ── 왜 발송·도달·열람을 나눠 적는가 ─────────────────────────────────────────
-- 분쟁에서 쟁점은 "안내를 받았는가" 다(D-23). '보냈다' 와 '도달했다' 와 '읽었다' 는
-- 서로 다른 사실이고, 하나로 합치면 셋 중 어느 것도 증명하지 못한다.
-- 반대로 **무엇을 보냈는지는 남기지 않는다**(§7.3) — 필요한 것은 내용이 아니라
-- 언제 어떤 상태였는가다.
-- =============================================================================

-- =============================================================================
-- 1) notifications — 발송·도달·열람·실패를 나눠 적는다 (§3.7, D-23)
-- =============================================================================
alter table public.notifications
  -- 발송사(메일·알림톡·푸시)가 돌려준 식별자. 이게 있어야 "우리 기록" 과 "발송사 기록" 을
  -- 대조할 수 있다. 없으면 분쟁에서 우리 말만 남는다.
  add column if not exists provider_message_id text,
  add column if not exists delivered_at        timestamptz,
  add column if not exists failed_at           timestamptz,
  add column if not exists failure_reason      text;

comment on column public.notifications.provider_message_id is
  '발송사가 돌려준 메시지 식별자. 우리 기록과 발송사 기록을 대조하는 열쇠다.';
comment on column public.notifications.delivered_at is
  '수신 확인 시각. sent_at(보냄)과 다른 사실이다 — 보냈지만 도달하지 않을 수 있다.';
comment on column public.notifications.read_at is
  '열람 시각. delivered_at(도달)과 다른 사실이다 — 도달했지만 읽지 않을 수 있다.';
comment on column public.notifications.failure_reason is
  '실패 사유 코드·요약. **원문이나 수신자 식별정보를 넣지 않는다**(§7.3).';
comment on column public.notifications.payload_json is
  '참조 ID와 해시만 담는다. **원문 내용을 저장하지 않는다**(§7.3) — 재구성해야 하는 사실은 "무엇을 보냈는가" 가 아니라 "언제 보냈고 도달했고 열람됐는가" 다.';

-- 시간 순서를 DB 가 지킨다. 도달이 발송보다 앞서거나, 보내지도 않았는데 읽힌 기록은
-- 증적이 아니라 오류다. 그런 행이 하나라도 있으면 타임라인 전체를 믿을 수 없게 된다.
alter table public.notifications
  add constraint notifications_delivery_order_chk
  check (
    (delivered_at is null or sent_at is null or delivered_at >= sent_at)
    and (read_at is null or sent_at is null or read_at >= sent_at)
  );

-- 실패는 사유와 짝이다. 사유 없는 실패는 왜 실패했는지 물을 수 없다.
alter table public.notifications
  add constraint notifications_failure_pair_chk
  check ((failed_at is null) = (failure_reason is null));

-- 성공과 실패를 동시에 주장할 수 없다.
alter table public.notifications
  add constraint notifications_failed_not_delivered_chk
  check (failed_at is null or delivered_at is null);

-- 발송사 응답으로 우리 행을 찾는 경로(웹훅). 널이 대부분이라 부분 인덱스다.
create unique index if not exists uq_notifications_provider_message
  on public.notifications (provider_message_id)
  where provider_message_id is not null;

-- SLA 추적: 보냈는데 아직 도달하지 않은 것(S4-13·F-A-08 이 훑는다).
create index if not exists idx_notifications_pending_delivery
  on public.notifications (sent_at)
  where sent_at is not null and delivered_at is null and failed_at is null;

-- -----------------------------------------------------------------------------
-- notifications RLS 보강 — **읽음 처리만** 갱신할 수 있게 한다
-- -----------------------------------------------------------------------------
-- 0005 의 정책 주석은 "읽음 처리만 갱신 가능" 이라고 적었지만, **RLS 는 컬럼을 가르지
-- 못한다.** 지금 상태로는 수신자가 `sent_at`·`delivered_at` 을 자기 손으로 고칠 수
-- 있고, 그러면 "안 받았다" 는 주장을 만들 수 있다 — 증적이 당사자에게 열려 있으면
-- 증적이 아니다.
--
-- 컬럼 단위는 GRANT 의 일이다. UPDATE 권한을 전부 회수하고 `read_at` 하나만 돌려준다.
-- 정책(본인 행)과 권한(그 컬럼)이 겹쳐야 "본인이 자기 읽음만" 이 된다.
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- =============================================================================
-- 2) audit_logs — 조율 결정의 근거를 함께 남긴다 (§3.8, §3.11)
-- =============================================================================
alter table public.audit_logs
  add column if not exists resolution_basis uuid[];

comment on column public.audit_logs.resolution_basis is
  '운영자 조율 결정의 근거가 된 entity_events id 목록(§3.11). 결론만 남기면 왜 그렇게 정했는지 재구성할 수 없고, 그러면 조율자가 아니라 판정자가 된다(D-24).';
comment on table public.audit_logs is
  '전 주체(고객·업체·플래너·운영자)의 상태 변경 기록. 계약서 원문·Storage 경로·마스킹 맵을 기록하지 않는다(CLAUDE.md §5.3).';

-- 근거를 적었으면 그것은 조율 결정이다. 빈 배열은 "적었는데 비었다" 라 사실이 아니다.
-- `array_length(빈 배열, 1)` 은 0이 아니라 **NULL** 이고, `NULL >= 1` 은 false 가 아니라
-- NULL 이라 CHECK 를 통과한다. coalesce 로 0을 만들어야 실제로 막힌다.
alter table public.audit_logs
  add constraint audit_logs_resolution_basis_not_empty_chk
  check (resolution_basis is null or coalesce(array_length(resolution_basis, 1), 0) >= 1);

-- 시간순 조회(F-A-09 감사 로그 화면·S8-02 증적 타임라인).
create index if not exists idx_audit_logs_created_at on public.audit_logs (created_at desc);

-- =============================================================================
-- 3) entity_events — 당사자 열람 정책을 채운다 (§3.9)
-- =============================================================================
-- 0008 은 `vendor` 타입 하나만 열어 두고 "다른 엔티티 타입의 열람 정책은 해당 도메인을
-- 만드는 태스크(S4-03 등)에서 추가한다" 고 남겼다. 그 사이 커플·장바구니·찜·프로필·
-- 삭제요청 이벤트가 쌓였고, 화면은 **서비스롤로** 읽고 있었다. 서비스롤로 읽으면
-- 경계가 RLS 가 아니라 애플리케이션 코드로 넘어간다.
--
-- **INSERT 정책은 여전히 두지 않는다.** 이벤트는 서버가 서비스롤로만 적재한다.
-- **UPDATE·DELETE 정책도 어떤 역할에도 주지 않는다** — insert-only 는 정책의 부재로
-- 강제된다(RLS 가 켜져 있고 정책이 없으면 기본 거부).
--
-- `entity_type` 은 **테이블 하나를 가리킨다.** 장바구니 항목 이벤트를 'cart' 로 적으면
-- entity_id 가 carts.id 인지 cart_items.id 인지 알 수 없어 정책을 쓸 수 없다.
-- 그래서 'cart_item' 을 따로 둔다(같은 커밋에서 호출부도 고쳤다).
-- =============================================================================

-- 커플 이벤트 — 그 커플의 당사자·멤버만.
create policy entity_events_select_couple on public.entity_events
  for select to authenticated
  using (entity_type = 'couple' and public.is_couple_member(entity_id));

-- 장바구니·항목 — 부모 장바구니의 커플 멤버만.
create policy entity_events_select_cart on public.entity_events
  for select to authenticated
  using (
    entity_type = 'cart'
    and public.is_couple_member(public.cart_couple_id(entity_id))
  );

create policy entity_events_select_cart_item on public.entity_events
  for select to authenticated
  using (
    entity_type = 'cart_item'
    and exists (
      select 1 from public.cart_items i
      where i.id = entity_events.entity_id
        and public.is_couple_member(public.cart_couple_id(i.cart_id))
    )
  );

create policy entity_events_select_wishlist on public.entity_events
  for select to authenticated
  using (
    entity_type = 'wishlist'
    and exists (
      select 1 from public.wishlists w
      where w.id = entity_events.entity_id and public.is_couple_member(w.couple_id)
    )
  );

-- 프로필 이벤트는 `entity_id` 가 **auth 사용자 id** 다(profiles.id 가 아니다).
create policy entity_events_select_profile on public.entity_events
  for select to authenticated
  using (entity_type = 'profile' and entity_id = auth.uid());

create policy entity_events_select_deletion_request on public.entity_events
  for select to authenticated
  using (
    entity_type = 'data_deletion_request'
    and exists (
      select 1 from public.data_deletion_requests r
      where r.id = entity_events.entity_id and r.user_id = auth.uid()
    )
  );

-- 운영자는 전체를 본다(§3.9). 분쟁 조율(F-A-12)의 타임라인이 여기서 나온다.
create or replace function public.is_operator()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role in ('ops', 'admin')
  );
$$;

comment on function public.is_operator() is
  '운영자(ops·admin) 여부. 화면 가드가 아니라 RLS 판정용이다.';

create policy entity_events_select_operator on public.entity_events
  for select to authenticated
  using (public.is_operator());

-- -----------------------------------------------------------------------------
-- insert-only 를 **권한으로도** 못박는다
-- -----------------------------------------------------------------------------
-- 정책이 없으면 RLS 가 막지만, UPDATE·DELETE 는 **오류가 아니라 0행**으로 끝난다.
-- 감사 테이블에서 조용한 실패는 위험하다 — 고쳤다고 믿는 코드가 생긴다.
-- 권한 자체를 회수하면 시도 시점에 끊긴다. "어떤 역할에도 부여하지 않는다"(§3.9)를
-- 정책의 부재가 아니라 권한의 부재로 표현하는 편이 정확하다.
revoke insert, update, delete on public.entity_events from authenticated, anon;

-- 사람 기준 조회(감사·CS). 누가 무엇을 했는지 훑는 경로다.
create index if not exists idx_entity_events_actor
  on public.entity_events (actor_id, occurred_at desc);

comment on column public.entity_events.entity_type is
  '이벤트가 가리키는 **테이블 이름**. entity_id 가 어느 테이블의 행인지 이것으로 정해지며, RLS 정책이 그 전제 위에 선다. 새 도메인을 만들 때 열람 정책을 함께 추가한다.';

-- =============================================================================
-- 이 파일이 한 것
--   ALTER  notifications +4컬럼 / audit_logs +1컬럼
--   CHECK  4 — 발송·도달·열람 순서 / 실패 짝 / 성공·실패 배타 / 근거 배열 비어 있지 않음
--   GRANT  notifications UPDATE 를 read_at 컬럼으로 좁힘 / entity_events 쓰기 권한 회수
--   인덱스 4(부분 유니크 1 포함)
--   정책 7 — entity_events 당사자 6 + 운영자 1 (전부 SELECT. INSERT·UPDATE·DELETE 없음)
--   함수 1 — is_operator()
--   신규 테이블 없음, 파괴적 변경 없음
-- =============================================================================
