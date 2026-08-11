-- =============================================================================
-- 0024 · 표준 문의·견적 (S4-12) + 문의게시판 검색 (S4-05)
-- 근거: docs/07_개발명세서.md §2.1 F-C-13·F-C-28, §2.2 F-V-07·F-V-16,
--       §3.4 inquiries·inquiry_targets·quotes·quote_items, §3.7 qna_posts,
--       §3.9 RLS, §7.4(가변 파라미터), D-03·D-23
-- =============================================================================
-- T-03 이 네 표를 만들었지만 **자유 양식 견적을 막는 장치가 없었다.** `quote_items` 는
-- `label text` + `amount bigint` 라 업체가 아무 이름에 아무 금액이나 적을 수 있었다.
-- 이 파일이 그 구멍을 닫는다.
--
-- ── 왜 이것이 스키마의 일인가 ───────────────────────────────────────────────
-- "표준 견적서 폼으로만 응답(자유 텍스트 견적 금지)"(F-V-07)을 **화면 제약으로 두면
-- 지켜지지 않는다.** 화면은 우회할 수 있고, API 는 고쳐질 수 있다. 항목 이름과 구성이
-- 업체마다 제각각이 되는 순간 **비교가 불가능해지고**, 비교가 안 되면 가격 정찰제
-- (D-03)도 장바구니 비교(F-C-14)도 성립하지 않는다. 그래서 DB 가 막는다 —
-- S2-04 가 추가금 미확정 상품의 게시를 CHECK 로 막은 것과 같은 판단이다.
--
-- ── 네 겹으로 막는다 ────────────────────────────────────────────────────────
--
--  1. **출처 강제** — 견적 항목은 `products` 또는 `product_options` 를 **참조해야만**
--     존재할 수 있다(`quote_items_source_chk`). 즉석에서 만든 항목은 참조할 행이
--     없으므로 INSERT 자체가 실패한다. F-V-04 의 "사전 미등록 항목은 사후 청구 불가"
--     를 **견적 단계부터** 적용하는 것이다.
--
--  2. **이름·분류를 DB 가 덮어쓴다** — `quote_item_fill_from_source()` 트리거가
--     `label`·`category_code`·`is_option`·`is_mandatory` 를 참조된 행에서 **다시 읽어
--     채운다.** 클라이언트가 무엇을 보내든 무시된다. 그래서 항목 자리에 자유 텍스트를
--     넣을 방법이 없다. (자유 텍스트는 `quotes.vendor_memo` 한 곳에만 허용한다.)
--
--  3. **상한 초과 금지** — `amount <= cap_amount`, `total_amount <= cap_total` 을
--     CHECK 로 건다. **할인만 되고 할증은 안 된다.** 고객이 장바구니·탐색에서 본
--     가격보다 비싼 견적이 나오면 그 화면들이 거짓이 된다. 성수기·주말 할증이
--     필요하면 `price_rules` 로 **미리 등록**해야 하고, 룰은 사유 라벨이 고객에게
--     공개되므로(S3-03 `customer-price.ts`) "왜 이 가격인가" 를 고객이 알 수 있다.
--
--  4. **쓰기 경로를 서버로 좁힌다** — `quotes`·`quote_items` 의 INSERT·UPDATE 권한을
--     회수한다. 이유는 3번의 한계에 있다: **옵션 항목의 상한은 DB 가 스스로 안다**
--     (`product_options.price` — 트리거가 강제로 덮어쓴다). 그런데 **기본 항목의
--     상한은 `price_rules` 평가 결과**이고, 그 평가는 `lib/core/pricing/dynamic.ts`
--     의 순수 함수가 한다. DB 는 그 값을 계산할 수 없다. 클라이언트가 `cap_amount` 를
--     직접 적어 넣을 수 있으면 3번이 무력해지므로, 쓰기를 서버(서비스롤)로 좁혀
--     **API 가 상한을 스스로 계산하고 클라이언트 입력을 무시**하게 만든다.
--     §3.9 가 입점 심사에 쓴 "서비스롤 경유" 와 같은 방식이며, 그 API 는 권한을
--     **RLS 에게 물어서**(세션 클라이언트로 `inquiry_targets` 를 읽어 본다) 판정한다 —
--     경계를 새로 구현하지 않는다(CLAUDE.md §5.5).
--
--  5. **첨부 자리를 만들지 않는다** — 견적에 파일 컬럼을 두지 않는다. PDF·이미지로
--     보내는 순간 플랫폼 밖 양식이 되고 1~4가 전부 무의미해진다. Storage 버킷도
--     견적용으로 새로 만들지 않는다.
--
-- ── 가격 스냅샷 (재현 가능성) ───────────────────────────────────────────────
-- 견적 시점의 룰 평가 결과를 통째로 박아 둔다. 업체가 나중에 룰을 바꿔도 "그때 왜 이
-- 가격이었나" 를 재구성할 수 있어야 한다 — 분쟁에서 재현할 수 없는 금액은 주장할 수
-- 없는 금액이다(D-23).
--   quotes.base_price_snapshot   룰 적용 **전** 기준가(products.base_price_total)
--   quotes.cap_total             룰 적용 **후** 상한 총액
--   quotes.total_amount          업체가 실제로 제시한 금액
--   quotes.discount_total        위 둘의 차 (생성 컬럼 — 손으로 적을 수 없다)
--   quotes.pricing_context_json  asOf · eventDate · leadTimeDays · occupancyRatioBp
--   quotes.pricing_steps_json    적용된 룰 id · 종류 · 조정 전후 금액 · 사유
-- `leadTimeDays` 를 호출자가 넘기게 만든 S2-06 의 결정이 여기서 값을 한다 — 견적은
-- 예식일이 정해져 있으므로 조건이 결정적이고, 같은 입력이면 같은 금액이 나온다.
-- =============================================================================

