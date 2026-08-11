-- =============================================================================
-- 0026 · 업체 알림·연동 설정 + 미가입자 초대 (S4-14 · S2-09)
-- 근거: docs/07_개발명세서.md §2.2 F-V-14·F-V-13, §3.3 vendor_members, §3.9 RLS,
--       §4.3, §6.3, §7.4(가변 파라미터), D-23·D-28
-- =============================================================================
-- 두 태스크를 한 파일에 둔다. 둘 다 **업체 조직 설정**이고, 초대는 그 조직에 사람을
-- 들이는 일이라 담당자 배정·수신 대상과 같은 표를 본다.
--
-- ── 1. 업체 알림 설정을 소비자와 **같은 표에 두지 않는다** ──────────────────
-- `notification_prefs` 는 `(user_id, topic)` 이다. 개인이 "나는 이 알림을 푸시로
-- 받겠다" 를 정하는 자리이고, 그 전제는 **수신자가 곧 설정 주체**라는 것이다.
-- 업체는 다르다 — owner·staff 여럿이 있고, "문의 알림을 누가 받는가" 는 개인의
-- 취향이 아니라 **조직의 라우팅 결정**이다.
--
-- 개인 설정만으로 두면: 새 staff 가 들어올 때마다 아무도 문의를 못 받는 상태가
-- 되고(기본값은 개인마다 꺼져 있을 수 있다), owner 가 "우리는 이메일로 받는다" 를
-- 정할 수 없다.
-- 조직 설정만으로 두면: 개인이 야간 푸시를 끌 수 없다.
--
-- **그래서 두 층이다.** 조직이 대상과 채널을 정하고(`vendor_notification_prefs`),
-- 개인은 그 안에서 자기 채널을 끌 수 있다(기존 `notification_prefs`).
-- 발송 판정은 **둘 다 통과해야** 한다 — 다만 `in_app` 은 어느 층에서도 끄지 못한다
-- (0020 이 세운 규칙: 앱 알림함을 끄면 증적을 남길 자리가 사라진다).
--
-- ── 2. 영업시간은 SLA **판정**에 반영하지 않는다 ────────────────────────────
-- 반영하면 **업체가 자기 SLA 기준을 자기가 정하는 구조**가 된다. 영업시간을
-- "화요일 14~15시" 로 적으면 미응답 판정이 사실상 사라지는데, SLA 는 고객 보호
-- 장치다(F-V-15 미응답 에스컬레이션). 규제 대상이 규제 기준을 정하면 규제가 아니다 —
-- S4-12 가 "업체가 견적 없이 responded 로 바꾸면 SLA 시계를 스스로 끄는 셈" 이라
-- 막았던 것과 같은 문제다.
--
-- 그렇다고 새벽 3시에 "지연됐습니다" 를 보내는 것도 맞지 않다. 그래서 **가른다.**
--   · **판정 기준(고객의 권리)** — 벽시계 그대로. 업체 설정이 움직이지 못한다.
--   · **알림 시각(업체의 편의)** — 영업시간을 존중한다. 에스컬레이션 알림은 다음
--     영업 시작 시각으로 미룬다.
--   · **고객 안내** — 업체 영업시간을 화면에 적어 기대를 맞춘다.
-- 영업시간은 그래서 `business_hours` 한 컬럼이며 SLA 계산 함수는 이 값을 보지 않는다.
--
-- ── 3. 담당자 배정은 **라운드로빈이 아니다** ────────────────────────────────
-- 목적이 공평 분배가 아니라 **응답 책임**이기 때문이다. 누가 받았는지 모르면 SLA
-- 책임이 흐려진다. 라운드로빈은 (가) 마지막 배정자를 상태로 들고 있어야 하고 동시
-- 요청에서 어긋나며, (나) 담당자가 1~2명인 규모에서는 분배 알고리즘이 필요 없다.
-- 그래서 `recipient_mode` 세 값으로 둔다 — 전원 / 담당자 우선 / 지정.
--
-- ── 4. 이월분(빠른 답변·견적 템플릿)을 **한 표로 합친다** ───────────────────
-- S4-04 와 S4-12 가 "표가 필요해서" 넘긴 둘이다. 모양은 다르지만
-- (빠른 답변은 문장, 견적은 상품·옵션 구성) **수명주기·권한·화면이 같다** — 업체가
-- 저장해 두고 꺼내 쓰는 것이고, 만들고 지우는 화면이 하나다.
--
-- 견적 템플릿에 `products` FK 를 걸지 않는 이유: 템플릿은 **초안**이지 견적이
-- 아니다. 실제 견적은 S4-12 의 검증(참조 강제·상한 CHECK·트리거)을 그대로 지나므로
-- 무결성 경계는 거기다. 템플릿에 FK 를 걸면 상품을 지울 때 템플릿이 막고, 그건
-- 초안이 할 일이 아니다. 상품이 사라진 템플릿은 **적용 시점에** 걸러진다.
--
-- ── 5. 초대 대기 표는 §3.3 에 없다. 만든다 ──────────────────────────────────
-- S2-07 이 "가입된 이메일만 연결" 로 처리하며 남긴 자리다(그 파일 주석에 이유가
-- 적혀 있다 — `vendor_members.user_id` 가 `auth.users` FK 라 계정 없이는 행을 만들
-- 수 없다). 계정이 생기기 **전에** 초대를 붙들어 둘 곳이 필요하고, 그게 이 표다.
-- =============================================================================

