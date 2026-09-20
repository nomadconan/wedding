-- =============================================================================
-- 0080 · 지역 코드 체계 (C-2f)
--   근거: 07 §2.1 F-C-10 확장 · F-C-09(참가격 지수) · §3.3 · B-1
--
-- ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
-- `region_code` 가 **자유 입력 문자열**이고 탐색 필터가 `ilike %값%` 부분 일치였다.
-- "강남" 이 "강남구·강남동" 을 함께 물고, 오탈자는 **조용히 0건**이 된다 —
-- 업체는 자기가 어떤 필터에도 안 걸린다는 사실을 모른다.
--
-- ── 코드는 ASCII 슬러그다 ───────────────────────────────────────────────────
-- 지역 코드는 `/prices/[region]/[category]` 의 **URL 조각**이다. 이 리포는 이미
-- `SLUG_PATTERN` 에서 *"퍼센트 인코딩된 한글 URL 은 공유될 때 깨져 보인다"* 며
-- 한글 슬러그를 거부했다. 같은 규칙을 따른다 — **코드는 슬러그, 표시는 한글 라벨**.
--
-- ── 깊이는 균일하지 않다 ────────────────────────────────────────────────────
-- 깊으면 참가격 표본이 흩어져 지수가 안 서고(하한 5), 얕으면 '서울' 한 칸이 된다.
-- **서울 25구·경기 31시군은 시군구**, 그 밖은 **시도**다. 시도 17개가 전부 어휘에
-- 있으므로 **표현 불가한 지역이 없다.**
--
-- ── 어휘는 `lib/core/region/regions.ts` 가 진실이다 ─────────────────────────
-- 아래 목록은 그 파일에서 **기계로 뽑아** 적었고 `db:rls` 가 둘을 대조한다.
-- 손으로 두 벌을 적으면 한쪽이 낡는다(0045·0075 가 같은 방식이다).
-- =============================================================================

