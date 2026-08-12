-- =============================================================================
-- 0027 · 장바구니 재설계 — 커플당 1개 → 최대 5개 + 비교 (IDEA-01 / S3-12)
-- 근거: docs/07_개발명세서.md §2.1 F-C-25·F-C-10, §3.4 carts·cart_items,
--       §3.9(장바구니·찜 행), §7.4(가변 파라미터), D-17·D-18
-- =============================================================================
-- **무엇이 바뀌는가.** 0016 은 "커플당 활성 장바구니 1건" 을 부분 유니크로 못 박았다.
-- 그 전제에서는 고객이 여러 조합을 만들어 놓고 견줄 수 없다 — 홀 A + 스튜디오 B 조합과
-- 홀 C + 스튜디오 B 조합을 동시에 들고 있을 자리가 없어서, 바꿔 보려면 담은 것을 지워야
-- 하고 지우면 이전 조합의 총액이 사라진다. 예산에 맞춰 좁혀 가는 일이 그래서 불가능했다.
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **상한은 DB 가 강제한다. 값은 app_settings 가 갖는다.**
--     0024 의 `inquiry.max_targets` 는 API 에서만 판정했다. 거기서는 그래도 됐다 —
--     동시 발송 대상은 **한 요청 안의 배열 길이**라 세는 순간과 쓰는 순간이 같은
--     트랜잭션이다. 장바구니는 다르다. 생성이 **요청마다 하나씩** 일어나므로 API 가
--     세고 나서 넣는 사이에 배우자의 요청이 끼어들 수 있다(커플은 둘이 같은 장바구니를
--     공유한다 — D-19). 세는 것과 넣는 것이 갈라지는 순간 API 카운트는 조언일 뿐이다.
--     그래서 S2-05·S4-07 이 UNIQUE·EXCLUDE 로 못 박은 것과 같은 이유로 DB 로 내렸다 —
--     **경로가 무엇이든 성립해야 하는 불변식**이면 DB 가 든다.
--     다만 상한은 **점의 중복도 구간의 겹침도 아니라 개수**라 UNIQUE·EXCLUDE 로 쓸 수
--     없다(부분 유니크로 5개를 표현하려면 seq 별 인덱스 5개를 손으로 늘어놓아야 하고,
--     그러면 값이 스키마에 박힌다). 개수 판정은 트리거이며, **커플 행을 잠가** 동시
--     삽입을 직렬화한다. API 는 같은 값을 읽어 **미리** 422 로 답한다 — 트리거는 마지막
--     경계이고 API 는 문구를 위한 것이다(§3.9 가 RLS 와 앱 체크를 가른 방식과 같다).
--
--     **설정이 없으면 1개로 좁힌다.** 값을 지어내지 않는다는 원칙(0024)을 여기서도 지키되,
--     '판정 안 함' 이 아니라 **가장 보수적인 값**으로 내려간다. 그러면 설정 행이 사라져도
--     서비스는 0016 의 옛 동작(커플당 하나)으로 돌아가 계속 돌아간다 — 상한이 조용히
--     풀리는 것보다 낫다.
--
--  2. **순번(seq)은 빈 번호를 채운다.** 계속 증가하지 않는다.
--     seq 는 화면에 "장바구니 3" 으로 그대로 나가는 **이름 없는 장바구니의 호칭**이다.
--     단조 증가로 두면 3개만 있는데 "장바구니 7" 이 뜨고, 상한이 5인 화면에서 7은
--     설명할 수 없는 숫자가 된다. 그래서 **1..상한 사이의 빈 번호 중 가장 작은 값**을
--     준다. 번호가 재사용된다는 뜻이지만, **정체성은 uuid** 이고 증적(`entity_events`)도
--     uuid 로 남으므로 재사용이 기록을 섞지 않는다. seq 는 슬롯 이름표다.
--
--  3. **status 를 다시 정의한다.** 0016 에서 status 는 "커플당 하나" 를 정하는 값이었다
--     (부분 유니크의 조건). 이제 그 역할이 없어졌으므로 **'상한에 드는가'와 '화면에
--     뜨는가'를 정하는 값**이다.
--       · `active`    — 고객이 지금 쓰는 장바구니. **상한의 대상**이고 화면에 뜬다.
--       · `converted` — 항목이 계약으로 넘어갔다. 상한에서 빠지고 화면에서 내려간다(S5).
--       · `abandoned` — 고객이 치웠다. 상한에서 빠진다. **행은 남는다.**
--     값 집합은 그대로다. 새 값을 만들지 않은 이유 — 셋으로 위 셋을 다 말할 수 있고,
--     상태 값을 늘리면 기존 정책·조회가 전부 새 값을 알아야 한다.
--
--     **치우기는 삭제가 아니라 `abandoned` 다.** 하드 삭제를 쓰지 않는 이유는 증적이다 —
--     `entity_events` 의 장바구니 이벤트는 `entity_type='cart'` + `entity_id=carts.id` 로
--     쌓이고, 열람 정책이 `cart_couple_id(entity_id)` 로 커플을 찾는다(0019). 행을 지우면
--     그 함수가 null 을 돌려주므로 **커플이 자기 활동 기록을 더는 못 읽는다** — 조용히,
--     이유도 없이. 완전 삭제가 필요한 경우는 F-C-24(개인정보 삭제 요청)의 일이다.
--     DELETE 정책은 그대로 둔다(고객의 데이터다). 앱이 쓰지 않을 뿐이다.
--
--  4. **이름은 nullable · 20자 · 중복 허용.**
--     길이는 **스키마 제약이라 여기 박는다** — 요율·금액·개수처럼 운영이 배포 없이
--     조정할 값이 아니고, DB CHECK 와 zod 가 같은 값을 알아야 한다(정합은 `db:rls` 가
--     지켜본다). 20자로 정한 이유는 화면이다: 375px 에서 최대 5개 탭에 이름과 순번을
--     같이 얹으므로, 읽히지 않는 이름은 이름 구실을 못 한다.
--     **빈 문자열을 저장하지 않는다.** ''(빈 문자열)과 null 이 둘 다 '이름 없음' 이면
--     화면·API 가 두 경우를 따로 다뤄야 하고 언젠가 한쪽을 빠뜨린다. 이름 없음의 표현은
--     null 하나다(공백만 있는 이름도 API 가 null 로 접는다).
--     **중복을 막지 않는다.** 구분자는 seq 이고 화면이 이름과 seq 를 늘 함께 보인다.
--     유니크를 걸면 (가) 배우자가 먼저 쓴 이름 때문에 내 이름 바꾸기가 실패하고
--     (나) "부모님추천" 을 두 조합에 붙이는 정당한 쓰임이 막힌다. 이름은 라벨이고
--     식별자가 아니다.
--
--  5. **항목이 바뀌면 부모 장바구니를 만진다(touch).**
--     '지금 쓰는 장바구니' 를 `carts.updated_at` 최신으로 정하는데, 담기·빼기는
--     `cart_items` 만 건드리므로 부모의 시각이 멈춰 있으면 방금 담은 장바구니가
--     '가장 오래된 것' 으로 밀린다. 트리거로 부모를 만진다.
-- =============================================================================

