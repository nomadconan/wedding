-- 0055 분쟁 조율 콘솔 (S8-03 · F-A-12 · F-A-16 · 명세서 §6.4 `/admin/disputes` · §4.3)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 당사자가 **플랫폼의 조율 결론을 위조**할 수 없게 한다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **이 태스크가 발견한 것(함정 6 · 네 번째).** `disputes_insert` 정책은 `raised_by` 와
-- 예약 소속만 보고 `status`·`resolution_json` 은 보지 않았다. 그래서:
--
--   set local role authenticated;   -- 예약 당사자(커플 또는 업체)
--   insert into public.disputes(booking_id, raised_by, reason_code, status, resolution_json)
--     values (..., 'no_show', 'resolved',
--             '{"decision":"full_refund","fault":"vendor"}');   -- 성공
--
-- 앞선 셋(FIX-30·35·36)보다 나쁘다. 그것들은 **기록을 감추거나 지우는** 것이었지만
-- 이것은 **없던 결론을 만들어 낸다** — 플랫폼이 전액 환불을 결정하고 업체에 귀책을
-- 물었다는 기록이 증적에 남는다. D-24 는 플랫폼을 **조율자**로 규정하는데, 위조된
-- `resolution_json` 은 **플랫폼이 취한 적 없는 입장**이다. 게다가 `status='resolved'`
-- 로 들어온 건은 **운영자 큐에 뜨지 않아** 아무도 그것을 보지 못한다.
--
-- **표에서 걷고 필요한 칸만 다시 준다.** 컬럼 권한은 표 권한을 줄이지 못한다(FIX-36 에서
-- 물린 것과 같다).

-- ── 조율 기록 컬럼 ──────────────────────────────────────────────────────────
-- 다른 세 경로(`consultation_deposits`·`contract_cancellations`·`escrow_holds`)가 이미
-- 쓰는 이름을 그대로 쓴다. 같은 뜻에 다른 이름을 붙이면 콘솔이 넷을 한 줄로 세울 때
-- 매핑 표가 하나 더 생긴다.
alter table public.disputes
  add column if not exists proposal_note text,
  add column if not exists resolution_note text,
  add column if not exists resolved_by uuid references auth.users (id) on delete set null,
  add column if not exists resolved_at timestamptz,
  add column if not exists couple_agreed boolean not null default false,
  add column if not exists vendor_agreed boolean not null default false;

comment on column public.disputes.proposal_note is
  'S8-03. 운영자가 제시한 조율안. 판정이 아니라 제안이다(D-24).';
comment on column public.disputes.resolution_note is
  'S8-03. 종결 사유. agreed·unresolved·withdrawn 에는 필수다.';
comment on column public.disputes.couple_agreed is
  'S8-03. 커플 측 합의 여부를 운영자가 기록한 값. 플랫폼의 판정이 아니다.';

-- ── 상태 어휘 ───────────────────────────────────────────────────────────────
-- `disputes` 에는 **CHECK 이 하나도 없었다** — `status` 도 `reason_code` 도 자유 문자열이라
-- 오타가 그대로 저장되고 큐가 그 행을 영영 못 찾는다.
--
-- **`unresolved` 를 둔 이유.** 합의가 안 되는 건이 반드시 있는데, 그때 플랫폼이
-- 무엇을 하는지는 **약관 소관**이다(§7.7 · O-03). 코드가 '기각'·'플랫폼 결정' 같은
-- 결론을 만들면 그것이 곧 약관이 된다. 그래서 상태는 **"여기서 우리 몫은 끝났다"**
-- 까지만 말하고 다음 절차는 적지 않는다.
alter table public.disputes drop constraint if exists disputes_status_vocab;
alter table public.disputes
  add constraint disputes_status_vocab
  check (status = any (array['open', 'mediating', 'agreed', 'unresolved', 'withdrawn']));

alter table public.disputes drop constraint if exists disputes_reason_vocab;
alter table public.disputes
  add constraint disputes_reason_vocab
  check (reason_code = any (array[
    'no_show', 'quality', 'schedule', 'refund', 'contract_terms', 'payment', 'other'
  ]));

