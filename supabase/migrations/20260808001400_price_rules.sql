-- =============================================================================
-- 0014 · 다이내믹 프라이싱 룰 (S2-06)
-- 근거: docs/07_개발명세서.md §2.2 F-V-06, §3.3 price_rules, §3.9, §6.3
-- =============================================================================
-- 가격은 정산·계약과 직결된다. **같은 입력이면 항상 같은 결과**가 나와야 한다.
-- 그래서 이 파일은 결정성을 흔드는 두 구멍을 막는다.
--
--  1. **적용 순서가 없다.** §3.3 에 `priority` 가 없어 룰이 둘 이상 걸리면 순서가
--     DB 반환 순서에 좌우된다. 순서가 달라지면 결과 금액이 달라진다.
--     → `priority` 컬럼을 더한다(부가 컬럼 확장 — S2-02·S2-03 과 같은 기준).
--     동률일 때의 처리는 `lib/core/pricing/dynamic.ts` 가 **전순서**로 못박는다.
--
--  2. **`adjust_value` 가 numeric 이다.** 소수가 들어오면 반올림 지점이 코드마다
--     달라지고 부동소수점 오차가 금액에 실린다(CLAUDE.md §3.1 — 결정적 계산에
--     부동소수점을 쓰지 않는다). → **정수만** 저장하도록 CHECK 를 건다.
--     컬럼 타입은 명세 그대로 두고 값의 규약만 좁힌다.
--
-- **요율(0006)과 다른 점** 요율은 한 시점에 **하나만** 적용돼야 해서 겹침을 EXCLUDE 로
-- 거부했다. 프라이싱 룰은 **여러 개가 함께 적용되는 것이 정상**이다(시즌 + 주말).
-- 그래서 거부가 아니라 **순서를 못박는 방식**으로 결정성을 얻는다.
-- =============================================================================

alter table public.price_rules
  -- 작은 값이 먼저 적용된다. 기본값 100 은 "특별히 지정하지 않음" 자리다.
  add column if not exists priority  integer not null default 100,
  -- 룰을 지우지 않고 끌 수 있어야 한다. 지워 버리면 무엇을 시험했는지 남지 않는다.
  add column if not exists is_active boolean not null default true;

comment on column public.price_rules.priority is
  '적용 순서. **작을수록 먼저** 적용된다. 동률일 때의 순서는 lib/core/pricing/dynamic.ts 가 전순서로 못박는다(rule_type -> created_at -> id).';
comment on column public.price_rules.is_active is
  '꺼진 룰은 평가 대상이 아니다. 삭제 대신 끄면 무엇을 시험했는지 남는다.';
comment on column public.price_rules.adjust_value is
  '정수만 허용한다. adjust_type=percent_bp 면 basis point(-1000 = -10%), amount_krw 면 원 단위 정수다. 부동소수점을 쓰지 않는다.';

-- 조정 방식의 값 집합을 못박는다. 명세가 값을 정하지 않았으므로 text + CHECK 다(0001 원칙).
alter table public.price_rules
  add constraint price_rules_adjust_type_chk
  check (adjust_type in ('percent_bp', 'amount_krw'));

-- 소수를 막는다. numeric 이라도 값은 항상 정수다.
alter table public.price_rules
  add constraint price_rules_adjust_value_integer_chk
  check (adjust_value = trunc(adjust_value));

-- 비율 조정은 -100% ~ +100% 안에서만 한다. 그 밖은 입력 사고다.
-- (업무 상한이 아니라 스키마 수준 sanity bound 다 — 실제 할인 정책은 업체가 정한다.)
alter table public.price_rules
  add constraint price_rules_percent_range_chk
  check (
    adjust_type <> 'percent_bp'
    or (adjust_value >= -10000 and adjust_value <= 10000)
  );

alter table public.price_rules
  add constraint price_rules_priority_range_chk
  check (priority >= 0 and priority <= 9999);

-- 평가 경로: "이 업체의 켜진 룰을 우선순위 순으로" 읽는다.
create index if not exists idx_price_rules_vendor_priority
  on public.price_rules (vendor_id, priority, created_at);

-- =============================================================================
-- RLS 는 손대지 않는다 (§3.9)
--   T-03 의 정책 그대로다 — **가격 테이블이라 쓰기는 owner 전용, staff 불가**.
--   S2-03(상품·판매가)·S2-04(추가금)와 같은 경계다.
-- =============================================================================

-- =============================================================================
-- 이 파일이 한 것
--   ALTER  price_rules + 2컬럼(priority, is_active)
--   CHECK  4 — 조정 방식 / 정수 / 비율 범위 / 우선순위 범위
--   인덱스 1, 컬럼 주석 3, 신규 테이블·정책 없음
-- =============================================================================