-- =============================================================================
-- 1) 컬럼 — 이름 · 순번
-- =============================================================================
alter table public.carts add column if not exists name text;
alter table public.carts add column if not exists seq integer;

-- 이름은 없거나(null), 앞뒤 공백이 없는 1~20자다. 빈 문자열은 통과하지 못한다.
alter table public.carts drop constraint if exists carts_name_chk;
alter table public.carts
  add constraint carts_name_chk
  check (name is null or (name = btrim(name) and char_length(name) between 1 and 20));

comment on column public.carts.name is
  '고객이 붙인 이름(예: 가성비안 · 부모님추천). null 이면 순번으로 부른다("장바구니 3"). 1~20자이며 빈 문자열은 CHECK 가 막는다 — 이름 없음의 표현은 null 하나여야 한다. **중복을 허용한다**: 구분자는 seq 이고 이름은 라벨이지 식별자가 아니다. 길이 20 은 lib/core/cart/multi-cart.ts 의 CART_NAME_MAX_LENGTH 와 같아야 하며 db:rls 가 정합을 본다.';

-- 기존 행에 순번을 채운다. 0016 의 부분 유니크가 활성 장바구니를 커플당 하나로
-- 보장해 왔으므로, 활성끼리는 충돌하지 않는다. 지나간 것들은 만들어진 순서를 준다.
update public.carts c
set seq = t.rn
from (
  select id, row_number() over (
    partition by couple_id, (status = 'active') order by created_at, id
  ) as rn
  from public.carts
) t
where c.id = t.id and c.seq is null;

alter table public.carts alter column seq set not null;

alter table public.carts drop constraint if exists carts_seq_chk;
alter table public.carts add constraint carts_seq_chk check (seq >= 1);

comment on column public.carts.seq is
  '커플 안에서의 순번. 이름이 없을 때의 호칭이다("장바구니 3"). **빈 번호를 채운다** — 단조 증가로 두면 3개뿐인데 "장바구니 7" 이 떠서 상한 5를 설명할 수 없다. 재사용되지만 정체성은 id(uuid)이고 증적도 uuid 로 남으므로 기록이 섞이지 않는다. 상한 값을 여기 박지 않는다(app_settings).';