-- =============================================================================
-- 1) inquiries — 표준 요청 폼 (F-C-13)
-- =============================================================================
-- §3.4 는 `request_json(날짜·하객수·옵션)` 하나로 적었다. 날짜와 하객수는 **컬럼으로
-- 꺼낸다** — 견적 가격 계산의 입력이고(예식일), 만료 배치가 훑을 값이며, jsonb 안에
-- 있으면 인덱스도 CHECK 도 걸 수 없다. `request_json` 에는 나머지(필수 옵션 선택)만
-- 남긴다. **두 곳에 같은 값을 두지 않는다** — 날짜·하객수의 진실은 컬럼이다.
alter table public.inquiries
  add column if not exists event_date   date,
  add column if not exists guest_count  integer,
  add column if not exists region_code  text,
  add column if not exists budget_total bigint,
  add column if not exists categories   text[] not null default '{}',
  add column if not exists note         text,
  add column if not exists closed_at    timestamptz;

comment on column public.inquiries.event_date is
  '예식일. **견적 가격 계산의 입력**이다(price_rules 의 season·weekday·leadtime 조건). request_json 이 아니라 컬럼인 이유 — 인덱스·CHECK·배치 조회가 전부 이 값에 걸린다.';
comment on column public.inquiries.categories is
  '요청 카테고리(hall·studio·dress·makeup 등). 업체를 고르는 기준이자, 업체가 자기와 무관한 문의를 받지 않게 하는 값이다.';
comment on column public.inquiries.note is
  '고객이 덧붙이는 자유 텍스트. **요청 쪽에는 허용한다** — 막아야 하는 것은 견적의 항목·금액이지 고객의 질문이 아니다.';
comment on column public.inquiries.request_json is
  '표준 폼의 나머지(필수 옵션 선택 등). 날짜·하객수는 여기 두지 않는다 — 컬럼이 진실이다.';

alter table public.inquiries
  add constraint inquiries_guest_count_chk
  check (guest_count is null or guest_count >= 0);

alter table public.inquiries
  add constraint inquiries_budget_chk
  check (budget_total is null or budget_total >= 0);

-- 값 집합을 못박는다(0001 원칙 — 명세가 값을 명시하지 않은 status 는 text + CHECK).
alter table public.inquiries
  add constraint inquiries_status_chk
  check (status in ('open', 'closed', 'expired'));

-- 닫힌 문의에는 닫은 시각이 있다. 없으면 "언제부터 닫혔나" 를 말할 수 없다.
alter table public.inquiries
  add constraint inquiries_closed_pair_chk
  check ((status = 'open') = (closed_at is null));

create index if not exists idx_inquiries_event_date on public.inquiries (event_date);
create index if not exists idx_inquiries_open
  on public.inquiries (created_at desc)
  where status = 'open';

-- =============================================================================
-- 2) inquiry_targets — 업체별 응답 상태·SLA (F-C-13 · F-V-07)
-- =============================================================================
-- **미응답과 거절은 다른 사실이다.** "아직 답이 없다" 는 업체가 늦은 것이고,
-- "받지 않겠다" 는 업체가 답한 것이다. 하나로 뭉치면 (가) SLA 가 거절한 업체까지
-- 지연으로 세고, (나) 고객은 기다려야 할지 다른 곳을 알아봐야 할지 알 수 없다.
alter table public.inquiry_targets
  add column if not exists declined_at         timestamptz,
  add column if not exists decline_reason_code text,
  add column if not exists first_viewed_at     timestamptz;

