// =============================================================================
// 커플 데이터 RLS 격리 점검 (S3-01) — **로컬 전용**
// -----------------------------------------------------------------------------
// docs/TASKS.md 의 부채 "RLS 통합 테스트 미커밋" 을 갚는다. T-03·S3-01 이 세운
// 커플 정책이 실제로 격리를 만들어 내는지 psql 세션을 전환해 확인한다.
//
// **왜 psql 인가.** RLS 는 앱 코드가 아니라 DB 가 판정한다. 앱을 통해서만 확인하면
// "라우트가 막았는지, DB 가 막았는지" 를 구분할 수 없다. 여기서는 `set local role
// authenticated` + `request.jwt.claims` 로 사용자를 갈아 끼워 DB 만 시험한다.
//
// 실행:  npm run db:rls        (먼저 npm run db:reset && npm run seed:accounts)
// =============================================================================
import { execFileSync } from "node:child_process";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// 안전장치 — 원격 프로젝트에 붙은 상태면 즉시 중단한다.
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL_)) {
  console.error(`이 스크립트는 로컬 전용이다. NEXT_PUBLIC_SUPABASE_URL=${URL_ || "(없음)"}`);
  process.exit(1);
}

const container = execFileSync("docker", [
  "ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}",
]).toString().trim().split(/\r?\n/)[0];

if (!container) {
  console.error("supabase_db_* 컨테이너가 없다. npm run db:start 를 먼저 실행한다.");
  process.exit(1);
}

/**
 * psql 을 한 번 실행하고 결과를 값 하나로 돌려준다.
 *
 *  -A -t  구분자·헤더 없이 값만
 *  -q     BEGIN·SET·ROLLBACK 같은 명령 태그를 찍지 않는다 — 없으면 값에 섞인다
 *  -v ON_ERROR_STOP=1
 *         **없으면 psql 은 SQL 이 실패해도 종료 코드 0 을 돌려준다.** 그러면
 *         "거절돼야 정상" 인 검사(42501·유니크 위반)가 통과로 둔갑한다.
 *         오류로 끊기면 트랜잭션은 커밋되지 않으므로 rollback 을 못 타도 안전하다.
 *
 * `stdio` 를 전부 pipe 로 고정한다. execFileSync 는 stderr 를 부모로 흘려보내는 것이
 * 기본이라, 그대로 두면 **에러 메시지를 코드에서 읽을 수 없다**(아래 42501 판정이 필요하다).
 */
function sql(text) {
  return execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
      "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
    { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

/**
 * 특정 사용자 세션으로 실행한다. 트랜잭션을 되돌려 DB 를 더럽히지 않는다.
 *
 * `setup` 은 **역할을 바꾸기 전에** postgres 로 실행된다(RLS 를 지나간다).
 * 시험용 데이터를 만들 때 쓴다 — 같은 트랜잭션이라 rollback 으로 함께 사라진다.
 * 역할은 한 번 내려가면 되돌릴 수 없으므로 setup 이 먼저다.
 */
function asUser(userId, body, setup = "") {
  return sql(
    `begin;\n` +
    `${setup ? `${setup}\n` : ""}` +
    `set local role authenticated;\n` +
    `set local request.jwt.claims = '${JSON.stringify({
      sub: userId, role: "authenticated", aud: "authenticated",
    })}';\n` +
    `${body}\n` +
    `rollback;`,
  );
}

/** anon(비로그인) 세션. 공개 데이터 외에는 아무것도 보이면 안 된다. */
function asAnon(body, setup = "") {
  return sql(
    `begin;\n` +
    `${setup ? `${setup}\n` : ""}` +
    `set local role anon;\n` +
    `set local request.jwt.claims = '{"role":"anon"}';\n` +
    `${body}\n` +
    `rollback;`,
  );
}

/** 거절돼야 정상인 문장. 기대한 사유로 끊겼으면 true. */
function rejectedWith(pattern, run) {
  try {
    run();

    return false;
  } catch (error) {
    return pattern.test(String(error.stderr ?? error));
  }
}

const results = [];
const check = (label, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` :: ${detail}` : ""}`);
};

// ── 대상 계정 ────────────────────────────────────────────────────────────────
const users = await (
  await fetch(`${URL_}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  })
).json();

const idOf = (email) => users.users?.find((u) => u.email === email)?.id ?? null;

const owner = idOf("couple-a@local.test");
const partner = idOf("couple-b@local.test");
const outsider = idOf("vendor@local.test");
// 플래너 위임 시험용. 커플 구성원만 아니면 된다 — 플래너 판정은 couple_members 가
// 아니라 planner_engagements 로만 이뤄지고, 그것을 확인하는 것이 이 검사의 목적이다.
const vendorStaff = idOf("staff@local.test");
// 채팅·문의(S4-01)는 **네 종류의 남**이 필요하다: 타 커플 당사자 · 타 업체 멤버 ·
// 위임받은 플래너 · 운영자. 시드 계정 6개로 그 넷을 다 세우려면 아래처럼 겹쳐 쓴다.
const adminUser = idOf("admin@local.test");
const opsUser = idOf("ops@local.test");

if (!owner || !partner || !outsider) {
  console.error("시드 계정이 없다. npm run seed:accounts 를 먼저 실행한다.");
  process.exit(1);
}

const coupleId = sql("select id from public.couples limit 1;");

if (!coupleId) {
  console.error(
    "커플 데이터가 없다. 로그인 후 /onboarding 을 한 번 진행하거나 tmp 플로우 스크립트를 돌린 뒤 실행한다.",
  );
  process.exit(1);
}

const memberOf = sql(
  `select count(*) from public.couple_members
     where couple_id = '${coupleId}' and user_id = '${partner}' and member_role = 'partner';`,
);

// ── 1) 당사자는 본다 ─────────────────────────────────────────────────────────
check("소유자는 자기 커플을 본다", asUser(owner, "select count(*) from public.couples;") === "1");
check("소유자는 답변을 본다", Number(asUser(owner, "select count(*) from public.onboarding_answers;")) > 0);

if (memberOf === "1") {
  check("배우자도 같은 커플을 본다", asUser(partner, "select count(*) from public.couples;") === "1");

  // 배우자도 커플 정보를 고칠 수 있어야 한다(F-C-02). UPDATE 는 막혀도 에러가 아니라
  // 0 행으로 끝나므로 **반영된 행 수**로 확인한다.
  check(
    "배우자의 수정이 반영된다 (couples_update = 당사자)",
    asUser(partner, `with u as (update public.couples set region_code = 'RLS점검' returning id)
       select count(*) from u;`) === "1",
  );

  // 삭제는 소유자 전용이다.
  check(
    "배우자는 커플을 지울 수 없다",
    asUser(partner, `with d as (delete from public.couples returning id) select count(*) from d;`) === "0",
  );
} else {
  console.log("SKIP  배우자 항목 — 연동된 partner 가 없다");
}

// ── 2) 남은 못 본다 ──────────────────────────────────────────────────────────
for (const [label, table] of [
  ["남은 남의 커플을 못 본다", "couples"],
  ["남은 남의 온보딩 답변을 못 본다", "onboarding_answers"],
  ["남은 남의 커플 멤버를 못 본다", "couple_members"],
  ["남은 남의 초대 코드를 못 본다", "couple_invites"],
]) {
  check(label, asUser(outsider, `select count(*) from public.${table};`) === "0");
}

check(
  "남의 수정은 한 행도 반영되지 않는다",
  asUser(outsider, `with u as (update public.couples set region_code = '침입' returning id)
     select count(*) from u;`) === "0",
);

// 끼어들기는 에러(42501)로 끊겨야 한다 — 조용한 0 행이 아니라 거절이어야 한다.
check(
  "남은 남의 커플에 멤버로 끼어들 수 없다 (42501)",
  rejectedWith(/row-level security/i, () =>
    asUser(outsider, `insert into public.couple_members (couple_id, user_id, member_role)
       values ('${coupleId}', '${outsider}', 'partner');`)),
);

// ── 3) 한 사람 한 커플 ───────────────────────────────────────────────────────
check(
  "한 사람은 커플 하나에만 속한다 (부분 유니크)",
  memberOf !== "1" || rejectedWith(/uq_couple_members_single_couple/, () =>
    sql(`begin;
      insert into public.couples (id, owner_id, stage)
        values ('00000000-0000-0000-0000-0000000000ff', '${outsider}', 'onboarding');
      insert into public.couple_members (couple_id, user_id, member_role)
        values ('00000000-0000-0000-0000-0000000000ff', '${partner}', 'partner');
      rollback;`)),
);