-- 종결에는 사유와 처리자가 붙는다(S7-17 · S8-04 와 같은 규칙).
-- **`withdrawn` 도 예외가 아니다** — '조치 없음' 도 설명해야 한다.
--
-- **종결 상태를 이름으로 적는다.** 처음엔 `status = any (array['open','mediating']) or ...`
-- 로 썼는데, 그러면 **어휘에 없는 값**(오타)도 "종결" 로 취급돼 이 CHECK 이 먼저 걸린다.
-- 그러면 어휘 CHECK 이 도는지 확인할 수 없고(실제로 검사 하나가 그렇게 어긋났다),
-- 무엇보다 오류 메시지가 "사유가 없다" 라고 거짓말한다 — 진짜 문제는 상태 오타다.
alter table public.disputes drop constraint if exists disputes_resolution_chk;
alter table public.disputes
  add constraint disputes_resolution_chk
  check (
    status <> all (array['agreed', 'unresolved', 'withdrawn'])
    or (
      nullif(btrim(coalesce(resolution_note, '')), '') is not null
      and resolved_by is not null
      and resolved_at is not null
    )
  );

-- **합의는 양측이 다 해야 합의다.** 한쪽만 끄덕인 것을 `agreed` 로 적으면 그 기록이
-- 나중에 "합의했잖아요" 의 근거로 쓰인다.
alter table public.disputes drop constraint if exists disputes_agreed_chk;
alter table public.disputes
  add constraint disputes_agreed_chk
  check (status <> 'agreed' or (couple_agreed and vendor_agreed));

-- ── 권한 (함정 6) ───────────────────────────────────────────────────────────
-- 당사자가 넣을 수 있는 것은 **무엇에 대해 · 누가 · 왜 · 증빙** 까지다.
-- 상태·조율안·종결·합의 여부는 서버(서비스롤)만 쓴다.
revoke insert on public.disputes from anon, authenticated;
grant insert (booking_id, raised_by, reason_code, evidence_paths)
  on public.disputes to authenticated;

-- 접수한 뒤에는 당사자가 고칠 수 없다. 증빙을 더하는 경로가 필요해지면 그때
-- **서버 라우트로** 연다 — 표를 열어 두는 것과 다르다.
revoke update, delete on public.disputes from anon, authenticated;

-- ── 같은 구멍이 옆 표에도 있었다 ────────────────────────────────────────────
-- 셋 다 UPDATE·DELETE 정책이 없어 지금은 RLS 가 막지만 **권한은 열려 있었다.**
-- 정책을 누가 잘못 고치는 날 함께 살아난다(0053·0054 가 배운 것과 같다).
revoke insert, update, delete on public.escrow_holds from anon, authenticated;
revoke insert, update, delete on public.consultation_deposits from anon, authenticated;
revoke update, delete on public.contract_cancellations from anon, authenticated;

-- `contract_cancellations` 의 INSERT 는 남긴다 — 해지 요청은 당사자가 넣는다(S5-06).
-- 다만 **판정 칸은 주지 않는다.** 표에서 걷고 접수에 필요한 칸만 다시 준다.
revoke insert on public.contract_cancellations from anon, authenticated;
grant insert (
  contract_id, booking_id, requested_by, requester_side, reason_code, reason_note
) on public.contract_cancellations to authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 운영자가 네 출처를 **읽는다**
-- ══════════════════════════════════════════════════════════════════════════
--
-- **행이 목적이고 보여 줘도 되는 표**라 RLS 정책이다(D-115·D-120).
-- `escrow_holds`·`contract_cancellations` 는 이미 운영자 정책을 갖고 있고,
-- 나머지 둘에 같은 것을 더한다.
create policy disputes_select_operator
  on public.disputes
  for select
  using (public.is_operator());

create policy consultation_deposits_select_operator
  on public.consultation_deposits
  for select
  using (public.is_operator());

-- **운영자에게 UPDATE 정책을 주지 않는다**(D-62). 환불·몰취·정산 조정은 되돌릴 수
-- 없는 집행이라 클라이언트 번들이 닿는 자리에 그 권한을 두지 않는다. 변경은 전부
-- 서비스롤 경유이며, **집행 로직은 각 도메인이 이미 가진 것을 그대로 쓴다**
-- (`resolveEscrow`·`applyVerdict`·`resolveCancellation`) — 큐만 하나로 모은다(D-121).

-- ── 큐 인덱스 ───────────────────────────────────────────────────────────────
-- 열린 건만 자주 읽는다. 부분 인덱스로 좁힌다(0025 가 보증금에 건 것과 같은 모양).
create index if not exists idx_disputes_open
  on public.disputes (created_at)
  where status = any (array['open', 'mediating']);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 새 표를 만들지 않았다 (FIX-35 확인)
-- ══════════════════════════════════════════════════════════════════════════
-- 0053 의 `alter default privileges ... revoke truncate` 가 이후 표를 자동으로 막는다.
-- 이 마이그레이션은 표를 더하지 않아 확인만 하며, `db:rls` 가 매번 다시 센다.