comment on column public.inquiry_targets.status is
  'pending(미응답 — SLA 시계가 돈다) | responded(견적을 보냈다) | declined(받지 않겠다고 답했다) | expired(SLA 를 넘긴 채 문의가 닫혔다) | withdrawn(고객이 거뒀다). **미응답과 거절을 뭉치지 않는다** — 앞은 업체가 늦은 것이고 뒤는 업체가 답한 것이다.';
comment on column public.inquiry_targets.declined_at is
  '거절 시각. 거절은 **응답이다** — SLA 시계를 멈춘다. 사유 코드와 짝이며 그 짝은 CHECK 가 강제한다.';
comment on column public.inquiry_targets.first_viewed_at is
  '업체가 이 문의를 처음 연 시각. "못 봤다" 와 "보고도 안 답했다" 를 가르는 증적이다(D-23).';
comment on column public.inquiry_targets.sla_deadline is
  '응답 기한. 값은 app_settings.inquiry.sla_response_minutes 로 계산한다 — **코드에 박지 않는다**(§7.4).';

alter table public.inquiry_targets
  add constraint inquiry_targets_status_chk
  check (status in ('pending', 'responded', 'declined', 'expired', 'withdrawn'));

-- 거절은 사유와 짝이다. 사유 없는 거절은 고객에게 아무것도 알려 주지 못한다.
alter table public.inquiry_targets
  add constraint inquiry_targets_decline_pair_chk
  check ((declined_at is null) = (decline_reason_code is null));

-- 거절 상태와 거절 시각이 어긋나면 둘 중 하나는 거짓이다.
alter table public.inquiry_targets
  add constraint inquiry_targets_declined_state_chk
  check ((status = 'declined') = (declined_at is not null));

-- 응답 상태에는 응답 시각이 있다.
alter table public.inquiry_targets
  add constraint inquiry_targets_responded_state_chk
  check (status <> 'responded' or responded_at is not null);

-- sla-escalation 배치(S4-13 잔여)가 훑을 경로. 대부분 pending 이 아니라 부분 인덱스다.
create index if not exists idx_inquiry_targets_pending_sla
  on public.inquiry_targets (sla_deadline)
  where status = 'pending';

-- 업체 인박스 — 미응답 먼저.
create index if not exists idx_inquiry_targets_vendor_status
  on public.inquiry_targets (vendor_id, status, created_at desc);

-- =============================================================================
-- 3) quotes — 표준 견적서 (F-V-07)
-- =============================================================================
-- **상품 참조를 필수로 만든다.** 견적은 등록된 상품에 대한 제안이지 즉석 제안이
-- 아니다. `on delete set null` 이던 FK 를 `restrict` 로 바꾼다 — 견적이 가리키는 상품이
-- 사라지면 그 견적은 무엇에 대한 제안인지 알 수 없게 되고, 그건 지워도 되는 정보가
-- 아니다(D-23).
alter table public.quotes drop constraint if exists quotes_product_id_fkey;
alter table public.quotes
  add constraint quotes_product_id_fkey
  foreign key (product_id) references public.products (id) on delete restrict;

alter table public.quotes alter column product_id set not null;

alter table public.quotes
  add column if not exists base_price_snapshot  bigint,
  add column if not exists cap_total            bigint,
  add column if not exists pricing_context_json jsonb  not null default '{}'::jsonb,
  add column if not exists pricing_steps_json   jsonb  not null default '[]'::jsonb,
  add column if not exists vendor_memo          text,
  add column if not exists sent_at              timestamptz,
  add column if not exists decided_at           timestamptz;

-- 표가 비어 있으므로 기본값으로 채운 뒤 곧바로 기본값을 걷는다. 앞으로의 INSERT 는
-- 반드시 값을 넣어야 한다 — 스냅샷 없는 견적은 재현할 수 없는 견적이다.
update public.quotes set base_price_snapshot = 0 where base_price_snapshot is null;
update public.quotes set cap_total = 0 where cap_total is null;
alter table public.quotes alter column base_price_snapshot set not null;
alter table public.quotes alter column cap_total set not null;

comment on column public.quotes.base_price_snapshot is
  '룰 적용 **전** 기준가(products.base_price_total 의 그 시점 값). 상품 가격이 나중에 바뀌어도 견적의 근거는 이 값이다.';