-- =============================================================================
-- 2) '커플당 활성 1건' 해제 → '활성 장바구니끼리 순번이 겹치지 않는다'
-- =============================================================================
drop index if exists public.uq_carts_active_per_couple;

create unique index if not exists uq_carts_couple_seq
  on public.carts (couple_id, seq)
  where status = 'active';

comment on index public.uq_carts_couple_seq is
  '활성 장바구니끼리 순번은 유일하다. "장바구니 2" 가 둘이면 탭이 어느 쪽인지 말할 수 없다. 지나간 장바구니(converted·abandoned)는 조건에서 빠지므로 번호가 풀려 새 장바구니가 그 자리를 쓴다.';

comment on table public.carts is
  '커플 장바구니(F-C-25). **커플당 활성 최대 N개**(N 은 app_settings.cart.max_active). 고객이 여러 조합을 만들어 놓고 예산에 맞춰 좁혀 간다. 지나간 장바구니는 지우지 않고 상태로 남긴다.';
comment on column public.carts.status is
  'active(고객이 쓰는 장바구니 · **상한의 대상** · 화면에 뜬다) | converted(항목이 계약으로 넘어갔다 — 상한에서 빠진다) | abandoned(고객이 치웠다 — 상한에서 빠지고 행은 증적으로 남는다). 0016 에서는 "커플당 하나" 를 정하는 값이었고, 이제는 **상한에 드는가·화면에 뜨는가**를 정하는 값이다.';

-- =============================================================================
-- 3) 상한 — 값은 app_settings, 판정은 트리거
-- =============================================================================
create or replace function public.cart_active_limit()
returns integer language sql stable security definer set search_path = public as $$
  -- 설정이 없으면 1이다. '판정 안 함' 이 아니라 **가장 보수적인 값**으로 내려간다 —
  -- 상한이 조용히 풀리는 것보다 0016 의 옛 동작으로 돌아가는 편이 낫다.
  select greatest(1, coalesce((
    select (value_json ->> 'max')::int
    from public.app_settings
    where key = 'cart.max_active'
      and (value_json ->> 'max') ~ '^[0-9]+$'
  ), 1));
$$;

comment on function public.cart_active_limit() is
  '활성 장바구니 상한. app_settings.cart.max_active 가 값을 갖는다(§7.4) — 코드·스키마에 박지 않는다. 행이 없거나 값이 이상하면 1로 좁힌다.';

create or replace function public.cart_assign_slot()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_limit integer := public.cart_active_limit();
  v_count integer;
begin
  -- **커플 행을 잠근다.** 개수 판정은 세는 순간과 넣는 순간이 벌어지면 무의미하다.
  -- 커플 하나에 대한 장바구니 생성이 이 지점에서 직렬화된다.
  perform 1 from public.couples where id = new.couple_id for update;

  if new.status = 'active' then
    select count(*) into v_count
    from public.carts
    where couple_id = new.couple_id and status = 'active';

    if v_count >= v_limit then
      raise exception '장바구니는 최대 %개까지 만들 수 있습니다.', v_limit
        using errcode = 'check_violation', constraint = 'carts_active_limit';
    end if;
  end if;

  -- 순번은 **1..상한 사이의 빈 번호 중 가장 작은 값**이다. 명시적으로 넘어온 값은
  -- 그대로 둔다(마이그레이션·복구 경로).
  if new.seq is null then
    select coalesce(min(s), v_limit + 1) into new.seq
    from generate_series(1, v_limit) s
    where not exists (
      select 1 from public.carts c
      where c.couple_id = new.couple_id and c.status = 'active' and c.seq = s
    );
  end if;

  return new;
end;
$$;

comment on function public.cart_assign_slot() is
  '장바구니 생성 시 상한을 판정하고 순번을 채운다. 커플 행을 잠가 동시 삽입을 직렬화한다 — API 카운트만으로는 배우자의 동시 요청을 막을 수 없다(D-19 커플 공유).';

drop trigger if exists trg_carts_assign_slot on public.carts;
create trigger trg_carts_assign_slot
  before insert on public.carts
  for each row execute function public.cart_assign_slot();

-- 되살리기(abandoned → active)도 같은 상한을 지나야 한다. 화면에는 그 동작이 없지만
-- 정책상 UPDATE 는 열려 있으므로, 상한을 도는 길을 남겨 두지 않는다.
create or replace function public.cart_reactivate_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_limit integer := public.cart_active_limit();
  v_count integer;
