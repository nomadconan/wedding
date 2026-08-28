-- 0059 AI 품질·비용 관리 (S8-07 · F-A-04 · §5.8 · §6.4 `/admin/ai-quality`)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 표를 만지기 전에 권한부터 봤다 (FIX-30·35·36·37·39 가 가르친 것)
-- ══════════════════════════════════════════════════════════════════════════
--
-- 여섯 번째다. 이번에는 **아직 터지지 않은 자리**를 걷는다.
--
--   `ai_call_logs`      정책이 **하나도 없다**(0005 [52] — 서비스롤 전용). 그래서 지금은
--                       RLS 가 막는다. **그런데 이 태스크가 바로 운영자 SELECT 정책을
--                       더하는 태스크다** — 정책이 하나 생기는 순간 아래의 열린
--                       INSERT·UPDATE·DELETE 가 함께 살아난다. S8-10 이 `price_sources`
--                       에서 똑같이 만난 자리이며, 그때와 같은 순서로 처리한다:
--                       **정책을 더하기 전에 권한을 먼저 걷는다.**
--
--   `document_analyses` `findings` SELECT 정책만 있고 쓰기 권한은 열려 있다.
--                       여기가 더 나쁘다 — `findings.citation_verified` 는 **인용 대조를
--                       통과했다는 표시**이고(§5.2 7단계) 그 칸이 열려 있으면 당사자가
--                       **폐기됐어야 할 finding 을 '검증됨' 으로 바꿀 수 있다**.
--                       리포트는 업체와의 협상에 쓰이는 문서라, 근거 없는 high 판정을
--                       스스로 만들 수 있으면 그 리포트는 증거가 못 된다.
--                       `risk_score` 도 같다(당사자가 위험 점수를 올릴 수 있다).
--
-- **FIX-39 와 같은 층위이되 방향이 반대다.** 저쪽은 남의 평판을 만드는 것이었고
-- 이쪽은 **우리 산출물의 신뢰도를 스스로 조작**하는 것이다. 지금은 정책이 없어 막히므로
-- 결함으로 세지 않고 **다음 사람이 정책을 더하는 날을 막는다**.
revoke insert, update, delete on public.ai_call_logs from anon, authenticated;
revoke insert, update, delete on public.document_analyses from anon, authenticated;
revoke insert, update, delete on public.findings from anon, authenticated;
revoke insert, update, delete on public.ai_tool_calls from anon, authenticated;

-- 호출 로그는 **비로그인에게 열 이유가 없다.** 모델명·판본·실패 사유가 줄줄이 들어
-- 있어 우리가 무엇을 어떻게 부르는지가 그대로 드러난다.
revoke select on public.ai_call_logs from anon;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 어휘를 DB 가 강제한다 — `FIX-33` 해소
-- ══════════════════════════════════════════════════════════════════════════
--
-- **`document_analyses.status` 에 CHECK 이 없었다.** 어휘는 `lib/core/report/pipeline.ts`
-- 의 `ANALYSIS_STATUSES` 인데 표가 그것을 강제하지 않아, S8-01 이 집계에서 `succeeded`
-- 로 세는 실수를 했을 때 **오류가 나지 않고 값이 늘 0** 이었다. 같은 함정이 쓰기 쪽에도
-- 있었다 — 오타 상태가 그대로 저장된다. FIX-33 이 담당을 이 태스크로 적어 두었고,
-- **품질 대시보드의 분모가 이 칸**이라 여기서 고치지 않으면 지표가 조용히 틀린다.
--
-- **허용 값을 나열한다.** 부정형으로 쓰면 값이 늘 때마다 뜻이 조용히 바뀐다(S8-03 이 물린 자리).
alter table public.document_analyses drop constraint if exists document_analyses_status_vocab;
alter table public.document_analyses
  add constraint document_analyses_status_vocab
  check (status = any (array['queued', 'running', 'done', 'failed']));

comment on column public.document_analyses.status is
  'S8-07. queued | running | done | failed — lib/core/report/pipeline.ts 의 ANALYSIS_STATUSES 와 같다(db:rls 가 대조한다). FIX-33.';

