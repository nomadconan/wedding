-- 0061 룰·프롬프트 콘솔 (S8-06 · F-A-03 · §6.4 `/admin/rules` · §4.3 `CRUD /api/admin/rules`)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 표를 만지기 전에 권한부터 봤다 — 층이 둘이다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 여덟 번째다. 앞선 일곱이 가르친 것을 두 층으로 나눠 본다.
--
-- ── 층 1: 정책 아래의 권한 (FIX-30·35·36·37·39) ────────────────────────────
--
--   `detect_rules`     정책이 **하나도 없다**(0005 [43] — 서비스롤 전용).
--   `prompt_versions`  정책이 **하나도 없다**(0005 [53] — 서비스롤 전용).
--   `penalty_rules`    정책이 **하나도 없다**(0005 [44]).
--
-- 셋 다 `authenticated` 에 **INSERT·UPDATE·DELETE 가 열려 있다.** 오늘은 정책이 없어
-- RLS 가 막지만, **이 태스크가 바로 운영자 SELECT 정책을 더하는 태스크다** — S8-07 이
-- `ai_call_logs` 에서, S8-10 이 `price_sources` 에서 만난 자리와 같고, 처리 순서도 같다:
-- **정책을 더하기 전에 권한을 먼저 걷는다.**
--
-- **여기가 특히 나쁜 이유.** 검출 룰은 계약서 분석의 판단 기준이다. 아무나 룰을
-- 끄거나 지시문을 바꿀 수 있으면 **리포트가 무엇을 근거로 나왔는지 답할 수 없고**,
-- 룰을 전부 지우면 분석이 "위험 없음" 을 내는 것이 아니라 **아예 서지 않는다**
-- (S7-01 이 그렇게 정했다 — "위험 없음" 과 "아무것도 보지 않았다" 는 화면에서
-- 구분되지 않는다). `penalty_rules` 는 더 직접적이다: 위약금 밴드가 곧 금액이다.
revoke insert, update, delete on public.detect_rules from anon, authenticated;
revoke insert, update, delete on public.prompt_versions from anon, authenticated;
revoke insert, update, delete on public.penalty_rules from anon, authenticated;

-- **비로그인에게 열 이유가 없다.** `prompt_fragment` 는 내부 자산이고(0005 [43] 주석)
-- `system_prompt` 는 프롬프트 본문 그대로다. 소비자 화면은 이 표들을 읽지 않는다 —
-- 리포트는 서버가 만들어 `findings` 로 내려준다.
revoke select on public.detect_rules from anon;
revoke select on public.prompt_versions from anon;
revoke select on public.penalty_rules from anon;

-- ── 층 2: 정책이 다른 표의 정책에 기대는가 (FIX-41) ────────────────────────
--
-- 아래에서 만드는 정책 셋은 전부 `is_operator()` 하나로 **자기 조건을 스스로 말한다.**
-- `exists (select 1 from <부모>)` 모양이 아니다 — 세 표 모두 부모가 없는 독립 표이며,
-- 자식으로 매달린 표도 없다(`findings.rule_code` 는 FK 가 아니라 문자열이다. 그것이
-- 의도다: 룰이 사라져도 이미 나간 리포트의 근거 표기는 남아야 한다).

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 어휘·형식을 DB 가 강제한다 — CHECK 이 하나도 없었다
-- ══════════════════════════════════════════════════════════════════════════
--
-- `detect_rules` 와 `prompt_versions` 에 **CHECK 이 단 하나도 없다.** 두 표 다 코드가
-- 어휘를 갖고 있는데 표는 그것을 모른다 — FIX-33 과 같은 모양이며, 여기서는 값이
-- 틀려도 **리포트가 조용히 다른 근거로 나온다.**
--
-- **허용 값을 나열한다.** 부정형으로 쓰면 값이 늘 때마다 뜻이 조용히 바뀐다.

-- 룰 코드 형식. `lib/core/rules/detect-rules.ts` 가 'R-01'~'R-20' 을 쓰고
-- `mergeDetectRules` 가 **코드에 없는 code 는 실행하지 않는다**(정규식이 없다).
-- 형식이 어긋난 행은 그래서 영원히 `unknownInDatabase` 로만 남는다 — 만들 수 없게 한다.
alter table public.detect_rules drop constraint if exists detect_rules_code_format_chk;
alter table public.detect_rules
  add constraint detect_rules_code_format_chk
  check (code ~ '^R-[0-9]{2}$');

-- 판본은 비어 있을 수 없다. 판본이 없으면 **코드와 DB 가 어긋났는지 알 수 없고**,
-- 그 대조가 `db:rls` 가 매번 하는 일이다(S7-01).
alter table public.detect_rules drop constraint if exists detect_rules_version_chk;
alter table public.detect_rules
  add constraint detect_rules_version_chk
  check (nullif(btrim(version), '') is not null);

alter table public.detect_rules drop constraint if exists detect_rules_title_chk;
alter table public.detect_rules
  add constraint detect_rules_title_chk
  check (nullif(btrim(title), '') is not null);