begin
  if new.status = 'active' and old.status <> 'active' then
    perform 1 from public.couples where id = new.couple_id for update;

    select count(*) into v_count
    from public.carts
    where couple_id = new.couple_id and status = 'active' and id <> new.id;

    if v_count >= v_limit then
      raise exception '장바구니는 최대 %개까지 만들 수 있습니다.', v_limit
        using errcode = 'check_violation', constraint = 'carts_active_limit';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_carts_reactivate_guard on public.carts;
create trigger trg_carts_reactivate_guard
  before update of status on public.carts
  for each row execute function public.cart_reactivate_guard();

-- =============================================================================
-- 4) 항목이 바뀌면 부모를 만진다 — '지금 쓰는 장바구니' 판정의 근거
-- =============================================================================
create or replace function public.cart_touch_parent()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ids uuid[];
begin
  -- **DELETE 에서 new 를 읽으면 안 된다.** plpgsql 은 그 경우 new 를 배정하지 않아
  -- 필드 접근 자체가 오류다(coalesce 로도 피할 수 없다).
  if tg_op = 'DELETE' then
    v_ids := array[old.cart_id];
  elsif tg_op = 'UPDATE' and old.cart_id <> new.cart_id then
    -- 항목을 다른 장바구니로 **옮긴** 경우다. 양쪽 다 바뀌었다.
    v_ids := array[old.cart_id, new.cart_id];
  else
    v_ids := array[new.cart_id];
  end if;

  -- security definer 다. 담기·빼기를 할 수 있는 사람은 부모를 만질 권한도 있지만
  -- (carts_update 정책), 그 판정을 여기서 다시 타게 하면 정책이 바뀔 때 항목 쓰기가
  -- 조용히 실패한다. 만지는 값은 updated_at 하나다.
  -- 장바구니가 지워지는 길(cascade)에서는 부모가 이미 없으므로 0행이 되고 만다.
  update public.carts
  set updated_at = now()
  where id = any (v_ids);

  return null;
end;
$$;

comment on function public.cart_touch_parent() is
  '항목 변경 시 부모 장바구니의 updated_at 을 올린다. 담기 대상 기본값이 "가장 최근에 쓴 장바구니" 이므로, 부모 시각이 멈춰 있으면 방금 담은 장바구니가 가장 오래된 것으로 밀린다.';

drop trigger if exists trg_cart_items_touch_parent on public.cart_items;
create trigger trg_cart_items_touch_parent
  after insert or update or delete on public.cart_items
  for each row execute function public.cart_touch_parent();

-- =============================================================================
-- 5) 운영 파라미터 (§7.4 — 코드에 박지 않는다)
-- =============================================================================
insert into public.app_settings (key, value_json, description)
values
  (
    'cart.max_active',
    '{"max": 5}'::jsonb,
    '커플당 활성 장바구니 상한(IDEA-01). 판정은 trg_carts_assign_slot 이 하고 API 는 같은 값을 읽어 미리 422 로 답한다. 행이 없으면 1로 좁혀 0016 의 옛 동작으로 돌아간다.'
  ),
  (
    'cart.core_categories',
    '{"categories": ["hall", "studio", "dress", "makeup"]}'::jsonb,
    '장바구니 채움 판정의 기준 카테고리(IDEA-01). products.category 값을 그대로 쓴다 — 새 카테고리 체계를 만들지 않는다. 이 목록에 든 카테고리가 비어 있으면 총액을 "미완성" 으로 적는다. **행이 없으면 채움 판정을 하지 않는다** — 코드가 기준을 지어내면 "완성" 이라는 거짓말을 하게 된다. video·agency 를 뺀 것은 운영 판단이며 배포 없이 바꾼다.'
  )
on conflict (key) do nothing;

-- =============================================================================
-- 이 파일이 한 것
--   컬럼 2 — carts.name · carts.seq (+ CHECK 2)
--   인덱스 — uq_carts_active_per_couple 해제, uq_carts_couple_seq 신설
--   함수 4 — cart_active_limit · cart_assign_slot · cart_reactivate_guard ·
--            cart_touch_parent
--   트리거 3 — carts BEFORE INSERT · carts BEFORE UPDATE OF status ·
--              cart_items AFTER INSERT/UPDATE/DELETE
--   app_settings 2 — cart.max_active · cart.core_categories
--   RLS 변경 없음 — 0016 의 정책이 그대로 유효하다(커플 당사자 쓰기 · 플래너 읽기).
--                   새 컬럼도 같은 행에 있으므로 같은 경계를 받는다.
--   기존 마이그레이션 수정 없음
-- =============================================================================