create or replace function public.is_region_code(p_value text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_value in (
    'seoul', 'seoul-jongno', 'seoul-jung', 'seoul-yongsan', 'seoul-seongdong', 'seoul-gwangjin',
    'seoul-dongdaemun', 'seoul-jungnang', 'seoul-seongbuk', 'seoul-gangbuk', 'seoul-dobong', 'seoul-nowon',
    'seoul-eunpyeong', 'seoul-seodaemun', 'seoul-mapo', 'seoul-yangcheon', 'seoul-gangseo', 'seoul-guro',
    'seoul-geumcheon', 'seoul-yeongdeungpo', 'seoul-dongjak', 'seoul-gwanak', 'seoul-seocho', 'seoul-gangnam',
    'seoul-songpa', 'seoul-gangdong', 'busan', 'daegu', 'incheon', 'gwangju',
    'daejeon', 'ulsan', 'sejong', 'gyeonggi', 'gyeonggi-suwon', 'gyeonggi-seongnam',
    'gyeonggi-uijeongbu', 'gyeonggi-anyang', 'gyeonggi-bucheon', 'gyeonggi-gwangmyeong', 'gyeonggi-pyeongtaek', 'gyeonggi-dongducheon',
    'gyeonggi-ansan', 'gyeonggi-goyang', 'gyeonggi-gwacheon', 'gyeonggi-guri', 'gyeonggi-namyangju', 'gyeonggi-osan',
    'gyeonggi-siheung', 'gyeonggi-gunpo', 'gyeonggi-uiwang', 'gyeonggi-hanam', 'gyeonggi-yongin', 'gyeonggi-paju',
    'gyeonggi-icheon', 'gyeonggi-anseong', 'gyeonggi-gimpo', 'gyeonggi-hwaseong', 'gyeonggi-gwangju', 'gyeonggi-yangju',
    'gyeonggi-pocheon', 'gyeonggi-yeoju', 'gyeonggi-yeoncheon', 'gyeonggi-gapyeong', 'gyeonggi-yangpyeong', 'gangwon',
    'chungbuk', 'chungnam', 'jeonbuk', 'jeonnam', 'gyeongbuk', 'gyeongnam',
    'jeju'
  );
$$;

comment on function public.is_region_code(text) is
  '지역 어휘(C-2f). 진실은 lib/core/region/regions.ts 이고 db:rls 가 둘을 대조한다.';

-- -----------------------------------------------------------------------------
-- 이행 — 자유 문자열을 코드로
-- -----------------------------------------------------------------------------
-- **추측하지 않는다.** 라벨과 정확히 맞거나(공백 무시), 시군구 접미사 한 글자가
-- 붙었거나, 시도 이름만 적힌 경우에만 옮긴다. "서울 강남구 테헤란로 123" 같은
-- 값은 **사람이 본다** — 주소를 지역으로 바꾸는 이행은 되돌릴 수 없다.
--
-- **로컬에서 이 문장들은 빈 표를 훑는다.** `db:reset` 은 마이그레이션을 먼저,
-- `seed.sql` 을 나중에 적용하기 때문이다(C-2a·C-2e 가 같은 자리에서 물렸다).
-- **로컬은 시드가 이미 코드로 적어 채우고, 운영 DB 는 아래 UPDATE 가 채운다.**
-- 라벨 → 코드 대응은 **이 마이그레이션 안에서만** 쓰는 함수로 둔다. 임시 표를 쓰면
-- 트랜잭션 경계에 따라 사라질 수 있어(세션 상태에 기대는 이행은 재현이 어렵다)
-- 함수로 만들고 **끝에서 지운다.**
create or replace function public.region_from_label(p_raw text)
returns text
language sql
stable
set search_path = public
as $$
  with m(label, code) as (values
      ('서울', 'seoul'),
      ('서울 종로', 'seoul-jongno'),
      ('서울 중', 'seoul-jung'),
      ('서울 용산', 'seoul-yongsan'),
      ('서울 성동', 'seoul-seongdong'),
      ('서울 광진', 'seoul-gwangjin'),
      ('서울 동대문', 'seoul-dongdaemun'),
      ('서울 중랑', 'seoul-jungnang'),
      ('서울 성북', 'seoul-seongbuk'),
      ('서울 강북', 'seoul-gangbuk'),
      ('서울 도봉', 'seoul-dobong'),
      ('서울 노원', 'seoul-nowon'),
      ('서울 은평', 'seoul-eunpyeong'),
      ('서울 서대문', 'seoul-seodaemun'),
      ('서울 마포', 'seoul-mapo'),
      ('서울 양천', 'seoul-yangcheon'),
      ('서울 강서', 'seoul-gangseo'),
      ('서울 구로', 'seoul-guro'),
      ('서울 금천', 'seoul-geumcheon'),
      ('서울 영등포', 'seoul-yeongdeungpo'),
      ('서울 동작', 'seoul-dongjak'),
      ('서울 관악', 'seoul-gwanak'),
      ('서울 서초', 'seoul-seocho'),
      ('서울 강남', 'seoul-gangnam'),
      ('서울 송파', 'seoul-songpa'),
      ('서울 강동', 'seoul-gangdong'),
      ('부산', 'busan'),
      ('대구', 'daegu'),
      ('인천', 'incheon'),
      ('광주', 'gwangju'),
      ('대전', 'daejeon'),
      ('울산', 'ulsan'),
      ('세종', 'sejong'),
      ('경기', 'gyeonggi'),
      ('경기 수원', 'gyeonggi-suwon'),
      ('경기 성남', 'gyeonggi-seongnam'),
      ('경기 의정부', 'gyeonggi-uijeongbu'),
      ('경기 안양', 'gyeonggi-anyang'),
      ('경기 부천', 'gyeonggi-bucheon'),
      ('경기 광명', 'gyeonggi-gwangmyeong'),
      ('경기 평택', 'gyeonggi-pyeongtaek'),
      ('경기 동두천', 'gyeonggi-dongducheon'),
      ('경기 안산', 'gyeonggi-ansan'),
      ('경기 고양', 'gyeonggi-goyang'),
      ('경기 과천', 'gyeonggi-gwacheon'),
      ('경기 구리', 'gyeonggi-guri'),
      ('경기 남양주', 'gyeonggi-namyangju'),
      ('경기 오산', 'gyeonggi-osan'),
      ('경기 시흥', 'gyeonggi-siheung'),
      ('경기 군포', 'gyeonggi-gunpo'),
      ('경기 의왕', 'gyeonggi-uiwang'),
      ('경기 하남', 'gyeonggi-hanam'),
      ('경기 용인', 'gyeonggi-yongin'),
      ('경기 파주', 'gyeonggi-paju'),
      ('경기 이천', 'gyeonggi-icheon'),
      ('경기 안성', 'gyeonggi-anseong'),
      ('경기 김포', 'gyeonggi-gimpo'),
      ('경기 화성', 'gyeonggi-hwaseong'),
      ('경기 광주', 'gyeonggi-gwangju'),
      ('경기 양주', 'gyeonggi-yangju'),
      ('경기 포천', 'gyeonggi-pocheon'),
      ('경기 여주', 'gyeonggi-yeoju'),
      ('경기 연천', 'gyeonggi-yeoncheon'),
      ('경기 가평', 'gyeonggi-gapyeong'),
      ('경기 양평', 'gyeonggi-yangpyeong'),
      ('강원', 'gangwon'),
      ('충북', 'chungbuk'),
      ('충남', 'chungnam'),
      ('전북', 'jeonbuk'),
      ('전남', 'jeonnam'),
      ('경북', 'gyeongbuk'),
      ('경남', 'gyeongnam'),
      ('제주', 'jeju')
  )
  select m.code
    from m
   where replace(btrim(p_raw), ' ', '') = replace(m.label, ' ', '')
      or replace(btrim(p_raw), ' ', '') in (
           replace(m.label, ' ', '') || '구',
           replace(m.label, ' ', '') || '시',
           replace(m.label, ' ', '') || '군')
   limit 1;
$$;

update public.vendors     set region_code = public.region_from_label(region_code)
 where region_code is not null and not public.is_region_code(region_code)
   and public.region_from_label(region_code) is not null;
update public.couples     set region_code = public.region_from_label(region_code)
 where region_code is not null and not public.is_region_code(region_code)
   and public.region_from_label(region_code) is not null;
update public.inquiries   set region_code = public.region_from_label(region_code)
 where region_code is not null and not public.is_region_code(region_code)
   and public.region_from_label(region_code) is not null;
update public.price_index set region_code = public.region_from_label(region_code)
 where not public.is_region_code(region_code)
   and public.region_from_label(region_code) is not null;

/* 플래너는 배열이다. 옮겨지는 것만 바꾸고 나머지는 그대로 둔다. */
update public.planners p
   set regions = (
     select array_agg(coalesce(public.region_from_label(r), r) order by idx)
       from unnest(p.regions) with ordinality as t(r, idx)
   )
 where p.regions is not null and array_length(p.regions, 1) > 0;

-- **못 옮긴 값은 비운다 — 지우지 않고 비운다.**
-- 코드가 아닌 값을 남겨 두면 아래 CHECK 이 기존 행에서 깨지고(C-2b 가 겪었다),
-- 그렇다고 아무 코드나 넣으면 **틀린 지역**이 된다. `null` 은 "아직 모른다" 이며
-- 탐색은 그 업체를 **목록에서 빼지 않는다**(지역으로 거를 때만 안 나온다).
update public.vendors   set region_code = null
 where region_code is not null and not public.is_region_code(region_code);
update public.couples   set region_code = null
 where region_code is not null and not public.is_region_code(region_code);
update public.inquiries set region_code = null
 where region_code is not null and not public.is_region_code(region_code);

-- `price_index.region_code` 는 NOT NULL 이라 비울 수 없다. 못 옮긴 칸은 **지운다** —
-- 지수 한 칸은 산출물이며 `price-index-refresh` 가 다시 만든다(원자료가 아니다).
delete from public.price_index where not public.is_region_code(region_code);

-- -----------------------------------------------------------------------------
-- 어휘를 잠근다
-- -----------------------------------------------------------------------------
-- `not valid` 로 걸고 곧바로 `validate` 한다 — 두 단계로 나누면 기존 행이 어긋났을 때
-- 어느 단계에서 멈췄는지 분명하고, 실데이터에서 막히면 `not valid` 상태로 **새 행만**
-- 막으면서 이행을 따로 할 수 있다(0076 이 FIX-75 에서 쓴 방식과 같다).
alter table public.vendors
  add constraint vendors_region_vocab_chk
  check (region_code is null or public.is_region_code(region_code)) not valid;
alter table public.vendors validate constraint vendors_region_vocab_chk;

alter table public.couples
  add constraint couples_region_vocab_chk
  check (region_code is null or public.is_region_code(region_code)) not valid;
alter table public.couples validate constraint couples_region_vocab_chk;

alter table public.inquiries
  add constraint inquiries_region_vocab_chk
  check (region_code is null or public.is_region_code(region_code)) not valid;
alter table public.inquiries validate constraint inquiries_region_vocab_chk;

alter table public.price_index
  add constraint price_index_region_vocab_chk
  check (public.is_region_code(region_code)) not valid;
alter table public.price_index validate constraint price_index_region_vocab_chk;

-- 배열은 **함수로 싼다** — CHECK 안에는 서브쿼리를 둘 수 없다(`unnest` 를 직접 쓰면
-- "cannot use subquery in check constraint" 로 마이그레이션이 죽는다).
create or replace function public.are_region_codes(p_values text[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(bool_and(public.is_region_code(r)), true) from unnest(p_values) r;
$$;

alter table public.planners
  add constraint planners_region_vocab_chk
  check (regions is null or public.are_region_codes(regions)) not valid;
alter table public.planners validate constraint planners_region_vocab_chk;

-- -----------------------------------------------------------------------------
-- 업체는 자기 지역을 바꿀 수 없다 (층 3)
-- -----------------------------------------------------------------------------
-- **지역은 참가격 지수(F-C-09)의 분모**다. 업체가 마음대로 바꾸면 표본이 적어
-- 유리한 칸으로 옮겨 다닐 수 있고, 그건 "자격의 근거 표를 자격을 얻으려는 사람이
-- 직접 쓰는" 모양이다(§5.5 층 3 · FIX-30 이 `badge_flags`·`status` 에서 막은 것과 같다).
--
-- 그래서 지역을 **입점 심사 대상 정보**로 다룬다 — 업체명·카테고리와 같은 자리다.
-- 칸만 걷으면 무효이므로 **표에서 걷고 남길 칸을 나열해 다시 준다**(§5.5 층 1).
revoke update on public.vendors from authenticated;
grant update (
  address, address_detail, capacity_min, capacity_max, facilities, intro, style_tags
) on public.vendors to authenticated;

-- 이행용 함수는 여기서 지운다 — 남겨 두면 다음 사람이 "옛 라벨을 아직 받는다" 로 읽는다.
drop function public.region_from_label(text);

-- =============================================================================
-- 이 파일이 한 것
--   함수 2 — is_region_code(text) · are_region_codes(text[]) · 어휘 73(시도 17 + 시군구 56)
--   이행   — vendors·couples·inquiries·price_index·planners(배열) 자유 문자열 → 코드
--            못 옮긴 값은 **비운다**(price_index 만 삭제 — 산출물이라 다시 만든다)
--   CHECK  5 — 다섯 표 전부 not valid → validate
--   권한   — vendors UPDATE 에서 region_code 를 걷는다(표에서 걷고 칸으로 재부여)
--   새 표·새 정책 없음
-- =============================================================================