comment on column public.quotes.cap_total is
  '룰 적용 **후** 상한 총액. 업체는 이 이하로만 제시할 수 있다(quotes_cap_chk). 고객이 탐색·장바구니에서 본 가격이 곧 이 값이므로, 이것을 넘는 견적은 그 화면들을 거짓으로 만든다.';
comment on column public.quotes.pricing_context_json is
  '가격 계산에 쓴 사실 — asOf · eventDate · leadTimeDays · occupancyRatioBp. **이게 있어야 나중에 같은 금액을 재현할 수 있다**(S2-06 이 leadTimeDays 를 호출자에게 넘긴 이유가 여기서 값을 한다).';
comment on column public.quotes.pricing_steps_json is
  '적용된 룰의 단계별 기록(룰 id·종류·조정 전후·사유). 업체가 나중에 룰을 바꿔도 그때의 계산을 그대로 되짚을 수 있다.';
comment on column public.quotes.vendor_memo is
  '**견적서에서 자유 텍스트가 허용되는 유일한 자리.** 항목 이름·금액에는 쓸 수 없다(quote_items 는 참조된 상품·옵션에서 이름을 가져온다).';
comment on column public.quotes.valid_until is
  '견적 유효기간. 만료된 견적은 지우지 않고 status=expired 로 둔다 — 받은 적 있는 제안이 흔적 없이 사라지면 안 된다(D-23).';

-- 할인액은 **손으로 적을 수 없다.** 생성 컬럼이라 항상 두 값의 차다.
alter table public.quotes
  add column if not exists discount_total bigint
  generated always as (cap_total - total_amount) stored;

comment on column public.quotes.discount_total is
  '상한 대비 할인액. 생성 컬럼이므로 업체가 "얼마 깎아 드렸다" 를 임의로 적을 수 없다.';

-- ★ 상한 초과 금지 — 할인만 되고 할증은 안 된다.
alter table public.quotes
  add constraint quotes_cap_chk check (total_amount <= cap_total);

alter table public.quotes
  add constraint quotes_status_chk
  check (status in ('draft', 'sent', 'accepted', 'declined', 'expired', 'withdrawn'));

-- 보낸 견적에는 보낸 시각이 있다. draft 만 예외다.
alter table public.quotes
  add constraint quotes_sent_pair_chk
  check (status = 'draft' or sent_at is not null);

create index if not exists idx_quotes_status on public.quotes (status);
-- 만료 배치가 훑을 경로.
create index if not exists idx_quotes_valid_until
  on public.quotes (valid_until)
  where status = 'sent' and valid_until is not null;

-- =============================================================================
-- 4) quote_items — 정규화 항목 (자유 양식 금지의 핵심)
-- =============================================================================
alter table public.quote_items
  add column if not exists product_id        uuid references public.products (id) on delete restrict,
  add column if not exists product_option_id uuid references public.product_options (id) on delete restrict,
  add column if not exists item_type         text not null default 'base',
  add column if not exists cap_amount        bigint;

update public.quote_items set cap_amount = amount where cap_amount is null;
alter table public.quote_items alter column cap_amount set not null;

alter table public.quote_items
  add column if not exists discount_amount bigint
  generated always as (cap_amount - amount) stored;

comment on column public.quote_items.item_type is
  'base(상품 본체) | option(사전 등록된 추가금). 이 값이 어느 표를 참조하는지를 정한다.';
comment on column public.quote_items.product_id is
  '참조하는 상품. **즉석 항목을 만들 수 없게 하는 장치다** — 등록되지 않은 것은 참조할 행이 없어 INSERT 가 실패한다(F-V-04 를 견적 단계부터 적용).';
comment on column public.quote_items.product_option_id is
  '참조하는 사전 등록 추가금(product_options). 옵션 항목의 상한은 DB 가 이 행에서 직접 읽어 덮어쓴다.';
comment on column public.quote_items.label is
  '**업체가 적는 값이 아니다.** 트리거가 참조된 상품·옵션의 이름으로 덮어쓴다 — 항목 자리에 자유 텍스트를 넣을 수 없게 하기 위해서다.';
comment on column public.quote_items.cap_amount is
  '이 항목의 상한. 옵션은 product_options.price 를 트리거가 강제하고, 본체는 price_rules 평가 결과를 서버가 넣는다(그 계산은 DB 가 할 수 없어 쓰기를 서버로 좁혔다).';
comment on column public.quote_items.discount_amount is
  '상한 대비 할인액. 생성 컬럼이라 손으로 적을 수 없다.';