-- =============================================================================
-- 1) vendor_settings — 업체 조직 설정 (F-V-14)
-- =============================================================================
create type public.vendor_recipient_mode as enum ('all', 'assignee_first', 'specific');

comment on type public.vendor_recipient_mode is
  'all(멤버 전원) | assignee_first(담당자가 있으면 담당자만, 없으면 전원) | specific(지정 담당자만). **라운드로빈은 두지 않는다** — 목적이 공평 분배가 아니라 응답 책임이다(0026 주석 3번).';

create table public.vendor_settings (
  -- 업체당 하나. PK 를 vendor_id 로 두면 "설정이 둘" 인 상태가 존재할 수 없다.
  vendor_id           uuid primary key references public.vendors (id) on delete cascade,
  recipient_mode      public.vendor_recipient_mode not null default 'all',
  -- 새 문의·채팅이 오면 자동으로 배정할 사람. 없으면 미배정으로 시작한다.
  default_assignee_id uuid references auth.users (id) on delete set null,
  /**
   * 영업시간 — `[{ "weekday": 0..6, "start": "HH:MM", "end": "HH:MM" }]`.
   *
   * **jsonb 인 이유**: 업체를 가로질러 조회할 일이 없다(자기 업체 것만 읽는다).
   * `vendor_availability` 가 표인 것은 겹침을 DB 가 거부해야 했기 때문인데,
   * 영업시간은 겹쳐도 합쳐 읽으면 그만이라 제약이 필요 없다.
   *
   * **SLA 판정에 쓰지 않는다**(0026 주석 2번). 쓰는 곳은 알림 발송 시각과 고객 안내다.
   */
  business_hours      jsonb not null default '[]'::jsonb,
  /** 영업시간 밖 알림을 다음 영업 시작으로 미룰지. 끄면 즉시 보낸다. */
  defer_offhours      boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint vendor_settings_hours_is_array
    check (jsonb_typeof(business_hours) = 'array')
);

comment on table public.vendor_settings is
  '업체 조직 설정(F-V-14) — 알림 수신 대상·담당자 배정·영업시간. 개인 설정(notification_prefs)과 **다른 층**이다: 여기는 "누가 받는가"(조직의 결정), 저기는 "어떤 채널로 받는가"(개인의 취향).';
comment on column public.vendor_settings.business_hours is
  '영업시간. **SLA 판정에는 쓰지 않는다** — 쓰면 업체가 자기 SLA 기준을 자기가 정하는 구조가 되고, SLA 는 고객 보호 장치다(0026 주석 2번). 알림 발송 시각과 고객 안내에만 쓴다.';