// =============================================================================
// 장바구니 · 찜 (S3-04)
// -----------------------------------------------------------------------------
// 시험용 업체·상품·장바구니는 **트랜잭션 안에서 만들고 함께 되돌린다.**
// 시드에 넣지 않는 이유는 `docs/06` §5-1 에 적어 뒀다 — 장바구니는 커플에 매달리고,
// 커플은 온보딩을 밟아야 생긴다. 시드가 미리 만들면 온보딩 첫 화면을 볼 수 없게 된다.
// =============================================================================
const V = "00000000-0000-0000-0000-00000000c001"; // vendor
const P1 = "00000000-0000-0000-0000-00000000c002"; // product
const P2 = "00000000-0000-0000-0000-00000000c003"; // product (다른 상품)
const CART = "00000000-0000-0000-0000-00000000c004";
const PLANNER = "00000000-0000-0000-0000-00000000c005";

/** 커플에 장바구니 1건 + 항목 1건 + 찜 1건을 붙인다. */
const cartFixture = `
  -- 앞선 확인이 남긴 진짜 장바구니·찜을 먼저 치운다. 같은 트랜잭션이라 롤백으로 되돌아온다
  -- (활성 장바구니는 커플당 하나이므로 지우지 않으면 부분 유니크에 걸린다).
  delete from public.carts where couple_id = '${coupleId}';
  delete from public.wishlists where couple_id = '${coupleId}';
  insert into public.vendors (id, name, category, status)
    values ('${V}', 'RLS점검업체', 'hall', 'active');
  insert into public.products (id, vendor_id, category, name, base_price_total)
    values ('${P1}', '${V}', 'hall', 'RLS점검상품', 10000000),
           ('${P2}', '${V}', 'hall', 'RLS점검상품2', 20000000);
  insert into public.carts (id, couple_id, status)
    values ('${CART}', '${coupleId}', 'active');
  insert into public.cart_items (cart_id, vendor_id, product_id, options_json, added_by, price_at_add)
    values ('${CART}', '${V}', '${P1}', '{"a":1,"b":2}'::jsonb, '${owner}', 10000000);
  insert into public.wishlists (couple_id, vendor_id, product_id, added_by, price_at_add)
    values ('${coupleId}', '${V}', '${P2}', '${owner}', 20000000);
`;

/** 위 픽스처에 더해, 플래너 위임까지 붙인다(범위: carts·wishlists). */
const plannerFixture = `${cartFixture}
  insert into public.planners (id, user_id, status)
    values ('${PLANNER}', '${vendorStaff ?? outsider}', 'active');
  insert into public.planner_engagements (planner_id, couple_id, scope_json, status, valid_from, valid_to)
    values ('${PLANNER}', '${coupleId}', '{"tables":["carts","wishlists"]}'::jsonb,
            'active', now() - interval '1 day', now() + interval '30 days');
`;

// ── 당사자 양측 ──────────────────────────────────────────────────────────────
check(
  "담은 사람은 자기 장바구니를 본다",
  asUser(owner, `select count(*) from public.cart_items;`, cartFixture) === "1",
);
check(
  "찜도 본다",
  asUser(owner, `select count(*) from public.wishlists;`, cartFixture) === "1",
);

if (memberOf === "1") {
  check(
    "배우자도 같은 장바구니를 본다 (커플 공유 · D-19)",
    asUser(partner, `select count(*) from public.cart_items;`, cartFixture) === "1",
  );
  check(
    "배우자도 담을 수 있다",
    asUser(partner, `with i as (
       insert into public.cart_items (cart_id, vendor_id, product_id, options_json, added_by, price_at_add)
       values ('${CART}', '${V}', '${P2}', '{}'::jsonb, '${partner}', 20000000) returning id)
       select count(*) from i;`, cartFixture) === "1",
  );
  check(
    "배우자가 담은 것을 소유자가 지울 수 있다",
    asUser(owner, `with d as (delete from public.cart_items returning id) select count(*) from d;`,
      cartFixture) === "1",
  );
}

// 담은 사람을 남으로 적을 수 없다 — 활동 기록의 작성자 표기가 거짓이 되면 안 된다.
check(
  "added_by 를 남의 이름으로 적을 수 없다 (42501)",
  rejectedWith(/row-level security/i, () =>
    asUser(owner, `insert into public.cart_items
       (cart_id, vendor_id, product_id, options_json, added_by, price_at_add)
       values ('${CART}', '${V}', '${P2}', '{}'::jsonb, '${outsider}', 20000000);`, cartFixture)),
);

// ── 타 커플 격리 ─────────────────────────────────────────────────────────────
for (const [label, table] of [
  ["남은 남의 장바구니를 못 본다", "carts"],
  ["남은 남의 장바구니 항목을 못 본다", "cart_items"],
  ["남은 남의 찜을 못 본다", "wishlists"],
]) {
  check(label, asUser(outsider, `select count(*) from public.${table};`, cartFixture) === "0");
}

check(
  "남은 남의 장바구니에 담을 수 없다 (42501)",
  rejectedWith(/row-level security/i, () =>
    asUser(outsider, `insert into public.cart_items
       (cart_id, vendor_id, product_id, options_json, added_by, price_at_add)
       values ('${CART}', '${V}', '${P2}', '{}'::jsonb, '${outsider}', 20000000);`, cartFixture)),
);
check(
  "남의 삭제는 한 행도 반영되지 않는다",
  asUser(outsider, `with d as (delete from public.cart_items returning id) select count(*) from d;`,
    cartFixture) === "0",
);

// ── anon ─────────────────────────────────────────────────────────────────────
for (const [label, table] of [
  ["비로그인은 장바구니를 못 본다", "carts"],
  ["비로그인은 장바구니 항목을 못 본다", "cart_items"],
  ["비로그인은 찜을 못 본다", "wishlists"],
]) {
  check(label, asAnon(`select count(*) from public.${table};`, cartFixture) === "0");
}

// ── 플래너 위임 ──────────────────────────────────────────────────────────────
// 판단: **읽기는 준다, 쓰기는 주지 않는다.** 무엇을 후보로 두고 있는지 모르는 플래너는
// 상담을 할 수 없다. 반면 planner_selected 는 플래너 자신의 수수료 스위치라(F-C-31)
// 플래너가 켤 수 있으면 이해충돌이다.
const plannerUser = vendorStaff ?? outsider;

check(
  "위임받은 플래너는 장바구니를 읽는다",
  asUser(plannerUser, `select count(*) from public.cart_items;`, plannerFixture) === "1",
);
check(
  "위임받은 플래너는 찜도 읽는다",
  asUser(plannerUser, `select count(*) from public.wishlists;`, plannerFixture) === "1",
);
check(
  "플래너는 담을 수 없다 (42501)",
  rejectedWith(/row-level security/i, () =>
    asUser(plannerUser, `insert into public.cart_items
       (cart_id, vendor_id, product_id, options_json, added_by, price_at_add)
       values ('${CART}', '${V}', '${P2}', '{}'::jsonb, '${plannerUser}', 20000000);`, plannerFixture)),
);
check(
  "플래너는 planner_selected 를 켤 수 없다 (이해충돌 차단)",
  asUser(plannerUser, `with u as (update public.cart_items set planner_selected = true returning id)
     select count(*) from u;`, plannerFixture) === "0",
);
check(
  "위임 범위를 빼면 플래너도 못 본다",
  asUser(plannerUser, `select count(*) from public.cart_items;`,
    `${cartFixture}
     insert into public.planners (id, user_id, status) values ('${PLANNER}', '${plannerUser}', 'active');
     insert into public.planner_engagements (planner_id, couple_id, scope_json, status)
       values ('${PLANNER}', '${coupleId}', '{"tables":["tasks"]}'::jsonb, 'active');`) === "0",
);