alter table public.prompt_versions drop constraint if exists prompt_versions_version_chk;
alter table public.prompt_versions
  add constraint prompt_versions_version_chk
  check (nullif(btrim(version), '') is not null);

-- **자기 자신을 롤백 대상으로 삼을 수 없다.** 자기참조 FK 는 그것을 막지 않는다.
alter table public.prompt_versions drop constraint if exists prompt_versions_rollback_self_chk;
alter table public.prompt_versions
  add constraint prompt_versions_rollback_self_chk
  check (rollback_of is null or rollback_of <> id);

comment on column public.detect_rules.pattern_json is
  'S8-06. **화면에서도 API 에서도 고치지 않는다.** 정규식은 lib/core/rules 가 갖고(실행 주체) 이 칸은 참고용 사본이다 — 운영자가 한 글자 잘못 적으면 스캔이 통째로 멈추거나(SyntaxError) 특정 문서에서 되돌아오지 않는다(파국적 백트래킹). S7-01 이 정한 경계다.';

comment on column public.detect_rules.is_active is
  'S8-06. 운영자 자산 — 콘솔에서 켜고 끈다. **전부 끄면 분석이 "위험 없음" 을 내는 것이 아니라 아예 서지 않는다**(S7-01 · RULE_SET_EMPTY_MESSAGE).';

comment on column public.prompt_versions.system_prompt is
  'S8-06. **배포 이력 표는 지금 비어 있고 이 태스크가 채우지 않는다.** 프롬프트 본문은 코드가 갖고(lib/core/{ai,report,search}/prompt.ts) "어느 판본이 언제부터 돌았나" 는 ai_call_logs 에서 계산된다 — 계산 가능한 값을 저장하지 않는다(D-124). 이 표를 쓰려면 배포 파이프라인이 먼저 있어야 한다(O-22).';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 운영자 열람 — **행이 목적이라 정책이다** (D-115)
-- ══════════════════════════════════════════════════════════════════════════
--
-- F-A-03 은 "어떤 룰이 도는가" 를 한 줄씩 보는 일이다. 합계가 아니라 행이 목적이므로
-- SECURITY DEFINER 함수가 아니라 정책이다(S8-01 이 지표에서, S8-02 가 감사 로그에서
-- 나눈 갈림길과 같다).
--
-- **`prompt_fragment` 를 운영자에게 연다.** 그것이 이 콘솔에서 고칠 수 있는 값이고,
-- 내부 자산이지만 운영자는 내부다. 소비자·업체·비로그인에게는 위에서 이미 닫았다.
create policy detect_rules_select_operator on public.detect_rules for select to authenticated
  using (public.is_operator());

create policy prompt_versions_select_operator on public.prompt_versions for select to authenticated
  using (public.is_operator());

-- 위약금 밴드도 같은 화면에서 읽는다 — 룰과 함께 "지금 무엇이 판단 기준인가" 이며,
-- 밴드는 **시드를 넣지 않기로 한 표**라(가정치가 운영 기준처럼 굳는다 · S5-08)
-- 비어 있다는 사실 자체를 운영자가 봐야 한다.
create policy penalty_rules_select_operator on public.penalty_rules for select to authenticated
  using (public.is_operator());

-- **쓰기 정책은 만들지 않는다.** 켬/끔·지시문·근거 수정은 전부 서비스롤 경유다(D-62) —
-- 운영자에게 UPDATE 를 주면 컬럼 권한이 역할 단위라 **`pattern_json`·`code` 까지 열린다**
-- (S8-11 이 후기에서 만난 것과 같은 제약). 라우트가 만질 칸을 코드로 나열한다.

-- ══════════════════════════════════════════════════════════════════════════
-- 4. 새 표를 만들지 않았다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **룰 변경 이력을 표로 만들지 않는다.** 운영자 조치는 이미 `entity_events`(전이)와
-- `audit_logs`(근거 event id)에 남는다(§7.2) — 세 번째 사본을 만들면 어느 것이
-- 이력인지 갈린다. S8-08 의 `content_revisions` 와 다른 판단인 이유: 그쪽은 **본문을
-- 덮어써서 이전 판본을 다시 셀 수 없었고**, 여기서 바뀌는 것은 켬/끔 같은 **짧은 값**
-- 이라 `audit_logs.before_json`/`after_json` 이 그대로 담는다.
--
-- **'지금 무엇이 도는가' 도 저장하지 않는다.** 판본별 첫 호출·마지막 호출·건수는
-- `ai_call_logs` 에서 세어진다(S8-07 이 계측을 붙였다) — 계산 가능한 값을 저장하지
-- 않는다(D-124).

-- TRUNCATE 는 0053 이 전역으로 걷었고 default privileges 까지 덮어 두었지만 매번 다시
-- 센다 — 기본값에 기대는 검사는 기본값이 바뀌는 날 조용히 무력해진다(FIX-35).
revoke truncate on public.detect_rules, public.prompt_versions, public.penalty_rules
  from anon, authenticated;