-- ★ 출처 강제 — 참조 없는 항목은 존재할 수 없다.
alter table public.quote_items
  add constraint quote_items_source_chk
  check (
    (item_type = 'base' and product_id is not null and product_option_id is null)
    or (item_type = 'option' and product_option_id is not null)
  );

-- ★ 상한 초과 금지.
alter table public.quote_items
  add constraint quote_items_cap_chk check (amount <= cap_amount);

create index if not exists idx_quote_items_product_id on public.quote_items (product_id);
create index if not exists idx_quote_items_option_id on public.quote_items (product_option_id);

-- -----------------------------------------------------------------------------
-- 트리거 — 이름·분류·옵션 상한을 **참조된 행에서 다시 읽어** 채운다
-- -----------------------------------------------------------------------------
-- 클라이언트가 무엇을 보내든 덮어쓴다. 그래서 항목 자리에 자유 텍스트를 넣을 방법이
-- 없다. 옵션의 상한(`product_options.price`)은 DB 가 아는 값이므로 여기서 강제한다 —
-- 서버가 잘못 계산해도, 서버를 우회해도 옵션은 등록가를 넘지 못한다.
create or replace function public.quote_item_fill_from_source()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_product   record;
  v_option    record;
  v_quote_pid uuid;
begin
  select q.product_id into v_quote_pid from public.quotes q where q.id = new.quote_id;

  if new.item_type = 'option' then
    select o.id, o.name, o.price, o.is_mandatory, o.product_id
      into v_option
    from public.product_options o
    where o.id = new.product_option_id;

    if v_option.id is null then
      raise exception '등록되지 않은 추가금은 견적에 넣을 수 없습니다.'
        using errcode = 'foreign_key_violation';
    end if;

    -- 옵션은 그 견적의 상품에 속한 것이어야 한다. 남의 상품 옵션을 끌어오면
    -- "등록된 항목만" 이라는 규칙이 이름만 남는다.
    if v_option.product_id is distinct from v_quote_pid then
      raise exception '이 견적의 상품에 등록되지 않은 추가금입니다.'
        using errcode = 'check_violation';
    end if;

    new.product_id        := v_option.product_id;
    new.label             := v_option.name;
    new.is_option         := true;
    new.is_mandatory      := v_option.is_mandatory;
    -- **상한은 DB 가 정한다.** 클라이언트·서버가 보낸 값을 쓰지 않는다.
    new.cap_amount        := v_option.price;
  else
    select p.id, p.name, p.category into v_product
    from public.products p
    where p.id = new.product_id;

    if v_product.id is null then
      raise exception '등록되지 않은 상품은 견적에 넣을 수 없습니다.'
        using errcode = 'foreign_key_violation';
    end if;

    if new.product_id is distinct from v_quote_pid then
      raise exception '견적의 상품과 다른 상품은 항목이 될 수 없습니다.'
        using errcode = 'check_violation';
    end if;

    new.product_option_id := null;
    new.label             := v_product.name;
    new.category_code     := v_product.category;
    new.is_option         := false;
    new.is_mandatory      := true;
  end if;

  if new.item_type = 'option' then
    new.category_code := coalesce(
      (select p.category from public.products p where p.id = new.product_id),
      new.category_code
    );
  end if;

  return new;
end;
$$;

comment on function public.quote_item_fill_from_source() is
  '견적 항목의 이름·분류·옵션 상한을 참조된 상품·추가금에서 다시 읽어 덮어쓴다. 자유 양식 견적을 스키마 수준에서 불가능하게 만드는 장치다(F-V-07).';

drop trigger if exists trg_quote_items_fill on public.quote_items;
create trigger trg_quote_items_fill
  before insert or update on public.quote_items
  for each row execute function public.quote_item_fill_from_source();

-- -----------------------------------------------------------------------------
-- 트리거 — 견적을 보내면 그 업체의 문의 상태가 '응답'으로 바뀐다
-- -----------------------------------------------------------------------------
-- 앱이 두 번 쓰게 두면 한쪽이 빠지는 날이 오고, 그날 SLA 는 답한 업체를 지연으로 센다.
create or replace function public.inquiry_target_mark_responded()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status <> 'sent' then return null; end if;

  update public.inquiry_targets t
     set status = 'responded',
         responded_at = coalesce(t.responded_at, coalesce(new.sent_at, now()))
   where t.id = new.inquiry_target_id
     and t.status in ('pending', 'expired');

  return null;
end;
$$;

comment on function public.inquiry_target_mark_responded() is
  '견적 발송이 곧 응답이다. 상태를 앱이 따로 쓰지 않게 해 SLA 판정이 앱의 성실함에 기대지 않도록 한다.';

