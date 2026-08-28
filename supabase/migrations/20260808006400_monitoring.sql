-- 0064 모니터링·장애 대응 (S8-13 · §7.4 · FIX-32)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 표를 만지기 전에 권한부터 봤다 — `job_runs` 는 이미 잠겨 있다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 열한 번째 감사다. `job_runs` 는 S8-10 이 이미 걷어 뒀다(0056 §5):
--
--   `anon`          권한 없음(SELECT 도 없다)
--   `authenticated` SELECT 만 · 쓰기 없음
--   정책            `job_runs_select_operator`(`is_operator()`) 하나
--   CHECK           `status` 어휘 4종 · `processed_count >= 0`
--
-- **층 2(FIX-41)도 확인했다** — 그 정책은 `is_operator()` 하나로 자기 조건을 스스로
-- 말한다. `exists (select 1 from <부모>)` 모양이 아니고 자식 표도 없다.
--
-- **남은 구멍 하나: `job_name` 에 CHECK 이 없다.** 어휘는 명세 §4.5 와 코드가 갖는데
-- 표는 그것을 모른다 — 오타 난 이름으로 저장되면 **그 실행이 어느 배치의 것인지
-- 알 수 없고**, 모니터링 화면은 그 배치가 "한 번도 안 돌았다" 고 적는다(FIX-33 과
-- 같은 모양이며, 여기서는 그 오해가 곧 장애 대응 실패다).
--
-- **허용 값을 나열한다.** 명세 §4.5 의 배치 이름 그대로이며 `lib/core/ops/monitor.ts`
-- 의 `BATCH_SPECS` 와 같아야 한다 — `db:rls` 가 두 곳을 대조한다.
alter table public.job_runs drop constraint if exists job_runs_name_vocab;
alter table public.job_runs
  add constraint job_runs_name_vocab
  check (job_name = any (array[
    'purge-documents',
    'dday-notifications',
    'price-index-refresh',
    'settlement-aggregate',
    'price-anomaly-scan',
    'sla-escalation',
    'consultation-confirm-request',
    'consultation-resolve',
    'planner-payout-due',
    'wishlist-price-watch'
  ]));

comment on column public.job_runs.job_name is
  'S8-13. 어휘는 명세 §4.5 와 lib/core/ops/monitor.ts 의 BATCH_SPECS 가 갖고 이 CHECK 이 강제한다(db:rls 가 대조). 오타 난 이름은 "어느 배치인지 모르는 실행" 이 되고 화면은 그 배치를 "안 돌았다" 고 적는다.';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. `FIX-32` — 로그인 실패가 서버에 아무 흔적도 남기지 않는다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 로그인 POST 는 **브라우저에서 Supabase 로 직접** 나간다. Route Handler·미들웨어
-- 로그에는 **구조상** 아무것도 남지 않으며, 그것이 `FIX-24`(로그인이 몇 주 동안
-- 막혀 있었다)가 안 잡힌 직접적인 이유다 — 찾던 "서버 로그" 가 원래 없었다.
--
-- ── 어떻게 관측할 것인가 ────────────────────────────────────────────────────
--
-- 두 길이 있었다.
--
--   (가) **로그인을 서버 경유로 바꾼다.** 흔적이 확실히 남지만 Supabase Auth 흐름을
--        통째로 바꾸는 일이고, 쿠키·리프레시·소셜 로그인이 전부 딸려 온다. 관측을
--        위해 인증 경로를 바꾸는 것은 **고치려는 것보다 큰 위험**이다.
--   (나) **클라이언트가 실패를 서버에 알린다.** 채택했다.
--
-- **(나)의 한계를 숨기지 않는다** — 브라우저가 안 보내면(네트워크 실패·JS 차단·
-- 탭 종료) 아무것도 안 남는다. 그래서 이 표의 값은 **"이만큼은 있었다" 이지
-- "이게 전부다" 가 아니며**, 화면이 그 문장을 그대로 적는다.
--
-- ── 비인증 입력을 증적에 섞지 않는다 ────────────────────────────────────────
--
-- 로그인 실패는 **로그인하기 전**의 사건이라 이 경로는 비인증이다. 그래서
-- **`entity_events` 에 쓰지 않는다** — 그쪽은 분쟁의 근거가 되는 증적이고(D-23),
-- 아무나 넣을 수 있는 값을 섞으면 증적 전체의 신뢰가 내려간다. 별도 표에 담는다.
--
-- **식별정보를 담을 자리를 아예 두지 않았다.** 이메일·IP·User-Agent·본문 칸이 없다 —
-- 있으면 언젠가 채워지고, 비인증 경로로 들어온 개인정보는 지울 근거도 주체도 없다.
create table public.client_events (
  id          uuid primary key default gen_random_uuid(),
  -- 무엇에 대한 신호인가. 지금은 로그인 하나이며 늘어날 때 어휘를 넓힌다.
  kind        text not null,
  -- 어느 실패인가. `lib/core/auth/login-error.ts` 의 `LoginErrorCode` 와 같다.
  code        text not null,
  occurred_at timestamptz not null default now()
);

