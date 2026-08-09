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

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