// ── 중복 처리 ────────────────────────────────────────────────────────────────
check(
  "같은 상품·같은 옵션은 두 번 담기지 않는다 (키 순서가 달라도 같은 값이다)",
  rejectedWith(/uq_cart_items_product_options/, () =>
    asUser(owner, `insert into public.cart_items
       (cart_id, vendor_id, product_id, options_json, added_by, price_at_add)
       values ('${CART}', '${V}', '${P1}', '{"b":2,"a":1}'::jsonb, '${owner}', 10000000);`, cartFixture)),
);
check(
  "옵션이 다르면 별개 항목으로 담긴다",
  asUser(owner, `with i as (
     insert into public.cart_items (cart_id, vendor_id, product_id, options_json, added_by, price_at_add)
     values ('${CART}', '${V}', '${P1}', '{"a":9}'::jsonb, '${owner}', 10000000) returning id)
     select count(*) from i;`, cartFixture) === "1",
);
check(
  "활성 장바구니는 커플당 하나다",
  rejectedWith(/uq_carts_active_per_couple/, () =>
    asUser(owner, `insert into public.carts (couple_id, status) values ('${coupleId}', 'active');`,
      cartFixture)),
);
check(
  "지나간 장바구니는 여러 개일 수 있다",
  asUser(owner, `with i as (
     insert into public.carts (couple_id, status) values ('${coupleId}', 'abandoned') returning id)
     select count(*) from i;`, cartFixture) === "1",
);
check(
  "같은 대상을 두 번 찜할 수 없다",
  rejectedWith(/uq_wishlists_target/, () =>
    asUser(owner, `insert into public.wishlists (couple_id, vendor_id, product_id, added_by, price_at_add)
       values ('${coupleId}', '${V}', '${P2}', '${owner}', 20000000);`, cartFixture)),
);
check(
  "업체 찜에 가격을 넣을 수 없다 (짝 CHECK)",
  rejectedWith(/wishlists_price_pair_chk/, () =>
    sql(`begin;
      insert into public.wishlists (couple_id, vendor_id, product_id, added_by, price_at_add)
        values ('${coupleId}', '${V}', null, '${owner}', 1000);
      rollback;`)),
);

// ── 장바구니 쓰기 (S3-05) ───────────────────────────────────────────────────
// 화면·API 가 생겼으므로 **쓰기 경로**도 DB 가 막는지 본다. 앱 코드를 고쳐도 남의
// 장바구니가 열리면 안 된다.
if (memberOf === "1") {
  check(
    "배우자는 플래너 선택을 바꿀 수 있다 (당사자)",
    asUser(partner, `with u as (update public.cart_items set planner_selected = true returning id)
       select count(*) from u;`, cartFixture) === "1",
  );
}
check(
  "남은 남의 플래너 선택을 바꿀 수 없다",
  asUser(outsider, `with u as (update public.cart_items set planner_selected = true returning id)
     select count(*) from u;`, cartFixture) === "0",
);
check(
  "남은 남의 찜을 지울 수 없다",
  asUser(outsider, `with d as (delete from public.wishlists returning id) select count(*) from d;`,
    cartFixture) === "0",
);
check(
  "비로그인은 장바구니에 담을 수 없다",
  rejectedWith(/permission denied|row-level security/i, () =>
    asAnon(`insert into public.cart_items
       (cart_id, vendor_id, product_id, options_json, added_by, price_at_add)
       values ('${CART}', '${V}', '${P2}', '{}'::jsonb, '${owner}', 20000000);`, cartFixture)),
);

// =============================================================================
// 탐색 공개 노출 (S3-03)
// -----------------------------------------------------------------------------
// `/explore` 는 비로그인도 본다(§1.4). 그래서 **anon 이 무엇을 볼 수 있는가** 가 곧
// 카탈로그의 경계다. 앱이 조회 조건을 잘못 써도 DB 가 막아야 한다.
// =============================================================================
const EV_ACTIVE = "00000000-0000-0000-0000-00000000e001";
const EV_PENDING = "00000000-0000-0000-0000-00000000e002";
const EP_PUB = "00000000-0000-0000-0000-00000000e003";
const EP_DRAFT = "00000000-0000-0000-0000-00000000e004";
const EP_HIDDEN = "00000000-0000-0000-0000-00000000e005";

const exploreFixture = `
  insert into public.vendors (id, name, category, status, region_code, style_tags)
    values ('${EV_ACTIVE}', 'RLS공개업체', 'hall', 'active', '서울', array['modern']),
           ('${EV_PENDING}', 'RLS심사중업체', 'hall', 'pending', '서울', array['modern']);
  insert into public.products
    (id, vendor_id, category, name, base_price_total, status, included_items_json, add_ons_declared_at)
    values
      ('${EP_PUB}', '${EV_ACTIVE}', 'hall', '게시상품', 10000000, 'published', '[{"label":"대관료"}]'::jsonb, now()),
      ('${EP_DRAFT}', '${EV_ACTIVE}', 'hall', '작성중상품', 9000000, 'draft', '[]'::jsonb, null),
      ('${EP_HIDDEN}', '${EV_PENDING}', 'hall', '미승인업체상품', 8000000, 'published', '[{"label":"대관료"}]'::jsonb, now());
  insert into public.product_options (product_id, name, price, is_mandatory, trigger_condition)
    values ('${EP_DRAFT}', '작성중 추가금', 500000, true, '{}'::jsonb),
           ('${EP_HIDDEN}', '미승인 추가금', 500000, true, '{}'::jsonb);
  insert into public.price_rules
    (vendor_id, product_id, rule_type, condition_json, adjust_type, adjust_value, floor_price, priority, is_active)
    values ('${EV_ACTIVE}', '${EP_PUB}', 'season', '{"from":"2027-05-01","to":"2027-05-31"}'::jsonb,
            'percent_bp', -1000, 7000000, 10, true);
`;

check(
  "비로그인은 승인된 업체만 본다",
  asAnon(`select count(*) from public.vendors where id in ('${EV_ACTIVE}', '${EV_PENDING}');`,
    exploreFixture) === "1",
);
check(
  "비로그인은 게시된 상품만 본다",
  asAnon(`select count(*) from public.products
     where id in ('${EP_PUB}', '${EP_DRAFT}', '${EP_HIDDEN}');`, exploreFixture) === "1",
);
check(
  "비로그인은 작성 중·미승인 상품의 추가금도 못 본다",
  asAnon(`select count(*) from public.product_options
     where product_id in ('${EP_DRAFT}', '${EP_HIDDEN}');`, exploreFixture) === "0",
);
// 룰에는 그 업체가 받아들일 수 있는 최저가(floor_price)가 들어 있다. 고객도 경쟁사도 볼 일이 없다.
check(
  "비로그인은 프라이싱 룰을 못 본다 (floor_price 비공개)",
  asAnon(`select count(*) from public.price_rules where vendor_id = '${EV_ACTIVE}';`,
    exploreFixture) === "0",
);
check(
  "남의 업체 프라이싱 룰도 못 본다",
  asUser(owner, `select count(*) from public.price_rules where vendor_id = '${EV_ACTIVE}';`,
    exploreFixture) === "0",
);
// anon 에는 UPDATE 권한 자체가 없다. RLS 보다 한 겹 앞에서 끊긴다 — 더 강한 경계다.
check(
  "비로그인은 게시 상품을 고칠 수 없다 (권한 없음)",
  rejectedWith(/permission denied|row-level security/i, () =>
    asAnon(`update public.products set base_price_total = 1;`, exploreFixture)),
);

// ── 참가격 인덱스 (S3-08) ───────────────────────────────────────────────────
// `/prices/[region]/[category]` 는 비로그인 SEO 페이지다. anon 이 지수를 읽을 수
// 있어야 하고, **표본 추적(price_sources)은 읽을 수 없어야** 한다 — 그 안에는 어느
// 업체의 어느 값이 표본이 됐는지가 그대로 들어 있다(§3.9 정책 없음 = 기본 거부).
const IDX = "00000000-0000-0000-0000-0000000ff001";

const indexFixture = `
  insert into public.price_index
    (id, region_code, category, guest_bucket, season, p25, p50, p75, sample_size,
     source_type, collected_at, version)
    values ('${IDX}', 'RLS시', 'hall', 'all', 'all', 10000000, 20000000, 30000000, 7,
            'registered_price', now(), 'rls-check');
  insert into public.price_sources (index_id, source_name, raw_value)
    values ('${IDX}', 'vendor_registered_price', 10000000);
`;