alter table public.client_events drop constraint if exists client_events_kind_vocab;
alter table public.client_events
  add constraint client_events_kind_vocab
  check (kind = any (array['login_failed']));

-- **어휘를 나열한다.** 자유 문자열이면 비인증 경로로 아무 문자열이나 저장된다 —
-- 표가 로그가 아니라 낙서장이 된다.
alter table public.client_events drop constraint if exists client_events_code_vocab;
alter table public.client_events
  add constraint client_events_code_vocab
  check (code = any (array[
    'AUTH_INVALID_CREDENTIALS',
    'AUTH_EMAIL_NOT_CONFIRMED',
    'AUTH_RATE_LIMITED',
    'AUTH_SERVICE_UNAVAILABLE',
    'AUTH_TIMEOUT',
    'AUTH_CONFIG',
    'AUTH_UNKNOWN'
  ]));

create index if not exists idx_client_events_kind_time
  on public.client_events (kind, occurred_at desc);

comment on table public.client_events is
  'S8-13 · FIX-32. 로그인 실패는 브라우저→Supabase 직행이라 서버에 흔적이 없다. 클라이언트가 사유 코드만 보내 남긴다. **식별정보 칸이 없다**(있으면 언젠가 채워진다). 브라우저가 안 보내면 안 남으므로 "이만큼은 있었다" 이지 "이게 전부다" 가 아니다 — 화면이 그 문장을 적는다.';

alter table public.client_events enable row level security;

-- **비인증이 INSERT 한다** — 로그인 전의 사건이라 그렇다. 대신 **두 칸만** 쓸 수 있고
-- (`occurred_at` 은 기본값) 어휘가 CHECK 으로 잠겨 있다.
create policy client_events_insert on public.client_events for insert to anon, authenticated
  with check (true);

-- 읽기는 운영자만. **행이 목적**이다 — 어떤 실패가 몰렸는지 한 줄씩 본다(D-115).
create policy client_events_select_operator on public.client_events for select to authenticated
  using (public.is_operator());

-- **표에서 걷고 필요한 칸만 다시 준다**(FIX-36 이 가르친 것). `id`·`occurred_at` 은
-- 기본값이 채우며, 클라이언트가 시각을 정하면 과거·미래로 로그를 흩뿌릴 수 있다.
revoke insert, update, delete on public.client_events from anon, authenticated;
grant insert (kind, code) on public.client_events to anon, authenticated;
revoke select on public.client_events from anon;
revoke truncate on public.client_events from anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 새 표를 더 만들지 않았다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **경보 표를 만들지 않는다.** §7.4 는 "파기 배치 실패는 즉시 경보" 를 요구하지만
-- **경보는 `job_runs` 와 `documents` 에서 계산되는 값**이다(D-124) — 저장하면 배치가
-- 다시 성공한 뒤에도 경보가 남고, 지우는 규칙을 또 만들어야 한다.
--
-- **발송 이력도 만들지 않는다.** 외부 발송이 스텁이라(D-28) 보내는 시늉을 하면
-- **"경보가 안 온 것" 과 "스텁이라 안 온 것" 이 구분되지 않는다.** 지금 경보는
-- 화면이 보여주는 것까지이며, 그 사실을 화면이 적는다.
--
-- **배치 등록 상태도 저장하지 않는다** — `vercel.json` 이 진실이고 코드가 그것을
-- 선언한다. DB 에 사본을 두면 배포와 갈린다.
