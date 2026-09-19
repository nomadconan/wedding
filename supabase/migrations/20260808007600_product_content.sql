-- =============================================================================
-- 0076 상품 본문·사진 (C-2b)
--   명세서 §3.3 「C 단계가 상품 쪽에 더하는 칸」 · §2.2 F-V-03 · §4.3
--   FIX-75(파는 축 본체에 CHECK 이 없다)를 같은 회차에 닫는다.
--
-- ── 이 마이그레이션이 **일부러 하지 않는 것** ────────────────────────────────
-- **게시 조건(`products_publish_requirements_chk`)을 건드리지 않는다.**
-- 사진·본문을 게시 필수로 걸면 **이미 게시된 상품이 그 순간 전부 위반**이 되고,
-- CHECK 은 기존 행을 즉시 검사하므로 **이 마이그레이션 자체가 실패**한다. 설령
-- `not valid` 로 피해 가더라도 다음 수정에서 그 상품들이 게시를 잃는다.
-- C-2b 의 완료 조건이 바로 **"기존 게시 상품이 내려가지 않는다"** 이므로,
-- 본문·사진은 **게시 차단 사유가 아니라 '완성도 권유'** 로 다룬다
-- (`productContentSuggestions` — `lib/core/product/content.ts`).
-- 필수로 돌리려면 **이행 계획이 먼저** 서야 한다(기존 행을 채우는 절차 + 유예 기한).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. products — 본문 두 칸
-- -----------------------------------------------------------------------------
-- 둘 다 nullable 이다. NOT NULL 로 두면 기존 행이 전부 걸린다(위 문단과 같은 이유).
alter table public.products
  add column if not exists summary          text,
  add column if not exists description_json jsonb;

comment on column public.products.summary is
  '한 줄 소개(C-2b). 목록·카드에서 쓰는 짧은 문장이며 본문과 별개다.';
comment on column public.products.description_json is
  '상품 본문(C-2b). {"v":1,"source":"<마크다운>"} 봉투다. **블록을 저장하지 않는다** — '
  '블록은 source 에서 계산되며(lib/core/content/markdown.ts · D-97) 계산 가능한 값을 '
  '저장하면 둘이 갈리는 날 어느 쪽이 맞는지 답할 수 없다.';

-- 빈 문자열을 "적었다" 로 세지 않는다. 비우려면 null 이다.
alter table public.products
  add constraint products_summary_shape_chk
  check (summary is null or length(btrim(summary)) between 1 and 300);

-- 본문 봉투 모양. **HTML 문자열을 담는 자리가 아니다**(D-97) — source 는 마크다운이고
-- 화면은 파서가 돌려준 블록을 React 로 그린다.
alter table public.products
  add constraint products_description_shape_chk
  check (
    description_json is null
    or (
      jsonb_typeof(description_json) = 'object'
      and jsonb_typeof(description_json -> 'v') = 'number'
      and jsonb_typeof(description_json -> 'source') = 'string'
      and length(btrim(description_json ->> 'source')) between 1 and 8000
    )
  );

-- -----------------------------------------------------------------------------
-- 2. vendor_media — 상품에 붙는 사진
-- -----------------------------------------------------------------------------
-- **표를 새로 만들지 않는다**(§3.3 NOTE). 두 벌이 되면 Storage 정책도 두 벌이 되고
-- 그 둘이 갈리는 날 어느 쪽이 맞는지 답할 수 없다.
alter table public.vendor_media
  add column if not exists product_id uuid;

comment on column public.vendor_media.product_id is
  'null 이면 업체 사진, 값이 있으면 그 상품의 사진(C-2b).';

-- **남의 업체 상품에 사진을 붙이지 못하게 한다.**
-- 단일 FK(`references products(id)`)로는 "그 상품이 내 업체 것인가" 를 못 본다.
-- 복합 FK 로 두면 **선언만으로** 같은 업체임이 강제된다 — 트리거로 흉내 내지 않는다.
-- (MATCH SIMPLE 기본값이라 product_id 가 null 이면 검사하지 않는다 = 업체 사진.)
alter table public.products
  add constraint products_id_vendor_uk unique (id, vendor_id);