-- ── 검증 결과 어휘 ──────────────────────────────────────────────────────────
-- `ai_call_logs.validation_result` 는 **실패율의 분자**다(§5.8). 오타가 들어가면
-- "ok 가 아닌 것" 으로 세어져 실패율이 올라가거나, 새 사유가 조용히 섞인다.
-- 어휘는 `lib/core/quality/metrics.ts` 가 갖고 이 CHECK 이 강제한다.
alter table public.ai_call_logs drop constraint if exists ai_call_logs_validation_vocab;
alter table public.ai_call_logs
  add constraint ai_call_logs_validation_vocab
  check (
    validation_result is null
    or validation_result = any (array[
      'ok',              -- 스키마 검증 통과
      'invalid_output',  -- 재시도 후에도 스키마 불일치 (§5.2 — 부분 결과를 내지 않는다)
      'call_failed',     -- 호출 자체가 실패
      'no_key',          -- ANTHROPIC_API_KEY 없음 — 실패가 아니라 **안 부른 것**이다
      'nothing_left',    -- 룰이 이미 다 읽어 모델에 넘길 것이 없었다
      'masking_blocked', -- 마스킹 실패로 호출을 중단했다(§5.2 · CLAUDE.md §5.2)
      'limit_reached'    -- 사용 상한에 막혔다
    ])
  );

comment on column public.ai_call_logs.validation_result is
  'S8-07. 어휘는 lib/core/quality/metrics.ts 의 VALIDATION_RESULTS 와 같다(db:rls 가 대조한다). no_key·nothing_left·limit_reached 는 실패가 아니라 "부르지 않았다" 이며 실패율 분모에서 빠진다.';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 셀 수 없던 것을 셀 수 있게 만든다
-- ══════════════════════════════════════════════════════════════════════════
--
-- §5.8 이 요구하는 넷 중 **둘을 지금 셀 수 없었다.**
--
--   인용 대조 폐기율   "폐기 finding 수 / 생성 시도 수" 인데 **폐기된 finding 은 저장되지
--                      않는다**(개별 폐기 · §5.2 7단계). 유일한 흔적이 `entity_events.memo`
--                      의 `discarded:3` 이라는 **문자열**이었다. 지표를 문자열 파싱으로
--                      만들면 memo 형식을 바꾸는 날 지표가 조용히 0이 된다.
--   건당 AI 비용       토큰은 `document_analyses` 에 있는데 그 표는 **리포트 전용**이라
--                      플래너 호출의 토큰을 담을 자리가 없다.
--
-- **계산 가능한 값을 저장하는 것이 아니다.** 폐기 수는 그 호출이 끝나는 순간 사라지는
-- 사실이고(폐기된 행이 없으므로 나중에 다시 셀 수 없다) 토큰도 마찬가지다.
-- `applied_fee_rate_bp` 스냅샷과 같은 종류다.
alter table public.ai_call_logs
  add column if not exists analysis_id uuid references public.document_analyses (id) on delete set null,
  add column if not exists latency_ms integer check (latency_ms is null or latency_ms >= 0),
  add column if not exists token_in integer check (token_in is null or token_in >= 0),
  add column if not exists token_out integer check (token_out is null or token_out >= 0),
  add column if not exists findings_generated integer check (findings_generated is null or findings_generated >= 0),
  add column if not exists findings_discarded integer check (findings_discarded is null or findings_discarded >= 0);

-- **`on delete set null` 이다.** 분석 행이 사라져도(문서 파기·커플 탈퇴) **품질 이력은
-- 남아야 한다** — "그 주에 폐기율이 왜 튀었나" 는 문서가 사라진 뒤에 묻는 질문이다.
-- 로그에는 문서 내용이 없으므로 남겨도 개인정보가 아니다(§7.3).
comment on column public.ai_call_logs.analysis_id is
  'S8-07. 리포트 호출만 채운다. on delete set null — 분석이 지워져도 품질 이력은 남는다(로그에 문서 내용이 없다).';
comment on column public.ai_call_logs.findings_discarded is
  'S8-07. 인용 대조에서 폐기된 finding 수. **폐기된 행은 저장되지 않으므로 나중에 다시 셀 수 없다** — 계산 가능한 값이 아니라 스냅샷이다.';