comment on column public.vendor_settings.default_assignee_id is
  '새 문의·채팅의 기본 담당자. 그 업체 멤버여야 하며 트리거가 강제한다.';

-- 담당자는 그 업체 사람이어야 한다. 0021 이 `chat_rooms.assigned_to` 에 건 것과 같은 규칙.
create or replace function public.assert_vendor_default_assignee()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.default_assignee_id is null then return new; end if;

  if tg_op = 'UPDATE'
     and old.default_assignee_id is not distinct from new.default_assignee_id then
    return new;
  end if;

  if not exists (
    select 1 from public.vendor_members vm
    where vm.vendor_id = new.vendor_id and vm.user_id = new.default_assignee_id
  ) then
    raise exception '기본 담당자는 해당 업체의 구성원이어야 합니다.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_vendor_settings_assignee on public.vendor_settings;
create trigger trg_vendor_settings_assignee
  before insert or update on public.vendor_settings
  for each row execute function public.assert_vendor_default_assignee();

select public.attach_set_updated_at('vendor_settings');

-- =============================================================================
-- 2) vendor_notification_prefs — 조직 단위 채널 설정 (F-V-14)
-- =============================================================================
create table public.vendor_notification_prefs (
  id            uuid primary key default gen_random_uuid(),
  vendor_id     uuid not null references public.vendors (id) on delete cascade,
  topic         text not null,
  channel_flags jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (vendor_id, topic),
  constraint vendor_notification_prefs_flags_is_object
    check (jsonb_typeof(channel_flags) = 'object')
);

comment on table public.vendor_notification_prefs is
  '업체가 **조직으로서** 어떤 채널을 켤지. 개인의 notification_prefs 와 AND 로 결합한다 — 조직이 켠 채널 중에서 개인이 끄지 않은 것만 나간다. in_app 은 어느 층에서도 끌 수 없다(0020).';

create index if not exists idx_vendor_notification_prefs_vendor
  on public.vendor_notification_prefs (vendor_id);

select public.attach_set_updated_at('vendor_notification_prefs');

-- =============================================================================
-- 3) vendor_templates — 빠른 답변 + 견적 템플릿 (S4-04·S4-12 이월)
-- =============================================================================
create table public.vendor_templates (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  kind         text not null,
  title        text not null,
  /**
   * 종류별 모양은 zod 가 검증한다(`lib/core/schemas/vendor-settings.ts`).
   *   quick_reply : { body: string }
   *   quote       : { productId, lines: [{ itemType, productOptionId, amount }] }
   *
   * **견적 템플릿에 products FK 를 걸지 않는다** — 템플릿은 초안이고 무결성 경계는
   * 실제 견적 쪽이다(S4-12 의 참조 강제·상한 CHECK). FK 를 걸면 상품을 지울 때
   * 초안이 막아서고, 그건 초안이 할 일이 아니다.
   */
  payload_json jsonb not null default '{}'::jsonb,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint vendor_templates_kind_chk check (kind in ('quick_reply', 'quote')),
  constraint vendor_templates_title_chk check (btrim(title) <> ''),
  constraint vendor_templates_payload_is_object
    check (jsonb_typeof(payload_json) = 'object'),
  -- 같은 종류에 같은 이름이 둘이면 목록에서 고를 수 없다.
  unique (vendor_id, kind, title)
);

comment on table public.vendor_templates is
  '업체가 저장해 두고 꺼내 쓰는 것 — 빠른 답변(S4-04 이월)과 견적 템플릿(S4-12 이월). 모양은 다르지만 수명주기·권한·화면이 같아 한 표에 둔다. 종류별 payload 검증은 zod 가 한다.';

create index if not exists idx_vendor_templates_vendor_kind
  on public.vendor_templates (vendor_id, kind, sort_order);

select public.attach_set_updated_at('vendor_templates');