alter table public.vendor_media
  add constraint vendor_media_product_same_vendor_fk
  foreign key (product_id, vendor_id)
  references public.products (id, vendor_id)
  on delete cascade;

create index if not exists idx_vendor_media_product_sort
  on public.vendor_media (product_id, sort_order)
  where product_id is not null;

-- -----------------------------------------------------------------------------
-- 3. vendor_media RLS — 초안 상품의 사진이 새지 않게 한다 (층 2)
-- -----------------------------------------------------------------------------
-- **기존 공개 정책은 업체가 active 인지만 본다.** 그대로 두고 product_id 를 더하면
-- **초안 상품의 사진이 비로그인에게 보인다** — 아직 팔지 않기로 한 것이 공개된다.
--
-- 부모(products)의 정책에 기대지 않고 **여기서 status 를 직접 본다.** 기대면
-- `products` 의 공개 조건이 넓어지는 날 이쪽도 같이 넓어지고, 그때 아무도 모른다
-- (C-3 가 `product_options_select_public` 을 기록으로 남긴 것과 같은 자리다).
drop policy if exists vendor_media_select_public on public.vendor_media;
create policy vendor_media_select_public on public.vendor_media for select to anon, authenticated
  using (
    exists (
      select 1 from public.vendors v
      where v.id = vendor_media.vendor_id and v.status = 'active'
    )
    and (
      vendor_media.product_id is null
      or exists (
        select 1 from public.products p
        where p.id = vendor_media.product_id and p.status = 'published'
      )
    )
  );

-- 쓰기 — **상품 사진은 owner 전용이고 업체 사진은 멤버 그대로다.**
--
-- 왜 가르는가: `products` 의 쓰기가 이미 owner 전용이다(가격 표라서). 상품의 **공개
-- 표현**도 같은 사람의 책임으로 둔다 — 이름은 못 고치는데 대표 사진은 갈아 끼울 수
-- 있으면 그 경계가 말이 안 된다. 업체 사진(product_id is null)은 **기존 동작을 바꾸지
-- 않는다** — staff 가 계속 다룰 수 있다.
--
-- `using` 과 `with check` 를 **둘 다** 좁힌다. `with check` 는 **바뀐 뒤의 행**만 보므로
-- 그것만 좁히면 staff 가 상품 사진 행을 **업체 사진으로 떼어 내는** 길이 열리고,
-- `using` 만 좁히면 staff 가 자기 업체 사진에 **product_id 를 붙여** 상품 사진을
-- 만들어 낼 수 있다.
drop policy if exists vendor_media_insert on public.vendor_media;
create policy vendor_media_insert on public.vendor_media for insert to authenticated
  with check (
    public.is_vendor_member(vendor_id)
    and (product_id is null or public.is_vendor_owner(vendor_id))
  );

drop policy if exists vendor_media_update on public.vendor_media;
create policy vendor_media_update on public.vendor_media for update to authenticated
  using (
    public.is_vendor_member(vendor_id)
    and (product_id is null or public.is_vendor_owner(vendor_id))
  )
  with check (
    public.is_vendor_member(vendor_id)
    and (product_id is null or public.is_vendor_owner(vendor_id))
  );

drop policy if exists vendor_media_delete on public.vendor_media;
create policy vendor_media_delete on public.vendor_media for delete to authenticated
  using (
    public.is_vendor_member(vendor_id)
    and (product_id is null or public.is_vendor_owner(vendor_id))
  );