drop trigger if exists trg_quotes_mark_responded on public.quotes;
create trigger trg_quotes_mark_responded
  after insert or update of status on public.quotes
  for each row execute function public.inquiry_target_mark_responded();

-- -----------------------------------------------------------------------------
-- 트리거 — '응답' 상태를 손으로 적을 수 없다
-- -----------------------------------------------------------------------------
-- 업체가 견적 없이 responded 로 바꾸면 SLA 를 스스로 끄는 셈이다. 응답은 견적이
-- 있어야 응답이다. (서비스롤·트리거 경로는 auth.uid() 가 없으므로 통과한다.)
create or replace function public.assert_inquiry_target_response()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if new.status <> 'responded' or old.status = 'responded' then return new; end if;

  if not exists (
    select 1 from public.quotes q
    where q.inquiry_target_id = new.id and q.status <> 'draft'
  ) then
    raise exception '견적을 보내야 응답으로 바뀝니다.' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.assert_inquiry_target_response() is
  '견적 없는 응답 처리를 막는다. 업체가 SLA 시계를 스스로 끌 수 있으면 SLA 가 아니다.';

drop trigger if exists trg_inquiry_targets_response on public.inquiry_targets;
create trigger trg_inquiry_targets_response
  before update on public.inquiry_targets
  for each row execute function public.assert_inquiry_target_response();

-- =============================================================================
-- 5) 권한 — 견적 쓰기를 서버로 좁힌다 (위 4번 근거)
-- =============================================================================
-- 0005 가 만든 쓰기 정책을 걷어낸다. 정책만 남겨 두면 "정책이 있으니 쓸 수 있다" 로
-- 읽히는데 실제로는 권한이 없어 실패한다 — 읽는 사람을 헷갈리게 하는 상태다.
drop policy if exists quotes_insert on public.quotes;
drop policy if exists quotes_update on public.quotes;
drop policy if exists quote_items_insert on public.quote_items;
drop policy if exists quote_items_update on public.quote_items;

-- **권한 회수**로 못박는다. 정책의 부재만으로는 실패가 조용한 0행이라
-- "보냈다" 고 믿는 코드가 생긴다(0019·0021 과 같은 판단).
revoke insert, update, delete on public.quotes from authenticated, anon;
revoke insert, update, delete on public.quote_items from authenticated, anon;

comment on table public.quotes is
  '표준 견적서(F-V-07). **자유 텍스트 견적 금지** — 항목은 등록된 상품·추가금 참조로만 만들어지고(quote_items), 금액은 price_rules 상한 이하만 허용한다. 쓰기는 서비스롤 전용이다: 상한 계산이 lib/core/pricing 의 순수 함수라 DB 가 스스로 검증할 수 없기 때문이다(0024 주석 4번).';
comment on table public.quote_items is
  '견적 항목. 이름·분류는 트리거가 참조된 상품·추가금에서 덮어쓰고, 금액은 상한 이하만 허용한다. 자유 양식이 들어올 자리가 없다.';

-- `quote_items` 의 SELECT 정책은 상위 견적 스코프를 그대로 따르는데(0005 [30]),
-- 그 정책이 `exists (select 1 from quotes ...)` 라 quotes 의 RLS 를 다시 탄다.
-- 견적을 볼 수 있으면 항목도 보인다 — 그대로 둔다.

-- 문의 상태는 커플이 바꾸되(거두기·닫기), 업체는 자기 target 만 만진다.
-- `inquiry_targets` 는 업체가 status·거절 사유·열람 시각만 건드리면 된다.
-- 나머지(sla_deadline·responded_at)는 서버가 정하는 값이라 컬럼 권한으로 좁힌다.
revoke update on public.inquiry_targets from authenticated, anon;
grant update (status, decline_reason_code, declined_at, first_viewed_at)
  on public.inquiry_targets to authenticated;