-- =============================================================================
-- 4) vendor_invites — 미가입자 초대 (S2-09 · F-V-13 잔여)
-- =============================================================================
-- **§3.3 에 없는 표다.** S2-07 이 남긴 자리이며, 계정이 생기기 전에 초대를 붙들어
-- 둘 곳이 필요해서 만든다(`vendor_members.user_id` 가 `auth.users` FK 라 계정 없이는
-- 멤버 행을 만들 수 없다).
--
-- ── 커플 초대(0002 `couple_invites`)와 다르게 가는 점 ───────────────────────
-- 커플 초대는 **사람이 불러 주는 8자 코드**다(헷갈리는 글자를 뺐다). 업체 초대는
-- **이메일로 링크를 보낸다** — 옮겨 적을 일이 없으므로 짧을 이유가 없고, 짧은 코드는
-- 추측에 약하다. 업체 멤버 권한은 가격·정산에 닿으므로(§3.9) 커플 초대보다 높은
-- 강도가 맞다. 그래서 긴 랜덤 토큰이다.
--
-- 공통으로 가져가는 것은 **판정의 모양**이다 — 만료·사용 여부를 한 함수가 보고
-- (`inviteBlocker` 와 같은 자리), 만료 기한을 상수·파라미터로 둔다.
create table public.vendor_invites (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors (id) on delete cascade,
  -- 소문자로 저장한다. 대소문자가 다른 같은 주소로 두 번 초대되면 안 된다.
  email       text not null,
  vendor_role public.vendor_member_role not null default 'staff',
  token       text not null unique,
  expires_at  timestamptz not null,
  invited_by  uuid references auth.users (id) on delete set null,
  -- 발송 증적. **미가입자에게는 `notifications` 행을 만들 수 없다**(user_id 가
  -- auth.users FK 다). 그래서 "보냈는가" 를 이 표가 들고 있는다 — D-23 이 요구하는
  -- 것은 기록이지 특정 표가 아니다.
  sent_at     timestamptz,
  send_attempts integer not null default 0 check (send_attempts >= 0),
  send_failure_reason text,
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint vendor_invites_email_chk check (email = lower(btrim(email)) and email like '%@%'),
  -- 수락에는 수락자와 시각이 짝이다.
  constraint vendor_invites_accept_pair_chk
    check ((accepted_at is null) = (accepted_by is null)),
  -- 수락된 초대를 다시 거둘 수는 없다.
  constraint vendor_invites_revoke_chk
    check (revoked_at is null or accepted_at is null)
);

comment on table public.vendor_invites is
  '업체 멤버 초대 대기(F-V-13 · S2-09). 계정이 생기기 전에 초대를 붙들어 둔다 — vendor_members.user_id 가 auth.users FK 라 계정 없이는 멤버 행을 만들 수 없다. 커플 초대와 달리 **이메일 링크용 긴 토큰**이다(가격·정산에 닿는 권한이라 추측에 약한 짧은 코드를 쓰지 않는다).';
comment on column public.vendor_invites.sent_at is
  '발송 증적(D-23). 미가입자에게는 notifications 행을 만들 수 없어(user_id FK) 여기에 남긴다. 가입자에게는 notifications 에도 남는다.';
comment on column public.vendor_invites.token is
  '이메일 링크에 실리는 토큰. 사람이 옮겨 적지 않으므로 길이를 줄이지 않는다.';

-- 같은 업체·같은 이메일에 **살아 있는 초대는 하나**다. 수락·거둠·만료된 것은 여러 개
-- 쌓일 수 있다 — 재발송 이력이 곧 증적이므로 지우지 않는다(장바구니 부분 유니크와
-- 같은 발상).
create unique index if not exists uq_vendor_invites_pending
  on public.vendor_invites (vendor_id, email)
  where accepted_at is null and revoked_at is null;

create index if not exists idx_vendor_invites_email on public.vendor_invites (email);
create index if not exists idx_vendor_invites_vendor on public.vendor_invites (vendor_id, created_at desc);

select public.attach_set_updated_at('vendor_invites');

