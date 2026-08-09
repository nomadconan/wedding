-- =============================================================================
-- 0013 · 실재고 캘린더 (S2-05)
-- 근거: docs/07_개발명세서.md §2.2 F-V-05, §3.4 inventory_slots, §3.9, §6.3
-- =============================================================================
-- 이 파일이 지키는 것
--   1. **같은 자리에 슬롯이 둘 있으면 안 된다.** 같은 업체·상품·날짜·시각에 슬롯이 둘이면
--      어느 것을 소진시킬지 비결정적이 되고, 그 상태로 예약(4단계)이 붙으면 이중 예약이 된다.
--   2. **상태 값 집합을 못박는다.** `open`(예약 가능) / `blocked`(휴무·외부 예약으로 막음).
--      명세가 값을 정하지 않았으므로 text + CHECK 로 둔다(0001 의 원칙).
--
-- **겹침 판정에 EXCLUDE 를 쓰지 않는 이유**
--   0006(요율)·0007(가능 시간대)은 **기간**이 겹칠 수 있어 range 연산자가 필요했다.
--   재고 슬롯은 `slot_date + slot_time` 이라는 **한 점**이다. 점끼리는 같은지만 보면 되고
--   그건 UNIQUE 인덱스로 충분하다. EXCLUDE 는 GiST 인덱스라 더 무겁고 얻는 것이 없다.
--
-- **`remaining` 을 줄이는 것은 이번 범위가 아니다.**
--   예약(bookings)은 4단계다. 지금은 업체가 `capacity` 를 정하고 `remaining` 은 그와 같이
--   시작한다. 예약이 붙을 때 줄이는 지점은 아래 컬럼 주석에 남겨 뒀다.
-- =============================================================================

-- 같은 업체·상품·날짜·시각에 슬롯은 하나뿐이다.
-- product_id·slot_time 이 null 일 수 있어 그대로 UNIQUE 를 걸면 NULL 끼리 중복이 통과한다.
-- (Postgres 에서 NULL <> NULL 이다) 그래서 coalesce 로 좁혀 표현식 인덱스를 만든다.
create unique index if not exists uq_inventory_slots_slot
  on public.inventory_slots (
    vendor_id,
    (coalesce(product_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    slot_date,
    (coalesce(slot_time, '00:00'::time))
  );

comment on index public.uq_inventory_slots_slot is
  '같은 업체·상품·날짜·시각의 슬롯 중복을 막는다(F-V-05). 둘이면 어느 것을 소진시킬지 비결정적이 된다.';

alter table public.inventory_slots
  add constraint inventory_slots_status_chk
  check (status in ('open', 'blocked'));

-- 정원 0짜리 슬롯은 예약을 받을 수 없으므로 슬롯으로서 의미가 없다.
-- 휴무는 `status='blocked'` 로 표현한다 — 정원 0과 휴무를 같은 값으로 두면 구분이 사라진다.
alter table public.inventory_slots
  add constraint inventory_slots_capacity_positive_chk
  check (capacity > 0);

comment on column public.inventory_slots.capacity is
  '업체가 정하는 총량. 예약이 생겨도 줄지 않는다.';
comment on column public.inventory_slots.remaining is
  '남은 자리. **예약(bookings, 4단계)이 확정될 때 줄이고 취소될 때 되돌린다.** S2-05 에서는 업체가 정한 capacity 와 같은 값으로 시작하며, 재고 화면은 이 값을 표시만 한다.';
comment on column public.inventory_slots.status is
  'open(예약 가능) | blocked(휴무·외부 예약으로 막음). 블록은 정원을 지우지 않고 상태만 바꾼다 — 되돌릴 때 원래 정원을 복원하기 위해서다.';

-- 달력 화면은 "이 업체의 이 달" 을 통째로 읽는다. 상태까지 인덱스에 넣어 정렬 없이 훑는다.
create index if not exists idx_inventory_slots_vendor_date_time
  on public.inventory_slots (vendor_id, slot_date, slot_time);

-- =============================================================================
-- RLS 는 손대지 않는다 (§3.9)
--   T-03 의 정책 그대로다 — active 업체 슬롯은 공개 열람, **쓰기는 멤버(staff 포함)**.
--   재고는 가격·정산이 아니므로 staff 가 등록할 수 있다. S2-07 에서 확인한 경계와 같다.
-- =============================================================================

-- =============================================================================
-- 이 파일이 한 것
--   UNIQUE 인덱스 1 — 같은 자리 슬롯 중복 금지
--   CHECK 2 — 상태 값 집합 / 정원 > 0
--   인덱스 1, 컬럼 주석 3, 신규 테이블·정책 없음
-- =============================================================================
