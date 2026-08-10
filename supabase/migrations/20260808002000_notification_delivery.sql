-- =============================================================================
-- 0020 · 알림 발송 증적 · 멱등 (S4-13)
-- 근거: docs/07_개발명세서.md §2.1 F-C-21, §3.7 notifications·notification_prefs,
--       §7.3(증적 최소화), D-23·D-28
-- =============================================================================
-- S4-03(0019)이 **발송·도달·열람·실패 시각**을 만들었다. 여기서는 그 옆에 필요한
-- 세 가지를 더한다 — **같은 알림을 두 번 보내지 않게 하는 열쇠**, **몇 번 시도했는지**,
-- 그리고 **본문 없이 문장을 다시 만드는 데 필요한 참조**다.
--
-- **`dedupe_key` 는 지금까지 없었다.** 브리프는 이미 있다고 적었지만 T-03·0019 어디에도
-- 없다(`types/database.ts` 로 확인). 멱등이 요구사항이므로 여기서 만든다.
--
-- ── 왜 본문을 저장하지 않는가 (§7.3) ────────────────────────────────────────
-- 알림 문장에는 업체명·금액·예식일이 그대로 들어간다. 그것을 남기면 알림함이 곧
-- 개인정보 저장소가 되고, 파기 요청(F-C-23)이 들어와도 지울 곳이 하나 더 늘어난다.
-- 대신 **틀(template_key) + 참조(payload_json) + 해시(body_hash)** 만 남긴다.
-- 화면은 읽을 때마다 다시 만들고, 분쟁에서는 해시로 "그때 문장과 같은가" 를 판정한다.
-- =============================================================================

alter table public.notifications
  -- 같은 알림을 두 번 보내지 않기 위한 열쇠. 배치는 실패하면 다시 도는데, 그때
  -- 어제 것을 또 보내면 사용자는 같은 말을 두 번 듣고 우리는 횟수를 셀 수 없게 된다.
  add column if not exists dedupe_key    text,
  -- 몇 번 시도했는가. 상한(lib/core/schemas/notification.ts MAX_SEND_ATTEMPTS)에 닿으면
  -- 멈추고 실패로 남긴다 — 영구 오류가 큐를 영원히 막지 않게.
  add column if not exists attempt_count integer not null default 0,
  -- 어떤 문장 틀로 만들었는가. 본문 대신 이것을 남긴다.
  add column if not exists template_key  text,
  -- 보낸 시점 본문의 해시. 본문 자체가 아니다.
  add column if not exists body_hash     text;

comment on column public.notifications.dedupe_key is
  '같은 알림의 재발송을 막는 열쇠. 규칙은 lib/core/schemas/notification.ts 의 dedupeKey() 가 갖는다 — 호출부마다 다르게 지으면 중복 판정이 호출부 수만큼 갈린다.';
comment on column public.notifications.attempt_count is
  '발송 시도 횟수. 상한에 닿으면 failed_at 을 남기고 멈춘다.';
comment on column public.notifications.template_key is
  '문장 틀 id. **본문을 저장하지 않는 대신** 이것과 payload_json(참조·숫자만)으로 화면이 다시 만든다(§7.3).';
comment on column public.notifications.body_hash is
  '보낸 시점 본문의 해시. 분쟁에서 "그때 보낸 문장과 지금 만든 문장이 같은가" 를 판정하는 용도이며 본문 자체가 아니다.';

-- **한 사람에게 같은 열쇠의 알림은 하나뿐이다.** 이것이 멱등의 실체다 — 애플리케이션이
-- 확인하고 넣는 방식은 동시에 두 번 들어오면 둘 다 통과한다. DB 가 거절해야 한다.
create unique index if not exists uq_notifications_dedupe
  on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null;

comment on index public.uq_notifications_dedupe is
  '같은 사람에게 같은 열쇠로 두 번 기록되지 않는다(S4-13). 배치 재실행의 안전장치다.';

-- 시도 횟수는 음수가 될 수 없다.
--
-- **`failed_at` 이 있는데 시도 0회인 경우가 정상으로 존재한다** — 수신 설정으로 막힌
-- 알림이다. 발송사를 부른 적이 없으므로 시도 1회로 적으면 재시도 통계가 거짓이 된다.
-- "보내지 않기로 정했다" 도 종료 상태이고 사유가 있으므로 failed_at·failure_reason 이
-- 그것을 담는 자리가 맞다.
alter table public.notifications
  add constraint notifications_attempt_count_chk
  check (attempt_count >= 0);

-- 값 집합. 명세가 채널·토픽을 문장으로만 정했으므로 text + CHECK 다(0001 원칙).
-- 코드의 단일 진실은 `lib/core/schemas/notification.ts` 이고 여기는 그 방어선이다.
alter table public.notifications
  add constraint notifications_channel_chk
  check (channel in ('in_app', 'email', 'sms', 'push'));

alter table public.notifications
  add constraint notifications_topic_chk
  check (topic in ('dday', 'schedule', 'contract', 'care', 'price_change', 'couple_invite'));

alter table public.notification_prefs
  add constraint notification_prefs_topic_chk
  check (topic in ('dday', 'schedule', 'contract', 'care', 'price_change', 'couple_invite'));

alter table public.notification_prefs
  add constraint notification_prefs_flags_is_object_chk
  check (jsonb_typeof(channel_flags) = 'object');

-- 알림함은 안 읽은 것부터 본다. 부분 인덱스로 그 경로만 좁게 잡는다.
create index if not exists idx_notifications_unread
  on public.notifications (user_id, created_at desc)
  where read_at is null;

-- =============================================================================
-- RLS — S4-03 에서 정한 경계를 그대로 둔다
-- -----------------------------------------------------------------------------
-- `notifications` 는 본인 SELECT + `read_at` 컬럼만 UPDATE 다(0019 에서 권한으로 좁혔다).
-- **INSERT 정책은 두지 않는다** — 알림을 만드는 것은 서버(서비스롤)의 일이다. 사용자가
-- 자기 알림을 만들 수 있으면 "안내를 받았다" 는 기록을 스스로 지어낼 수 있다.
--
-- 새로 더한 컬럼(`dedupe_key`·`attempt_count`·`template_key`·`body_hash`)도 같은
-- 경계 안에 있다 — 0019 의 `grant update (read_at)` 이 컬럼을 열거하는 방식이라
-- 컬럼이 늘어도 자동으로 닫혀 있다. 확인 케이스를 `npm run db:rls` 에 넣었다.
--
-- `notification_prefs` 는 본인 CRUD 그대로다(0005). 수신 설정은 사용자의 것이다.
-- =============================================================================

-- =============================================================================
-- 이 파일이 한 것
--   ALTER  notifications +4컬럼(dedupe_key, attempt_count, template_key, body_hash)
--   UNIQUE 인덱스 1 — 사람당 같은 열쇠 하나(멱등)
--   CHECK  5 — 시도 횟수 / 채널·토픽 값 집합 / 수신 설정 토픽·플래그 형태
--   인덱스 1 — 안 읽은 알림 조회 경로
--   신규 테이블·정책 없음
-- =============================================================================