-- -----------------------------------------------------------------------------
-- 4. Storage — vendor-media 버킷을 조인다
-- -----------------------------------------------------------------------------
-- 지금 이 버킷은 **크기·형식 제한이 없다**(둘 다 null = 무제한). 업로드는 서버가
-- 발급한 서명 URL 로만 하지만, 서명 URL 은 **무엇을 올리는지 보지 않는다** — 발급
-- 시점에 파일이 없기 때문이다. 그래서 **Storage 자신이 막게 한다.**
--
-- **`image/svg+xml` 을 넣지 않는다.** 공개 버킷의 SVG 는 스크립트를 품을 수 있고
-- 같은 출처로 열리면 그대로 XSS 다. 이 목록을 운영 파라미터로 빼지 않는 이유도
-- 같다 — **형식 허용목록은 보안 경계이지 운영 손잡이가 아니다.**
update storage.buckets
   set file_size_limit = 20971520, -- 20MB
       allowed_mime_types = array[
         'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif',
         'video/mp4', 'video/webm', 'video/quicktime'
       ]
 where id = 'vendor-media';

-- -----------------------------------------------------------------------------
-- 5. FIX-75 — 파는 축 본체에 어휘 CHECK 을 건다
-- -----------------------------------------------------------------------------
-- `is_vendor_category()` 는 C-2a(0075)가 이미 만들었다. 여기서는 **거는 일만** 한다.
--
-- `not valid` 로 걸고 곧바로 `validate` 하는 이유: 두 문장으로 나누면 **기존 행이
-- 어긋났을 때 어느 단계에서 멈췄는지**가 분명하다. 지금 값은 전부 `hall` 이라
-- validate 가 통과하지만, 이 순서를 남겨 두면 나중에 실데이터에서 막혔을 때
-- `not valid` 상태로 **새 행만 막으면서** 기존 행 이행을 따로 할 수 있다.
-- **기존 행을 조용히 바꾸지 않는다** — 업체를 임의로 재분류하는 것이 더 나쁘다.
alter table public.products
  add constraint products_category_vocab_chk
  check (public.is_vendor_category(category)) not valid;
alter table public.products validate constraint products_category_vocab_chk;

alter table public.vendors
  add constraint vendors_category_vocab_chk
  check (public.is_vendor_category(category)) not valid;
alter table public.vendors validate constraint vendors_category_vocab_chk;

-- -----------------------------------------------------------------------------
-- 6. 운영 파라미터 — 상품당 사진 개수
-- -----------------------------------------------------------------------------
-- **개수는 운영 손잡이**라 여기 둔다(형식·크기와 다르다 — 그 둘은 위에서 Storage 가
-- 막는 보안 경계다). 행이 없으면 코드가 기본값을 지어내지 않고 **업로드를 거절한다**.
insert into public.app_settings (key, value_json, description)
values (
  'products.media_max_per_product',
  '{"max": 12, "unit": "files"}'::jsonb,
  '상품 하나에 붙일 수 있는 사진 개수 상한(C-2b). 무제한이면 상품 상세 로딩이 업체 '
  '입력에 좌우된다. **행이 없으면 업로드를 거절한다** — 코드가 상한을 지어내면 '
  '운영이 정한 적 없는 값이 기준처럼 굳는다. 형식·용량은 여기서 정하지 않는다: '
  'vendor-media 버킷의 allowed_mime_types·file_size_limit 이 Storage 층에서 막는다.'
)
on conflict (key) do nothing;

-- =============================================================================
-- 이 파일이 한 것
--   ALTER  products      + 2컬럼(summary, description_json), CHECK 2(모양),
--                          UNIQUE 1(id, vendor_id — 복합 FK 의 대상),
--                          CHECK 1(category 어휘 · FIX-75)
--   ALTER  vendors       + CHECK 1(category 어휘 · FIX-75)
--   ALTER  vendor_media  + 1컬럼(product_id), 복합 FK 1(같은 업체 강제), 인덱스 1
--   RLS    vendor_media  정책 4개 재작성(공개 열람에 게시 조건 · 쓰기에 owner 조건)
--   Storage vendor-media 크기 20MB · MIME 허용목록(SVG 제외)
--   app_settings +1행(products.media_max_per_product)
--   **게시 조건(products_publish_requirements_chk)은 건드리지 않았다**
-- =============================================================================
