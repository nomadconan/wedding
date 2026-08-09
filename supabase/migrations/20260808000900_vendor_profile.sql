-- =============================================================================
-- 0009 · 업체 프로필·미디어 (S2-02)
-- 근거: docs/07_개발명세서.md §2.2 F-V-02, §3.3, §3.9, §3.10, §6.3, §7.2
-- =============================================================================
-- F-V-02 는 프로필에 "기본 정보, **위치·수용 인원, 시설·포함 서비스**, 미디어, **소개문**"
-- 을 요구하는데 §3.3 `vendors` 의 주요 컬럼에는 이 항목들이 없다.
--
-- **새 테이블을 만들지 않고 `vendors` 에 컬럼을 더한 이유**
--   1. §3 의 컬럼 목록은 '**주요 컬럼**' 이다. 전체 목록이 아니므로 부가 컬럼 추가가
--      명세와 충돌하지 않는다(S2-01 의 `vendor_applications` 는 status 값 집합이
--      **명세와 어긋나** 별도 테이블이 필요했던 경우로, 성격이 다르다).
--   2. 프로필 항목은 전부 **공개 정보**다. `vendors` 는 이미 active 행에 anon SELECT 가
--      열려 있어(§3.9) 같은 노출 규칙을 그대로 쓴다. 별도 테이블로 빼면 같은 공개 정책을
--      한 벌 더 만들어야 하고, 탐색 목록(S3-03)이 매번 조인해야 한다.
--   3. 전부 nullable 이다. 심사 중(pending)에도 부분 입력이 가능해야 한다.
--
-- RLS 는 손대지 않는다. 기존 정책이 그대로 적용된다(§3.9).
--   - 조회: active 업체는 anon 포함 공개, 멤버는 자기 업체
--   - 수정: `vendors_update_owner` — **owner 전용**. staff 는 프로필을 못 바꾼다.
--     미디어(`vendor_media`)는 멤버(staff 포함)가 등록·수정할 수 있다 — 기존 정책 그대로다.
-- =============================================================================

alter table public.vendors
  add column if not exists address        text,
  add column if not exists address_detail text,
  add column if not exists capacity_min   integer,
  add column if not exists capacity_max   integer,
  add column if not exists facilities     text[] not null default '{}',
  add column if not exists intro          text;

comment on column public.vendors.address is
  '도로명 주소(F-V-02 위치). 지도 좌표는 이번 범위가 아니다 — 필요해지면 컬럼을 더한다.';
comment on column public.vendors.capacity_min is
  '수용 인원 하한. 상품별 수용 인원은 products.capacity_min/max 로 따로 관리한다.';
comment on column public.vendors.facilities is
  '시설·포함 서비스 코드 배열. 유료 노출·광고성 값을 넣지 않는다(CLAUDE.md §2.2).';
comment on column public.vendors.intro is
  '소개문. 업체가 직접 쓰는 텍스트이며 플랫폼이 품질을 보증하는 표현으로 가공하지 않는다(D-24).';

-- 하한이 상한보다 큰 입력은 화면·API 어디서 들어와도 막는다.
alter table public.vendors
  add constraint vendors_capacity_range_chk
  check (
    (capacity_min is null or capacity_min >= 0)
    and (capacity_max is null or capacity_max >= 0)
    and (capacity_min is null or capacity_max is null or capacity_min <= capacity_max)
  );

-- -----------------------------------------------------------------------------
-- Storage — 업체 미디어 버킷 (§3.10)
-- -----------------------------------------------------------------------------
-- 명세 §3.10 에 이미 정의된 버킷이다(공개 읽기). 공개 버킷은 이것 하나뿐이며
-- 여기에는 업체가 스스로 공개하려고 올린 사진·영상만 들어간다.
-- **쓰기 정책은 만들지 않는다** — 업로드는 서버가 발급한 서명 URL 로만 한다.
insert into storage.buckets (id, name, public)
values ('vendor-media', 'vendor-media', true)
on conflict (id) do nothing;

-- =============================================================================
-- 이 파일이 한 것
--   ALTER  vendors + 6컬럼(address, address_detail, capacity_min, capacity_max,
--          facilities, intro), CHECK 1(수용 인원 범위)
--   Storage 버킷 1 — vendor-media(공개 읽기, §3.10 기정의)
--   신규 테이블·RLS 정책 없음
-- =============================================================================
