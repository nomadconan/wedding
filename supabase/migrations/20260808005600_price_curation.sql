-- 0056 가격 큐레이션·이상 탐지 (S8-10 · F-A-02 · F-A-14 · §6.4 `/admin/prices` · §5.7)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 참가격 표의 권한 감사 (FIX-30·35·36·37 이 가르친 것)
-- ══════════════════════════════════════════════════════════════════════════
--
-- 네 번 연속 같은 모양이었다 — **RLS 정책은 맞았는데 그 아래 권한이 열려 있었다.**
-- 그래서 이번에는 표를 만지기 전에 먼저 봤다.
--
--   `price_index`    쓰기 정책 없음(RLS 가 막는다) · **그러나 authenticated 에
--                    INSERT·UPDATE·DELETE 권한이 열려 있다**
--   `price_sources`  **정책이 하나도 없다**(아무도 못 읽는다) · 쓰기 권한은 열려 있다
--
-- 지금은 정책이 없어 실제로 막힌다(직접 확인했다 — 업체 세션으로 `price_index` INSERT 는
-- `violates row-level security policy` 로 끊긴다). **그러나 이 표에 정책을 하나 더하는
-- 날 그 권한이 함께 살아난다.** 그리고 이 태스크가 바로 `price_sources` 에 정책을
-- 더하는 태스크다 — 열린 권한을 남겨 둔 채 정책을 더하면 그것이 곧 구멍이다.
--
-- **참가격은 이 서비스의 핵심 가치다**(§7.7 · D-03 — 광고를 받지 않는 대신 가격으로
-- 신뢰를 산다). 업체가 자기 손으로 지수를 밀어 올리거나 남의 표본을 지울 수 있으면
-- 그 가치가 통째로 무너진다.
revoke insert, update, delete on public.price_index from anon, authenticated;
revoke insert, update, delete on public.price_sources from anon, authenticated;

-- **원천 표는 운영자만 본다.** `price_index`(사분위·표본수)는 공개지만
-- `price_sources` 는 **개별 금액**이 줄줄이 들어 있다 — 표본 하한이 5곳이라
-- 다섯 줄을 다 보면 특정 업체의 등록가를 역산할 수 있다(S2-08 이 `pricePositionBp`
-- 에서 막은 것과 같은 위험). 소비자 API 는 `price_index` 만 읽으므로 잃는 것이 없다.
revoke select on public.price_sources from anon;

-- ── 운영자 열람 (D-115·D-120) ───────────────────────────────────────────────
-- F-A-02 는 **원천 데이터를 한 줄씩 검증**하는 일이라 행이 목적이고, 운영자에게는
-- 보여 줘야 하는 값이다. 그래서 집계 함수가 아니라 정책이다.
create policy price_sources_select_operator
  on public.price_sources
  for select
  using (public.is_operator());

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 지워진 값은 **왜 지워졌는지 답할 수 있어야 한다** (F-A-02)
-- ══════════════════════════════════════════════════════════════════════════
--
-- `excluded_reason`·`verified_by` 컬럼은 T-03 부터 있었지만 **아무 제약이 없었다** —
-- 사유 없이 제외하거나, 누가 제외했는지 없이 제외할 수 있었다. 참가격에서 표본 하나를
-- 빼는 것은 지수를 움직이는 일이라 **그 자체가 조율 행위**다(D-24 와 같은 결).
--
-- **허용 상태를 나열한다.** "제외가 아니면 …" 같은 부정형으로 쓰면 값이 늘 때마다
-- 뜻이 조용히 바뀐다(S8-03 이 `disputes_resolution_chk` 에서 물린 자리).
alter table public.price_sources
  drop constraint if exists price_sources_exclusion_chk;
alter table public.price_sources
  add constraint price_sources_exclusion_chk
  check (
    -- (가) 포함된 표본: 제외 사유도 검증자도 없다.
    (excluded_reason is null and verified_by is null)
    -- (나) 검증만 한 표본: 누가 봤는지만 남는다.
    or (excluded_reason is null and verified_by is not null)
    -- (다) 제외한 표본: **사유와 검증자가 둘 다** 있어야 한다.
    or (
      nullif(btrim(excluded_reason), '') is not null
      and verified_by is not null
    )
  );

comment on column public.price_sources.excluded_reason is
  'S8-10. 제외 사유. 있으면 그 표본은 지수 계산에서 빠진다. 빈 문자열은 사유가 아니다(CHECK).';
comment on column public.price_sources.verified_by is
  'S8-10. 검증·제외한 운영자. 제외에는 반드시 있다(CHECK).';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 어휘를 DB 가 강제한다
-- ══════════════════════════════════════════════════════════════════════════
--
-- `source_type` 의 어휘는 `lib/core/pricing/price-index.ts` 의
-- `PRICE_INDEX_SOURCE_TYPES` 가 갖고 있는데 **표는 그것을 강제하지 않았다** —
-- 오타가 들어가면 오류 없이 저장되고 화면이 출처를 못 읽는다(FIX-33 과 같은 모양).
--
-- **허용 값을 나열한다.** 구간(`guest_bucket`·`season`)에는 CHECK 을 걸지 않는다 —
-- 지금 값은 `all` 하나뿐이고(등록 판매가에는 예식일도 하객수도 없다) 앞으로 어떤
-- 구간으로 나눌지는 실거래가가 쌓인 뒤의 일이다. **없는 어휘를 지금 지어내지 않는다.**
alter table public.price_index drop constraint if exists price_index_source_type_vocab;
alter table public.price_index
  add constraint price_index_source_type_vocab
  check (source_type is null or source_type = any (array['registered_price', 'transaction']));

