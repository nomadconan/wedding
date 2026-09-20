-- =============================================================================
-- 0083 · 기한 알림 토픽과 파라미터 (C-4d)
--   근거: 07 §2.1 F-C-21 확장 · §3.7 · §4.5 · §7.4 · B-1 조사 4-6
--
-- ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
-- `dday-notifications` 가 **`tasks` 를 아예 읽지 않았다.** 예식일까지 남은 날만
-- 여덟 번 보내고, 정작 *"청첩장 주문할 때가 됐어요"* 는 아무도 말하지 않았다.
-- 체크리스트는 **무엇을 할지**는 적는데 **언제까지인지를 알려 주지 않았다.**
--
-- ── 토픽을 하나만 더한다 ────────────────────────────────────────────────────
-- 태스크 기한과 상품 주문 기한은 **사용자에게 같은 것**이다 — *"이 날짜까지 해야
-- 한다"*. 다른 것은 어디로 가는가(체크리스트 / 상품 상세)뿐이고 그것은 **템플릿**이
-- 가른다. 토픽은 **끄는 단위**이며 비슷한 항목 둘을 수신 설정에 세우면 사용자가
-- 차이를 설명받아야 한다.
--
-- `dday` 와는 나눈다 — 그쪽은 **예식일 하나**에 대한 안내이고 이쪽은 **항목마다**
-- 온다. 빈도가 달라 따로 끌 수 있어야 한다.
--
-- ── 파라미터는 값을 비운다 ──────────────────────────────────────────────────
-- 사용자는 *"40일이나 35일 이전부터 일정한 간격으로"* 라고 했다 — **정확한 숫자가
-- 아직 정해지지 않았다는 뜻**이며 그것이 운영 파라미터인 이유다.
--   · 값이 **없으면 보내지 않는다.** 0 으로 읽으면 "기한 당일 한 번" 이 되어 조용히
--     다른 정책이 되고, 무제한으로 읽으면 매일 보낸다 — 둘 다 코드가 정책을 대신
--     답한 것이다(D-49 · D-225 와 같은 규칙).
--   · 로컬 데모 값은 `scripts/seed-accounts.mjs` 가 넣는다(AI 상한·요율·리드타임
--     상한과 같은 분리 · S5-03).
--
-- ── 값은 여기서 넣지 않는다 ─────────────────────────────────────────────────
-- `supabase db reset` 은 **마이그레이션을 먼저, `seed.sql` 을 나중에** 적용하므로
-- 여기에 `update` 를 적으면 **빈 표를 훑고 성공**한다(C-2a·C-2f·C-4b 가 밟았다).
-- `seed.sql` 의 app_settings 블록은 `on conflict do nothing` 이라 **이미 있는 DB 에는
-- 새 키가 안 들어간다** — 그래서 키는 마이그레이션이 만든다(0082 와 같은 이유).
--
-- ── 권한은 건드리지 않는다 ──────────────────────────────────────────────────
-- `notifications` 의 UPDATE 는 S4-13 이 **칸 목록 하나**(`read_at`)로 좁혀 뒀다.
-- 칸 목록 방식이라 **새 칸은 자동으로 못 고치는 칸**이 된다(`products` 가 표 단위라
-- 정반대인 것과 대비 · C-2e·C-4b 가 짚은 자리). 이번 회차는 칸을 더하지 않았고,
-- 토픽을 늘려도 그 좁힘은 그대로다 — `db:rls` 가 그 사실을 다시 본다.
-- =============================================================================

-- ── 1. 토픽 어휘 ────────────────────────────────────────────────────────────
-- 두 표가 **같은 목록**을 갖는다. 한쪽만 넓히면 알림은 저장되는데 수신 설정은
-- 저장되지 않아, 사용자가 끈 줄 알고 계속 받게 된다.
alter table public.notifications drop constraint if exists notifications_topic_chk;
alter table public.notifications
  add constraint notifications_topic_chk
  check (topic in (
    'dday', 'schedule', 'contract', 'care', 'price_change', 'couple_invite',
    'chat', 'inquiry', 'vendor_invite', 'payment', 'settlement',
    'task_due'   -- C-4d
  )) not valid;