check(
  "비로그인은 참가격 지수를 읽는다 (공개 데이터)",
  asAnon(`select count(*) from public.price_index where id = '${IDX}';`, indexFixture) === "1",
);
check(
  "비로그인은 표본 추적을 읽을 수 없다",
  asAnon(`select count(*) from public.price_sources where index_id = '${IDX}';`, indexFixture) === "0",
);
check(
  "로그인 사용자도 표본 추적은 못 본다 (운영 큐레이션 정보)",
  asUser(owner, `select count(*) from public.price_sources where index_id = '${IDX}';`,
    indexFixture) === "0",
);
check(
  "비로그인은 지수를 고칠 수 없다",
  rejectedWith(/permission denied|row-level security/i, () =>
    asAnon(`update public.price_index set p50 = 1 where id = '${IDX}';`, indexFixture)),
);

// ── 마이페이지 · 개인정보 (S3-09) ───────────────────────────────────────────
// 삭제 요청은 **본인만** 보고, 처리 상태를 스스로 바꿀 수 없어야 한다. 사용자가
// 자기 요청을 completed 로 만들면 F-A-08 의 SLA 추적이 통째로 무너진다.
const REQ = "00000000-0000-0000-0000-0000000dd001";

const deletionFixture = `
  delete from public.data_deletion_requests where user_id in ('${owner}', '${outsider}');
  insert into public.data_deletion_requests (id, user_id, scope, status)
    values ('${REQ}', '${owner}', 'account', 'pending');
`;

check(
  "본인은 자기 삭제 요청을 본다",
  asUser(owner, `select count(*) from public.data_deletion_requests where id = '${REQ}';`,
    deletionFixture) === "1",
);
check(
  "남은 남의 삭제 요청을 못 본다",
  asUser(outsider, `select count(*) from public.data_deletion_requests where id = '${REQ}';`,
    deletionFixture) === "0",
);
check(
  "비로그인은 삭제 요청을 못 본다",
  asAnon(`select count(*) from public.data_deletion_requests where id = '${REQ}';`,
    deletionFixture) === "0",
);
// 정책이 pending -> cancelled 전이 하나만 연다(0018).
check(
  "본인은 접수 상태의 요청을 거둘 수 있다",
  asUser(owner, `with u as (update public.data_deletion_requests set status = 'cancelled',
       completed_at = now() where id = '${REQ}' returning id) select count(*) from u;`,
    deletionFixture) === "1",
);
// 정책이 도착 상태를 cancelled 로 못박았으므로, 다른 상태로의 전이는 **0행이 아니라
// 오류**로 끊긴다(with check 위반). 조용히 무시되는 것보다 낫다.
check(
  "본인도 요청을 완료 처리할 수는 없다",
  rejectedWith(/row-level security/i, () =>
    asUser(owner, `update public.data_deletion_requests set status = 'completed',
       completed_at = now() where id = '${REQ}';`, deletionFixture)),
);
check(
  "처리가 시작된 요청은 거둘 수 없다",
  asUser(owner, `with u as (update public.data_deletion_requests set status = 'cancelled',
       completed_at = now() where id = '${REQ}' returning id) select count(*) from u;`,
    `${deletionFixture}
     update public.data_deletion_requests set status = 'in_progress' where id = '${REQ}';`) === "0",
);
check(
  "열린 요청은 사람당 하나다 (부분 유니크)",
  rejectedWith(/uq_deletion_requests_open_per_user/, () =>
    sql(`begin;
      ${deletionFixture}
      insert into public.data_deletion_requests (user_id, scope, status)
        values ('${owner}', 'service_data', 'pending');
      rollback;`)),
);
check(
  "남은 남의 프로필을 못 본다",
  asUser(outsider, `select count(*) from public.profiles where user_id = '${owner}';`) === "0",
);
check(
  "남은 남의 동의 이력을 못 본다",
  asUser(outsider, `select count(*) from public.consents where user_id = '${owner}';`,
    `insert into public.consents (user_id, consent_type, version)
       values ('${owner}', 'terms', 'v1');`) === "0",
);

// ── 증거 보존 (S4-03) ───────────────────────────────────────────────────────
// entity_events 는 **insert-only** 다(D-23). 정책의 부재로 강제되므로, 정책이 하나라도
// 잘못 열리면 증적이 당사자에게 고쳐진다 — 그러면 증적이 아니다.
const EV = "00000000-0000-0000-0000-0000000ee001";
const NOTI = "00000000-0000-0000-0000-0000000ee002";

const evidenceFixture = `
  insert into public.entity_events (id, entity_type, entity_id, event_type, actor_id, actor_role)
    values ('${EV}', 'couple', '${coupleId}', 'rls_check', '${owner}', 'consumer');
  insert into public.notifications (id, user_id, topic, channel, sent_at)
    values ('${NOTI}', '${owner}', 'dday', 'email', now());
  insert into public.audit_logs (actor_id, actor_role, action, target_type, target_id)
    values ('${owner}', 'consumer', 'rls_check', 'couple', '${coupleId}');
`;

check(
  "당사자는 자기 커플 이벤트를 본다",
  asUser(owner, `select count(*) from public.entity_events where id = '${EV}';`,
    evidenceFixture) === "1",
);
check(
  "남은 남의 이벤트를 못 본다",
  asUser(outsider, `select count(*) from public.entity_events where id = '${EV}';`,
    evidenceFixture) === "0",
);
check(
  "비로그인은 이벤트를 못 본다",
  asAnon(`select count(*) from public.entity_events where id = '${EV}';`, evidenceFixture) === "0",
);
// insert-only — 어떤 역할에도 쓰기 정책이 없다. 권한 자체가 없어 오류로 끊긴다.
check(
  "당사자도 이벤트를 고칠 수 없다 (insert-only)",
  rejectedWith(/permission denied|row-level security/i, () =>
    asUser(owner, `update public.entity_events set memo = '조작' where id = '${EV}';`,
      evidenceFixture)),
);
check(
  "당사자도 이벤트를 지울 수 없다 (insert-only)",
  rejectedWith(/permission denied|row-level security/i, () =>
    asUser(owner, `delete from public.entity_events where id = '${EV}';`, evidenceFixture)),
);
check(
  "당사자도 이벤트를 새로 쓸 수 없다 (서버 전용)",
  rejectedWith(/permission denied|row-level security/i, () =>
    asUser(owner, `insert into public.entity_events (entity_type, entity_id, event_type)
       values ('couple', '${coupleId}', '위조');`, evidenceFixture)),
);

// notifications — 본인만 보고, **읽음만** 고칠 수 있다.
check(
  "본인은 자기 알림을 본다",
  asUser(owner, `select count(*) from public.notifications where id = '${NOTI}';`,
    evidenceFixture) === "1",
);
check(
  "남은 남의 알림을 못 본다",
  asUser(outsider, `select count(*) from public.notifications where id = '${NOTI}';`,
    evidenceFixture) === "0",
);
check(
  "본인은 읽음 시각을 남길 수 있다",
  asUser(owner, `with u as (update public.notifications set read_at = now()
     where id = '${NOTI}' returning id) select count(*) from u;`, evidenceFixture) === "1",
);
// 컬럼 단위 GRANT 로 막는다 — RLS 는 컬럼을 가르지 못한다(0019).
check(
  "본인도 발송 시각은 고칠 수 없다 (증적을 당사자가 못 바꾼다)",
  rejectedWith(/permission denied/i, () =>
    asUser(owner, `update public.notifications set sent_at = null where id = '${NOTI}';`,
      evidenceFixture)),
);
check(
  "본인도 도달 시각은 고칠 수 없다",
  rejectedWith(/permission denied/i, () =>
    asUser(owner, `update public.notifications set delivered_at = now() where id = '${NOTI}';`,
      evidenceFixture)),
);

// audit_logs — 정책 없음(서비스롤 전용).
check(
  "당사자도 감사 로그를 못 본다",
  asUser(owner, `select count(*) from public.audit_logs;`, evidenceFixture) === "0",
);
check(
  "비로그인도 감사 로그를 못 본다",
  asAnon(`select count(*) from public.audit_logs;`, evidenceFixture) === "0",
);