-- =============================================================================
-- 5b) **정책 재귀 해소** — 0005 가 남긴 잠복 결함
-- -----------------------------------------------------------------------------
-- 0005 의 정책 두 개가 **서로를 조회한다.**
--   inquiries_select        → `exists (select 1 from inquiry_targets ...)`
--   inquiry_targets_select  → `exists (select 1 from inquiries ...)`
-- 정책 안의 하위 질의도 그 표의 RLS 를 다시 타므로, 둘 중 어느 쪽을 읽어도
-- `infinite recursion detected in policy` 로 끊긴다. `quotes`·`quote_items` 도
-- 그 둘을 조인하므로 같이 무너진다.
--
-- **지금까지 드러나지 않은 이유**는 이 표들을 읽는 코드가 없었기 때문이다(T-03 이
-- 만들고 S4-12 가 처음 쓴다). 스키마만 있고 소비처가 없는 구간에서는 이런 결함이
-- 조용히 남는다 — S4-12 의 `db:rls` 가 첫 조회를 시도하면서 잡혔다.
--
-- **고치는 방법은 이 리포가 이미 쓰던 것과 같다** — 하위 질의를 `security definer`
-- 헬퍼로 감싸 RLS 재평가를 끊는다(0005 의 `is_couple_member`, 0016 의
-- `cart_couple_id`, 0021 의 `chat_room_couple_id` 와 같은 방식).
--
-- **판정 내용은 그대로 둔다.** 누가 무엇을 볼 수 있는지는 한 글자도 바꾸지 않았다 —
-- 재귀만 끊는다. (커플 쪽이 `is_couple_member` 라 플래너 멤버 행도 참으로 보는 문제는
-- 0005 가 정한 것이고, 바꾸려면 별도 판단이 필요하므로 여기서 건드리지 않는다.)
-- =============================================================================
create or replace function public.inquiry_couple_id(p_inquiry_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select i.couple_id from public.inquiries i where i.id = p_inquiry_id;
$$;

create or replace function public.is_inquiry_vendor(p_inquiry_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.inquiry_targets t
    where t.inquiry_id = p_inquiry_id and public.is_vendor_member(t.vendor_id)
  );
$$;

create or replace function public.target_vendor_id(p_target_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select t.vendor_id from public.inquiry_targets t where t.id = p_target_id;
$$;

create or replace function public.target_couple_id(p_target_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select i.couple_id
  from public.inquiry_targets t
  join public.inquiries i on i.id = t.inquiry_id
  where t.id = p_target_id;
$$;

create or replace function public.quote_target_id(p_quote_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select q.inquiry_target_id from public.quotes q where q.id = p_quote_id;
$$;

comment on function public.is_inquiry_vendor(uuid) is
  '이 문의를 받은 업체의 멤버인가. 정책 안에서 inquiry_targets 를 직접 읽으면 그 표의 정책이 다시 inquiries 를 읽어 무한 재귀가 된다(0005 잠복 결함, S4-12 에서 발견).';

drop policy if exists inquiries_select on public.inquiries;
create policy inquiries_select on public.inquiries for select to authenticated
  using (public.is_couple_member(couple_id) or public.is_inquiry_vendor(id));

drop policy if exists inquiry_targets_select on public.inquiry_targets;
create policy inquiry_targets_select on public.inquiry_targets for select to authenticated
  using (
    public.is_vendor_member(vendor_id)
    or public.is_couple_member(public.inquiry_couple_id(inquiry_id))
  );

drop policy if exists inquiry_targets_insert on public.inquiry_targets;
create policy inquiry_targets_insert on public.inquiry_targets for insert to authenticated
  with check (public.is_couple_member(public.inquiry_couple_id(inquiry_id)));

drop policy if exists inquiry_targets_update on public.inquiry_targets;
create policy inquiry_targets_update on public.inquiry_targets for update to authenticated
  using (public.is_vendor_member(vendor_id))
  with check (public.is_vendor_member(vendor_id));

drop policy if exists quotes_select on public.quotes;
create policy quotes_select on public.quotes for select to authenticated
  using (
    public.is_vendor_member(public.target_vendor_id(inquiry_target_id))
    or public.is_couple_member(public.target_couple_id(inquiry_target_id))
    or public.has_planner_scope(public.target_couple_id(inquiry_target_id), 'quotes')
  );

-- 견적 항목은 상위 견적 스코프를 그대로 따른다. 0005 는 `exists (select 1 from quotes)`
-- 로 적었는데, 그 하위 질의가 quotes 정책을 타고 다시 재귀에 걸린다.
drop policy if exists quote_items_select on public.quote_items;
create policy quote_items_select on public.quote_items for select to authenticated
  using (
    public.is_vendor_member(public.target_vendor_id(public.quote_target_id(quote_id)))
    or public.is_couple_member(public.target_couple_id(public.quote_target_id(quote_id)))
    or public.has_planner_scope(
      public.target_couple_id(public.quote_target_id(quote_id)), 'quotes'
    )
  );

-- =============================================================================
-- 6) 운영 파라미터 (§7.4 — 코드에 박지 않는다)
-- =============================================================================
insert into public.app_settings (key, value_json, description)
values
  (
    'inquiry.max_targets',
    '{"max": 5}'::jsonb,
    '1:N 문의의 동시 발송 상한(F-C-13 "최대 5개 업체 동시"). 명세가 든 값이지만 코드에 박지 않는다 — 운영이 배포 없이 조정한다.'
  ),
  (
    'inquiry.sla_response_minutes',
    '{"minutes": 2880, "warnPercent": 75}'::jsonb,
    '문의 응답 SLA(F-V-07). minutes 를 넘기면 지연, warnPercent 지점부터 임박. 초기 운영값 48시간 — 견적은 채팅 답장보다 품이 드는 일이라 채팅(24시간)보다 길게 잡았다.'
  )
on conflict (key) do nothing;

-- =============================================================================
-- 7) 알림 토픽에 `inquiry` 추가
-- =============================================================================
-- 0023 이 남긴 경고 그대로다 — 토픽 목록은 이 CHECK 와
-- `lib/core/schemas/notification.ts` **양쪽**에 있으므로 함께 고친다.
-- (S4-04 에서 한쪽만 늘렸다가 알림이 조용히 실패했고, 그 뒤 `db:rls` 에 정합 검사를
--  넣어 두었다. 이번에는 그 검사가 지켜본다.)
alter table public.notifications drop constraint if exists notifications_topic_chk;

alter table public.notifications
  add constraint notifications_topic_chk
  check (
    topic in (
      'dday', 'schedule', 'contract', 'care', 'price_change', 'couple_invite',
      'chat',
      -- S4-12. 문의 도착(업체) · 견적 도착(고객) · 거절 · 만료.
      'inquiry'
    )
  );

-- =============================================================================
-- 8) 문의게시판 유사 질문 검색 (S4-05 · F-C-28)
-- =============================================================================
-- 0021 이 "trigram·tsvector·임베딩 중 무엇을 쓰느냐가 인덱스 모양을 정하므로 미리
-- 고르지 않았다" 며 S4-05 에 넘긴 판단이다. **pg_trgm 을 고른다.**
--
--  · **tsvector 는 한국어에서 못 쓴다.** 형태소 분석기 없이 `simple` 설정으로는 공백
--    단위로만 쪼개져서 "주차 가능한가요" 와 "주차장 있나요" 가 한 토큰도 겹치지 않는다.
--  · **임베딩은 여기서 고를 문제가 아니다.** pgvector 확장과 질문마다의 AI 호출이
--    필요하고, 그건 AI 파이프라인(§5)의 결정이지 게시판 화면의 결정이 아니다.
--  · **trigram 은 문자 3-gram 이라 형태소 분석기 없이도 한국어 부분 일치를 잡는다.**
--    pg_trgm 은 PostgreSQL 기본 제공 확장이라 새 의존성이 아니다(0001 이 pgcrypto 를
--    같은 방식으로 켰다).
create extension if not exists pg_trgm;

-- 제목과 본문을 함께 본다 — 제목만 보면 "이거 되나요?" 같은 제목이 전부 비슷해진다.
create index if not exists idx_qna_posts_similarity
  on public.qna_posts using gin ((title || ' ' || body) gin_trgm_ops);

comment on index public.idx_qna_posts_similarity is
  '유사 질문 노출(F-C-28)의 검색 경로. 한국어라 형태소 분석기가 필요한 tsvector 대신 문자 3-gram(pg_trgm)을 쓴다.';

-- =============================================================================
-- 이 파일이 한 것
--   ALTER  inquiries +7컬럼 / inquiry_targets +3 / quotes +7(생성 1 포함) /
--          quote_items +5(생성 1 포함). quotes.product_id 를 NOT NULL + restrict 로
--   CHECK  12 — 문의 상태·닫힘 짝·하객수·예산 / 대상 상태·거절 짝·거절 상태·응답 상태 /
--          **견적 상한 초과 금지** · 견적 상태 · 발송 짝 / **항목 출처 강제** ·
--          **항목 상한 초과 금지**
--   트리거 3 — 항목 이름·분류·옵션 상한 덮어쓰기 / 견적 발송 시 응답 처리 /
--              견적 없는 응답 처리 차단
--   GRANT  quotes·quote_items 쓰기 권한 회수(서비스롤 전용) ·
--          inquiry_targets UPDATE 를 4컬럼으로 좁힘
--   정책   0005 의 견적 쓰기 정책 4개 제거(권한 회수와 짝)
--   인덱스 8(부분 4 포함) · 확장 1(pg_trgm) · GIN 인덱스 1
--   app_settings 2행 · notifications 토픽 CHECK 교체
--   신규 테이블 없음. 기존 마이그레이션 파일 수정 없음
-- =============================================================================