-- ══════════════════════════════════════════════════════════════════════════
-- 4. 이상 탐지 임계값은 **미결이다** (O-19 신설)
-- ══════════════════════════════════════════════════════════════════════════
--
-- §5.7 은 임계값을 적어 두었지만 **본문이 스스로 "(가정)" 이라 밝히고** "임계값은
-- app_settings 로 관리하여 데이터 축적 후 조정한다" 고 이어 쓴다. 즉 그 숫자는
-- 명세가 정한 값이 아니라 **자리표시**다.
--
-- **값을 비워 둔다.** 지금 `price_index` 는 표본이 대부분 부족해 사분위 자체가 없고,
-- 그 위에서 "-40% 면 미끼" 를 돌리면 **없는 기준으로 업체를 의심 목록에 올리는 일**이
-- 된다. 그것은 광고를 받지 않는 대신 공정함으로 신뢰를 사는 구조(D-03)에서 가장
-- 하면 안 되는 종류의 실수다.
--
-- 값이 없으면 **탐지하지 않고 화면이 그 사실을 말한다**(O-15·O-18 과 같은 규칙).
insert into public.app_settings (key, value_json, description)
values
  (
    'pricing.bait_gap_bp',
    '{"unit": "bp", "value": null, "status": "undecided", "openIssue": "O-19"}'::jsonb,
    'TODO: O-19 확정 후 입력 — 미끼 의심 임계(bp). 등록가가 지수 중앙값 대비 이만큼 낮고 성사 건이 없으면 큐에 올린다. §5.7 의 40% 는 본문이 "(가정)" 이라 밝힌 자리표시이며 표본이 쌓인 뒤 정한다. 값이 없으면 탐지하지 않는다.'
  ),
  (
    'pricing.addon_excess_bp',
    '{"unit": "bp", "value": null, "status": "undecided", "openIssue": "O-19"}'::jsonb,
    'TODO: O-19 확정 후 입력 — 추가금 과다 임계(bp). 계약 총액이 견적 총액 대비 이만큼 넘으면 큐에 올린다. §5.7 의 25% 는 "(가정)" 이다. 값이 없으면 탐지하지 않는다.'
  )
on conflict (key) do nothing;

-- ══════════════════════════════════════════════════════════════════════════
-- 5. 배치 이력 표도 같은 감사를 받는다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 이 태스크가 `job_runs` 에 두 배치를 더하면서 함께 봤다.
--
--   · `authenticated` 에 **INSERT·UPDATE·DELETE 가 열려 있었다.** 지금은 쓰기 정책이
--     없어 RLS 가 막지만, S8-04 가 SELECT 정책을 더한 표라 **정책이 이미 하나 있다** —
--     다음 사람이 쓰기 정책을 더하는 날 이 권한이 함께 살아난다. 배치 이력이 고쳐질 수
--     있으면 "언제 무엇이 돌았나" 가 증거가 못 된다.
--   · `status` 에 **CHECK 이 없었다.** 어휘는 코드에만 있어(running·succeeded·failed·
--     skipped) 오타가 그대로 저장되고 화면이 그 실행을 못 읽는다(FIX-33 과 같은 모양).
revoke insert, update, delete on public.job_runs from anon, authenticated;
revoke select on public.job_runs from anon;

-- **허용 값을 나열한다.** "실패가 아니면 성공" 같은 부정형으로 쓰면 값이 늘 때마다
-- 뜻이 조용히 바뀐다(S8-03 이 물린 자리).
--
-- `skipped` 를 어휘에 넣은 이유: **막힌 실행을 성공으로 적으면 안 된다.** 이상 탐지가
-- 임계값 미결로 돌지 못했을 때 `succeeded / 0건` 으로 남기면 이력을 보는 사람이
-- "돌았고 이상 없었다" 로 읽는다 — 실제로는 **보지 않은 것**이다.
alter table public.job_runs drop constraint if exists job_runs_status_vocab;
alter table public.job_runs
  add constraint job_runs_status_vocab
  check (status = any (array['running', 'succeeded', 'failed', 'skipped']));

-- ══════════════════════════════════════════════════════════════════════════
-- 6. 새 표를 만들지 않았다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **이상 탐지 큐를 표로 저장하지 않는다.** 플래그는 `products`(등록가)와
-- `price_index`(사분위)에서 **계산되는 값**이고, 계산 가능한 값을 저장하면 원본이
-- 바뀔 때 큐가 낡는다(공통 제약). `price-anomaly-scan` 배치는 큐를 세어 `job_runs` 에
-- 남기고, 화면은 볼 때마다 같은 순수 함수로 다시 센다 — **배치와 화면이 같은 답을 낸다.**
--
-- 그래서 TRUNCATE 회수·default privileges 는 확인만 한다(0053 이 전역으로 걸었고
-- `db:rls` 가 매번 다시 센다).