create index if not exists idx_ai_call_logs_created on public.ai_call_logs (created_at desc);

-- ── 조건 검색 파서도 AI 호출이다 ────────────────────────────────────────────
-- `lib/ai/search-parse.ts` 는 zod 검증·재시도까지 같은 파이프라인을 타는데
-- `ai_feature` 에 자리가 없어 **아무 데도 안 남았다.** 품질 대시보드가 그 경로를
-- 빼고 실패율을 내면 그 값은 전체를 말하지 않는다.
alter type public.ai_feature add value if not exists 'search';

-- ══════════════════════════════════════════════════════════════════════════
-- 4. 운영자 열람 — **행이 목적이라 정책이다** (D-115)
-- ══════════════════════════════════════════════════════════════════════════
--
-- S8-01 은 지표가 **합계**라 SECURITY DEFINER 함수로 좁혔고, S8-02 는 감사 로그가
-- **행을 읽는 것이 목적**이라 정책을 썼다. 품질 대시보드는 뒤쪽이다 — 실패율이 올랐을
-- 때 운영자가 묻는 것은 "몇 퍼센트냐" 가 아니라 **"어떤 호출이 왜 실패했느냐"** 다.
--
-- 열어도 되는 이유: 이 표에는 **문서 내용도 대화 내용도 없다.** 기능·모델·판본·검증
-- 결과·숫자뿐이다(§7.3 이 그렇게 설계했다).
create policy ai_call_logs_select_operator on public.ai_call_logs for select to authenticated
  using (public.is_operator());

-- 분석 행도 마찬가지다. **`findings` 는 열지 않는다** — 그쪽에는 조항 인용이 들어 있고,
-- 마스킹본이라 해도 운영자가 남의 계약 조항을 통째로 읽을 이유는 없다. 검수 화면은
-- **룰 코드와 인용 대조 결과**만 보면 되고, 그 둘은 이미 셀 수 있는 값으로 있다.
create policy document_analyses_select_operator on public.document_analyses for select to authenticated
  using (public.is_operator());

-- ══════════════════════════════════════════════════════════════════════════
-- 5. 검수 기록 — 저장하지 않으면 없는 일이 된다
-- ══════════════════════════════════════════════════════════════════════════
--
-- F-A-04 는 '생성 리포트 5% 샘플 검수 큐' 를 요구한다. **큐는 계산하고 기록은
-- 저장한다** — 무엇을 검수해야 하는지는 `document_analyses` 와 이 표의 차집합이라
-- 계산되지만(D-124), "누가 언제 무엇을 보고 어떻게 판단했나" 는 저장하지 않으면 사라진다.
create table public.ai_report_reviews (
  id          uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.document_analyses (id) on delete cascade,
  reviewer_id uuid not null references auth.users (id) on delete restrict,
  verdict     text not null,
  note        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- 한 사람이 같은 분석을 두 번 검수하지 않는다. **여러 사람은 볼 수 있다** —
  -- 판단이 갈리는 것 자체가 품질 신호다.
  unique (analysis_id, reviewer_id)
);

-- **어휘가 평가적이어도 되는 유일한 자리다.** D-24 가 금지하는 것은 *업체·사용자에
-- 대한* 판정이고, 여기는 **우리 자신의 산출물**을 우리가 보는 일이다. 그래도 표현은
-- 사실 기술로 둔다 — "틀렸다" 가 아니라 "근거와 맞지 않는다".
alter table public.ai_report_reviews drop constraint if exists ai_report_reviews_verdict_vocab;
alter table public.ai_report_reviews
  add constraint ai_report_reviews_verdict_vocab
  check (verdict = any (array['accurate', 'inaccurate', 'unclear']));

-- **'근거와 맞음' 에도 메모가 필수다.** 조치에는 사유를 요구한다는 규칙에 예외를 두면
-- 검수 기록의 대부분이 빈칸이 되고, 그러면 나중에 "무엇을 보고 통과시켰나" 를 답할 수 없다.
alter table public.ai_report_reviews drop constraint if exists ai_report_reviews_note_chk;
alter table public.ai_report_reviews
  add constraint ai_report_reviews_note_chk
  check (nullif(btrim(note), '') is not null);