// 발송·도달·열람 순서를 DB 가 지킨다.
check(
  "도달이 발송보다 앞설 수 없다",
  rejectedWith(/notifications_delivery_order_chk/, () =>
    sql(`begin;
      insert into public.notifications (user_id, topic, channel, sent_at, delivered_at)
        values ('${owner}', 'chk', 'email', now(), now() - interval '1 hour');
      rollback;`)),
);
check(
  "사유 없는 실패를 적을 수 없다",
  rejectedWith(/notifications_failure_pair_chk/, () =>
    sql(`begin;
      insert into public.notifications (user_id, topic, channel, failed_at)
        values ('${owner}', 'chk', 'email', now());
      rollback;`)),
);
check(
  "성공과 실패를 동시에 주장할 수 없다",
  rejectedWith(/notifications_failed_not_delivered_chk/, () =>
    sql(`begin;
      insert into public.notifications (user_id, topic, channel, sent_at, delivered_at, failed_at, failure_reason)
        values ('${owner}', 'chk', 'email', now(), now(), now(), 'bounced');
      rollback;`)),
);
check(
  "근거를 적었다면 비어 있을 수 없다",
  rejectedWith(/audit_logs_resolution_basis_not_empty_chk/, () =>
    sql(`begin;
      insert into public.audit_logs (action, target_type, resolution_basis)
        values ('chk', 'couple', array[]::uuid[]);
      rollback;`)),
);

// ── 알림 (S4-13) ────────────────────────────────────────────────────────────
// S4-03 이 세운 경계를 그대로 지키는지 본다 — 본인만 보고, **read_at 만** 고친다.
// 새로 생긴 컬럼(dedupe_key·attempt_count·template_key·body_hash)도 닫혀 있어야 한다.
const NT = "00000000-0000-0000-0000-0000000nn001".replace(/n/g, "1");

const notifyFixture = `
  delete from public.notifications where user_id = '${owner}';
  insert into public.notifications
    (id, user_id, topic, channel, template_key, payload_json, dedupe_key, sent_at, delivered_at)
    values ('${NT}', '${owner}', 'dday', 'in_app', 'dday.remind', '{"days":30}'::jsonb,
            'dday.remind:x:d-30', now(), now());
`;

check(
  "본인은 자기 알림을 본다",
  asUser(owner, `select count(*) from public.notifications where id = '${NT}';`,
    notifyFixture) === "1",
);
check(
  "남은 남의 알림을 못 본다",
  asUser(outsider, `select count(*) from public.notifications where id = '${NT}';`,
    notifyFixture) === "0",
);
check(
  "본인은 읽음을 남길 수 있다",
  asUser(owner, `with u as (update public.notifications set read_at = now()
     where id = '${NT}' returning id) select count(*) from u;`, notifyFixture) === "1",
);
check(
  "본인도 발송 시각은 못 바꾼다 (S4-03 경계 유지)",
  rejectedWith(/permission denied/i, () =>
    asUser(owner, `update public.notifications set sent_at = null where id = '${NT}';`,
      notifyFixture)),
);
check(
  "본인도 멱등 열쇠는 못 바꾼다",
  rejectedWith(/permission denied/i, () =>
    asUser(owner, `update public.notifications set dedupe_key = null where id = '${NT}';`,
      notifyFixture)),
);
check(
  "본인도 시도 횟수는 못 바꾼다",
  rejectedWith(/permission denied/i, () =>
    asUser(owner, `update public.notifications set attempt_count = 99 where id = '${NT}';`,
      notifyFixture)),
);
check(
  "본인도 알림을 새로 만들 수 없다 (서버 전용)",
  rejectedWith(/permission denied|row-level security/i, () =>
    asUser(owner, `insert into public.notifications (user_id, topic, channel)
       values ('${owner}', 'dday', 'in_app');`, notifyFixture)),
);
check(
  "비로그인은 알림을 못 본다",
  asAnon(`select count(*) from public.notifications where id = '${NT}';`, notifyFixture) === "0",
);
// 멱등은 DB 가 지킨다 — 애플리케이션 확인만으로는 동시 실행에서 둘 다 통과한다.
check(
  "같은 사람에게 같은 열쇠는 하나뿐이다",
  rejectedWith(/uq_notifications_dedupe/, () =>
    sql(`begin;
      ${notifyFixture}
      insert into public.notifications (user_id, topic, channel, dedupe_key)
        values ('${owner}', 'dday', 'in_app', 'dday.remind:x:d-30');
      rollback;`)),
);
check(
  "정의되지 않은 채널은 거부한다",
  rejectedWith(/notifications_channel_chk/, () =>
    sql(`begin;
      insert into public.notifications (user_id, topic, channel)
        values ('${owner}', 'dday', '비둘기');
      rollback;`)),
);
// 수신 설정은 사용자의 것이다.
check(
  "본인은 수신 설정을 만들 수 있다",
  asUser(owner, `with i as (
     insert into public.notification_prefs (user_id, topic, channel_flags)
     values ('${owner}', 'dday', '{"email":false}'::jsonb) returning id)
     select count(*) from i;`) === "1",
);
check(
  "남의 수신 설정은 못 본다",
  asUser(outsider, `select count(*) from public.notification_prefs where user_id = '${owner}';`,
    `insert into public.notification_prefs (user_id, topic, channel_flags)
       values ('${owner}', 'care', '{}'::jsonb);`) === "0",
);