-- =============================================================================
-- 5) RLS (§3.9)
-- -----------------------------------------------------------------------------
-- **읽기는 멤버 전원, 쓰기는 owner.**
-- §3.9 는 staff 에게 **가격·정산**을 막는다. 알림 설정·담당자 배정·영업시간은 그
-- 둘이 아니지만, **조직 전체의 수신 대상을 바꾸는 일**이라 staff 가 혼자 정할 일이
-- 아니다 — staff 가 `recipient_mode` 를 'specific: 나' 로 바꾸면 대표가 문의를 못
-- 받는다. 그래서 조직 설정은 owner 로 좁힌다.
--
-- **템플릿은 staff 도 만든다.** 문안을 저장하는 것은 응대의 일부이고(staff 가 채팅·
-- 문의를 응대한다 — S4-04·S4-12), 잘못 만들어도 조직의 수신 경로가 바뀌지 않는다.
--
-- **초대는 owner 전용이다.** `vendor_members` INSERT 정책이 owner 전용인데(0005)
-- 초대가 staff 에게 열려 있으면 그 경계를 우회하는 길이 된다.
-- =============================================================================
alter table public.vendor_settings enable row level security;

create policy vendor_settings_select on public.vendor_settings for select to authenticated
  using (public.is_vendor_member(vendor_id));
create policy vendor_settings_insert on public.vendor_settings for insert to authenticated
  with check (public.is_vendor_owner(vendor_id));
create policy vendor_settings_update on public.vendor_settings for update to authenticated
  using (public.is_vendor_owner(vendor_id))
  with check (public.is_vendor_owner(vendor_id));

-- 설정은 지우지 않는다. 되돌리려면 값을 바꾼다.
revoke delete on public.vendor_settings from authenticated, anon;

alter table public.vendor_notification_prefs enable row level security;

create policy vendor_notification_prefs_select on public.vendor_notification_prefs
  for select to authenticated using (public.is_vendor_member(vendor_id));
create policy vendor_notification_prefs_insert on public.vendor_notification_prefs
  for insert to authenticated with check (public.is_vendor_owner(vendor_id));
create policy vendor_notification_prefs_update on public.vendor_notification_prefs
  for update to authenticated
  using (public.is_vendor_owner(vendor_id))
  with check (public.is_vendor_owner(vendor_id));
create policy vendor_notification_prefs_delete on public.vendor_notification_prefs
  for delete to authenticated using (public.is_vendor_owner(vendor_id));

alter table public.vendor_templates enable row level security;

create policy vendor_templates_select on public.vendor_templates
  for select to authenticated using (public.is_vendor_member(vendor_id));
create policy vendor_templates_insert on public.vendor_templates
  for insert to authenticated with check (public.is_vendor_member(vendor_id));
create policy vendor_templates_update on public.vendor_templates
  for update to authenticated
  using (public.is_vendor_member(vendor_id))
  with check (public.is_vendor_member(vendor_id));
create policy vendor_templates_delete on public.vendor_templates
  for delete to authenticated using (public.is_vendor_member(vendor_id));

alter table public.vendor_invites enable row level security;

-- 업체 멤버는 초대 현황을 본다(누구를 불렀는지 staff 도 알아야 한다).
create policy vendor_invites_select_member on public.vendor_invites
  for select to authenticated using (public.is_vendor_member(vendor_id));

-- **초대받은 본인도 본다.** 수락 화면이 "어느 업체가 불렀는가" 를 보여줘야 하는데,
-- 그 사람은 아직 멤버가 아니다. 자기 이메일로 온 것만 열어 준다.
create policy vendor_invites_select_invitee on public.vendor_invites
  for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')));

create policy vendor_invites_insert on public.vendor_invites
  for insert to authenticated with check (public.is_vendor_owner(vendor_id));

-- 거둠(revoke)은 owner, 수락은 본인. 컬럼 권한으로 가른다 — 초대받은 사람이
-- `vendor_role` 을 owner 로 바꿔 수락하면 권한 상승이 된다.
create policy vendor_invites_update_owner on public.vendor_invites
  for update to authenticated
  using (public.is_vendor_owner(vendor_id))
  with check (public.is_vendor_owner(vendor_id));