create index if not exists idx_ai_report_reviews_analysis on public.ai_report_reviews (analysis_id);
select public.attach_set_updated_at('ai_report_reviews');

alter table public.ai_report_reviews enable row level security;

-- **읽기도 쓰기도 운영자만이다.** 검수는 내부 품질 활동이고, 사용자에게 "당신 리포트가
-- 부정확으로 표시됐다" 를 보여 주는 것은 전혀 다른 결정이라 지금 하지 않는다.
create policy ai_report_reviews_select_operator on public.ai_report_reviews for select to authenticated
  using (public.is_operator());

-- 쓰기 정책을 두지 않는다 — **기록은 서비스롤 경유**(D-62)다. 운영자에게 INSERT 를
-- 주면 `reviewer_id` 를 남의 것으로 적을 수 있고, 검수 기록의 요점이 "누가 봤나" 다.
revoke insert, update, delete on public.ai_report_reviews from anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- 6. 오탐 신고 — **cascade 가 기록을 지운다**
-- ══════════════════════════════════════════════════════════════════════════
--
-- F-A-04 의 '오탐 신고 처리' 다. 여기서 FK 를 어떻게 거는지가 이 표의 전부다.
--
-- `findings` 를 `on delete cascade` 로 걸면 **재분석 한 번에 신고가 전부 사라진다** —
-- `lib/reports/analyze.ts` 는 분석할 때마다 `delete().eq("analysis_id", ...)` 로 finding
-- 을 통째로 지우고 다시 넣는다. 오탐 신고는 "이 룰이 잘못 걸렸다" 는 **품질 신호**이고
-- 그것을 남기려고 만드는 표인데, 그 표가 재분석에 쓸려 나가면 만들 이유가 없다.
--
-- `document_analyses` 쪽도 같다. 그쪽은 `documents` 에 cascade 로 매달려 있고
-- **`documents_delete` 정책은 커플에게 삭제 권한을 준다** — 당사자가 자기 문서를 지우면
-- (정당한 권리다) 오탐 신고까지 함께 사라진다. FIX-39 에서 본 것과 같은 모양이다:
-- **cascade 로 남의 표의 기록을 지울 수 있다.**
--
-- 그래서 **둘 다 `on delete set null` 로 걸고 `rule_code` 를 스냅샷한다.** 원본이
-- 사라져도 "R-07 에 오탐 신고 세 건" 은 남는다. `rule_code` 에는 개인정보가 없다.
create table public.finding_reports (
  id              uuid primary key default gen_random_uuid(),
  finding_id      uuid references public.findings (id) on delete set null,
  analysis_id     uuid references public.document_analyses (id) on delete set null,
  -- 원본이 사라져도 남는 것. 신고가 무엇에 대한 것인지는 이 칸이 답한다.
  rule_code       text not null,
  reporter_id     uuid references auth.users (id) on delete set null,
  reason_code     text not null,
  status          text not null default 'open',
  resolved_by     uuid references auth.users (id) on delete set null,
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on column public.finding_reports.rule_code is
  'S8-07. 스냅샷. finding·analysis 가 사라져도(재분석·문서 삭제) 이 칸이 남아 신고가 무엇에 대한 것인지 답한다. 개인정보가 아니다.';

alter table public.finding_reports drop constraint if exists finding_reports_reason_vocab;
alter table public.finding_reports
  add constraint finding_reports_reason_vocab
  check (reason_code = any (array[
    'not_in_document',  -- 문서에 없는 내용이다
    'wrong_rule',       -- 이 조항에 해당하는 룰이 아니다
    'wrong_severity',   -- 위험도가 실제와 다르다
    'misread'           -- 내용을 잘못 읽었다
  ]));

-- S8-11 이 `review_reports` 에서 정한 것과 같은 규칙이다 — **'받아들이지 않음' 도
-- 사유를 요구한다.** 사유 없는 거절은 처리가 아니라 무시다.
alter table public.finding_reports drop constraint if exists finding_reports_status_chk;
alter table public.finding_reports
  add constraint finding_reports_status_chk
  check (
    (status = 'open' and resolved_by is null and resolved_at is null and resolution_note is null)
    or (
      status = any (array['upheld', 'rejected'])
      and resolved_by is not null
      and resolved_at is not null
      and nullif(btrim(resolution_note), '') is not null
    )
  );

create index if not exists idx_finding_reports_open
  on public.finding_reports (created_at desc) where status = 'open';
create index if not exists idx_finding_reports_rule on public.finding_reports (rule_code);
select public.attach_set_updated_at('finding_reports');

alter table public.finding_reports enable row level security;

-- 신고자는 자기 신고를 본다. 운영자는 전부 본다.
create policy finding_reports_select_reporter on public.finding_reports for select to authenticated
  using (reporter_id = auth.uid());
create policy finding_reports_select_operator on public.finding_reports for select to authenticated
  using (public.is_operator());

-- **접수는 자기 리포트의 finding 에 대해서만.** 남의 finding 을 신고할 수 없다 —
-- 애초에 보이지도 않지만(`findings_select`), 경계는 여기서도 건다.
create policy finding_reports_insert on public.finding_reports for insert to authenticated
  with check (
    reporter_id = auth.uid()
    and exists (
      select 1
      from public.findings f
      join public.document_analyses a on a.id = f.analysis_id
      join public.documents d on d.id = a.document_id
      where f.id = finding_reports.finding_id
        and f.rule_code = finding_reports.rule_code
        and public.is_couple_member(d.couple_id)
    )
  );

-- **접수에 필요한 칸만 준다**(FIX-36 기법 · 함정 6). 표에서 걷고 다시 준다 —
-- `revoke insert (컬럼)` 만으로는 표 권한을 줄이지 못한다.
-- `status`·`resolved_*` 가 목록에 없으므로 **신고자가 자기 신고를 닫을 수 없다.**
revoke insert, update, delete on public.finding_reports from anon, authenticated;
grant insert (finding_id, analysis_id, rule_code, reporter_id, reason_code)
  on public.finding_reports to authenticated;

-- 처리는 서비스롤 경유다(D-62). 운영자에게 UPDATE 정책을 주지 않는다.

-- ══════════════════════════════════════════════════════════════════════════
-- 7. 토큰 단가는 **비워 둔다** (O-21 신설 · D-123 과 같은 규칙)
-- ══════════════════════════════════════════════════════════════════════════
--
-- §5.8 은 '건당 AI 비용 = token_in·token_out × 단가' 라고만 적고 **단가를 말하지
-- 않는다.** 모델별로 다르고 계약·환율에 따라 바뀌는 값이라 코드가 고를 수 있는 종류가
-- 아니다. 지어낸 단가로 낸 금액은 **곧 예산 근거로 쓰이고**, 그때 그 숫자가 어디서
-- 왔는지 아무도 답할 수 없다.
--
-- **값이 없으면 비용을 계산하지 않고 화면·API 가 그 사실을 말한다**(S8-01 이 수수료
-- 수익에서 `undecided` 를 쓴 것과 같다 — 0원은 "비용이 없었다" 로 읽힌다).
insert into public.app_settings (key, value_json, description)
values
  (
    'ai.input_price_per_mtok_krw',
    '{"unit": "KRW per 1M input tokens", "value": null, "status": "undecided", "openIssue": "O-21"}'::jsonb,
    'TODO: O-21 확정 후 입력 — 입력 토큰 100만 개당 원화 단가. 모델·계약·환율에 따라 달라지므로 코드가 고르지 않는다. 값이 없으면 비용을 계산하지 않고 0원으로도 적지 않는다.'
  ),
  (
    'ai.output_price_per_mtok_krw',
    '{"unit": "KRW per 1M output tokens", "value": null, "status": "undecided", "openIssue": "O-21"}'::jsonb,
    'TODO: O-21 확정 후 입력 — 출력 토큰 100만 개당 원화 단가. 입력 단가와 함께 있어야 건당 비용이 성립한다.'
  )
on conflict (key) do nothing;

-- ══════════════════════════════════════════════════════════════════════════
-- 8. 새 표 둘에 대한 마무리 감사
-- ══════════════════════════════════════════════════════════════════════════
--
-- 0053 이 전역으로 TRUNCATE 를 걷고 `alter default privileges` 로 **다음 마이그레이션이
-- 만드는 표까지** 덮어 두었다. 그래도 매번 다시 센다 — 기본값에 기대는 검사는
-- 기본값이 바뀌는 날 조용히 무력해진다(FIX-35 가 가르친 것).
revoke truncate on public.ai_report_reviews, public.finding_reports from anon, authenticated;
revoke select on public.ai_report_reviews, public.finding_reports from anon;

-- ══════════════════════════════════════════════════════════════════════════
-- 9. `FIX-41` — 부모의 RLS 를 빌려 쓰는 정책은 부모가 열리는 날 함께 열린다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 위 4번에서 `document_analyses` 에 운영자 SELECT 정책을 더하자 **`findings` 가 함께
-- 열렸다.** `db:rls` 가 잡았다("운영자에게 findings 는 열지 않았다" 가 실패했다).
--
-- 원인은 정책의 모양이다. 네 표가 전부 이렇게 적혀 있었다:
--
--   findings_select            exists (select 1 from document_analyses a where a.id = …)
--   document_analyses_select   exists (select 1 from documents d           where d.id = …)
--   ai_messages_select         exists (select 1 from ai_conversations c    where c.id = …)
--   ai_tool_calls_select       exists (select 1 from ai_messages m         where m.id = …)
--
-- **소유자를 묻는 조건이 하나도 없다.** 이 정책들이 실제로 막아 온 것은 서브쿼리 안의
-- 표에 걸린 RLS 였다 — "부모가 보이면 자식도 보인다" 는 뜻이다. 사슬로 이어져 있어
-- `documents` 하나가 커플만 보게 막고 나머지 셋이 그것을 물려받는 구조였다.
--
-- 그래서 **부모에 정책을 하나 더하는 날 자식이 통째로 열린다.** 이번이 그 날이었고,
-- 열린 것이 하필 **마스킹된 계약 조항**이었다. 앞선 다섯(FIX-30·35·36·37·39)은
-- "정책은 맞았는데 그 아래 권한이 열려 있었다" 였는데, 이번 것은 **"정책이 다른 표의
-- 정책에 기대고 있었다"** 다 — 층이 다르지만 결과는 같다: 아무도 의도하지 않은 열람.
--
-- **소유자를 명시한다.** 중복처럼 보이지만 그것이 요점이다 — 정책은 자기가 지키려는
-- 것을 스스로 말해야 하고, 그래야 옆 표를 고치는 사람이 이 표를 깨뜨리지 않는다.
drop policy if exists findings_select on public.findings;
create policy findings_select on public.findings for select to authenticated
  using (
    exists (
      select 1
      from public.document_analyses a
      join public.documents d on d.id = a.document_id
      where a.id = findings.analysis_id
        and public.is_couple_member(d.couple_id)
    )
  );

drop policy if exists document_analyses_select on public.document_analyses;
create policy document_analyses_select on public.document_analyses for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = document_analyses.document_id
        and public.is_couple_member(d.couple_id)
    )
  );

drop policy if exists ai_messages_select on public.ai_messages;
create policy ai_messages_select on public.ai_messages for select to authenticated
  using (
    exists (
      select 1 from public.ai_conversations c
      where c.id = ai_messages.conversation_id
        and public.is_couple_member(c.couple_id)
    )
  );

drop policy if exists ai_tool_calls_select on public.ai_tool_calls
;
create policy ai_tool_calls_select on public.ai_tool_calls for select to authenticated
  using (
    exists (
      select 1
      from public.ai_messages m
      join public.ai_conversations c on c.id = m.conversation_id
      where m.id = ai_tool_calls.message_id
        and public.is_couple_member(c.couple_id)
    )
  );

-- **운영자 열람은 `document_analyses` 하나뿐이다**(4번의 정책). 나머지 셋은 열지
-- 않았다 — `findings` 에는 조항 인용이, `ai_messages`·`ai_tool_calls` 에는 대화 본문이
-- 들어 있고, 검수 화면은 **룰 코드와 셀 수 있는 값**만 보면 된다.