// =============================================================================
// 채팅 · 문의게시판 (S4-01)
// -----------------------------------------------------------------------------
// 확인하는 경계는 다섯이다.
//   1) 격리 — 타 커플 · 타 업체 · 플래너 · 운영자 · 비로그인
//   2) 편(sender_type) 위조 금지 — 사칭하면 D-23 증적이 거짓이 된다
//   3) 불변성 — 메시지는 아무도 수정·삭제할 수 없고, 회수는 뷰가 가린다
//   4) 유도값 — 읽음·정렬 기준·SLA 시계는 트리거의 것이며 당사자가 못 만진다
//   5) 문의 공개 설정 — 업체는 내릴 수만 있고 올릴 수는 없다
//
// **역할 배치** (시드 계정을 겹쳐 쓴다)
//   owner·partner      커플 당사자 (우리 커플)
//   outsider           대화 상대 업체 CV 의 owner  (커플에는 남이다)
//   vendorStaff        같은 업체 CV 의 staff       (방은 조직 단위임을 확인한다)
//   adminUser          타 업체 OV 의 owner + 우리 커플의 위임 플래너
//   opsUser            타 커플 OC 의 owner + 운영자(ops)
// =============================================================================
if (!adminUser || !opsUser || !vendorStaff) {
  console.log("SKIP  채팅·문의 항목 — admin/ops/staff 시드 계정이 없다");
} else {
  const CV = "00000000-0000-0000-0000-00000000a001"; // 대화 상대 업체
  const OV = "00000000-0000-0000-0000-00000000a002"; // 타 업체
  const OC = "00000000-0000-0000-0000-00000000a003"; // 타 커플
  const ROOM = "00000000-0000-0000-0000-00000000a004"; // 우리 커플 ↔ CV
  const OROOM = "00000000-0000-0000-0000-00000000a005"; // 타 커플 ↔ CV
  const MSG_C = "00000000-0000-0000-0000-00000000a006"; // 고객이 보낸 메시지
  const MSG_V = "00000000-0000-0000-0000-00000000a007"; // 업체가 보낸 메시지
  const QPUB = "00000000-0000-0000-0000-00000000a008"; // 공개 질문
  const QPRIV = "00000000-0000-0000-0000-00000000a009"; // 비공개 질문
  const CPLANNER = "00000000-0000-0000-0000-00000000a00a";

  // 두 업체 · 두 커플 · 두 방 · 두 메시지 · 두 질문. 전부 트랜잭션 안에서 만들고
  // 되돌린다(장바구니 픽스처와 같은 방식이다).
  const chatFixture = `
    insert into public.vendors (id, name, category, status)
      values ('${CV}', 'RLS대화업체', 'hall', 'active'),
             ('${OV}', 'RLS타업체', 'hall', 'active');
    insert into public.vendor_members (vendor_id, user_id, vendor_role)
      values ('${CV}', '${outsider}', 'owner'),
             ('${CV}', '${vendorStaff}', 'staff'),
             ('${OV}', '${adminUser}', 'owner');
    insert into public.couples (id, owner_id, stage)
      values ('${OC}', '${opsUser}', 'onboarding');
    insert into public.couple_members (couple_id, user_id, member_role)
      values ('${OC}', '${opsUser}', 'owner');
    insert into public.chat_rooms (id, couple_id, vendor_id)
      values ('${ROOM}', '${coupleId}', '${CV}'),
             ('${OROOM}', '${OC}', '${CV}');
    insert into public.chat_messages (id, room_id, sender_id, sender_type, body)
      values ('${MSG_C}', '${ROOM}', '${owner}', 'couple', '견적 문의드립니다'),
             ('${MSG_V}', '${ROOM}', '${outsider}', 'vendor', '안내드립니다');
    insert into public.qna_posts (id, vendor_id, author_id, title, body, is_public)
      values ('${QPUB}', '${CV}', '${owner}', '공개 질문', '주차 가능한가요', true),
             ('${QPRIV}', '${CV}', '${owner}', '비공개 질문', '연락처 남깁니다', false);
  `;

  // ── 1) 당사자는 본다 ──────────────────────────────────────────────────────
  check(
    "고객은 자기 방을 본다",
    asUser(owner, `select count(*) from public.chat_rooms where id = '${ROOM}';`,
      chatFixture) === "1",
  );
  check(
    "고객은 방의 메시지를 본다",
    asUser(owner, `select count(*) from public.chat_messages where room_id = '${ROOM}';`,
      chatFixture) === "2",
  );

  if (memberOf === "1") {
    check(
      "배우자도 같은 방을 본다 (커플 양측이 방을 공유한다 · §3.7)",
      asUser(partner, `select count(*) from public.chat_rooms where id = '${ROOM}';`,
        chatFixture) === "1",
    );
    check(
      "배우자도 같은 방에 쓸 수 있다",
      asUser(partner, `with i as (
         insert into public.chat_messages (room_id, sender_id, sender_type, body)
         values ('${ROOM}', '${partner}', 'couple', '배우자입니다') returning id)
         select count(*) from i;`, chatFixture) === "1",
    );
  }

  // 방은 사람 단위가 아니라 **조직 단위** 1:1 이다 — staff 도 같은 방에 들어온다.
  check(
    "업체 staff 도 같은 방을 본다 (방은 조직 단위다)",
    asUser(vendorStaff, `select count(*) from public.chat_rooms where id = '${ROOM}';`,
      chatFixture) === "1",
  );
  check(
    "업체 staff 도 응대할 수 있다",
    asUser(vendorStaff, `with i as (
       insert into public.chat_messages (room_id, sender_id, sender_type, body)
       values ('${ROOM}', '${vendorStaff}', 'vendor', 'staff 응대') returning id)
       select count(*) from i;`, chatFixture) === "1",
  );
  // 업체 인박스(F-V-15)는 그 업체의 모든 방을 본다 — 우리 커플 방 + 타 커플 방.
  check(
    "업체는 자기 업체의 방을 모두 본다 (인박스)",
    asUser(outsider, `select count(*) from public.chat_rooms
       where id in ('${ROOM}', '${OROOM}');`, chatFixture) === "2",
  );

  // ── 2) 타 커플 · 타 업체 · 운영자 · 비로그인 격리 ─────────────────────────
  check(
    "타 커플 당사자는 우리 방을 못 본다",
    asUser(opsUser, `select count(*) from public.chat_rooms where id = '${ROOM}';`,
      chatFixture) === "0",
  );
  check(
    "타 커플 당사자는 우리 메시지를 못 본다",
    asUser(opsUser, `select count(*) from public.chat_messages where room_id = '${ROOM}';`,
      chatFixture) === "0",
  );
  check(
    "타 업체 멤버는 우리 방을 못 본다",
    asUser(adminUser, `select count(*) from public.chat_rooms where id = '${ROOM}';`,
      chatFixture) === "0",
  );
  check(
    "타 업체 멤버는 우리 메시지를 못 본다",
    asUser(adminUser, `select count(*) from public.chat_messages where room_id = '${ROOM}';`,
      chatFixture) === "0",
  );
  // opsUser 는 profiles.role='ops' 라 is_operator() 가 참이다. 그래도 클라이언트
  // 세션으로는 아무것도 열리지 않는다 — 운영자 열람은 서비스롤 경유만이다(§3.9).
  check(
    "운영자도 클라이언트 세션으로는 남의 대화를 못 본다 (서비스롤 경유만)",
    asUser(opsUser, `select count(*) from public.chat_messages where room_id = '${ROOM}';`,
      chatFixture) === "0",
  );
  check(
    "남의 방에는 쓸 수 없다 (42501)",
    rejectedWith(/row-level security/i, () =>
      asUser(opsUser, `insert into public.chat_messages (room_id, sender_id, sender_type, body)
         values ('${ROOM}', '${opsUser}', 'couple', '끼어들기');`, chatFixture)),
  );

  for (const [label, table] of [
    ["비로그인은 방을 못 본다", "chat_rooms"],
    ["비로그인은 메시지를 못 본다", "chat_messages"],
  ]) {
    check(label, asAnon(`select count(*) from public.${table};`, chatFixture) === "0");
  }
  check(
    "비로그인은 방을 열 수 없다",
    rejectedWith(/permission denied|row-level security/i, () =>
      asAnon(`insert into public.chat_rooms (couple_id, vendor_id)
         values ('${coupleId}', '${OV}');`, chatFixture)),
  );
  // 뷰는 anon 에서 권한 자체를 회수했다 — RLS 보다 한 겹 앞에서 끊긴다.
  check(
    "비로그인은 회수 뷰에 접근조차 못 한다 (권한 없음)",
    rejectedWith(/permission denied/i, () =>
      asAnon(`select count(*) from public.chat_messages_visible;`, chatFixture)),
  );

  // ── 3) 플래너 — 위임 범위에 채팅을 넣어도 열리지 않는다 ───────────────────
  // §3.9 의 채팅 행은 "커플 구성원과 업체 멤버만" 이라 쓰고, 상담 행은 "위임 플래너"
  // 를 명시한다. 그 차이가 의도임을 확인한다. 장바구니(S3-04)에서 읽기를 준 것과
  // 갈리는 이유는 0021 헬퍼 블록에 적었다 — 대화에는 상대 당사자가 있다.
  const chatPlannerFixture = `${chatFixture}
    insert into public.planners (id, user_id, status)
      values ('${CPLANNER}', '${adminUser}', 'active');
    insert into public.planner_engagements
      (planner_id, couple_id, scope_json, status, valid_from, valid_to)
      values ('${CPLANNER}', '${coupleId}',
              '{"tables":["carts","wishlists","chat_rooms","chat_messages"]}'::jsonb,
              'active', now() - interval '1 day', now() + interval '30 days');
  `;

  check(
    "위임 범위에 채팅을 적어도 플래너는 방을 못 본다 (§3.9 — 채팅에 플래너는 없다)",
    asUser(adminUser, `select count(*) from public.chat_rooms where id = '${ROOM}';`,
      chatPlannerFixture) === "0",
  );
  check(
    "플래너는 메시지도 못 본다",
    asUser(adminUser, `select count(*) from public.chat_messages where room_id = '${ROOM}';`,
      chatPlannerFixture) === "0",
  );
  check(
    "플래너는 고객을 대신해 쓸 수 없다 (누가 약속했는가가 흔들린다 · D-23)",
    rejectedWith(/row-level security/i, () =>
      asUser(adminUser, `insert into public.chat_messages (room_id, sender_id, sender_type, body)
         values ('${ROOM}', '${adminUser}', 'couple', '대신 씁니다');`, chatPlannerFixture)),
  );

  // ── 4) 편(sender_type) 위조 금지 ──────────────────────────────────────────
  check(
    "고객은 업체 편으로 쓸 수 없다 (42501)",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.chat_messages (room_id, sender_id, sender_type, body)
         values ('${ROOM}', '${owner}', 'vendor', '업체 사칭');`, chatFixture)),
  );
  check(
    "업체는 고객 편으로 쓸 수 없다",
    rejectedWith(/row-level security/i, () =>
      asUser(outsider, `insert into public.chat_messages (room_id, sender_id, sender_type, body)
         values ('${ROOM}', '${outsider}', 'couple', '고객 사칭');`, chatFixture)),
  );
  check(
    "system 카드는 클라이언트가 만들 수 없다 (서버 전용 · §3.7)",
    rejectedWith(/row-level security/i, () =>
      asUser(outsider, `insert into public.chat_messages (room_id, sender_id, sender_type, body)
         values ('${ROOM}', null, 'system', '상담 일정 제안');`, chatFixture)),
  );
  check(
    "남의 이름으로 쓸 수 없다",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.chat_messages (room_id, sender_id, sender_type, body)
         values ('${ROOM}', '${outsider}', 'couple', '이름 도용');`, chatFixture)),
  );
  check(
    "본문도 첨부도 없는 메시지는 만들 수 없다",
    rejectedWith(/chat_messages_not_empty_chk/, () =>
      asUser(owner, `insert into public.chat_messages (room_id, sender_id, sender_type, body)
         values ('${ROOM}', '${owner}', 'couple', '   ');`, chatFixture)),
  );

  // ── 5) 불변성 — 수정·삭제는 권한 자체가 없다 ─────────────────────────────
  // 정책의 부재가 아니라 **권한의 회수**여야 한다. 정책만 없으면 실패가 오류가 아니라
  // 조용한 0행이라 "지웠다" 고 믿는 코드가 생긴다(0019 와 같은 판단).
  check(
    "고객은 자기 메시지도 고칠 수 없다 (권한 회수)",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `update public.chat_messages set body = '고쳤다' where id = '${MSG_C}';`,
        chatFixture)),
  );
  check(
    "업체도 자기 메시지를 고칠 수 없다",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `update public.chat_messages set body = '고쳤다' where id = '${MSG_V}';`,
        chatFixture)),
  );
  check(
    "메시지는 아무도 지울 수 없다",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `delete from public.chat_messages where id = '${MSG_C}';`, chatFixture)),
  );
  check(
    "읽음 표시도 손으로 찍을 수 없다 (트리거가 유도한다)",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `update public.chat_messages set read_at = now() where id = '${MSG_C}';`,
        chatFixture)),
  );
  check(
    "방도 지울 수 없다 (분쟁 이력)",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `delete from public.chat_rooms where id = '${ROOM}';`, chatFixture)),
  );

  // 회수: 본문은 남고 뷰가 가린다.
  const retractedFixture = `${chatFixture}
    update public.chat_messages set retracted_at = now(), retracted_by = '${outsider}'
      where id = '${MSG_V}';
  `;

  check(
    "회수된 메시지는 뷰에서 본문이 가려진다",
    asUser(owner, `select count(*) from public.chat_messages_visible
       where id = '${MSG_V}' and body is null and attachments = '[]'::jsonb;`,
      retractedFixture) === "1",
  );
  check(
    "회수돼도 원본은 표에 남는다 (운영자 조율용 · D-23)",
    sql(`begin;
      ${retractedFixture}
      select count(*) from public.chat_messages
        where id = '${MSG_V}' and body is not null and retracted_by = '${outsider}';
      rollback;`) === "1",
  );
  check(
    "회수되지 않은 메시지는 뷰에서 그대로 보인다",
    asUser(owner, `select count(*) from public.chat_messages_visible
       where id = '${MSG_C}' and body is not null;`, retractedFixture) === "1",
  );
  // 뷰가 우회로가 되면 안 된다 — security_invoker 라 밑의 RLS 를 그대로 통과한다.
  check(
    "뷰로도 남의 방은 열리지 않는다 (security_invoker)",
    asUser(opsUser, `select count(*) from public.chat_messages_visible
       where room_id = '${ROOM}';`, chatFixture) === "0",
  );

  // ── 6) 읽음 두 층 — 메시지의 read_at 은 참여자 읽음에서 유도된다 ──────────
  check(
    "고객이 읽으면 업체 메시지의 read_at 이 채워진다 (트리거 유도)",
    asUser(owner, `insert into public.chat_room_reads (room_id, user_id, last_read_at)
         values ('${ROOM}', '${owner}', now());
       select count(*) from public.chat_messages
         where id = '${MSG_V}' and read_at is not null;`, chatFixture) === "1",
  );
  check(
    "자기가 보낸 메시지는 자기가 읽어도 read_at 이 채워지지 않는다",
    asUser(owner, `insert into public.chat_room_reads (room_id, user_id, last_read_at)
         values ('${ROOM}', '${owner}', now());
       select count(*) from public.chat_messages
         where id = '${MSG_C}' and read_at is null;`, chatFixture) === "1",
  );
  check(
    "읽음은 뒤로 갈 수 없다 (단조 증가)",
    asUser(owner, `insert into public.chat_room_reads (room_id, user_id, last_read_at)
         values ('${ROOM}', '${owner}', now());
       update public.chat_room_reads set last_read_at = now() - interval '10 days'
         where room_id = '${ROOM}' and user_id = '${owner}';
       select count(*) from public.chat_room_reads
         where room_id = '${ROOM}' and user_id = '${owner}'
           and last_read_at > now() - interval '1 hour';`, chatFixture) === "1",
  );
  check(
    "남의 읽음 기록을 만들 수 없다",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.chat_room_reads (room_id, user_id)
         values ('${ROOM}', '${outsider}');`, chatFixture)),
  );

  const readFixture = `${chatFixture}
    insert into public.chat_room_reads (room_id, user_id, last_read_at)
      values ('${ROOM}', '${outsider}', now());
  `;

  check(
    "자기 읽음 기록은 본다",
    asUser(outsider, `select count(*) from public.chat_room_reads
       where room_id = '${ROOM}';`, readFixture) === "1",
  );
  // 상대 조직의 누가 몇 시에 봤는지까지 열면 업체 staff 의 근태를 고객이 들여다본다.
  // 읽음 여부는 chat_messages.read_at 한 비트로 충분하다.
  check(
    "상대 편의 읽음 기록은 볼 수 없다 (근태 노출 방지)",
    asUser(owner, `select count(*) from public.chat_room_reads
       where room_id = '${ROOM}';`, readFixture) === "0",
  );
  check(
    "비로그인은 읽음 기록을 못 본다",
    asAnon(`select count(*) from public.chat_room_reads;`, readFixture) === "0",
  );
  check(
    "읽음은 지울 수 없다 (\"안 읽었다\" 를 만들 수 없다)",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `delete from public.chat_room_reads where room_id = '${ROOM}';`,
        readFixture)),
  );

  // ── 7) 방의 유일성 · 개설 권한 ────────────────────────────────────────────
  check(
    "같은 커플·업체에 방은 하나뿐이다 (UNIQUE — 한 점의 중복이다)",
    rejectedWith(/uq_chat_rooms_couple_vendor/, () =>
      asUser(owner, `insert into public.chat_rooms (couple_id, vendor_id)
         values ('${coupleId}', '${CV}');`, chatFixture)),
  );
  check(
    "고객은 다른 승인 업체와 새 방을 열 수 있다",
    asUser(owner, `with i as (insert into public.chat_rooms (couple_id, vendor_id)
       values ('${coupleId}', '${OV}') returning id) select count(*) from i;`,
      chatFixture) === "1",
  );
  check(
    "심사 중 업체와는 방을 열 수 없다",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.chat_rooms (couple_id, vendor_id)
         values ('${coupleId}', '${OV}');`,
        `${chatFixture}
         update public.vendors set status = 'pending' where id = '${OV}';`)),
  );
  // 업체가 먼저 말을 걸 수 있으면 채팅이 영업 창구가 된다(§2.2, D-03).
  check(
    "업체는 방을 먼저 열 수 없다 (영업 창구 방지)",
    rejectedWith(/row-level security/i, () =>
      asUser(adminUser, `insert into public.chat_rooms (couple_id, vendor_id)
         values ('${coupleId}', '${OV}');`, chatFixture)),
  );
  check(
    "차단된 방에는 쓸 수 없다",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.chat_messages (room_id, sender_id, sender_type, body)
         values ('${ROOM}', '${owner}', 'couple', '차단 후 발신');`,
        `${chatFixture}
         update public.chat_rooms set status = 'blocked' where id = '${ROOM}';`)),
  );
  check(
    "차단된 방도 읽기는 남는다",
    asUser(owner, `select count(*) from public.chat_messages where room_id = '${ROOM}';`,
      `${chatFixture}
       update public.chat_rooms set status = 'blocked' where id = '${ROOM}';`) === "2",
  );

  // ── 8) 담당자 배정 (F-V-15) ───────────────────────────────────────────────
  check(
    "업체는 자기 구성원을 담당자로 배정한다",
    asUser(outsider, `with u as (update public.chat_rooms set assigned_to = '${vendorStaff}'
       where id = '${ROOM}' returning id) select count(*) from u;`, chatFixture) === "1",
  );
  check(
    "업체 밖 사람은 담당자가 될 수 없다",
    rejectedWith(/구성원이어야/, () =>
      asUser(outsider, `update public.chat_rooms set assigned_to = '${owner}'
         where id = '${ROOM}';`, chatFixture)),
  );
  check(
    "고객은 상대 조직의 담당자를 지정할 수 없다",
    rejectedWith(/업체만/, () =>
      asUser(owner, `update public.chat_rooms set assigned_to = '${vendorStaff}'
         where id = '${ROOM}';`, chatFixture)),
  );

  // ── 9) 정렬 기준 · SLA 시계는 트리거의 것이다 ─────────────────────────────
  check(
    "당사자도 정렬 기준(last_message_at)을 손댈 수 없다",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `update public.chat_rooms set last_message_at = now()
         where id = '${ROOM}';`, chatFixture)),
  );
  check(
    "업체도 SLA 시계를 끌 수 없다 (답변으로만 꺼진다)",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `update public.chat_rooms set awaiting_vendor_since = null
         where id = '${ROOM}';`, chatFixture)),
  );
  check(
    "업체가 답하면 SLA 시계가 꺼진다",
    asUser(owner, `select count(*) from public.chat_rooms where id = '${ROOM}'
       and awaiting_vendor_since is null and last_message_at is not null;`,
      chatFixture) === "1",
  );
  check(
    "고객이 다시 물으면 SLA 시계가 켜진다",
    sql(`begin;
      ${chatFixture}
      insert into public.chat_messages (room_id, sender_id, sender_type, body)
        values ('${ROOM}', '${owner}', 'couple', '다시 문의');
      select count(*) from public.chat_rooms
        where id = '${ROOM}' and awaiting_vendor_since is not null;
      rollback;`) === "1",
  );
  // 고객이 세 번 더 물어도 SLA 시계는 **첫 질문**에서 흘러야 한다.
  check(
    "추가 질문이 와도 SLA 시계는 첫 질문 시각을 유지한다",
    sql(`begin;
      ${chatFixture}
      update public.chat_rooms set awaiting_vendor_since = '2026-01-01 00:00:00+00'
        where id = '${ROOM}';
      insert into public.chat_messages (room_id, sender_id, sender_type, body)
        values ('${ROOM}', '${owner}', 'couple', '또 문의');
      select count(*) from public.chat_rooms
        where id = '${ROOM}' and awaiting_vendor_since = '2026-01-01 00:00:00+00';
      rollback;`) === "1",
  );

  // ── 10) 문의게시판 (F-C-28 · F-V-16) ──────────────────────────────────────
  check(
    "비로그인은 공개 질문만 본다",
    asAnon(`select count(*) from public.qna_posts where id in ('${QPUB}', '${QPRIV}');`,
      chatFixture) === "1",
  );
  check(
    "작성자는 자기 비공개 질문을 본다",
    asUser(owner, `select count(*) from public.qna_posts where id = '${QPRIV}';`,
      chatFixture) === "1",
  );
  check(
    "해당 업체는 비공개 질문을 본다 (답해야 한다)",
    asUser(outsider, `select count(*) from public.qna_posts where id = '${QPRIV}';`,
      chatFixture) === "1",
  );
  check(
    "타 업체는 비공개 질문을 못 본다",
    asUser(adminUser, `select count(*) from public.qna_posts where id = '${QPRIV}';`,
      chatFixture) === "0",
  );
  check(
    "제3자는 비공개 질문을 못 본다",
    asUser(opsUser, `select count(*) from public.qna_posts where id = '${QPRIV}';`,
      chatFixture) === "0",
  );
  check(
    "심사 중 업체의 공개 질문은 비로그인에게 보이지 않는다",
    asAnon(`select count(*) from public.qna_posts where id = '${QPUB}';`,
      `${chatFixture}
       update public.vendors set status = 'pending' where id = '${CV}';`) === "0",
  );

  // 공개 설정: 업체는 **내리는 방향만**. 올리면 설정 변경이 아니라 유출이다.
  check(
    "업체는 공개 질문을 비공개로 내릴 수 있다 (F-V-16 공개 설정 변경)",
    asUser(outsider, `with u as (update public.qna_posts set is_public = false
       where id = '${QPUB}' returning id) select count(*) from u;`, chatFixture) === "1",
  );
  check(
    "업체는 비공개 질문을 공개로 올릴 수 없다",
    rejectedWith(/작성자만/, () =>
      asUser(outsider, `update public.qna_posts set is_public = true where id = '${QPRIV}';`,
        chatFixture)),
  );
  check(
    "작성자는 자기 질문을 공개로 올릴 수 있다",
    asUser(owner, `with u as (update public.qna_posts set is_public = true
       where id = '${QPRIV}' returning id) select count(*) from u;`, chatFixture) === "1",
  );
  check(
    "업체는 고객 질문의 본문을 고칠 수 없다",
    rejectedWith(/작성자만/, () =>
      asUser(outsider, `update public.qna_posts set body = '업체가 고친 질문'
         where id = '${QPUB}';`, chatFixture)),
  );
  check(
    "질문의 소속 업체는 아무도 바꿀 수 없다 (권한)",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `update public.qna_posts set vendor_id = '${OV}' where id = '${QPUB}';`,
        chatFixture)),
  );
  check(
    "질문은 아무도 지울 수 없다 (상태로 내린다)",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `delete from public.qna_posts where id = '${QPUB}';`, chatFixture)),
  );
  check(
    "남의 이름으로 질문할 수 없다",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.qna_posts (vendor_id, author_id, title, body)
         values ('${CV}', '${opsUser}', '사칭 질문', '본문');`, chatFixture)),
  );

  // 답변 — 미답변 큐에서 빠지는 것까지 트리거가 한다.
  check(
    "업체가 답하면 질문이 미답변 큐에서 빠진다 (트리거)",
    asUser(outsider, `insert into public.qna_answers (post_id, responder_id, body)
         values ('${QPUB}', '${outsider}', '가능합니다');
       select status from public.qna_posts where id = '${QPUB}';`, chatFixture) === "answered",
  );
  check(
    "업체 아닌 사람은 답변을 달 수 없다",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.qna_answers (post_id, responder_id, body)
         values ('${QPUB}', '${owner}', '고객이 답한다');`, chatFixture)),
  );
  check(
    "타 업체는 남의 질문에 답할 수 없다",
    rejectedWith(/row-level security/i, () =>
      asUser(adminUser, `insert into public.qna_answers (post_id, responder_id, body)
         values ('${QPUB}', '${adminUser}', '타 업체가 답한다');`, chatFixture)),
  );

  // 답변의 가시성은 질문을 따라간다 — "비공개 질문의 답변은 작성자에게만"(F-V-16).
  const answerFixture = `${chatFixture}
    insert into public.qna_answers (post_id, responder_id, body)
      values ('${QPRIV}', '${outsider}', '비공개 답변입니다');
  `;

  check(
    "비공개 질문의 답변은 비로그인에게 보이지 않는다",
    asAnon(`select count(*) from public.qna_answers where post_id = '${QPRIV}';`,
      answerFixture) === "0",
  );
  check(
    "비공개 질문의 답변은 작성자에게 보인다",
    asUser(owner, `select count(*) from public.qna_answers where post_id = '${QPRIV}';`,
      answerFixture) === "1",
  );
  check(
    "비공개 질문의 답변은 타 업체에게 보이지 않는다",
    asUser(adminUser, `select count(*) from public.qna_answers where post_id = '${QPRIV}';`,
      answerFixture) === "0",
  );
  check(
    "답변은 지울 수 없다 (질문자가 본 답변이 사라지면 안 된다)",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `delete from public.qna_answers where post_id = '${QPRIV}';`,
        answerFixture)),
  );
  check(
    "업체는 자기 답변의 본문을 고칠 수 있다 (게시된 문서다)",
    asUser(outsider, `with u as (update public.qna_answers set body = '정정합니다'
       where post_id = '${QPRIV}' returning id) select count(*) from u;`,
      answerFixture) === "1",
  );
  check(
    "답변자 이름은 바꿀 수 없다 (권한)",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `update public.qna_answers set responder_id = '${vendorStaff}'
         where post_id = '${QPRIV}';`, answerFixture)),
  );
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