revoke update on public.vendor_invites from authenticated, anon;
grant update (revoked_at) on public.vendor_invites to authenticated;

comment on policy vendor_invites_select_invitee on public.vendor_invites is
  '초대받은 본인은 아직 멤버가 아니므로 멤버 정책으로는 못 본다. 자기 이메일로 온 초대만 열어 준다 — 수락 화면이 "어느 업체가 불렀는가" 를 보여줘야 한다.';

-- **수락은 서비스롤이 처리한다.** `vendor_members` INSERT 정책이 owner 전용인데
-- (0005) 초대받은 사람은 owner 가 아니다. 토큰·이메일 일치·만료를 서버가 확인한 뒤
-- 멤버 행을 만든다 — §3.9 가 입점 심사에 쓴 "서비스롤 경유" 와 같은 방식이다.
-- 그래서 `accepted_by`·`accepted_at` 도 컬럼 권한에서 빠져 있다(위 grant 참조).

-- =============================================================================
-- 6) 운영 파라미터 (§7.4 — 시간·기한을 코드에 박지 않는다)
-- =============================================================================
insert into public.app_settings (key, value_json, description)
values (
  'vendor_invite.ttl_hours',
  '{"hours": 72}'::jsonb,
  '업체 멤버 초대 링크의 유효 시간(S2-09). 커플 초대(24시간)보다 길다 — 받는 사람이 가입·이메일 확인까지 마쳐야 하기 때문이다. 운영이 배포 없이 조정한다.'
)
on conflict (key) do nothing;

-- =============================================================================
-- 7) 알림 토픽에 `vendor_invite` 추가
-- =============================================================================
-- 0023·0024 가 남긴 규칙 그대로 — 토픽 목록은 이 CHECK 와
-- `lib/core/schemas/notification.ts` **양쪽**에 있으므로 함께 고친다.
-- (`db:rls` 의 정합 검사가 지켜본다.)
alter table public.notifications drop constraint if exists notifications_topic_chk;

alter table public.notifications
  add constraint notifications_topic_chk
  check (
    topic in (
      'dday', 'schedule', 'contract', 'care', 'price_change', 'couple_invite',
      'chat', 'inquiry',
      -- S2-09. 업체 멤버 초대. **가입자에게만 이 행이 생긴다** — 미가입자는
      -- auth.users 에 없어 user_id 를 채울 수 없고, 그 발송 증적은
      -- vendor_invites.sent_at 이 갖는다.
      'vendor_invite'
    )
  );

-- =============================================================================
-- 이 파일이 한 것
--   테이블 4 — vendor_settings · vendor_notification_prefs · vendor_templates ·
--              vendor_invites
--   ENUM 1 — vendor_recipient_mode (라운드로빈 없음 — 주석 3번)
--   UNIQUE 3 — 업체당 설정 1(PK) · 업체·토픽 1 · 업체·종류·이름 1
--            + 부분 유니크 1(살아 있는 초대는 업체·이메일당 하나)
--   CHECK 8 — 영업시간 배열 / 채널 플래그 객체 / 템플릿 종류·이름·payload /
--             초대 이메일 형식 · 수락 짝 · 거둠 배타
--   함수 1 + 트리거 1 — 기본 담당자는 그 업체 구성원이어야 한다
--   정책 13 — 설정 3 · 조직 채널 4 · 템플릿 4 · 초대 4(초대받은 본인 열람 포함)
--   GRANT  vendor_settings DELETE 회수 / vendor_invites UPDATE 를 (revoked_at) 로 좁힘
--          — 수락은 서비스롤이 처리한다(vendor_members INSERT 가 owner 전용이라)
--   인덱스 4 · app_settings 1행 · notifications 토픽 CHECK 교체
--   기존 마이그레이션 파일 수정 없음
-- =============================================================================