alter table public.notifications validate constraint notifications_topic_chk;

alter table public.notification_prefs drop constraint if exists notification_prefs_topic_chk;
alter table public.notification_prefs
  add constraint notification_prefs_topic_chk
  check (topic in (
    'dday', 'schedule', 'contract', 'care', 'price_change', 'couple_invite',
    'chat', 'inquiry', 'vendor_invite', 'payment', 'settlement',
    'task_due'   -- C-4d
  )) not valid;
alter table public.notification_prefs validate constraint notification_prefs_topic_chk;

comment on column public.notifications.topic is
  '알림 토픽(§2.1 F-C-21). 어휘는 lib/core/schemas/notification.ts NOTIFICATION_TOPICS 이고 db:rls 가 대조한다. task_due 는 C-4d 가 더했다 — 체크리스트 항목 기한과 상품 주문 기한을 **한 토픽**으로 둔다(사용자에게 둘 다 "이 날짜까지 해야 한다" 이고, 다른 것은 링크뿐이라 템플릿이 가른다).';

-- ── 2. 배치 이름 어휘 ───────────────────────────────────────────────────────
-- **`job_runs.job_name` 에 어휘 CHECK 이 있다.** 새 배치 이름을 여기 넣지 않으면
-- **첫 실행에서 CHECK 에 걸려 실행 기록이 통째로 사라진다** — 배치는 돌았는데
-- 모니터링 화면은 "한 번도 안 돌았다" 고 적는다. CLAUDE.md §7.0 이 적어 둔
-- `settlement-run` / `settlement-aggregate` 사고가 정확히 이 모양이었다.
--
-- `wishlist-price-watch` 는 **라우트가 없는데도 어휘에 있다**(T-00n 이 확인) —
-- 어휘를 지우지 않는 것이 이 표의 관행이라 그대로 둔다.
alter table public.job_runs drop constraint if exists job_runs_name_vocab;
alter table public.job_runs
  add constraint job_runs_name_vocab
  check (job_name in (
    'purge-documents', 'dday-notifications', 'price-index-refresh',
    'settlement-aggregate', 'price-anomaly-scan', 'sla-escalation',
    'consultation-confirm-request', 'consultation-resolve',
    'planner-payout-due', 'escrow-release', 'wishlist-price-watch',
    'task-due-notifications'   -- C-4d
  )) not valid;
alter table public.job_runs validate constraint job_runs_name_vocab;

-- ── 3. 운영 파라미터 — 값을 비운다 ──────────────────────────────────────────
insert into public.app_settings (key, value_json, description) values
  (
    'notify.task_due_lead_days',
    '{"value": null, "unit": "days", "status": "undecided"}'::jsonb,
    'TODO: 운영 정책 확정 후 입력 — 기한 며칠 전부터 알림을 시작하는가(사용자 요청: 40일 또는 35일). **값이 없으면 발송하지 않는다**(C-4d) — 0 으로 읽으면 기한 당일 한 번이 되어 조용히 다른 정책이 된다.'
  ),
  (
    'notify.task_due_interval_days',
    '{"value": null, "unit": "days", "status": "undecided"}'::jsonb,
    'TODO: 운영 정책 확정 후 입력 — 시작 뒤 며칠마다 보내는가. **값이 없으면 발송하지 않는다**(C-4d). 1 미만은 거절한다 — 0 은 "매일" 이 아니라 무한 루프다.'
  )
on conflict (key) do nothing;

-- =============================================================================
-- 이 파일이 한 것
--   CHECK 3 재작성 — notifications.topic · notification_prefs.topic 에 task_due 추가
--                    job_runs.job_name 에 task-due-notifications 추가
--                    (셋 다 not valid → validate · 기존 행은 전부 옛 어휘라 통과한다)
--   파라미터 키 2 — notify.task_due_lead_days · task_due_interval_days (**값 없음**)
--   새 표·새 칸·새 정책·권한 변경 없음
-- =============================================================================
