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
import { existsSync, readFileSync, readdirSync } from "node:fs";

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

// **연동 커플 픽스처를 쓴다**(S4-04). 예전에는 couple-a/couple-b 를 썼는데, 그 둘은
// `db:reset` 직후 커플이 없다 — 온보딩 첫 화면을 확인할 수 있어야 하기 때문이다(S0-02).
// 그래서 이 검사는 누군가 손으로 온보딩을 밟아 준 뒤에만 돌았다. 깨끗한 DB 에서 돌지
// 않는 RLS 검사는 가장 필요한 순간에 못 도는 검사다.
// `seed-accounts.mjs` 가 온보딩을 마친 별도 커플 한 쌍을 만들고, 여기서 그것을 쓴다.
const owner = idOf("couple-linked-a@local.test");
const partner = idOf("couple-linked-b@local.test");
const outsider = idOf("vendor@local.test");
// 플래너 위임 시험용. 커플 구성원만 아니면 된다 — 플래너 판정은 couple_members 가
// 아니라 planner_engagements 로만 이뤄지고, 그것을 확인하는 것이 이 검사의 목적이다.
const vendorStaff = idOf("staff@local.test");
// 채팅·문의(S4-01)는 **네 종류의 남**이 필요하다: 타 커플 당사자 · 타 업체 멤버 ·
// 위임받은 플래너 · 운영자. 시드 계정 6개로 그 넷을 다 세우려면 아래처럼 겹쳐 쓴다.
const adminUser = idOf("admin@local.test");
const opsUser = idOf("ops@local.test");
// S6-01. **전용 계정**이어야 한다 — 소비자 계정을 겸하면 "플래너"와 "커플 구성원"이
// 같은 사람이 되어 격리 검사가 엉뚱한 이유로 통과한다.
// (S3-04 구역의 `plannerUser` 는 vendorStaff 를 플래너 대역으로 쓰는 **옛 임시 조치**다.
//  이름이 겹치지 않게 여기서는 `plannerAccount` 로 둔다 — FIX-16 참조.)
const plannerAccount = idOf("planner@local.test");

if (!owner || !partner || !outsider) {
  console.error("시드 계정이 없다. npm run seed:accounts 를 먼저 실행한다.");
  process.exit(1);
}

// 시드가 만든 연동 커플을 **소유자로 특정한다.** `limit 1` 로 아무 커플이나 집으면
// 손으로 만든 커플이 섞였을 때 배우자 연동 여부가 달라져 검사 결과가 흔들린다.
const coupleId = sql(
  `select m.couple_id from public.couple_members m
    where m.user_id = '${owner}' and m.member_role = 'owner' limit 1;`,
);

if (!coupleId) {
  console.error("연동 커플 픽스처가 없다. npm run seed:accounts 를 먼저 실행한다.");
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
  insert into public.planners (id, user_id, status, profile_json, regions)
    values ('${PLANNER}', '${vendorStaff ?? outsider}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']);
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
     insert into public.planners (id, user_id, status, profile_json, regions) values ('${PLANNER}', '${plannerUser}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']);
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
// =============================================================================
// 여러 장바구니 (IDEA-01 / S3-12 · 0027)
// -----------------------------------------------------------------------------
// 0016 의 "커플당 활성 1건" 부분 유니크가 풀렸다. 그 자리를 **트리거 + 순번 유니크**가
// 대신하므로, 상한이 실제로 DB 에서 서는지·순번이 빈 자리를 채우는지를 여기서 본다.
// API 카운트는 배우자의 동시 요청을 막을 수 없어 보조 수단일 뿐이다(0027 근거 1).
// =============================================================================
const cartLimit = Number(
  sql(`select value_json ->> 'max' from public.app_settings where key = 'cart.max_active';`) || "0",
);

check("활성 장바구니 상한은 코드가 아니라 app_settings 가 갖는다", cartLimit >= 1, `max=${cartLimit}`);

/** 픽스처의 1개에 더해 상한까지 채운다. */
const fillToLimit = `${cartFixture}
  insert into public.carts (couple_id, status)
    select '${coupleId}', 'active' from generate_series(2, ${cartLimit});
`;

check(
  `활성 장바구니는 상한(${cartLimit})까지 만들 수 있다`,
  asUser(owner, `select count(*) from public.carts where status = 'active';`, fillToLimit) ===
    String(cartLimit),
);
check(
  "상한을 넘기면 DB 가 거절한다 (API 카운트가 아니라 트리거)",
  rejectedWith(/최대/, () =>
    asUser(owner, `insert into public.carts (couple_id, status) values ('${coupleId}', 'active');`,
      fillToLimit)),
);
check(
  "치우면 자리가 생긴다 (abandoned 는 상한에서 빠진다)",
  asUser(owner, `update public.carts set status = 'abandoned' where seq = 2 and status = 'active';
     with i as (insert into public.carts (couple_id, status) values ('${coupleId}', 'active') returning seq)
     select count(*) from i;`, fillToLimit) === "1",
);
check(
  "순번은 빈 자리를 채운다 (단조 증가가 아니다)",
  asUser(owner, `update public.carts set status = 'abandoned' where seq = 2 and status = 'active';
     with i as (insert into public.carts (couple_id, status) values ('${coupleId}', 'active') returning seq)
     select seq from i;`, fillToLimit) === "2",
);
check(
  "활성 장바구니끼리 순번이 겹치지 않는다",
  rejectedWith(/uq_carts_couple_seq/, () =>
    asUser(owner, `insert into public.carts (couple_id, status, seq) values ('${coupleId}', 'active', 1);`,
      cartFixture)),
);
check(
  "지나간 장바구니는 여러 개일 수 있다",
  asUser(owner, `with i as (
     insert into public.carts (couple_id, status) values ('${coupleId}', 'abandoned') returning id)
     select count(*) from i;`, cartFixture) === "1",
);

// ── 이름 ────────────────────────────────────────────────────────────────────
// 이름 없음의 표현은 null 하나다. 빈 문자열이 통과하면 화면·API 가 두 경우를 따로
// 다뤄야 하고 언젠가 한쪽을 빠뜨린다(0027 근거 4).
check(
  "장바구니 이름을 붙일 수 있다",
  asUser(owner, `with u as (update public.carts set name = '가성비안' where id = '${CART}' returning id)
     select count(*) from u;`, cartFixture) === "1",
);
check(
  "같은 이름을 두 장바구니에 붙일 수 있다 (구분자는 순번이다)",
  asUser(owner, `update public.carts set name = '부모님추천' where id = '${CART}';
     with i as (insert into public.carts (couple_id, status, name)
       values ('${coupleId}', 'active', '부모님추천') returning id)
     select count(*) from i;`, cartFixture) === "1",
);
for (const [label, value] of [
  ["빈 이름", "''"],
  ["공백만 있는 이름", "'   '"],
  ["앞뒤 공백이 붙은 이름", "' 가성비안'"],
  ["상한을 넘는 이름", `'${"가".repeat(21)}'`],
]) {
  check(
    `${label}은 CHECK 가 막는다`,
    rejectedWith(/carts_name_chk/, () =>
      asUser(owner, `update public.carts set name = ${value} where id = '${CART}';`, cartFixture)),
  );
}

// 이름 길이는 **스키마 제약**이라 DB CHECK 와 코드가 같은 값을 알아야 한다.
// 0023 이 알림 토픽에서 겪은 일(한쪽만 늘려 조용히 실패)을 되풀이하지 않기 위한 검사다.
const dbNameCheck = sql(
  `select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.carts'::regclass and conname = 'carts_name_chk';`,
);
const codeNameMax = readFileSync("lib/core/cart/multi-cart.ts", "utf8").match(
  /export const CART_NAME_MAX_LENGTH = (\d+);/,
)?.[1];

check(
  "장바구니 이름 길이 상한이 코드와 DB CHECK 에서 일치한다",
  codeNameMax !== undefined && dbNameCheck.includes(codeNameMax),
  `code=${codeNameMax ?? "(없음)"}`,
);

check(
  "채움 판정 기준도 코드가 아니라 app_settings 가 갖는다",
  sql(`select count(*) from public.app_settings where key = 'cart.core_categories';`) === "1",
);
check(
  "장바구니 파라미터는 소비자에게 보이지 않는다 (정책 없음 = 기본 거부)",
  asUser(owner, `select count(*) from public.app_settings where key like 'cart.%';`) === "0",
);

// ── 항목 이동 ───────────────────────────────────────────────────────────────
const OTHER_COUPLE = "00000000-0000-0000-0000-00000000c006";
const OTHER_CART = "00000000-0000-0000-0000-00000000c007";
const SECOND_CART = "00000000-0000-0000-0000-00000000c008";
const THIRD_CART = "00000000-0000-0000-0000-00000000c009";

/** 남의 커플·장바구니를 하나 붙인다. 항목을 그쪽으로 밀어 넣을 수 없어야 한다. */
const foreignCartFixture = `${cartFixture}
  insert into public.couples (id, owner_id, stage)
    values ('${OTHER_COUPLE}', '${outsider}', 'onboarding');
  insert into public.carts (id, couple_id, status)
    values ('${OTHER_CART}', '${OTHER_COUPLE}', 'active');
`;

check(
  "항목을 우리 다른 장바구니로 옮길 수 있다",
  asUser(owner, `insert into public.carts (id, couple_id, status)
       values ('${SECOND_CART}', '${coupleId}', 'active');
     with u as (update public.cart_items set cart_id = '${SECOND_CART}' returning id)
     select count(*) from u;`, cartFixture) === "1",
);
check(
  "남의 장바구니로는 옮길 수 없다 (WITH CHECK)",
  rejectedWith(/row-level security/i, () =>
    asUser(owner, `update public.cart_items set cart_id = '${OTHER_CART}';`, foreignCartFixture)),
);
check(
  "같은 상품·같은 옵션은 옮긴 뒤에도 한 장바구니에 하나뿐이다",
  rejectedWith(/uq_cart_items_product_options/, () =>
    asUser(owner, `insert into public.carts (id, couple_id, status)
         values ('${THIRD_CART}', '${coupleId}', 'active');
       insert into public.cart_items
         (cart_id, vendor_id, product_id, options_json, added_by, price_at_add)
         values ('${THIRD_CART}', '${V}', '${P1}', '{"a":1,"b":2}'::jsonb, '${owner}', 10000000);
       update public.cart_items set cart_id = '${THIRD_CART}' where cart_id = '${CART}';`,
      cartFixture)),
);

// ── 부모 만지기 ─────────────────────────────────────────────────────────────
// '지금 쓰는 장바구니' 를 updated_at 최신으로 정하므로, 항목만 바뀌고 부모 시각이
// 멈춰 있으면 방금 담은 장바구니가 가장 오래된 것으로 밀린다(0027 근거 5).
check(
  "항목을 담으면 부모 장바구니의 updated_at 이 올라간다",
  sql(`begin;
    ${cartFixture}
    update public.carts set updated_at = now() - interval '1 hour' where id = '${CART}';
    insert into public.cart_items (cart_id, vendor_id, product_id, options_json, added_by, price_at_add)
      values ('${CART}', '${V}', '${P2}', '{}'::jsonb, '${owner}', 20000000);
    select updated_at > now() - interval '1 minute' from public.carts where id = '${CART}';
    rollback;`) === "t",
);
check(
  "항목을 빼도 부모 장바구니의 updated_at 이 올라간다",
  sql(`begin;
    ${cartFixture}
    update public.carts set updated_at = now() - interval '1 hour' where id = '${CART}';
    delete from public.cart_items where cart_id = '${CART}';
    select updated_at > now() - interval '1 minute' from public.carts where id = '${CART}';
    rollback;`) === "t",
);

// ── 플래너 ──────────────────────────────────────────────────────────────────
// 읽기는 주고 쓰기는 주지 않는다는 원칙(0016)이 새 동작에도 그대로 적용되는지 본다.
check(
  "플래너는 장바구니를 만들 수 없다",
  rejectedWith(/row-level security/i, () =>
    asUser(plannerUser, `insert into public.carts (couple_id, status) values ('${coupleId}', 'active');`,
      plannerFixture)),
);
check(
  "플래너는 장바구니 이름을 바꿀 수 없다",
  asUser(plannerUser, `with u as (update public.carts set name = '플래너안' returning id)
     select count(*) from u;`, plannerFixture) === "0",
);
check(
  "플래너는 장바구니를 치울 수 없다",
  asUser(plannerUser, `with u as (update public.carts set status = 'abandoned' returning id)
     select count(*) from u;`, plannerFixture) === "0",
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
// **S8-10 이 이 검사를 더 강하게 만들었다.** 예전에는 정책이 없어 0행이 나오는 것으로
// 통과했는데, 0056 이 `anon` 의 SELECT 권한 자체를 걷어 이제 **권한 오류로 끊긴다.**
// 둘 다 "비로그인은 못 본다" 이지만 뒤쪽이 낫다 — 이 태스크가 `price_sources` 에
// 운영자 정책을 더했으므로, 정책만 믿었다면 그 순간 문이 열렸을 자리다.
check(
  "비로그인은 표본 추적을 읽을 수 없다 (권한 자체가 없다)",
  rejectedWith(/permission denied/, () =>
    asAnon(`select count(*) from public.price_sources where index_id = '${IDX}';`, indexFixture),
  ),
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
// **S8-02 가 이 검사를 더 강하게 만들었다.** 예전에는 정책이 0행을 돌려주는 것으로
// 통과했는데, 0053 이 `anon` 의 SELECT 권한 자체를 걷어 이제 **권한 오류로 끊긴다.**
// 둘 다 "비로그인은 못 본다" 이지만 뒤쪽이 낫다 — 정책을 누가 잘못 고쳐도 권한이 없으면
// 여전히 막힌다(방어선이 둘이다).
check(
  "비로그인은 이벤트를 못 본다 (권한 자체가 없다)",
  rejectedWith(/permission denied/, () =>
    asAnon(`select count(*) from public.entity_events where id = '${EV}';`, evidenceFixture),
  ),
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

// audit_logs — **S8-02 가 운영자 SELECT 정책을 하나 더했다**(0053). 당사자·비로그인은
// 여전히 못 본다. 비로그인은 이제 정책이 아니라 **권한**에서 끊긴다(방어선이 둘이다).
check(
  "당사자도 감사 로그를 못 본다",
  asUser(owner, `select count(*) from public.audit_logs;`, evidenceFixture) === "0",
);
check(
  "비로그인도 감사 로그를 못 본다 (권한 자체가 없다)",
  rejectedWith(/permission denied/, () =>
    asAnon(`select count(*) from public.audit_logs;`, evidenceFixture),
  ),
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
    insert into public.planners (id, user_id, status, profile_json, regions)
      values ('${CPLANNER}', '${adminUser}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']);
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

// =============================================================================
// 표준 문의·견적 (S4-12)
// -----------------------------------------------------------------------------
// 확인하는 경계는 다섯이다.
//   1) 격리 — 타 커플·타 업체·비로그인
//   2) **자유 양식 금지** — 등록되지 않은 항목은 존재할 수 없고, 이름은 DB 가 덮어쓴다
//   3) **상한 초과 금지** — 할인만 되고 할증은 안 된다 (CHECK)
//   4) **쓰기 경로가 서버뿐** — 클라이언트는 견적을 만들 권한 자체가 없다
//   5) 미응답과 거절의 구분, 견적 없는 응답 처리 차단
// =============================================================================
if (!adminUser || !opsUser || !vendorStaff) {
  console.log("SKIP  문의·견적 항목 — 시드 계정이 없다");
} else {
  const IV = "00000000-0000-0000-0000-00000000b001"; // 문의 받는 업체
  const IOV = "00000000-0000-0000-0000-00000000b002"; // 타 업체
  const IP = "00000000-0000-0000-0000-00000000b003"; // 상품
  const IP_OTHER = "00000000-0000-0000-0000-00000000b004"; // 타 업체 상품
  const IOPT = "00000000-0000-0000-0000-00000000b005"; // 추가금
  const IOPT_OTHER = "00000000-0000-0000-0000-00000000b006"; // 타 상품의 추가금
  const INQ = "00000000-0000-0000-0000-00000000b007";
  const TGT = "00000000-0000-0000-0000-00000000b008";
  const QUO = "00000000-0000-0000-0000-00000000b009";
  const OC2 = "00000000-0000-0000-0000-00000000b00a"; // 타 커플

  const inquiryFixture = `
    insert into public.vendors (id, name, category, status)
      values ('${IV}', 'RLS문의업체', 'hall', 'active'),
             ('${IOV}', 'RLS문의타업체', 'hall', 'active');
    insert into public.vendor_members (vendor_id, user_id, vendor_role)
      values ('${IV}', '${outsider}', 'owner'),
             ('${IV}', '${vendorStaff}', 'staff'),
             ('${IOV}', '${adminUser}', 'owner');
    insert into public.products
      (id, vendor_id, category, name, base_price_total, status, included_items_json, add_ons_declared_at)
      values ('${IP}', '${IV}', 'hall', 'RLS견적상품', 10000000, 'published',
              '[{"label":"대관료"}]'::jsonb, now()),
             ('${IP_OTHER}', '${IOV}', 'hall', 'RLS타업체상품', 20000000, 'published',
              '[{"label":"대관료"}]'::jsonb, now());
    insert into public.product_options (id, product_id, name, price, is_mandatory, trigger_condition)
      values ('${IOPT}', '${IP}', '주말 추가', 500000, false,
              '{"description":"토·일 예식일 때"}'::jsonb),
             ('${IOPT_OTHER}', '${IP_OTHER}', '남의 추가금', 700000, false,
              '{"description":"타 업체 조건"}'::jsonb);
    insert into public.couples (id, owner_id, stage)
      values ('${OC2}', '${opsUser}', 'onboarding');
    insert into public.couple_members (couple_id, user_id, member_role)
      values ('${OC2}', '${opsUser}', 'owner');
    insert into public.inquiries (id, couple_id, event_date, guest_count, categories, status)
      values ('${INQ}', '${coupleId}', '2027-05-15', 150, array['hall'], 'open');
    insert into public.inquiry_targets (id, inquiry_id, vendor_id, status, sla_deadline)
      values ('${TGT}', '${INQ}', '${IV}', 'pending', now() + interval '2 days');
  `;

  /** 위 픽스처에 보낸 견적 하나를 더한다. */
  const quoteFixture = `${inquiryFixture}
    insert into public.quotes
      (id, inquiry_target_id, product_id, total_amount, cap_total, base_price_snapshot,
       status, sent_at, pricing_context_json, pricing_steps_json)
      values ('${QUO}', '${TGT}', '${IP}', 9000000, 10000000, 10000000,
              'sent', now(), '{"asOf":"2026-08-11"}'::jsonb, '[]'::jsonb);
    insert into public.quote_items
      (quote_id, item_type, product_id, amount, cap_amount, label, category_code)
      values ('${QUO}', 'base', '${IP}', 9000000, 10000000, '', '');
  `;

  // ── 1) 당사자는 본다 ──────────────────────────────────────────────────────
  check(
    "고객은 자기 문의를 본다",
    asUser(owner, `select count(*) from public.inquiries where id = '${INQ}';`,
      inquiryFixture) === "1",
  );
  check(
    "업체는 자기에게 온 문의를 본다",
    asUser(outsider, `select count(*) from public.inquiry_targets where id = '${TGT}';`,
      inquiryFixture) === "1",
  );
  check(
    "업체 staff 도 문의를 본다 (가격·정산이 아니다)",
    asUser(vendorStaff, `select count(*) from public.inquiry_targets where id = '${TGT}';`,
      inquiryFixture) === "1",
  );
  check(
    "고객은 받은 견적을 본다",
    asUser(owner, `select count(*) from public.quotes where id = '${QUO}';`, quoteFixture) === "1",
  );

  // ── 2) 격리 ──────────────────────────────────────────────────────────────
  check(
    "타 커플은 남의 문의를 못 본다",
    asUser(opsUser, `select count(*) from public.inquiries where id = '${INQ}';`,
      inquiryFixture) === "0",
  );
  check(
    "타 업체는 남에게 간 문의를 못 본다",
    asUser(adminUser, `select count(*) from public.inquiry_targets where id = '${TGT}';`,
      inquiryFixture) === "0",
  );
  check(
    "타 업체는 남의 견적을 못 본다",
    asUser(adminUser, `select count(*) from public.quotes where id = '${QUO}';`,
      quoteFixture) === "0",
  );
  for (const [label, table] of [
    ["비로그인은 문의를 못 본다", "inquiries"],
    ["비로그인은 문의 대상을 못 본다", "inquiry_targets"],
    ["비로그인은 견적을 못 본다", "quotes"],
    ["비로그인은 견적 항목을 못 본다", "quote_items"],
  ]) {
    check(label, asAnon(`select count(*) from public.${table};`, quoteFixture) === "0");
  }

  // ── 3) 자유 양식 금지 ────────────────────────────────────────────────────
  // 견적 쓰기 권한 자체가 없다. 정책의 부재가 아니라 **권한 회수**여야 실패가
  // 조용한 0행이 아니라 오류로 끊긴다(0019·0021 과 같은 판단).
  check(
    "업체도 견적을 직접 만들 수 없다 (권한 회수 — 서버 경유만)",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `insert into public.quotes
         (inquiry_target_id, product_id, total_amount, cap_total, base_price_snapshot, status, sent_at)
         values ('${TGT}', '${IP}', 1, 1, 1, 'sent', now());`, inquiryFixture)),
  );
  check(
    "업체도 견적 항목을 직접 만들 수 없다",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `insert into public.quote_items
         (quote_id, item_type, product_id, amount, cap_amount, label, category_code)
         values ('${QUO}', 'base', '${IP}', 1, 1, '마음대로 지은 항목', 'hall');`, quoteFixture)),
  );
  check(
    "업체도 보낸 견적 금액을 고칠 수 없다",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `update public.quotes set total_amount = 1 where id = '${QUO}';`,
        quoteFixture)),
  );

  // 서비스롤로도 **등록되지 않은 항목은 못 넣는다.** 출처 CHECK 와 트리거가 막는다.
  check(
    "참조 없는 항목은 존재할 수 없다 (BEFORE 트리거가 CHECK 보다 먼저 잡는다)",
    rejectedWith(/등록되지 않은 상품|quote_items_source_chk/, () =>
      sql(`begin; ${quoteFixture}
        insert into public.quote_items
          (quote_id, item_type, product_id, amount, cap_amount, label, category_code)
          values ('${QUO}', 'base', null, 1000, 1000, '즉석 항목', 'hall');
        rollback;`)),
  );
  // 트리거를 비켜 가도 CHECK 가 남아 있다 — option 인데 옵션 id 가 없는 경우.
  check(
    "옵션 항목인데 옵션을 안 가리키면 출처 CHECK 가 막는다",
    rejectedWith(/quote_items_source_chk|등록되지 않은 추가금/, () =>
      sql(`begin; ${quoteFixture}
        insert into public.quote_items
          (quote_id, item_type, product_id, product_option_id, amount, cap_amount, label, category_code)
          values ('${QUO}', 'option', '${IP}', null, 1000, 1000, '', '');
        rollback;`)),
  );
  check(
    "남의 상품 추가금은 견적에 넣을 수 없다",
    rejectedWith(/등록되지 않은 추가금/, () =>
      sql(`begin; ${quoteFixture}
        insert into public.quote_items
          (quote_id, item_type, product_id, product_option_id, amount, cap_amount, label, category_code)
          values ('${QUO}', 'option', '${IP}', '${IOPT_OTHER}', 100, 700000, '', '');
        rollback;`)),
  );
  // 이름을 마음대로 적어도 DB 가 등록된 이름으로 덮어쓴다 — 자유 텍스트가 남지 않는다.
  check(
    "항목 이름은 DB 가 등록된 상품 이름으로 덮어쓴다",
    sql(`begin; ${quoteFixture}
      insert into public.quote_items
        (quote_id, item_type, product_id, amount, cap_amount, label, category_code)
        values ('${QUO}', 'base', '${IP}', 100, 10000000, '특별 관리비(업체가 지은 이름)', '아무거나');
      select label from public.quote_items where quote_id = '${QUO}' and amount = 100;
      rollback;`) === "RLS견적상품",
  );
  check(
    "추가금 상한은 DB 가 등록가로 덮어쓴다 (서버가 틀려도 등록가를 넘지 못한다)",
    sql(`begin; ${quoteFixture}
      insert into public.quote_items
        (quote_id, item_type, product_id, product_option_id, amount, cap_amount, label, category_code)
        values ('${QUO}', 'option', '${IP}', '${IOPT}', 500000, 99999999, '', '');
      select cap_amount from public.quote_items where quote_id = '${QUO}' and item_type = 'option';
      rollback;`) === "500000",
  );

  // ── 4) 상한 초과 금지 ────────────────────────────────────────────────────
  check(
    "항목 금액이 상한을 넘으면 거부한다 (CHECK)",
    rejectedWith(/quote_items_cap_chk/, () =>
      sql(`begin; ${quoteFixture}
        insert into public.quote_items
          (quote_id, item_type, product_id, amount, cap_amount, label, category_code)
          values ('${QUO}', 'base', '${IP}', 10000001, 10000000, '', '');
        rollback;`)),
  );
  check(
    "견적 총액이 상한을 넘으면 거부한다 (CHECK)",
    rejectedWith(/quotes_cap_chk/, () =>
      sql(`begin; ${inquiryFixture}
        insert into public.quotes
          (inquiry_target_id, product_id, total_amount, cap_total, base_price_snapshot, status, sent_at)
          values ('${TGT}', '${IP}', 10000001, 10000000, 10000000, 'sent', now());
        rollback;`)),
  );
  check(
    "상한과 같은 금액은 통과한다 (할인 없음은 위반이 아니다)",
    sql(`begin; ${inquiryFixture}
      insert into public.quotes
        (inquiry_target_id, product_id, total_amount, cap_total, base_price_snapshot, status, sent_at)
        values ('${TGT}', '${IP}', 10000000, 10000000, 10000000, 'sent', now());
      select count(*) from public.quotes where inquiry_target_id = '${TGT}';
      rollback;`) === "1",
  );
  check(
    "할인액은 생성 컬럼이라 손으로 적을 수 없다",
    rejectedWith(/discount_total|generated/i, () =>
      sql(`begin; ${quoteFixture}
        update public.quotes set discount_total = 0 where id = '${QUO}';
        rollback;`)),
  );

  // ── 5) 미응답 · 거절 · 응답 ──────────────────────────────────────────────
  check(
    "업체는 거절할 수 있다 (거절도 응답이다)",
    asUser(outsider, `with u as (update public.inquiry_targets
       set status = 'declined', declined_at = now(), decline_reason_code = 'no_availability'
       where id = '${TGT}' returning id) select count(*) from u;`, inquiryFixture) === "1",
  );
  check(
    "사유 없는 거절은 거부한다 (짝 CHECK)",
    rejectedWith(/inquiry_targets_decline_pair_chk|inquiry_targets_declined_state_chk/, () =>
      asUser(outsider, `update public.inquiry_targets set status = 'declined'
         where id = '${TGT}';`, inquiryFixture)),
  );
  // 업체가 견적 없이 responded 로 바꾸면 SLA 시계를 스스로 끄는 셈이다.
  check(
    "견적 없이 응답 처리할 수 없다 (트리거)",
    rejectedWith(/견적을 보내야/, () =>
      asUser(outsider, `update public.inquiry_targets set status = 'responded'
         where id = '${TGT}';`, inquiryFixture)),
  );
  // 응답 시각은 서버가 정하는 값이라 컬럼 권한 자체가 없다 — 트리거보다 앞선 문이다.
  check(
    "업체는 응답 시각을 손댈 수 없다 (권한)",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `update public.inquiry_targets set responded_at = now()
         where id = '${TGT}';`, inquiryFixture)),
  );
  check(
    "견적을 보내면 트리거가 응답으로 바꾼다",
    sql(`begin; ${quoteFixture}
      select status from public.inquiry_targets where id = '${TGT}';
      rollback;`) === "responded",
  );
  check(
    "업체는 SLA 기한을 손댈 수 없다 (권한)",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `update public.inquiry_targets set sla_deadline = now() + interval '99 days'
         where id = '${TGT}';`, inquiryFixture)),
  );
  check(
    "타 업체는 남의 문의 상태를 바꿀 수 없다",
    asUser(adminUser, `with u as (update public.inquiry_targets set status = 'declined',
       declined_at = now(), decline_reason_code = 'other' where id = '${TGT}' returning id)
       select count(*) from u;`, inquiryFixture) === "0",
  );

  // ── 6) 문의게시판 유사 질문 인덱스 (S4-05) ───────────────────────────────
  check(
    "유사 질문 검색 인덱스가 있다 (pg_trgm)",
    sql(`select count(*) from pg_indexes
       where schemaname = 'public' and indexname = 'idx_qna_posts_similarity';`) === "1",
  );
  check(
    "pg_trgm 확장이 켜져 있다",
    sql(`select count(*) from pg_extension where extname = 'pg_trgm';`) === "1",
  );
}

// =============================================================================
// 상담·탐방 예약 · 노쇼 보증금 (S4-07 · S4-08 · S4-09)
// -----------------------------------------------------------------------------
// 확인하는 경계는 다섯이다.
//   1) 격리 — 타 커플·타 업체·비로그인
//   2) **플래너는 상담을 본다** — 채팅과 갈리는 지점(§3.9 가 상담에만 명시했다)
//   3) **슬롯 중복 금지** — 구간 겹침이라 EXCLUDE 다
//   4) **보증금은 서비스롤 전용** — 당사자가 상태를 못 바꾼다(§3.9)
//   5) 이행 확인은 자기 칸에만, 한 번만
// =============================================================================
if (!adminUser || !opsUser || !vendorStaff) {
  console.log("SKIP  상담·예약 항목 — 시드 계정이 없다");
} else {
  const CV2 = "00000000-0000-0000-0000-00000000d001"; // 상담 업체
  const OV2 = "00000000-0000-0000-0000-00000000d002"; // 타 업체
  const OC3 = "00000000-0000-0000-0000-00000000d003"; // 타 커플
  const CONS = "00000000-0000-0000-0000-00000000d004";
  const DEP = "00000000-0000-0000-0000-00000000d005";
  const PL2 = "00000000-0000-0000-0000-00000000d006"; // 플래너

  const consultFixture = `
    insert into public.vendors (id, name, category, status)
      values ('${CV2}', 'RLS상담업체', 'hall', 'active'),
             ('${OV2}', 'RLS상담타업체', 'hall', 'active');
    insert into public.vendor_members (vendor_id, user_id, vendor_role)
      values ('${CV2}', '${outsider}', 'owner'),
             ('${CV2}', '${vendorStaff}', 'staff'),
             ('${OV2}', '${adminUser}', 'owner');
    insert into public.vendor_availability (vendor_id, weekday, start_time, end_time, slot_minutes)
      values ('${CV2}', 6, '14:00', '17:00', 60);
    insert into public.couples (id, owner_id, stage)
      values ('${OC3}', '${opsUser}', 'onboarding');
    insert into public.couple_members (couple_id, user_id, member_role)
      values ('${OC3}', '${opsUser}', 'owner');
    insert into public.consultations
      (id, couple_id, vendor_id, type, scheduled_at, duration_minutes, ends_at, status)
      values ('${CONS}', '${coupleId}', '${CV2}', 'visit_consult',
              '2027-05-15 05:00:00+00', 60, '2027-05-15 06:00:00+00', 'confirmed');
    insert into public.consultation_deposits
      (id, consultation_id, amount, status, held_at, idempotency_key)
      values ('${DEP}', '${CONS}', 30000, 'held', now(), 'rls-check-key');
  `;

  // ── 1) 당사자는 본다 ──────────────────────────────────────────────────────
  check(
    "고객은 자기 예약을 본다",
    asUser(owner, `select count(*) from public.consultations where id = '${CONS}';`,
      consultFixture) === "1",
  );
  check(
    "업체는 자기에게 온 예약을 본다",
    asUser(outsider, `select count(*) from public.consultations where id = '${CONS}';`,
      consultFixture) === "1",
  );
  check(
    "업체 staff 도 예약을 본다 (일정은 가격·정산이 아니다)",
    asUser(vendorStaff, `select count(*) from public.consultations where id = '${CONS}';`,
      consultFixture) === "1",
  );

  // ── 2) 격리 ──────────────────────────────────────────────────────────────
  check(
    "타 커플은 남의 예약을 못 본다",
    asUser(opsUser, `select count(*) from public.consultations where id = '${CONS}';`,
      consultFixture) === "0",
  );
  check(
    "타 업체는 남에게 간 예약을 못 본다",
    asUser(adminUser, `select count(*) from public.consultations where id = '${CONS}';`,
      consultFixture) === "0",
  );
  for (const [label, table] of [
    ["비로그인은 예약을 못 본다", "consultations"],
    ["비로그인은 보증금을 못 본다", "consultation_deposits"],
  ]) {
    check(label, asAnon(`select count(*) from public.${table};`, consultFixture) === "0");
  }

  // ── 3) 플래너 — **채팅과 갈리는 지점** ───────────────────────────────────
  // §3.9 는 상담 행에만 "위임 플래너" 를 명시한다. 채팅(0021)에서는 뺐다.
  const consultPlannerFixture = `${consultFixture}
    insert into public.planners (id, user_id, status, profile_json, regions) values ('${PL2}', '${adminUser}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']);
    insert into public.planner_engagements
      (planner_id, couple_id, scope_json, status, valid_from, valid_to)
      values ('${PL2}', '${coupleId}', '{"tables":["consultations"]}'::jsonb,
              'active', now() - interval '1 day', now() + interval '30 days');
  `;

  check(
    "위임받은 플래너는 상담을 **본다** (채팅과 다르다 — §3.9 가 상담에만 명시)",
    asUser(adminUser, `select count(*) from public.consultations where id = '${CONS}';`,
      consultPlannerFixture) === "1",
  );
  check(
    "같은 플래너가 채팅은 못 본다 (경계가 표마다 다르다)",
    asUser(adminUser, `select count(*) from public.chat_rooms;`,
      `${consultPlannerFixture}
       insert into public.chat_rooms (couple_id, vendor_id) values ('${coupleId}', '${CV2}');`) === "0",
  );
  // 열람은 주되 이행 확인은 못 한다 — 노쇼 판정의 주체는 그 자리에 있던 당사자다.
  //
  // **여기서는 오류가 아니라 0행이 정상이다.** `consultations_update` 정책이
  // 당사자·업체만 통과시키므로 플래너의 UPDATE 는 대상 행을 못 찾고 끝난다. 트리거는
  // 아예 돌지 않는다. 0019·0021 이 "조용한 0행" 을 권한 회수로 바꾼 것은 **아무도
  // 써서는 안 되는 표·컬럼**이었기 때문이고, 여기는 당사자가 정상적으로 쓰는 컬럼이라
  // 행 필터가 맞는 도구다. API 는 그 앞에서 403 으로 분명히 답한다.
  check(
    "플래너는 이행 확인을 할 수 없다 (행 정책이 걸러 0행)",
    asUser(adminUser, `with u as (update public.consultations
       set couple_outcome = 'fulfilled', couple_confirmed_at = now()
       where id = '${CONS}' returning id) select count(*) from u;`,
      consultPlannerFixture) === "0",
  );
  check(
    "위임 범위를 빼면 플래너도 못 본다",
    asUser(adminUser, `select count(*) from public.consultations where id = '${CONS}';`,
      `${consultFixture}
       insert into public.planners (id, user_id, status, profile_json, regions) values ('${PL2}', '${adminUser}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']);
       insert into public.planner_engagements (planner_id, couple_id, scope_json, status)
         values ('${PL2}', '${coupleId}', '{"tables":["carts"]}'::jsonb, 'active');`) === "0",
  );

  // ── 4) 슬롯 중복 금지 (구간 겹침이라 EXCLUDE) ────────────────────────────
  check(
    "같은 시각에 두 번 확정할 수 없다",
    rejectedWith(/consultations_no_overlap/, () =>
      sql(`begin; ${consultFixture}
        insert into public.consultations
          (couple_id, vendor_id, type, scheduled_at, duration_minutes, ends_at, status)
          values ('${OC3}', '${CV2}', 'visit_consult',
                  '2027-05-15 05:00:00+00', 60, '2027-05-15 06:00:00+00', 'confirmed');
        rollback;`)),
  );
  // 시작 시각이 달라도 겹치면 막는다 — UNIQUE 로는 잡을 수 없는 경우다.
  check(
    "시작 시각이 달라도 구간이 겹치면 막는다 (UNIQUE 로는 못 잡는다)",
    rejectedWith(/consultations_no_overlap/, () =>
      sql(`begin; ${consultFixture}
        insert into public.consultations
          (couple_id, vendor_id, type, scheduled_at, duration_minutes, ends_at, status)
          values ('${OC3}', '${CV2}', 'visit_consult',
                  '2027-05-15 05:30:00+00', 60, '2027-05-15 06:30:00+00', 'confirmed');
        rollback;`)),
  );
  check(
    "맞닿기만 하는 다음 슬롯은 통과한다 (반개구간)",
    sql(`begin; ${consultFixture}
      insert into public.consultations
        (couple_id, vendor_id, type, scheduled_at, duration_minutes, ends_at, status)
        values ('${OC3}', '${CV2}', 'visit_consult',
                '2027-05-15 06:00:00+00', 60, '2027-05-15 07:00:00+00', 'confirmed');
      select count(*) from public.consultations where vendor_id = '${CV2}';
      rollback;`) === "2",
  );
  // 신청만으로는 자리를 차지하지 않는다 — 업체가 후보를 여럿 받아 고를 수 있어야 한다.
  check(
    "신청(requested)은 자리를 차지하지 않는다",
    sql(`begin; ${consultFixture}
      insert into public.consultations
        (couple_id, vendor_id, type, scheduled_at, duration_minutes, ends_at, status)
        values ('${OC3}', '${CV2}', 'visit_consult',
                '2027-05-15 05:00:00+00', 60, '2027-05-15 06:00:00+00', 'requested');
      select count(*) from public.consultations where vendor_id = '${CV2}';
      rollback;`) === "2",
  );
  check(
    "다른 업체의 같은 시각은 막지 않는다",
    sql(`begin; ${consultFixture}
      insert into public.consultations
        (couple_id, vendor_id, type, scheduled_at, duration_minutes, ends_at, status)
        values ('${OC3}', '${OV2}', 'visit_consult',
                '2027-05-15 05:00:00+00', 60, '2027-05-15 06:00:00+00', 'confirmed');
      select count(*) from public.consultations where scheduled_at = '2027-05-15 05:00:00+00';
      rollback;`) === "2",
  );

  // ── 5) 보증금은 서비스롤 전용 (§3.9) ─────────────────────────────────────
  check(
    "커플 owner 는 보증금을 본다 (금전 건이라 owner 만)",
    asUser(owner, `select count(*) from public.consultation_deposits where id = '${DEP}';`,
      consultFixture) === "1",
  );
  check(
    "업체도 보관 여부를 본다 (자리를 비워 둘지 판단해야 한다)",
    asUser(outsider, `select count(*) from public.consultation_deposits where id = '${DEP}';`,
      consultFixture) === "1",
  );
  check(
    "고객도 보증금 상태를 바꿀 수 없다 (권한 회수)",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `update public.consultation_deposits set status = 'refunded'
         where id = '${DEP}';`, consultFixture)),
  );
  check(
    "업체도 보증금을 몰취 처리할 수 없다",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `update public.consultation_deposits set status = 'forfeited'
         where id = '${DEP}';`, consultFixture)),
  );
  // 사유 없는 종결은 집행이 아니라 처분이다(D-24).
  check(
    "사유 없이 종결할 수 없다 (서비스롤도)",
    rejectedWith(/consultation_deposits_resolved_chk/, () =>
      sql(`begin; ${consultFixture}
        update public.consultation_deposits set status = 'refunded', resolved_at = now()
          where id = '${DEP}';
        rollback;`)),
  );
  check(
    "같은 멱등 열쇠로 두 번 결제할 수 없다",
    rejectedWith(/consultation_deposits_idempotency_key_key/, () =>
      sql(`begin; ${consultFixture}
        insert into public.consultations
          (id, couple_id, vendor_id, type, scheduled_at, duration_minutes, ends_at, status)
          values ('00000000-0000-0000-0000-00000000d007', '${coupleId}', '${OV2}', 'visit_consult',
                  '2027-06-15 05:00:00+00', 60, '2027-06-15 06:00:00+00', 'approved');
        insert into public.consultation_deposits
          (consultation_id, amount, status, held_at, idempotency_key)
          values ('00000000-0000-0000-0000-00000000d007', 30000, 'held', now(), 'rls-check-key');
        rollback;`)),
  );

  // ── 6) 이행 확인 — 자기 칸에만, 한 번만 ─────────────────────────────────
  check(
    "고객은 자기 칸에 답한다",
    asUser(owner, `with u as (update public.consultations
       set couple_outcome = 'fulfilled', couple_confirmed_at = now()
       where id = '${CONS}' returning id) select count(*) from u;`, consultFixture) === "1",
  );
  check(
    "고객은 업체 칸에 답할 수 없다",
    rejectedWith(/업체 이행 확인은/, () =>
      asUser(owner, `update public.consultations
         set vendor_outcome = 'fulfilled', vendor_confirmed_at = now()
         where id = '${CONS}';`, consultFixture)),
  );
  check(
    "업체는 고객 칸에 답할 수 없다",
    rejectedWith(/고객 이행 확인은/, () =>
      asUser(outsider, `update public.consultations
         set couple_outcome = 'no_show_couple', couple_confirmed_at = now()
         where id = '${CONS}';`, consultFixture)),
  );
  // 상대 답을 보고 말을 바꿀 수 있으면 대조가 의미를 잃는다.
  check(
    "이미 제출한 확인은 바꿀 수 없다",
    rejectedWith(/이미 제출한/, () =>
      asUser(owner, `update public.consultations set couple_outcome = 'no_show_vendor'
         where id = '${CONS}';`,
        `${consultFixture}
         update public.consultations set couple_outcome = 'fulfilled',
           couple_confirmed_at = now() where id = '${CONS}';`)),
  );
  check(
    "판정 결과(outcome)는 당사자가 쓸 수 없다 (권한)",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `update public.consultations set outcome = 'fulfilled'
         where id = '${CONS}';`, consultFixture)),
  );
  check(
    "확인 기한도 당사자가 미룰 수 없다",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `update public.consultations set confirm_due_at = now() + interval '99 days'
         where id = '${CONS}';`, consultFixture)),
  );
  check(
    "예약은 아무도 지울 수 없다 (분쟁의 근거다)",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `delete from public.consultations where id = '${CONS}';`, consultFixture)),
  );
  // 확인 시각과 주장은 짝이다 — 하나만 있으면 대조할 수 없다.
  check(
    "주장 없는 확인 시각은 거부한다 (짝 CHECK)",
    rejectedWith(/consultations_couple_confirm_pair_chk/, () =>
      sql(`begin; ${consultFixture}
        update public.consultations set couple_confirmed_at = now() where id = '${CONS}';
        rollback;`)),
  );

  // ── 7) 운영 파라미터 ─────────────────────────────────────────────────────
  check(
    "보증금액·취소 기한·확인 기한이 전부 app_settings 에 있다",
    sql(`select count(*) from public.app_settings where key in
       ('consultation.deposit_amount', 'consultation.free_cancel_hours',
        'consultation.confirm_due_hours');`) === "3",
  );
}

// =============================================================================
// 업체 알림·연동 설정 · 멤버 초대 (S4-14 · S2-09)
// -----------------------------------------------------------------------------
// 확인하는 경계는 넷이다.
//   1) **조직 설정은 owner, 템플릿은 멤버** — staff 가 수신 대상을 혼자 못 바꾼다
//   2) 기본 담당자는 그 업체 사람이어야 한다(트리거)
//   3) **초대받은 본인은 자기 초대만** 본다 — 아직 멤버가 아니라 멤버 정책으로는 못 본다
//   4) 수락은 서비스롤 경유 — 클라이언트는 vendor_members 에 못 넣는다
// =============================================================================
if (!adminUser || !opsUser || !vendorStaff) {
  console.log("SKIP  업체 설정·초대 항목 — 시드 계정이 없다");
} else {
  const SV = "00000000-0000-0000-0000-00000000e001"; // 설정 대상 업체
  const SOV = "00000000-0000-0000-0000-00000000e002"; // 타 업체
  const INV = "00000000-0000-0000-0000-00000000e003";
  const TPL = "00000000-0000-0000-0000-00000000e004";

  const settingsFixture = `
    insert into public.vendors (id, name, category, status)
      values ('${SV}', 'RLS설정업체', 'hall', 'active'),
             ('${SOV}', 'RLS설정타업체', 'hall', 'active');
    insert into public.vendor_members (vendor_id, user_id, vendor_role)
      values ('${SV}', '${outsider}', 'owner'),
             ('${SV}', '${vendorStaff}', 'staff'),
             ('${SOV}', '${adminUser}', 'owner');
    insert into public.vendor_settings (vendor_id, recipient_mode, business_hours)
      values ('${SV}', 'all', '[{"weekday":1,"start":"10:00","end":"19:00"}]'::jsonb);
    insert into public.vendor_notification_prefs (vendor_id, topic, channel_flags)
      values ('${SV}', 'inquiry', '{"email":true}'::jsonb);
    insert into public.vendor_templates (id, vendor_id, kind, title, payload_json)
      values ('${TPL}', '${SV}', 'quick_reply', 'RLS인사', '{"body":"안녕하세요"}'::jsonb);
    insert into public.vendor_invites
      (id, vendor_id, email, vendor_role, token, expires_at, invited_by)
      values ('${INV}', '${SV}', 'invitee@local.test', 'staff',
              'rls-check-token-0123456789abcdef', now() + interval '3 days', '${outsider}');
  `;

  // ── 1) 읽기는 멤버 전원 ───────────────────────────────────────────────────
  for (const [label, table, id] of [
    ["업체 멤버는 조직 설정을 본다", "vendor_settings", null],
    ["업체 멤버는 조직 채널 설정을 본다", "vendor_notification_prefs", null],
    ["업체 멤버는 템플릿을 본다", "vendor_templates", TPL],
    ["업체 멤버는 초대 현황을 본다", "vendor_invites", INV],
  ]) {
    const where = id ? ` where id = '${id}'` : ` where vendor_id = '${SV}'`;
    check(label, asUser(vendorStaff, `select count(*) from public.${table}${where};`,
      settingsFixture) === "1");
  }

  // ── 2) 쓰기 권한이 갈린다 ─────────────────────────────────────────────────
  check(
    "대표는 수신 대상을 바꾼다",
    asUser(outsider, `with u as (update public.vendor_settings set recipient_mode = 'specific'
       where vendor_id = '${SV}' returning vendor_id) select count(*) from u;`,
      settingsFixture) === "1",
  );
  // staff 가 'specific: 나' 로 바꾸면 대표가 문의를 못 받는다.
  check(
    "staff 는 수신 대상을 바꿀 수 없다",
    asUser(vendorStaff, `with u as (update public.vendor_settings set recipient_mode = 'specific'
       where vendor_id = '${SV}' returning vendor_id) select count(*) from u;`,
      settingsFixture) === "0",
  );
  check(
    "staff 는 조직 채널 설정을 바꿀 수 없다",
    asUser(vendorStaff, `with u as (update public.vendor_notification_prefs
       set channel_flags = '{"email":false}'::jsonb where vendor_id = '${SV}' returning id)
       select count(*) from u;`, settingsFixture) === "0",
  );
  // 문안 저장은 응대의 일부라 staff 도 한다.
  check(
    "staff 도 템플릿을 만든다",
    asUser(vendorStaff, `with i as (insert into public.vendor_templates
       (vendor_id, kind, title, payload_json)
       values ('${SV}', 'quick_reply', 'staff 문안', '{"body":"확인해 드릴게요"}'::jsonb)
       returning id) select count(*) from i;`, settingsFixture) === "1",
  );
  check(
    "설정은 지울 수 없다 (권한 회수)",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `delete from public.vendor_settings where vendor_id = '${SV}';`,
        settingsFixture)),
  );

  // ── 3) 기본 담당자는 그 업체 사람이어야 한다 (트리거) ────────────────────
  check(
    "대표는 자기 업체 구성원을 기본 담당자로 지정한다",
    asUser(outsider, `with u as (update public.vendor_settings
       set default_assignee_id = '${vendorStaff}' where vendor_id = '${SV}' returning vendor_id)
       select count(*) from u;`, settingsFixture) === "1",
  );
  check(
    "업체 밖 사람은 기본 담당자가 될 수 없다",
    rejectedWith(/구성원이어야/, () =>
      asUser(outsider, `update public.vendor_settings set default_assignee_id = '${owner}'
         where vendor_id = '${SV}';`, settingsFixture)),
  );

  // ── 4) 격리 ──────────────────────────────────────────────────────────────
  for (const [label, table, where] of [
    ["타 업체는 남의 설정을 못 본다", "vendor_settings", `vendor_id = '${SV}'`],
    ["타 업체는 남의 템플릿을 못 본다", "vendor_templates", `id = '${TPL}'`],
    ["타 업체는 남의 초대를 못 본다", "vendor_invites", `id = '${INV}'`],
  ]) {
    check(label, asUser(adminUser, `select count(*) from public.${table} where ${where};`,
      settingsFixture) === "0");
  }
  for (const [label, table] of [
    ["비로그인은 업체 설정을 못 본다", "vendor_settings"],
    ["비로그인은 템플릿을 못 본다", "vendor_templates"],
    ["비로그인은 초대를 못 본다", "vendor_invites"],
  ]) {
    check(label, asAnon(`select count(*) from public.${table};`, settingsFixture) === "0");
  }

  // ── 5) 초대 ──────────────────────────────────────────────────────────────
  check(
    "staff 는 초대를 발행할 수 없다 (42501 — vendor_members INSERT 가 owner 전용이라)",
    rejectedWith(/row-level security/i, () =>
      asUser(vendorStaff, `insert into public.vendor_invites
         (vendor_id, email, vendor_role, token, expires_at)
         values ('${SV}', 'x@local.test', 'staff', 'staff-token-0123456789abcdef',
                 now() + interval '1 day');`, settingsFixture)),
  );
  // 초대받은 사람이 vendor_role 을 owner 로 바꿔 수락하면 권한 상승이 된다.
  check(
    "대표도 초대의 권한·이메일은 못 고친다 (컬럼 권한)",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `update public.vendor_invites set vendor_role = 'owner' where id = '${INV}';`,
        settingsFixture)),
  );
  check(
    "대표는 초대를 거둘 수 있다 (revoked_at 만 열려 있다)",
    asUser(outsider, `with u as (update public.vendor_invites set revoked_at = now()
       where id = '${INV}' returning id) select count(*) from u;`, settingsFixture) === "1",
  );
  // 수락은 서비스롤이 처리한다 — 클라이언트가 스스로 수락 표시를 할 수 없다.
  check(
    "아무도 수락 표시를 직접 할 수 없다",
    rejectedWith(/permission denied/i, () =>
      asUser(outsider, `update public.vendor_invites set accepted_at = now(), accepted_by = '${owner}'
         where id = '${INV}';`, settingsFixture)),
  );
  check(
    "초대받은 사람도 vendor_members 에 스스로 들어갈 수 없다 (42501)",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.vendor_members (vendor_id, user_id, vendor_role)
         values ('${SV}', '${owner}', 'staff');`, settingsFixture)),
  );
  // 살아 있는 초대는 업체·이메일당 하나. 재발송은 그 행에 새 토큰을 끼운다.
  check(
    "같은 이메일에 살아 있는 초대는 하나뿐이다",
    rejectedWith(/uq_vendor_invites_pending/, () =>
      sql(`begin; ${settingsFixture}
        insert into public.vendor_invites (vendor_id, email, vendor_role, token, expires_at)
          values ('${SV}', 'invitee@local.test', 'staff', 'dup-token-0123456789abcdef',
                  now() + interval '1 day');
        rollback;`)),
  );
  check(
    "거둔 뒤에는 같은 이메일로 다시 초대할 수 있다",
    sql(`begin; ${settingsFixture}
      update public.vendor_invites set revoked_at = now() where id = '${INV}';
      insert into public.vendor_invites (vendor_id, email, vendor_role, token, expires_at)
        values ('${SV}', 'invitee@local.test', 'staff', 'again-token-0123456789abcdef',
                now() + interval '1 day');
      select count(*) from public.vendor_invites where vendor_id = '${SV}';
      rollback;`) === "2",
  );
  check(
    "수락된 초대는 거둘 수 없다 (배타 CHECK)",
    rejectedWith(/vendor_invites_revoke_chk/, () =>
      sql(`begin; ${settingsFixture}
        update public.vendor_invites
          set accepted_at = now(), accepted_by = '${owner}', revoked_at = now()
          where id = '${INV}';
        rollback;`)),
  );
  check(
    "대문자 이메일은 저장되지 않는다 (소문자 CHECK)",
    rejectedWith(/vendor_invites_email_chk/, () =>
      sql(`begin; ${settingsFixture}
        insert into public.vendor_invites (vendor_id, email, vendor_role, token, expires_at)
          values ('${SV}', 'Upper@Local.test', 'staff', 'upper-token-0123456789abcdef',
                  now() + interval '1 day');
        rollback;`)),
  );

  // ── 6) 운영 파라미터 ─────────────────────────────────────────────────────
  check(
    "초대 유효 기간이 app_settings 에 있다",
    sql(`select count(*) from public.app_settings where key = 'vendor_invite.ttl_hours';`) === "1",
  );
}

// =============================================================================
// 실시간 전송 계층 (S4-04 · O-11)
// -----------------------------------------------------------------------------
// **무엇을 구독하느냐가 곧 무엇이 소켓을 타느냐다.** postgres_changes 는 바뀐 행을
// 통째로 보내고 뷰를 거치지 않으므로, `chat_messages` 를 publication 에 넣는 순간
// 본문이 전송 계층에 흐르고 회수 가림막(chat_messages_visible)이 우회된다.
// 이 검사는 그 실수를 되돌아오지 못하게 막는다.
// =============================================================================
const published = sql(
  `select coalesce(string_agg(tablename, ',' order by tablename), '')
     from pg_publication_tables where pubname = 'supabase_realtime';`,
);

check("실시간 publication 에 chat_rooms 가 있다", published.split(",").includes("chat_rooms"));
check(
  "실시간 publication 에 chat_messages 는 **없다** (본문이 소켓을 타면 안 된다)",
  !published.split(",").includes("chat_messages"),
);
// 토픽 목록은 TS 상수와 DB CHECK 두 곳에 있다. S4-04 에서 한쪽만 늘렸다가 발송이
// **조용히** 실패했다 — 알림 실패가 본 작업을 되돌리지 않게 만들어 둔 탓에 더 조용했다.
// 두 목록이 어긋나면 여기서 걸린다.
const dbTopics = sql(
  `select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.notifications'::regclass and conname = 'notifications_topic_chk';`,
);
const codeTopics = readFileSync("lib/core/schemas/notification.ts", "utf8")
  .match(/export const NOTIFICATION_TOPICS = \[([\s\S]*?)\] as const;/)?.[1]
  .match(/"([a-z_]+)"/g)
  ?.map((value) => value.replaceAll('"', "")) ?? [];

check(
  "알림 토픽 목록이 코드와 DB CHECK 에서 일치한다",
  codeTopics.length > 0 && codeTopics.every((topic) => dbTopics.includes(`'${topic}'`)),
  `code=${codeTopics.join(",")}`,
);
check(
  "SLA 기준 시간은 코드가 아니라 app_settings 가 갖는다",
  sql(`select count(*) from public.app_settings where key = 'chat.sla_response_minutes';`) === "1",
);
// 파라미터라도 남의 눈에 띌 이유는 없다. 정책이 없으므로 기본 거부여야 한다.
check(
  "비로그인은 운영 파라미터를 못 본다",
  asAnon(`select count(*) from public.app_settings;`) === "0",
);

// =============================================================================
// 분할 결제 · 정산 · 플래너 지급 (S5-01 잔여분 · 0028)
// -----------------------------------------------------------------------------
// 돈이 걸린 표들이다. 확인할 것은 셋이다 —
//   (가) **불변식이 DB 에 서 있는가**: 비율 합 10000bp · 요율 스냅샷 불변 · 유예 경계
//   (나) **경계가 RLS 인가**: staff 정산 차단 · 타 업체 격리 · 플래너 자기 것만 · anon
//   (다) **당사자가 자기 수수료율을 못 쓰는가**: 정책은 행을 가르고 컬럼을 가르지 않으므로
//        컬럼 수준 권한이 필요하다.
// =============================================================================
if (!vendorStaff || !adminUser) {
  console.log("SKIP  결제·정산 항목 — 시드 계정이 없다");
} else {
  const PV = "00000000-0000-0000-0000-00000000f001"; // 정산 대상 업체
  const POV = "00000000-0000-0000-0000-00000000f002"; // 타 업체
  const PP = "00000000-0000-0000-0000-00000000f003"; // 상품
  const PB = "00000000-0000-0000-0000-00000000f004"; // 예약
  const PC = "00000000-0000-0000-0000-00000000f005"; // 계약
  const PS1 = "00000000-0000-0000-0000-00000000f006"; // 회차 1
  const PS2 = "00000000-0000-0000-0000-00000000f007"; // 회차 2
  const PSET = "00000000-0000-0000-0000-00000000f008"; // 정산서
  const POSET = "00000000-0000-0000-0000-00000000f009"; // 타 업체 정산서
  const PPL = "00000000-0000-0000-0000-00000000f00a"; // 플래너
  const POPL = "00000000-0000-0000-0000-00000000f00b"; // 타 플래너
  const PPS = "00000000-0000-0000-0000-00000000f00c"; // 플래너 정산

  /**
   * 예약 → 계약 → 회차 2건(2000/8000) + 정산서 2건(우리·남) + 플래너 정산 1건.
   * 회차는 **한 트랜잭션 안에서** 두 행을 넣는다 — 비율 합 판정이 커밋 시점이라
   * 즉시 판정 트리거로는 첫 행에서 걸린다는 사실이 이 픽스처로 확인된다.
   */
  const payFixture = `
    insert into public.vendors (id, name, category, status)
      values ('${PV}', 'RLS정산업체', 'hall', 'active'),
             ('${POV}', 'RLS정산타업체', 'hall', 'active');
    insert into public.vendor_members (vendor_id, user_id, vendor_role)
      values ('${PV}', '${outsider}', 'owner'),
             ('${PV}', '${vendorStaff}', 'staff'),
             ('${POV}', '${adminUser}', 'owner');
    insert into public.products (id, vendor_id, category, name, base_price_total)
      values ('${PP}', '${PV}', 'hall', 'RLS정산상품', 10000000);
    insert into public.bookings (id, couple_id, vendor_id, product_id, status, total_amount)
      values ('${PB}', '${coupleId}', '${PV}', '${PP}', 'hold', 10000000);
    insert into public.contracts (id, booking_id, status)
      values ('${PC}', '${PB}', 'draft');
    insert into public.payment_schedules
      (id, contract_id, seq, ratio_bp, due_anchor, due_offset_days, amount)
      values ('${PS1}', '${PC}', 1, 2000, 'on_contract', 0, 2000000),
             ('${PS2}', '${PC}', 2, 8000, 'before_event', 30, 8000000);
    -- 0033 이 "계산이 선 정산서에는 기준 스냅샷이 있어야 한다" 를 CHECK 로 세웠다.
    -- 그래서 이 픽스처도 fee_basis 를 갖는다(검사의 뜻은 그대로다).
    insert into public.settlements
      (id, vendor_id, period_start, period_end, gross_amount, fee_rate_bp, fee_amount, net_amount,
       status, fee_basis, calculated_at)
      values ('${PSET}', '${PV}', '2026-09-01', '2026-09-30', 10000000, 500, 500000, 9500000,
              'draft', 'pre_discount', now()),
             ('${POSET}', '${POV}', '2026-09-01', '2026-09-30', 20000000, 800, 1600000, 18400000,
              'draft', 'pre_discount', now());
    insert into public.planners (id, user_id, status, profile_json, regions)
      values ('${PPL}', '${owner}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']),
             ('${POPL}', '${partner}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']);
    insert into public.planner_settlements
      (id, planner_id, booking_id, gross_amount, fee_rate_bp, fee_amount, earned_at, payable_at)
      values ('${PPS}', '${PPL}', '${PB}', 10000000, 300, 300000,
              now() - interval '20 days', now() - interval '6 days');
  `;

  // ── S5-06 이 더한 픽스처 (0030) ───────────────────────────────────────────
  // 0030 이 결제에 세 가지를 요구하게 됐다: **확정된 계약** · **고지·동의 기록** ·
  // **상태와 시각의 짝**. 그래서 0028 이 쓰던 "그냥 paid 한 줄" 픽스처로는 더 이상
  // 결제를 만들 수 없다 — 아래 셋이 그 자리를 대신한다.
  const PAY1 = "00000000-0000-0000-0000-00000000f010"; // 결제 1
  const PAY2 = "00000000-0000-0000-0000-00000000f011"; // 결제 2

  /** 계약을 **확정(active)까지** 밀어 올린다. 서명 두 건을 실제로 거쳐서 간다. */
  const activeFixture = `
    ${payFixture}
    update public.contracts set
      template_id = (select id from public.contract_templates where status = 'active'),
      template_version = 'v0-placeholder',
      content_hash = repeat('a', 64),
      total_amount = 10000000,
      applied_fee_rate_bp = 500,
      applied_planner_fee_rate_bp = 0,
      issued_at = now(),
      status = 'issued'
    where id = '${PC}';
    insert into public.contract_signatures
      (contract_id, signer_id, signer_role, signed_at, signed_content_hash, verification_method)
      values ('${PC}', '${owner}', 'couple', now(), repeat('a', 64), 'sms_stub'),
             ('${PC}', '${outsider}', 'vendor', now(), repeat('a', 64), 'sms_stub');
    update public.contracts set status = 'active', activated_at = now() where id = '${PC}';
  `;

  /** 결제 전 고지·동의 두 종. 이것이 없으면 승인 자체가 막힌다(F-C-14). */
  const consentFixture = `
    insert into public.payment_consents
      (payment_schedule_id, user_id, kind, consent_version)
      values ('${PS1}', '${owner}', 'installment_terms', 'v1'),
             ('${PS1}', '${owner}', 'refund_policy', 'v1');
  `;

  const paidInsert = (id, status = "paid") => `
    insert into public.payments
      (id, booking_id, payment_schedule_id, purpose, amount, status, paid_at, idempotency_key)
      values ('${id}', '${PB}', '${PS1}', 'deposit', 2000000, '${status}',
              ${status === "paid" ? "now()" : "null"}, 'schedule:${PS1}:charge:${id.slice(-3)}');
  `;

  // ── 회차 비율 합 (커밋 시점 판정) ─────────────────────────────────────────
  check(
    "회차 두 건을 한 트랜잭션에 넣으면 통과한다 (합 10000bp)",
    sql(`begin; ${payFixture} select count(*) from public.payment_schedules
         where contract_id = '${PC}'; rollback;`) === "2",
  );
  check(
    "비율 합이 10000bp 가 아니면 **커밋 시점에** 거절된다",
    rejectedWith(/payment_schedules_ratio_sum|10000bp/, () =>
      sql(`begin;
        insert into public.vendors (id, name, category, status)
          values ('${PV}', 'RLS정산업체', 'hall', 'active');
        insert into public.products (id, vendor_id, category, name, base_price_total)
          values ('${PP}', '${PV}', 'hall', 'RLS정산상품', 10000000);
        insert into public.bookings (id, couple_id, vendor_id, product_id, status, total_amount)
          values ('${PB}', '${coupleId}', '${PV}', '${PP}', 'hold', 10000000);
        insert into public.contracts (id, booking_id, status) values ('${PC}', '${PB}', 'draft');
        insert into public.payment_schedules
          (contract_id, seq, ratio_bp, due_anchor, due_offset_days, amount)
          values ('${PC}', 1, 2000, 'on_contract', 0, 2000000);
        commit;`)),
  );
  check(
    "회차가 0건인 계약은 통과한다 (스케줄 전 계약이 정상이다)",
    sql(`begin;
      insert into public.vendors (id, name, category, status)
        values ('${PV}', 'RLS정산업체', 'hall', 'active');
      insert into public.bookings (id, couple_id, vendor_id, status, total_amount)
        values ('${PB}', '${coupleId}', '${PV}', 'hold', 10000000);
      insert into public.contracts (id, booking_id, status) values ('${PC}', '${PB}', 'draft');
      select count(*) from public.contracts where id = '${PC}';
      rollback;`) === "1",
  );
  check(
    "void 회차는 합에서 빠진다 (취소된 회차가 합을 깨지 않는다)",
    sql(`begin; ${payFixture}
      update public.payment_schedules set status = 'void' where id = '${PS2}';
      insert into public.payment_schedules
        (contract_id, seq, ratio_bp, due_anchor, due_offset_days, amount)
        values ('${PC}', 3, 8000, 'before_event', 14, 8000000);
      select count(*) from public.payment_schedules where contract_id = '${PC}';
      rollback;`) === "3",
  );
  check(
    "기준 사건과 오프셋의 짝이 어긋나면 거절한다",
    rejectedWith(/payment_schedules_offset_shape/, () =>
      sql(`begin; ${payFixture}
        insert into public.payment_schedules
          (contract_id, seq, ratio_bp, due_anchor, due_offset_days, amount)
          values ('${PC}', 3, 1, 'on_contract', 5, 0);
        rollback;`)),
  );
  check(
    "같은 계약에 같은 순번은 하나뿐이다",
    rejectedWith(/payment_schedules_contract_id_seq_key|duplicate key/, () =>
      sql(`begin; ${payFixture}
        insert into public.payment_schedules
          (contract_id, seq, ratio_bp, due_anchor, due_offset_days, amount)
          values ('${PC}', 1, 1, 'on_contract', 0, 0);
        rollback;`)),
  );

  // ── 요율 스냅샷 (D-16 · D-17) ─────────────────────────────────────────────
  check(
    "요율 스냅샷 없이 계약을 확정할 수 없다",
    rejectedWith(/bookings_rate_snapshot_required|스냅샷/, () =>
      sql(`begin; ${payFixture}
        update public.bookings set status = 'confirmed' where id = '${PB}';
        rollback;`)),
  );
  check(
    "요율을 박으면 확정할 수 있다 (플래너 미선택은 0)",
    sql(`begin; ${payFixture}
      update public.bookings
        set applied_fee_rate_bp = 500, applied_planner_fee_rate_bp = 0 where id = '${PB}';
      with u as (update public.bookings set status = 'confirmed' where id = '${PB}' returning id)
      select count(*) from u;
      rollback;`) === "1",
  );
  check(
    "한 번 박힌 스냅샷은 바꿀 수 없다 (요율 변경이 과거 거래에 소급되지 않는다)",
    rejectedWith(/스냅샷은 바꿀 수 없습니다/, () =>
      sql(`begin; ${payFixture}
        update public.bookings set applied_fee_rate_bp = 500 where id = '${PB}';
        update public.bookings set applied_fee_rate_bp = 800 where id = '${PB}';
        rollback;`)),
  );
  check(
    "요율 범위를 벗어난 값은 거절한다",
    rejectedWith(/bookings_applied_fee_rate_range/, () =>
      sql(`begin; ${payFixture}
        update public.bookings set applied_fee_rate_bp = 10001 where id = '${PB}';
        rollback;`)),
  );

  // ── 당사자는 예약을 직접 쓸 수 없다 (0065 · FIX-44) ───────────────────────
  //
  // **이 자리에 있던 검사가 구멍을 정상 동작으로 적고 있었다.** 원문은 "커플 소유자는
  // 예약 상태를 바꿀 수 있다" 였고 실제로 통했다 — 그리고 그 길로 `status='confirmed'`
  // 를 만들면 `reviews_insert` 가 검증 후기 자격을 내줬다. 검사가 지키던 것이 지켜야
  // 할 것의 반대였던 셈이라, 뜻을 뒤집어 다시 쓴다.
  check(
    "**커플 소유자는 예약 상태를 바꿀 수 없다** (FIX-44 — 이 길로 후기 자격을 위조할 수 있었다)",
    rejectedWith(/permission denied|row-level security|42501/i, () =>
      asUser(owner, `update public.bookings set status = 'cancelled' where id = '${PB}';`,
        payFixture)),
  );
  check(
    "커플 소유자는 **요율 컬럼도 쓸 수 없다** (0065 이후에는 표 전체가 닫혔다)",
    rejectedWith(/permission denied|42501/i, () =>
      asUser(owner, `update public.bookings set applied_fee_rate_bp = 0 where id = '${PB}';`,
        payFixture)),
  );
  check(
    "업체 멤버도 요율 컬럼을 쓸 수 없다",
    rejectedWith(/permission denied|42501/i, () =>
      asUser(outsider, `update public.bookings set applied_fee_rate_bp = 0 where id = '${PB}';`,
        payFixture)),
  );
  check(
    "총액도 당사자가 바꿀 수 없다 (돈은 서비스롤의 일이다)",
    rejectedWith(/permission denied|42501/i, () =>
      asUser(owner, `update public.bookings set total_amount = 1 where id = '${PB}';`, payFixture)),
  );

  // ── 회차 열람 ─────────────────────────────────────────────────────────────
  // **개수가 아니라 이 픽스처의 계약에 달린 회차가 보이는지를 본다.** 원문은 `=== "2"`
  // 였고, S5-12 가 계약·회차 시드를 붙이자 곧바로 깨졌다 — 검사가 확인하려던 것은
  // "몇 개인가" 가 아니라 "내 계약의 회차가 보이는가" 다(함정 8).
  check(
    "커플 소유자는 결제 회차를 본다",
    asUser(
      owner,
      `select count(*) from public.payment_schedules where contract_id = '${PC}';`,
      payFixture,
    ) === "2",
  );
  check(
    "업체 멤버도 결제 회차를 본다 (응대에 필요한 운영 정보다)",
    asUser(
      vendorStaff,
      `select count(*) from public.payment_schedules where contract_id = '${PC}';`,
      payFixture,
    ) === "2",
  );
  check(
    "타 업체는 남의 회차를 못 본다",
    asUser(adminUser, `select count(*) from public.payment_schedules;`, payFixture) === "0",
  );
  check(
    "비로그인은 회차를 못 본다",
    asAnon(`select count(*) from public.payment_schedules;`, payFixture) === "0",
  );
  check(
    "회차는 아무도 쓸 수 없다 (정책 없음 = 서비스롤 전용)",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.payment_schedules
         (contract_id, seq, ratio_bp, due_anchor, due_offset_days, amount)
         values ('${PC}', 9, 1, 'on_contract', 0, 0);`, payFixture)),
  );
  check(
    "회차 상태도 당사자가 바꿀 수 없다",
    asUser(owner, `with u as (update public.payment_schedules set status = 'paid' returning id)
       select count(*) from u;`, payFixture) === "0",
  );

  // ── 정산 (§3.9 — staff 차단) ──────────────────────────────────────────────
  check(
    "업체 대표는 자기 정산서를 본다",
    asUser(outsider, `select count(*) from public.settlements;`, payFixture) === "1",
  );
  check(
    "**staff 는 정산서를 못 본다** (S2-08 이 화면에서만 막던 것을 DB 로 내렸다)",
    asUser(vendorStaff, `select count(*) from public.settlements;`, payFixture) === "0",
  );
  // 0033 이 운영자 열람 정책을 더했다(F-A-11 — 집행하려면 봐야 한다). 시드에서 타 업체
  // 대표 자리를 admin 계정이 겸하고 있어 그 계정으로는 격리를 볼 수 없다 —
  // **운영자가 아닌 업체 대표**(outsider)로 격리를, admin 으로 운영자 열람을 각각 본다.
  check(
    "업체 대표는 자기 정산서만 본다 (격리)",
    asUser(outsider, `select id from public.settlements;`, payFixture) === PSET,
  );
  check(
    "운영자는 모든 정산서를 본다 (F-A-11 — 집행하려면 봐야 한다)",
    asUser(adminUser, `select count(*) from public.settlements;`, payFixture) === "2",
  );
  check(
    "커플은 업체 정산서를 못 본다",
    asUser(partner, `select count(*) from public.settlements;`, payFixture) === "0",
  );
  check(
    "비로그인은 정산서를 못 본다",
    asAnon(`select count(*) from public.settlements;`, payFixture) === "0",
  );
  check(
    "staff 는 정산 명세도 못 본다 (상위 스코프를 그대로 따른다)",
    asUser(vendorStaff, `select count(*) from public.settlement_items;`,
      `${payFixture}
       insert into public.settlement_items
         (settlement_id, booking_id, amount, fee_rate_bp, fee_amount, net_amount)
         values ('${PSET}', '${PB}', 10000000, 500, 500000, 9500000);`) === "0",
  );
  check(
    "대표는 정산 명세를 본다",
    asUser(outsider, `select count(*) from public.settlement_items;`,
      `${payFixture}
       insert into public.settlement_items
         (settlement_id, booking_id, amount, fee_rate_bp, fee_amount, net_amount)
         values ('${PSET}', '${PB}', 10000000, 500, 500000, 9500000);`) === "1",
  );
  check(
    "정산액 정합이 깨지면 거절한다 (순액 = 총액 - 수수료)",
    rejectedWith(/settlements_net_amount_shape/, () =>
      sql(`begin;
        insert into public.vendors (id, name, category, status)
          values ('${PV}', 'RLS정산업체', 'hall', 'active');
        insert into public.settlements
          (vendor_id, period_start, period_end, gross_amount, fee_rate_bp, fee_amount, net_amount,
           status, fee_basis, calculated_at)
          values ('${PV}', '2026-10-01', '2026-10-31', 10000000, 500, 500000, 9000000,
                  'draft', 'pre_discount', now());
        rollback;`)),
  );
  check(
    "정산 요율은 bp 정수다 (numeric fee_rate 는 사라졌다)",
    sql(`select count(*) from information_schema.columns
         where table_name = 'settlements' and column_name = 'fee_rate';`) === "0",
  );

  // ── 플래너 정산 ───────────────────────────────────────────────────────────
  check(
    "플래너는 자기 정산만 본다",
    asUser(owner, `select count(*) from public.planner_settlements;`, payFixture) === "1",
  );
  check(
    "다른 플래너의 정산은 못 본다",
    asUser(partner, `select count(*) from public.planner_settlements;`, payFixture) === "0",
  );
  check(
    "업체는 플래너 정산을 못 본다 (남의 수입이다)",
    asUser(outsider, `select count(*) from public.planner_settlements;`, payFixture) === "0",
  );
  check(
    "비로그인은 플래너 정산을 못 본다",
    asAnon(`select count(*) from public.planner_settlements;`, payFixture) === "0",
  );
  check(
    "플래너도 자기 정산을 고칠 수 없다 (지급은 서비스롤의 일이다)",
    asUser(owner, `with u as (update public.planner_settlements set status = 'paid' returning id)
       select count(*) from u;`, payFixture) === "0",
  );
  check(
    "유예가 지나지 않은 정산은 지급 대상이 될 수 없다",
    rejectedWith(/planner_settlements_grace_not_elapsed|유예/, () =>
      sql(`begin; ${payFixture}
        insert into public.planner_settlements
          (planner_id, booking_id, gross_amount, fee_rate_bp, fee_amount, earned_at, payable_at, status)
          values ('${POPL}', '${PB}', 10000000, 300, 300000,
                  now(), now() + interval '14 days', 'payable');
        rollback;`)),
  );
  check(
    "유예가 지난 정산은 지급 대상이 된다",
    sql(`begin; ${payFixture}
      with u as (update public.planner_settlements set status = 'payable'
        where id = '${PPS}' returning id) select count(*) from u;
      rollback;`) === "1",
  );
  check(
    "한 계약에 같은 플래너 정산은 하나뿐이다",
    rejectedWith(/planner_settlements_planner_id_booking_id_key|duplicate key/, () =>
      sql(`begin; ${payFixture}
        insert into public.planner_settlements
          (planner_id, booking_id, gross_amount, fee_rate_bp, fee_amount, earned_at, payable_at)
          values ('${PPL}', '${PB}', 1, 0, 0, now() - interval '20 days', now() - interval '6 days');
        rollback;`)),
  );
  check(
    "지급 시점이 발생 시점보다 앞설 수 없다",
    rejectedWith(/planner_settlements_grace_order/, () =>
      sql(`begin; ${payFixture}
        insert into public.planner_settlements
          (planner_id, booking_id, gross_amount, fee_rate_bp, fee_amount, earned_at, payable_at)
          values ('${POPL}', '${PB}', 1, 0, 0, now(), now() - interval '1 day');
        rollback;`)),
  );

  // ── 결제 · 웹훅 ───────────────────────────────────────────────────────────
  // 0030 이 승인 조건을 조였다 — 확정된 계약 + 동의 + 상태·시각의 짝. 그래서 이
  // 두 검사의 픽스처가 activeFixture 로 바뀌었다(검사의 뜻은 그대로다).
  check(
    "회차당 성공 결제는 하나뿐이다",
    rejectedWith(/uq_payments_schedule_paid|duplicate key/, () =>
      sql(`begin; ${activeFixture} ${consentFixture} ${paidInsert(PAY1)} ${paidInsert(PAY2)}
        rollback;`)),
  );
  check(
    "실패한 결제는 여러 번 있을 수 있다 (재시도가 정상이다)",
    sql(`begin; ${payFixture}
      insert into public.payments
        (booking_id, payment_schedule_id, purpose, amount, status, failed_at)
        values ('${PB}', '${PS1}', 'deposit', 2000000, 'failed', now()),
               ('${PB}', '${PS1}', 'deposit', 2000000, 'failed', now());
      select count(*) from public.payments where payment_schedule_id = '${PS1}';
      rollback;`) === "2",
  );
  check(
    "알 수 없는 결제 상태는 거절한다",
    rejectedWith(/payments_status_values/, () =>
      sql(`begin; ${payFixture}
        insert into public.payments (booking_id, purpose, amount, status)
          values ('${PB}', 'deposit', 1, 'PAID');
        rollback;`)),
  );
  check(
    "멤버십 결제에는 회차를 붙일 수 없다",
    rejectedWith(/payments_schedule_purpose_chk/, () =>
      sql(`begin; ${payFixture}
        insert into public.payments (booking_id, payment_schedule_id, purpose, amount)
          values ('${PB}', '${PS1}', 'membership', 1);
        rollback;`)),
  );
  check(
    "웹훅 원문에 식별정보 키를 담을 수 없다 (§7.3)",
    rejectedWith(/payments_webhook_no_pii/, () =>
      sql(`begin; ${payFixture}
        insert into public.payments (booking_id, purpose, amount, raw_webhook_json)
          values ('${PB}', 'deposit', 1, '{"customerName": "홍길동"}'::jsonb);
        rollback;`)),
  );
  check(
    "정규화 스냅샷은 담을 수 있다",
    sql(`begin; ${payFixture}
      with i as (insert into public.payments (booking_id, purpose, amount, raw_webhook_json)
        values ('${PB}', 'deposit', 1,
          '{"provider":"toss","eventId":"evt_1","status":"DONE","amount":2000000}'::jsonb)
        returning id) select count(*) from i;
      rollback;`) === "1",
  );
  check(
    "같은 웹훅 이벤트는 두 번 적재되지 않는다 (멱등의 지점)",
    rejectedWith(/payment_webhook_events_provider_event_id_key|duplicate key/, () =>
      sql(`begin;
        insert into public.payment_webhook_events (provider, event_id, payload_digest)
          values ('toss', 'evt_dup', repeat('a', 64)),
                 ('toss', 'evt_dup', repeat('b', 64));
        rollback;`)),
  );
  check(
    "다른 결제사의 같은 이벤트 id 는 별개다",
    sql(`begin;
      insert into public.payment_webhook_events (provider, event_id, payload_digest)
        values ('toss', 'evt_same', repeat('a', 64)),
               ('other', 'evt_same', repeat('b', 64));
      select count(*) from public.payment_webhook_events where event_id = 'evt_same';
      rollback;`) === "2",
  );
  check(
    "해시 형식이 아니면 거절한다 (원문 대신 해시를 남기므로 형식이 곧 증적이다)",
    rejectedWith(/payment_webhook_events_digest_shape/, () =>
      sql(`begin;
        insert into public.payment_webhook_events (provider, event_id, payload_digest)
          values ('toss', 'evt_bad', 'not-a-digest');
        rollback;`)),
  );
  for (const [label, who] of [
    ["업체 대표", outsider],
    ["커플 소유자", owner],
  ]) {
    check(
      `${who ? "" : ""}웹훅 원장은 ${label}도 못 본다 (정책 없음)`,
      asUser(who, `select count(*) from public.payment_webhook_events;`,
        `insert into public.payment_webhook_events (provider, event_id, payload_digest)
           values ('toss', 'evt_hidden', repeat('c', 64));`) === "0",
    );
  }
  check(
    "비로그인도 웹훅 원장을 못 본다",
    asAnon(`select count(*) from public.payment_webhook_events;`,
      `insert into public.payment_webhook_events (provider, event_id, payload_digest)
         values ('toss', 'evt_hidden2', repeat('d', 64));`) === "0",
  );

  // ===========================================================================
  // 결제 실행 (S5-06 · 0030)
  // ---------------------------------------------------------------------------
  // 0028 이 **회차를 만드는 쪽**을 시험했다면 여기는 **실제로 내는 쪽**이다.
  // 확인할 것은 넷 —
  //   (가) 확정되지 않은 계약의 회차는 승인될 수 없다
  //   (나) 고지·동의 없이는 승인될 수 없다(F-C-14)
  //   (다) 회차당 진행 중 1건 · 성공 1건 · 상태를 되돌릴 수 없다(D-23)
  //   (라) 환불액과 상태가 어긋날 수 없다(부분 환불을 전제한 짝)
  // ===========================================================================
  check(
    "확정되지 않은 계약의 회차는 승인될 수 없다",
    rejectedWith(/payments_contract_not_active|확정된 계약의 회차만/, () =>
      sql(`begin; ${payFixture} ${consentFixture} ${paidInsert(PAY1)} rollback;`)),
  );
  check(
    "고지·동의 기록이 없으면 승인될 수 없다 (F-C-14)",
    rejectedWith(/payments_consent_missing|고지·동의 기록이 없습니다/, () =>
      sql(`begin; ${activeFixture} ${paidInsert(PAY1)} rollback;`)),
  );
  check(
    "같은 종류로만 두 건을 채워도 통과하지 못한다 (종류를 센다)",
    rejectedWith(/payments_consent_missing|고지·동의 기록이 없습니다/, () =>
      sql(`begin; ${activeFixture}
        insert into public.payment_consents
          (payment_schedule_id, user_id, kind, consent_version)
          values ('${PS1}', '${owner}', 'installment_terms', 'v1');
        ${paidInsert(PAY1)} rollback;`)),
  );
  check(
    "확정된 계약 + 동의가 있으면 승인된다",
    sql(`begin; ${activeFixture} ${consentFixture} ${paidInsert(PAY1)}
         select count(*) from public.payments where id = '${PAY1}'; rollback;`) === "1",
  );

  // ── 회차 완료의 근거 ──────────────────────────────────────────────────────
  check(
    "승인된 결제 없이 회차를 완료 처리할 수 없다",
    rejectedWith(/payment_schedules_paid_without_payment|승인된 결제 없이/, () =>
      sql(`begin; ${activeFixture}
        update public.payment_schedules set status = 'paid', paid_at = now() where id = '${PS1}';
        rollback;`)),
  );
  check(
    "승인된 결제가 있으면 회차가 완료로 넘어간다",
    sql(`begin; ${activeFixture} ${consentFixture} ${paidInsert(PAY1)}
        update public.payment_schedules set status = 'paid', paid_at = now() where id = '${PS1}';
        select status from public.payment_schedules where id = '${PS1}'; rollback;`) === "paid",
  );

  // ── 회차당 하나 ───────────────────────────────────────────────────────────
  check(
    "회차당 진행 중인 결제는 하나뿐이다 (0030 부분 유니크)",
    rejectedWith(/uq_payments_schedule_pending|23505/, () =>
      sql(`begin; ${activeFixture} ${paidInsert(PAY1, "pending")} ${paidInsert(PAY2, "pending")}
        rollback;`)),
  );
  // ── 되돌릴 수 없다 (D-23) ─────────────────────────────────────────────────
  check(
    "실패한 결제를 pending 으로 되돌릴 수 없다",
    rejectedWith(/payments_transition|허용되지 않은 결제 상태 전이/, () =>
      sql(`begin; ${activeFixture} ${paidInsert(PAY1, "pending")}
        update public.payments set status = 'failed', failed_at = now() where id = '${PAY1}';
        update public.payments set status = 'pending', failed_at = null where id = '${PAY1}';
        rollback;`)),
  );
  check(
    "승인된 결제를 실패로 바꿀 수 없다",
    rejectedWith(/payments_transition|허용되지 않은 결제 상태 전이/, () =>
      sql(`begin; ${activeFixture} ${consentFixture} ${paidInsert(PAY1)}
        update public.payments set status = 'failed', failed_at = now(), paid_at = null
          where id = '${PAY1}';
        rollback;`)),
  );

  // ── 환불 — 부분 환불을 전제한 짝 ──────────────────────────────────────────
  check(
    "받은 돈보다 많이 환불할 수 없다",
    rejectedWith(/payments_refund_shape/, () =>
      sql(`begin; ${activeFixture} ${consentFixture} ${paidInsert(PAY1)}
        update public.payments set status = 'partially_refunded', refunded_amount = 2000001
          where id = '${PAY1}';
        rollback;`)),
  );
  check(
    "전액을 돌려줬는데 partially_refunded 로 적을 수 없다",
    rejectedWith(/payments_refund_shape/, () =>
      sql(`begin; ${activeFixture} ${consentFixture} ${paidInsert(PAY1)}
        update public.payments set status = 'partially_refunded', refunded_amount = 2000000
          where id = '${PAY1}';
        rollback;`)),
  );
  check(
    "일부만 돌려주면 partially_refunded 로 남는다 (부분 환불이 기본형이다)",
    sql(`begin; ${activeFixture} ${consentFixture} ${paidInsert(PAY1)}
        update public.payments set status = 'partially_refunded', refunded_amount = 500000
          where id = '${PAY1}';
        select refunded_amount from public.payments where id = '${PAY1}'; rollback;`) === "500000",
  );

  // ── 웹훅 멱등 (들어오는 쪽) ───────────────────────────────────────────────
  check(
    "같은 웹훅 이벤트는 한 번만 들어간다 ((provider, event_id) 유니크)",
    rejectedWith(/payment_webhook_events_provider_event_id_key|23505/, () =>
      sql(`begin;
        insert into public.payment_webhook_events (provider, event_id, payload_digest)
          values ('toss', 'evt_dup_s506', repeat('e', 64)),
                 ('toss', 'evt_dup_s506', repeat('e', 64));
        rollback;`)),
  );

  // ── 동의 로그 열람 ────────────────────────────────────────────────────────
  const consentSetup = `${activeFixture} ${consentFixture}`;

  check(
    "커플 소유자는 자기 동의 기록을 본다",
    asUser(owner, `select count(*) from public.payment_consents;`, consentSetup) === "2",
  );
  check(
    "업체도 동의 기록을 본다 (고지했음을 증명해야 하는 쪽이다)",
    asUser(vendorStaff, `select count(*) from public.payment_consents;`, consentSetup) === "2",
  );
  check(
    "배우자는 동의 기록을 못 본다 (결제는 owner 조건 · §3.9)",
    asUser(partner, `select count(*) from public.payment_consents;`, consentSetup) === "0",
  );
  check(
    "타 업체는 남의 동의 기록을 못 본다",
    asUser(adminUser, `select count(*) from public.payment_consents;`, consentSetup) === "0",
  );
  check(
    "비로그인은 동의 기록을 못 본다",
    asAnon(`select count(*) from public.payment_consents;`, consentSetup) === "0",
  );
  check(
    "동의 기록은 아무도 쓸 수 없다 (정책 없음 = 서비스롤 전용)",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.payment_consents
         (payment_schedule_id, user_id, kind, consent_version)
         values ('${PS2}', '${owner}', 'refund_policy', 'v1');`, consentSetup)),
  );

  // ── 결제 열람 ─────────────────────────────────────────────────────────────
  const paidSetup = `${activeFixture} ${consentFixture} ${paidInsert(PAY1)}`;

  check(
    "커플 소유자는 자기 결제를 본다",
    // 픽스처가 만든 행으로 좁힌다 — 시드에 결제가 늘어도 이 검사의 뜻은 그대로다.
    asUser(owner, `select count(*) from public.payments where id = '${PAY1}';`, paidSetup) === "1",
  );
  check(
    "배우자는 결제를 못 본다 (결제 열람은 owner · §3.9)",
    asUser(partner, `select count(*) from public.payments where id = '${PAY1}';`, paidSetup) === "0",
  );
  check(
    "타 커플·타 업체는 남의 결제를 못 본다",
    asUser(adminUser, `select count(*) from public.payments;`, paidSetup) === "0",
  );
  check(
    "결제는 당사자가 쓸 수 없다 (금액을 스스로 적을 수 없다)",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.payments
         (booking_id, payment_schedule_id, purpose, amount, status)
         values ('${PB}', '${PS2}', 'balance', 1, 'pending');`, paidSetup)),
  );

  // ===========================================================================
  // 계약 해지 · 위약금 · 예약 자리 (S5-08 · 0031)
  // ---------------------------------------------------------------------------
  // 확인할 것은 넷 —
  //   (가) 확정된 계약만 해지 대상이고, 귀책 미정으로는 정산할 수 없다
  //   (나) 종결은 되돌릴 수 없고 조율 결과에는 사유가 붙는다(D-23·D-24)
  //   (다) 경계가 RLS 인가 — 배우자 차단 · 타 업체 격리 · 운영자 큐 열람
  //   (라) **예약 자리**가 확정에서 줄고 취소에서 되돌아오는가(S2-05 가 남긴 자리)
  // ===========================================================================
  const CX = "00000000-0000-0000-0000-00000000f020"; // 해지 절차
  const PSLOT = "00000000-0000-0000-0000-00000000f021"; // 재고 자리
  const PB2 = "00000000-0000-0000-0000-00000000f022"; // 자리 있는 예약

  const cancelInsert = (id, over = "") => `
    insert into public.contract_cancellations
      (id, contract_id, booking_id, requested_by, requester_side, reason_code${over ? ", " + over.split("=")[0] : ""})
      values ('${id}', '${PC}', '${PB}', '${owner}', 'couple', 'personal'${over ? ", " + over.split("=")[1] : ""});
  `;

  check(
    "확정된 계약만 해지할 수 있다",
    rejectedWith(/contract_cancellations_not_active|확정된 계약만 해지/, () =>
      sql(`begin; ${payFixture} ${cancelInsert(CX)} rollback;`)),
  );
  check(
    "확정된 계약이면 해지 절차를 만들 수 있다",
    sql(`begin; ${activeFixture} ${cancelInsert(CX)}
         select count(*) from public.contract_cancellations; rollback;`) === "1",
  );
  check(
    "계약당 살아 있는 해지 절차는 하나뿐이다",
    rejectedWith(/uq_contract_cancellations_open|23505/, () =>
      sql(`begin; ${activeFixture} ${cancelInsert(CX)}
        ${cancelInsert("00000000-0000-0000-0000-00000000f023")} rollback;`)),
  );
  check(
    "귀책이 미정인 채로 정산할 수 없다",
    rejectedWith(/contract_cancellations_fault_undecided|귀책이 확인되지 않은/, () =>
      sql(`begin; ${activeFixture} ${cancelInsert(CX)}
        update public.contract_cancellations
          set status = 'settled', settled_at = now(), penalty_applied = 0, refund_amount = 0
          where id = '${CX}';
        rollback;`)),
  );
  check(
    "귀책이 정해지면 정산할 수 있다",
    sql(`begin; ${activeFixture} ${cancelInsert(CX)}
        update public.contract_cancellations
          set fault = 'couple', status = 'settled', settled_at = now(),
              penalty_applied = 2000000, refund_amount = 0, balance_due = 2000000
          where id = '${CX}';
        select status from public.contract_cancellations where id = '${CX}'; rollback;`) === "settled",
  );
  check(
    "종결된 해지 절차는 되돌릴 수 없다 (D-23)",
    rejectedWith(/contract_cancellations_transition|종결된 해지 절차/, () =>
      sql(`begin; ${activeFixture} ${cancelInsert(CX)}
        update public.contract_cancellations
          set fault = 'mutual', status = 'settled', settled_at = now(),
              penalty_applied = 0, refund_amount = 0
          where id = '${CX}';
        update public.contract_cancellations set status = 'requested' where id = '${CX}';
        rollback;`)),
  );
  check(
    "환불과 추가 청구가 동시에 생길 수 없다",
    rejectedWith(/contract_cancellations_settlement_shape/, () =>
      sql(`begin; ${activeFixture} ${cancelInsert(CX)}
        update public.contract_cancellations
          set refund_amount = 100, balance_due = 100 where id = '${CX}';
        rollback;`)),
  );
  check(
    "조율 결과에는 사유가 반드시 붙는다 (D-24)",
    rejectedWith(/contract_cancellations_resolution_shape/, () =>
      sql(`begin; ${activeFixture} ${cancelInsert(CX)}
        update public.contract_cancellations
          set resolved_by = '${adminUser}', resolution_note = null where id = '${CX}';
        rollback;`)),
  );

  // ── 열람 ──────────────────────────────────────────────────────────────────
  const cancelSetup = `${activeFixture} ${cancelInsert(CX)}`;

  check(
    "커플 소유자는 자기 해지 절차를 본다",
    asUser(owner, `select count(*) from public.contract_cancellations;`, cancelSetup) === "1",
  );
  check(
    "업체 멤버도 해지 절차를 본다 (응대해야 한다)",
    asUser(vendorStaff, `select count(*) from public.contract_cancellations;`, cancelSetup) === "1",
  );
  check(
    "배우자는 해지 절차를 못 본다 (결제·서명과 같은 owner 조건)",
    asUser(partner, `select count(*) from public.contract_cancellations;`, cancelSetup) === "0",
  );
  check(
    "비로그인은 해지 절차를 못 본다",
    asAnon(`select count(*) from public.contract_cancellations;`, cancelSetup) === "0",
  );
  // 접수 자체는 당사자가 한다(S5-06). 0055 는 **판정 칸만** 못 쓰게 좁혔으므로
  // 이 INSERT 는 여전히 RLS 정책에서 끊긴다 — 남의 계약이기 때문이다.
  check(
    "해지 절차는 당사자가 쓸 수 없다 (자기 귀책을 스스로 적을 수 없다)",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(owner, `insert into public.contract_cancellations
         (contract_id, booking_id, requester_side, reason_code)
         values ('${PC}', '${PB}', 'couple', 'budget');`, cancelSetup)),
  );
  // **S8-03 이 이 검사를 더 강하게 만들었다.** 예전에는 정책이 0행을 돌려주는 것으로
  // 통과했는데, 0055 가 `authenticated` 의 UPDATE 권한 자체를 걷어 이제 **권한 오류로
  // 끊긴다.** 둘 다 "당사자는 귀책을 못 고친다" 이지만 뒤쪽이 낫다 — 정책을 누가
  // 잘못 고쳐도 권한이 없으면 여전히 막힌다(FIX-30·35·36 이 가르친 것).
  check(
    "당사자가 귀책을 고쳐 쓸 수 없다 (권한 자체가 없다)",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `update public.contract_cancellations set fault = 'vendor';`, cancelSetup),
    ),
  );

  // ── 예약 자리 (S2-05 가 남긴 자리) ────────────────────────────────────────
  const slotFixture = `
    ${payFixture}
    insert into public.inventory_slots (id, vendor_id, product_id, slot_date, capacity, remaining)
      values ('${PSLOT}', '${PV}', '${PP}', '2027-05-15', 1, 1);
    insert into public.bookings (id, couple_id, vendor_id, product_id, slot_id, status, total_amount)
      values ('${PB2}', '${coupleId}', '${PV}', '${PP}', '${PSLOT}', 'hold', 10000000);
  `;

  check(
    "예약이 확정되면 자리가 하나 줄어든다",
    sql(`begin; ${slotFixture}
        update public.bookings set status = 'confirmed',
          applied_fee_rate_bp = 500, applied_planner_fee_rate_bp = 0 where id = '${PB2}';
        select remaining from public.inventory_slots where id = '${PSLOT}'; rollback;`) === "0",
  );
  check(
    "예약이 취소되면 자리가 되돌아온다",
    sql(`begin; ${slotFixture}
        update public.bookings set status = 'confirmed',
          applied_fee_rate_bp = 500, applied_planner_fee_rate_bp = 0 where id = '${PB2}';
        update public.bookings set status = 'cancelled' where id = '${PB2}';
        select remaining from public.inventory_slots where id = '${PSLOT}'; rollback;`) === "1",
  );
  check(
    "남은 자리가 없으면 확정할 수 없다 (없는 자리를 팔지 않는다)",
    rejectedWith(/inventory_slots_no_remaining|남은 자리가 없어/, () =>
      sql(`begin; ${slotFixture}
        update public.inventory_slots set remaining = 0 where id = '${PSLOT}';
        update public.bookings set status = 'confirmed',
          applied_fee_rate_bp = 500, applied_planner_fee_rate_bp = 0 where id = '${PB2}';
        rollback;`)),
  );
  check(
    "자리를 쓰지 않는 예약도 확정된다 (슬롯 없는 계약이 가능하다)",
    sql(`begin; ${payFixture}
        update public.bookings set status = 'confirmed',
          applied_fee_rate_bp = 500, applied_planner_fee_rate_bp = 0 where id = '${PB}';
        select status from public.bookings where id = '${PB}'; rollback;`) === "confirmed",
  );
  check(
    "확정된 예약의 자리를 바꿀 수 없다",
    rejectedWith(/bookings_slot_immutable|자리를 바꿀 수 없습니다/, () =>
      sql(`begin; ${slotFixture}
        update public.bookings set status = 'confirmed',
          applied_fee_rate_bp = 500, applied_planner_fee_rate_bp = 0 where id = '${PB2}';
        update public.bookings set slot_id = null, status = 'confirmed' where id = '${PB2}';
        rollback;`)),
  );
  check(
    "이행 완료는 자리를 계속 차지한다 (지난 날짜를 다시 팔지 않는다)",
    sql(`begin; ${slotFixture}
        update public.bookings set status = 'confirmed',
          applied_fee_rate_bp = 500, applied_planner_fee_rate_bp = 0 where id = '${PB2}';
        update public.bookings set status = 'fulfilled' where id = '${PB2}';
        select remaining from public.inventory_slots where id = '${PSLOT}'; rollback;`) === "0",
  );

  // ── 환불 원장 ─────────────────────────────────────────────────────────────
  check(
    "알 수 없는 환불 상태는 거절한다",
    rejectedWith(/refunds_status_values/, () =>
      sql(`begin; ${activeFixture} ${consentFixture} ${paidInsert(PAY1)}
        insert into public.refunds (payment_id, amount, status)
          values ('${PAY1}', 1, 'DONE');
        rollback;`)),
  );
  check(
    "완료된 환불에는 완료 시각이 붙는다",
    rejectedWith(/refunds_completed_pair/, () =>
      sql(`begin; ${activeFixture} ${consentFixture} ${paidInsert(PAY1)}
        insert into public.refunds (payment_id, amount, status)
          values ('${PAY1}', 1, 'completed');
        rollback;`)),
  );

  // ── 위약금 기준은 시드로 굳히지 않았다 (0031 근거 6) ──────────────────────
  check(
    "penalty_rules 에 가정치를 시드하지 않았다 — 법무 검수 전이다",
    sql(`select count(*) from public.penalty_rules;`) === "0",
  );
  check(
    "위약금 요율 컬럼이 bp 정수다 (numeric standard_rate 를 대체했다)",
    sql(`select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'penalty_rules'
           and column_name = 'rate_bp' and data_type = 'integer';`) === "1",
  );
  check(
    "numeric standard_rate 는 남아 있지 않다 (요율의 진실은 하나다)",
    sql(`select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'penalty_rules'
           and column_name = 'standard_rate';`) === "0",
  );
  check(
    "확인 기한도 코드가 아니라 app_settings 가 갖는다",
    sql(`select count(*) from public.app_settings
         where key = 'cancellation.confirm_due_days' and (value_json ->> 'days') ~ '^[0-9]+$';`) === "1",
  );

  // ── 코드 ↔ DB 정합 · 파라미터 ─────────────────────────────────────────────
  const dbPaymentStatus = sql(
    `select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.payments'::regclass and conname = 'payments_status_values';`,
  );
  const codePaymentStatus = readFileSync("lib/core/payment/payment.ts", "utf8")
    .match(/export const PAYMENT_STATUSES = \[([\s\S]*?)\] as const;/)?.[1]
    .match(/"([a-z_]+)"/g)
    ?.map((value) => value.replaceAll('"', "")) ?? [];

  check(
    "결제 상태 목록이 코드와 DB CHECK 에서 일치한다",
    codePaymentStatus.length > 0 && codePaymentStatus.every((v) => dbPaymentStatus.includes(`'${v}'`)),
    `code=${codePaymentStatus.join(",")}`,
  );

  const dbAnchors = sql(
    `select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.payment_schedules'::regclass
        and conname = 'payment_schedules_anchor_values';`,
  );
  const codeAnchors = readFileSync("lib/core/payment/payment.ts", "utf8")
    .match(/export const DUE_ANCHORS = \[([\s\S]*?)\] as const;/)?.[1]
    .match(/"([a-z_]+)"/g)
    ?.map((value) => value.replaceAll('"', "")) ?? [];

  check(
    "기한 기준 목록이 코드와 DB CHECK 에서 일치한다",
    codeAnchors.length > 0 && codeAnchors.every((v) => dbAnchors.includes(`'${v}'`)),
    `code=${codeAnchors.join(",")}`,
  );

  check(
    "분할 비율은 코드가 아니라 app_settings 가 갖는다",
    sql(`select count(*) from public.app_settings
         where key = 'payment.split_ratios_bp' and value_json ? 'installments';`) === "1",
  );
  check(
    "플래너 유예 일수도 app_settings 가 갖는다",
    sql(`select count(*) from public.app_settings
         where key = 'planner.payout_grace_days' and (value_json ->> 'days') ~ '^[0-9]+$';`) === "1",
  );
  check(
    "수수료 기준(O-15)은 미결 자리로 남아 있다 — 코드가 정하지 않았다",
    sql(`select value_json ->> 'status' from public.app_settings
         where key = 'settlement.fee_basis';`) === "undecided",
  );

  // ── S5-06 이 더한 정합 ────────────────────────────────────────────────────
  // 동의 종류도 코드(CONSENT_KINDS)와 DB CHECK 두 곳에 있다. 한쪽만 늘리면
  // **결제 트리거가 요구하는 종류와 화면이 받는 종류가 갈린다** — 그러면 동의를
  // 다 눌러도 결제가 막히고, 원인은 화면 어디에도 나오지 않는다.
  const dbConsentKinds = sql(
    `select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.payment_consents'::regclass
        and conname = 'payment_consents_kind_values';`,
  );
  const codeConsentKinds = readFileSync("lib/core/payment/checkout.ts", "utf8")
    .match(/export const CONSENT_KINDS = \[([\s\S]*?)\] as const;/)?.[1]
    .match(/"([a-z_]+)"/g)
    ?.map((value) => value.replaceAll('"', "")) ?? [];

  check(
    "동의 종류가 코드와 DB CHECK 에서 일치한다",
    codeConsentKinds.length > 0 && codeConsentKinds.every((v) => dbConsentKinds.includes(`'${v}'`)),
    `code=${codeConsentKinds.join(",")}`,
  );

  // **수신 설정 쪽 CHECK 도 함께 본다.** 0023~0026 은 `notifications` 만 넓히고
  // `notification_prefs` 를 두고 갔다 — 그래서 chat·inquiry·vendor_invite 는 알림은
  // 나가는데 **끄는 설정을 저장할 수 없는** 상태였다. 0030 이 둘을 맞췄고, 이 검사가
  // 다음 번 드리프트를 잡는다.
  const dbPrefTopics = sql(
    `select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.notification_prefs'::regclass
        and conname = 'notification_prefs_topic_chk';`,
  );

  check(
    "알림 토픽 목록이 수신 설정 CHECK 에서도 일치한다",
    codeTopics.length > 0 && codeTopics.every((topic) => dbPrefTopics.includes(`'${topic}'`)),
    `code=${codeTopics.join(",")}`,
  );

  check(
    "결제 시도 상한도 코드가 아니라 app_settings 가 갖는다",
    sql(`select count(*) from public.app_settings
         where key = 'payment.max_attempts' and (value_json ->> 'count') ~ '^[0-9]+$';`) === "1",
  );

  // ── S5-11·S5-07 이 더한 정합 ──────────────────────────────────────────────
  for (const [label, file, constant, table, constraint] of [
    [
      "쿠폰 발행 조건",
      "lib/core/coupon/coupon.ts",
      "ISSUE_CONDITIONS",
      "coupons",
      "coupons_issue_condition_values",
    ],
    [
      "정산 상태",
      "lib/core/settlement/settlement.ts",
      "SETTLEMENT_STATUSES",
      "settlements",
      "settlements_status_values",
    ],
    [
      "상계 근거",
      "lib/core/settlement/settlement.ts",
      "ADJUSTMENT_SOURCES",
      "settlement_adjustments",
      "settlement_adjustments_source_values",
    ],
    [
      "지급 상태",
      "lib/core/settlement/settlement.ts",
      "PAYOUT_STATUSES",
      "settlement_payouts",
      "settlement_payouts_status_values",
    ],
  ]) {
    const dbDef = sql(
      `select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'public.${table}'::regclass and conname = '${constraint}';`,
    );
    const codeValues =
      readFileSync(file, "utf8")
        .match(new RegExp(`export const ${constant} = \\[([\\s\\S]*?)\\] as const;`))?.[1]
        .match(/"([a-z_]+)"/g)
        ?.map((value) => value.replaceAll('"', "")) ?? [];

    check(
      `${label} 목록이 코드와 DB CHECK 에서 일치한다`,
      codeValues.length > 0 && codeValues.every((value) => dbDef.includes(`'${value}'`)),
      `code=${codeValues.join(",")}`,
    );
  }

  const dbEscrow = sql(
    `select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.escrow_holds'::regclass and conname = 'escrow_holds_status_values';`,
  );
  const codeEscrow =
    readFileSync("lib/core/escrow/escrow.ts", "utf8")
      .match(/export const ESCROW_STATUSES = \[([\s\S]*?)\] as const;/)?.[1]
      .match(/"([a-z_]+)"/g)
      ?.map((value) => value.replaceAll('"', "")) ?? [];

  check(
    "안전거래 상태 목록이 코드와 DB CHECK 에서 일치한다",
    codeEscrow.length > 0 && codeEscrow.every((value) => dbEscrow.includes(`'${value}'`)),
    `code=${codeEscrow.join(",")}`,
  );

  // **금지가 살아 있는지 두 방향으로 본다** — 코드 목록에 리뷰 관련 값이 없는 것과,
  // DB CHECK 에도 없는 것. 한쪽만 보면 다른 쪽으로 들어온다(§7.7 · D-03).
  const dbConditions = sql(
    `select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.coupons'::regclass and conname = 'coupons_issue_condition_values';`,
  );

  check(
    "**쿠폰 발행 조건에 리뷰·후기·평점이 없다** (§7.7 · D-03)",
    !/review|후기|평점|rating/i.test(dbConditions),
    dbConditions.slice(0, 80),
  );

  for (const [label, key, field] of [
    ["쿠폰 할인율 상한", "coupon.max_discount_rate_bp", "rateBp"],
    ["쿠폰 중복 규칙", "coupon.stacking", "mode"],
    ["쿠폰 기본 유효기간", "coupon.default_valid_days", "days"],
    ["정산 지급 리드타임", "settlement.payout_lead_days", "days"],
    ["부가세율", "settlement.tax_rate_bp", "rateBp"],
  ]) {
    check(
      `${label}도 코드가 아니라 app_settings 가 갖는다`,
      sql(`select count(*) from public.app_settings
           where key = '${key}' and value_json ? '${field}';`) === "1",
    );
  }

  // ── S5-08 이 더한 정합 ────────────────────────────────────────────────────
  // 해지의 값 집합도 코드와 DB 두 곳에 있다. 한쪽만 늘리면 **화면이 보낸 사유를 DB 가
  // 거절**하고, 그 실패는 사용자에게 알 수 없는 오류로 보인다.
  const cancelSource = readFileSync("lib/core/cancellation/cancellation.ts", "utf8");

  for (const [label, constant, constraint] of [
    ["취소 사유 코드", "CANCEL_REASON_CODES", "contract_cancellations_reason_values"],
    ["해지 절차 상태", "CANCELLATION_STATUSES", "contract_cancellations_status_values"],
    ["귀책 값", "FAULT_PARTIES", "contract_cancellations_fault_values"],
  ]) {
    const dbDef = sql(
      `select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'public.contract_cancellations'::regclass and conname = '${constraint}';`,
    );
    const codeValues =
      cancelSource
        .match(new RegExp(`export const ${constant} = \\[([\\s\\S]*?)\\] as const;`))?.[1]
        .match(/"([a-z_]+)"/g)
        ?.map((value) => value.replaceAll('"', "")) ?? [];

    check(
      `${label} 목록이 코드와 DB CHECK 에서 일치한다`,
      codeValues.length > 0 && codeValues.every((value) => dbDef.includes(`'${value}'`)),
      `code=${codeValues.join(",")}`,
    );
  }

  // 운영자는 조율 큐를 봐야 한다(F-A-17). 서비스롤로 우회해 읽으면 경계가 앱 코드가 된다.
  check(
    "운영자는 조율 큐를 본다 (is_operator 정책)",
    asUser(
      adminUser,
      `select count(*) from public.contract_cancellations;`,
      `${activeFixture} ${cancelInsert(CX)}`,
    ) === "1",
  );
  // ===========================================================================
  // 쿠폰 (S5-11 · 0032)
  // ---------------------------------------------------------------------------
  //   (가) **리뷰 대가 쿠폰을 스키마가 막는가**(§7.7 · D-03) — 이 검사가 그 금지의 실효다
  //   (나) 정률에 상한이 붙는가 · 발행 주체와 id 의 짝
  //   (다) 발급 1건은 한 번만 · 중복 발급 금지 · 수량 소진
  //   (라) 사용 이력이 insert-only 인가
  // ===========================================================================
  const CP = "00000000-0000-0000-0000-00000000f030"; // 업체 쿠폰
  const CI = "00000000-0000-0000-0000-00000000f031"; // 발급분

  const couponFixture = `
    ${payFixture}
    insert into public.coupons
      (id, issuer_type, issuer_id, name, discount_type, discount_value,
       max_discount_amount, min_order_amount, issue_condition)
      values ('${CP}', 'vendor', '${PV}', 'RLS쿠폰', 'rate', 1000, 500000, 0, 'first_purchase');
    insert into public.coupon_issues (id, coupon_id, couple_id)
      values ('${CI}', '${CP}', '${coupleId}');
  `;

  check(
    "**리뷰 작성 대가 쿠폰은 스키마가 막는다** (§7.7 · D-03)",
    rejectedWith(/coupons_issue_condition_values/, () =>
      sql(`begin; ${payFixture}
        insert into public.coupons
          (issuer_type, issuer_id, name, discount_type, discount_value, max_discount_amount, issue_condition)
          values ('vendor', '${PV}', '후기쿠폰', 'amount', 5000, null, 'review_written');
        rollback;`)),
  );
  check(
    "정률 쿠폰에 상한이 없으면 거절한다 (업체 정산을 통째로 지운다)",
    rejectedWith(/coupons_max_discount_shape/, () =>
      sql(`begin; ${payFixture}
        insert into public.coupons
          (issuer_type, issuer_id, name, discount_type, discount_value, max_discount_amount, issue_condition)
          values ('vendor', '${PV}', '무제한', 'rate', 5000, null, 'first_purchase');
        rollback;`)),
  );
  check(
    "정액 쿠폰에 상한을 두면 거절한다 (두 값이 서로를 부정한다)",
    rejectedWith(/coupons_max_discount_shape/, () =>
      sql(`begin; ${payFixture}
        insert into public.coupons
          (issuer_type, issuer_id, name, discount_type, discount_value, max_discount_amount, issue_condition)
          values ('vendor', '${PV}', '정액', 'amount', 5000, 1000, 'first_purchase');
        rollback;`)),
  );
  check(
    "플랫폼 쿠폰에 업체 id 가 붙으면 거절한다 (부담 주체가 흐려진다)",
    rejectedWith(/coupons_issuer_shape/, () =>
      sql(`begin; ${payFixture}
        insert into public.coupons
          (issuer_type, issuer_id, name, discount_type, discount_value, issue_condition)
          values ('platform', '${PV}', '플랫폼', 'amount', 5000, 'period_event');
        rollback;`)),
  );
  check(
    "같은 쿠폰을 같은 커플에게 두 번 발급하지 않는다",
    rejectedWith(/uq_coupon_issues_couple|23505/, () =>
      sql(`begin; ${couponFixture}
        insert into public.coupon_issues (coupon_id, couple_id) values ('${CP}', '${coupleId}');
        rollback;`)),
  );
  check(
    "수량이 소진되면 발급을 거절한다",
    rejectedWith(/coupons_quantity|소진/, () =>
      sql(`begin; ${payFixture}
        insert into public.coupons
          (id, issuer_type, issuer_id, name, discount_type, discount_value, issue_condition, total_quantity)
          values ('${CP}', 'vendor', '${PV}', '한정', 'amount', 5000, 'period_event', 1);
        insert into public.coupon_issues (coupon_id, couple_id) values ('${CP}', '${coupleId}');
        insert into public.coupon_issues (coupon_id, user_id) values ('${CP}', '${owner}');
        rollback;`)),
  );
  check(
    "발급 1건은 한 번만 쓴다",
    rejectedWith(/coupon_redemptions_coupon_issue_id_key|사용할 수 없는 쿠폰|23505/, () =>
      sql(`begin; ${couponFixture}
        insert into public.coupon_redemptions (coupon_issue_id, booking_id, discount_amount, borne_by)
          values ('${CI}', '${PB}', 100000, 'vendor');
        insert into public.coupon_redemptions (coupon_issue_id, booking_id, discount_amount, borne_by)
          values ('${CI}', '${PB}', 100000, 'vendor');
        rollback;`)),
  );
  check(
    "사용하면 발급분이 used 로 넘어간다",
    sql(`begin; ${couponFixture}
        insert into public.coupon_redemptions (coupon_issue_id, booking_id, discount_amount, borne_by)
          values ('${CI}', '${PB}', 100000, 'vendor');
        select status from public.coupon_issues where id = '${CI}'; rollback;`) === "used",
  );
  check(
    "사용 이력은 고칠 수 없다 (insert-only · 되돌리는 일은 환불이다)",
    rejectedWith(/permission denied|42501/i, () =>
      asUser(owner, `update public.coupon_redemptions set discount_amount = 1;`, couponFixture)),
  );
  check(
    "사용 이력은 지울 수 없다",
    rejectedWith(/permission denied|42501/i, () =>
      asUser(owner, `delete from public.coupon_redemptions;`, couponFixture)),
  );
  // **개수가 아니라 이 픽스처의 행이 보이는지를 본다.** 원문은 `=== "1"` 이었고,
  // S5-12 가 쿠폰 시드를 붙이자 곧바로 깨졌다 — 검사가 확인하려던 것은 "몇 장인가"
  // 가 아니라 "내 것이 보이는가" 이므로 그 뜻대로 다시 쓴다(함정 8).
  check(
    "고객은 자기 발급분을 본다",
    asUser(
      owner,
      `select count(*) from public.coupon_issues where id = '${CI}';`,
      couponFixture,
    ) === "1",
  );
  check(
    "업체는 자사 쿠폰 발급 현황을 본다",
    asUser(
      outsider,
      `select count(*) from public.coupon_issues where id = '${CI}';`,
      couponFixture,
    ) === "1",
  );
  check(
    "타 업체는 남의 쿠폰을 못 본다",
    asUser(vendorStaff, `select count(*) from public.coupons where issuer_id is null;`, couponFixture) === "0",
  );
  // **0행이 아니라 거절이다**(0066). 원문은 `=== "0"` 이었는데, 그것은 "정책이 안
  // 보여준다" 를 뜻할 뿐이었다. S5-12 가 `anon` 의 SELECT GRANT 를 걷었으므로 이제는
  // 표에 닿지도 못한다 — 더 강한 사실이므로 그렇게 적는다.
  check(
    "비로그인은 쿠폰 표에 닿지도 못한다",
    rejectedWith(/permission denied/, () =>
      asAnon(`select count(*) from public.coupons;`, couponFixture)),
  );
  // 0066 이 GRANT 를 걷으면서 거절 사유가 `row-level security` 에서 `permission denied`
  // 로 바뀌었다 — **막히는 층이 하나 더 아래로 내려간 것**이라 둘 다 받는다.
  check(
    "쿠폰 발급은 당사자가 못 한다 (수량·조건을 우회할 수 있다)",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(owner, `insert into public.coupon_issues (coupon_id, user_id)
         values ('${CP}', '${owner}');`, couponFixture)),
  );

  // ===========================================================================
  // 정산 집행 (S5-07 · 0033)
  // ---------------------------------------------------------------------------
  //   (가) **미결(fee_basis)은 실패가 아니라 대기** — blocked 에 사유가 붙는가
  //   (나) 확정된 정산서가 동결되는가(D-23) · 성공한 지급 없이 paid 로 못 가는가
  //   (다) 정산서당 지급은 하나 · 상계는 근거당 한 번
  //   (라) 경계가 RLS 인가 — staff 차단 · 타 업체 격리 · 운영자 열람 · 금액 쓰기 금지
  // ===========================================================================
  const ST = "00000000-0000-0000-0000-00000000f040"; // 정산서
  const ADJ = "00000000-0000-0000-0000-00000000f041"; // 상계
  const PO = "00000000-0000-0000-0000-00000000f042"; // 지급

  // payFixture 의 정산서가 이미 draft + 기준 스냅샷을 갖는다(0033).
  const draftSettlement = payFixture;

  check(
    "대기 상태에는 이유가 반드시 붙는다 (이유 없는 blocked 는 고장으로 읽힌다)",
    rejectedWith(/settlements_blocked_shape/, () =>
      sql(`begin; ${payFixture}
        update public.settlements set status = 'blocked', blocked_reason = null
          where id = '${PSET}';
        rollback;`)),
  );
  check(
    "대기 사유는 정해진 값만 쓴다",
    rejectedWith(/settlements_blocked_shape/, () =>
      sql(`begin; ${payFixture}
        update public.settlements set status = 'blocked', blocked_reason = 'unknown'
          where id = '${PSET}';
        rollback;`)),
  );
  check(
    "수수료 기준 미결은 blocked 로 남는다 — 실패가 아니다",
    sql(`begin; ${payFixture}
        update public.settlements set status = 'blocked', blocked_reason = 'fee_basis_missing',
          fee_basis = null where id = '${PSET}';
        select blocked_reason from public.settlements where id = '${PSET}'; rollback;`) ===
      "fee_basis_missing",
  );
  check(
    "계산이 선 정산서에는 기준 스냅샷이 있어야 한다",
    rejectedWith(/settlements_fee_basis_shape/, () =>
      sql(`begin; ${payFixture}
        update public.settlements set status = 'draft', fee_basis = null where id = '${PSET}';
        rollback;`)),
  );
  check(
    "성공한 지급 기록 없이 지급 완료로 적을 수 없다",
    rejectedWith(/settlements_paid_without_payout|성공한 지급 기록 없이/, () =>
      sql(`begin; ${draftSettlement}
        update public.settlements set status = 'confirmed', confirmed_at = now(),
          payout_amount = 9500000 where id = '${PSET}';
        update public.settlements set status = 'paid', paid_at = now() where id = '${PSET}';
        rollback;`)),
  );
  check(
    "지급 기록이 있으면 지급 완료로 넘어간다",
    sql(`begin; ${draftSettlement}
        update public.settlements set status = 'confirmed', confirmed_at = now(),
          payout_amount = 9500000 where id = '${PSET}';
        insert into public.settlement_payouts
          (id, settlement_id, amount, status, paid_at, idempotency_key)
          values ('${PO}', '${PSET}', 9500000, 'paid', now(), 'settlement:${PSET}:payout:1');
        update public.settlements set status = 'paid', paid_at = now() where id = '${PSET}';
        select status from public.settlements where id = '${PSET}'; rollback;`) === "paid",
  );
  check(
    "확정된 정산서의 금액은 바꿀 수 없다 (조정은 상계로 넘긴다 · D-23)",
    rejectedWith(/settlements_frozen|확정된 정산서의 금액/, () =>
      sql(`begin; ${draftSettlement}
        update public.settlements set status = 'confirmed', confirmed_at = now(),
          payout_amount = 9500000 where id = '${PSET}';
        update public.settlements set fee_amount = 1 where id = '${PSET}';
        rollback;`)),
  );
  check(
    "허용되지 않은 정산 상태 전이는 거절한다",
    rejectedWith(/settlements_transition|허용되지 않은 정산 상태 전이/, () =>
      sql(`begin; ${draftSettlement}
        update public.settlements set status = 'paid', paid_at = now() where id = '${PSET}';
        rollback;`)),
  );
  check(
    "정산서당 진행 중인 지급은 하나뿐이다",
    rejectedWith(/uq_settlement_payouts_pending|23505/, () =>
      sql(`begin; ${payFixture}
        insert into public.settlement_payouts (settlement_id, amount, status, idempotency_key)
          values ('${PSET}', 100, 'pending', 'k1'), ('${PSET}', 100, 'pending', 'k2');
        rollback;`)),
  );
  check(
    "같은 멱등 열쇠로 지급을 두 번 만들 수 없다",
    rejectedWith(/settlement_payouts_idempotency_key_key|23505/, () =>
      sql(`begin; ${payFixture}
        insert into public.settlement_payouts (settlement_id, amount, status, failed_at, idempotency_key)
          values ('${PSET}', 100, 'failed', now(), 'same'), ('${PSET}', 100, 'failed', now(), 'same');
        rollback;`)),
  );
  check(
    "같은 근거로 두 번 상계하지 않는다 (업체가 두 번 잃는다)",
    rejectedWith(/uq_settlement_adjustments_source|23505/, () =>
      sql(`begin; ${payFixture}
        insert into public.settlement_adjustments (vendor_id, source_type, source_id, amount, reason)
          values ('${PV}', 'cancellation_refund', '${PB}', 100, '환불'),
                 ('${PV}', 'cancellation_refund', '${PB}', 100, '환불');
        rollback;`)),
  );
  check(
    "상계 반영 짝이 어긋나면 거절한다",
    rejectedWith(/settlement_adjustments_applied_pair/, () =>
      sql(`begin; ${payFixture}
        insert into public.settlement_adjustments
          (vendor_id, source_type, amount, reason, applied_settlement_id, applied_at)
          values ('${PV}', 'manual', 100, '조정', '${PSET}', null);
        rollback;`)),
  );
  check(
    "상계 금액은 양수로만 적는다 (부호로 표현하면 합계에서 실수한다)",
    rejectedWith(/settlement_adjustments_amount_positive/, () =>
      sql(`begin; ${payFixture}
        insert into public.settlement_adjustments (id, vendor_id, source_type, amount, reason)
          values ('${ADJ}', '${PV}', 'manual', -100, '조정');
        rollback;`)),
  );

  // ── 정산 열람·쓰기 경계 ───────────────────────────────────────────────────
  const adjustmentSetup = `
    ${payFixture}
    insert into public.settlement_adjustments (id, vendor_id, source_type, amount, reason)
      values ('${ADJ}', '${PV}', 'cancellation_refund', 500000, '해지 환불 상계');
  `;

  check(
    "업체 대표는 상계를 본다",
    asUser(outsider, `select count(*) from public.settlement_adjustments;`, adjustmentSetup) === "1",
  );
  check(
    "**staff 는 상계를 못 본다** (정산 금액과 같은 경계)",
    asUser(vendorStaff, `select count(*) from public.settlement_adjustments;`, adjustmentSetup) === "0",
  );
  check(
    "타 업체는 남의 상계를 못 본다",
    asUser(partner, `select count(*) from public.settlement_adjustments;`, adjustmentSetup) === "0",
  );
  check(
    "운영자는 정산서를 본다 (집행해야 한다)",
    Number(asUser(adminUser, `select count(*) from public.settlements;`, payFixture)) >= 1,
  );
  check(
    "업체는 정산 금액을 쓸 수 없다 (컬럼 권한)",
    rejectedWith(/permission denied|42501/i, () =>
      asUser(outsider, `update public.settlements set net_amount = 1 where id = '${PSET}';`,
        payFixture)),
  );
  check(
    "업체가 쓸 수 있는 것은 이의 제기 메모뿐이다",
    asUser(outsider, `with u as (update public.settlements set vendor_note = '확인 요청'
       where id = '${PSET}' returning id) select count(*) from u;`, payFixture) === "1",
  );
  check(
    "비로그인은 지급 기록을 못 본다",
    asAnon(`select count(*) from public.settlement_payouts;`,
      `${payFixture}
       insert into public.settlement_payouts (settlement_id, amount, status, idempotency_key)
         values ('${PSET}', 100, 'pending', 'anon-k');`) === "0",
  );

  // ===========================================================================
  // 요율 관리 (S5-03 · 0034)
  // ---------------------------------------------------------------------------
  //   (가) **운영자가 요율을 볼 수 있는가** — 0006 의 정책은 업체·플래너용이라
  //        운영자에게는 자기 관리 화면의 목록조차 보이지 않았다
  //   (나) 쓰기가 막혀 있는가 — 요율 한 줄이 모든 업체의 수입을 바꾼다
  //   (다) **이력을 지울 수 없는가**(D-23) — 지우면 "그때 어떤 요율표였나" 를 못 답한다
  //   (라) 겹침을 DB 가 막는가(0006 EXCLUDE)
  // ===========================================================================
  const RATE1 = "00000000-0000-0000-0000-00000000f050";

  const rateFixture = `
    ${payFixture}
    insert into public.commission_rates
      (id, scope_type, scope_key, fee_rate_bp, effective_from, effective_to)
      values ('${RATE1}', 'vendor', '${PV}', 500, '2026-01-01T00:00:00Z', null);
  `;

  check(
    "운영자는 요율을 본다 (F-A-15 — 관리하려면 봐야 한다)",
    Number(asUser(adminUser, `select count(*) from public.commission_rates;`, rateFixture)) >= 1,
  );
  // 시드가 **전역** 요율을 넣어 두므로(0034 근거 5) 업체 멤버는 전역 + 자사를 본다.
  // 격리를 보려면 **자사 스코프 행**만 세야 한다.
  check(
    "업체 멤버는 자사 요율을 본다",
    asUser(outsider, `select count(*) from public.commission_rates where scope_key = '${PV}';`,
      rateFixture) === "1",
  );
  check(
    "타 업체는 남의 요율을 못 본다",
    asUser(partner, `select count(*) from public.commission_rates where scope_key = '${PV}';`,
      rateFixture) === "0",
  );
  check(
    "비로그인은 요율을 못 본다",
    asAnon(`select count(*) from public.commission_rates;`, rateFixture) === "0",
  );
  check(
    "요율은 아무도 쓸 수 없다 (서비스롤 경유 · 정책 없음 + 권한 회수)",
    rejectedWith(/permission denied|42501|row-level security/i, () =>
      asUser(adminUser, `insert into public.commission_rates
         (scope_type, scope_key, fee_rate_bp, effective_from)
         values ('global', null, 700, now());`, rateFixture)),
  );
  check(
    "**요율 이력은 지울 수 없다** (D-23 — 지우면 정산 근거가 사라진다)",
    rejectedWith(/permission denied|42501/i, () =>
      asUser(adminUser, `delete from public.commission_rates where id = '${RATE1}';`, rateFixture)),
  );
  check(
    "요율은 고칠 수도 없다 — 변경은 새 행, 종료는 effective_to 다",
    rejectedWith(/permission denied|42501/i, () =>
      asUser(adminUser, `update public.commission_rates set fee_rate_bp = 1 where id = '${RATE1}';`,
        rateFixture)),
  );
  check(
    "같은 범위에 기간이 겹치는 요율은 DB 가 거부한다 (0006 EXCLUDE)",
    rejectedWith(/commission_rates_no_overlap|23P01|conflicting key/i, () =>
      sql(`begin; ${rateFixture}
        insert into public.commission_rates
          (scope_type, scope_key, fee_rate_bp, effective_from, effective_to)
          values ('vendor', '${PV}', 700, '2026-06-01T00:00:00Z', null);
        rollback;`)),
  );
  check(
    "끝과 시작이 같으면 겹치지 않는다 (반개구간)",
    sql(`begin; ${payFixture}
        insert into public.commission_rates
          (scope_type, scope_key, fee_rate_bp, effective_from, effective_to)
          values ('vendor', '${PV}', 500, '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
                 ('vendor', '${PV}', 700, '2026-06-01T00:00:00Z', null);
        select count(*) from public.commission_rates where scope_key = '${PV}'; rollback;`) === "2",
  );
  check(
    "플래너 요율도 같은 규칙이다 (운영자 열람 · 쓰기 금지)",
    asUser(adminUser, `select count(*) from public.planner_fee_rates;`, payFixture) !== "" &&
      rejectedWith(/permission denied|42501|row-level security/i, () =>
        asUser(adminUser, `insert into public.planner_fee_rates
           (scope_type, scope_key, fee_rate_bp, effective_from)
           values ('global', null, 300, now());`, payFixture)),
  );
  check(
    "**요율 값을 마이그레이션이 시드하지 않았다** (O-02 — 값은 화면에서 넣는다)",
    sql(`select count(*) from public.commission_rates
         where memo is null or memo not like 'local demo%';`) === "0",
  );

  // ===========================================================================
  // 에스크로 (S5-09 · 0035)
  // ---------------------------------------------------------------------------
  //   (가) **승인된 결제 위에만 홀드가 선다** — 받지 않은 돈을 보관할 수 없다
  //   (나) 종결은 되돌리지 않고 조율에서 보관으로도 돌아가지 않는다(D-23)
  //   (다) 상태와 시각의 짝 · 조율 결과에 사유
  //   (라) 경계가 RLS 인가 — 배우자 차단 · 타 업체 격리 · 운영자 열람 · 쓰기 금지
  // ===========================================================================
  const ESC = "00000000-0000-0000-0000-00000000f060";

  const escrowFixture = `
    ${activeFixture} ${consentFixture} ${paidInsert(PAY1)}
    insert into public.escrow_holds
      (id, payment_id, booking_id, payment_schedule_id, held_amount, status, held_at)
      values ('${ESC}', '${PAY1}', '${PB}', '${PS1}', 2000000, 'held', now());
  `;

  check(
    "승인되지 않은 결제 위에는 홀드를 세울 수 없다",
    rejectedWith(/escrow_holds_payment_not_paid|승인된 결제만/, () =>
      sql(`begin; ${activeFixture} ${paidInsert(PAY1, "pending")}
        insert into public.escrow_holds (payment_id, booking_id, held_amount)
          values ('${PAY1}', '${PB}', 2000000);
        rollback;`)),
  );
  check(
    "승인된 결제 위에는 홀드가 선다",
    sql(`begin; ${escrowFixture}
         select status from public.escrow_holds where id = '${ESC}'; rollback;`) === "held",
  );
  check(
    "회차당 홀드는 하나뿐이다",
    rejectedWith(/uq_escrow_holds_schedule|23505/, () =>
      sql(`begin; ${escrowFixture}
        insert into public.escrow_holds
          (payment_id, booking_id, payment_schedule_id, held_amount)
          values ('${PAY1}', '${PB}', '${PS1}', 2000000);
        rollback;`)),
  );
  check(
    "종결된 안전거래는 되돌릴 수 없다 (D-23)",
    rejectedWith(/escrow_holds_transition|허용되지 않은 안전거래/, () =>
      sql(`begin; ${escrowFixture}
        update public.escrow_holds set status = 'released', released_at = now() where id = '${ESC}';
        update public.escrow_holds set status = 'held', released_at = null where id = '${ESC}';
        rollback;`)),
  );
  check(
    "조율에서 보관으로 돌아가지 않는다 — 이의가 있었다는 사실이 남아야 한다",
    rejectedWith(/escrow_holds_transition|허용되지 않은 안전거래/, () =>
      sql(`begin; ${escrowFixture}
        update public.escrow_holds set status = 'disputed', disputed_at = now() where id = '${ESC}';
        update public.escrow_holds set status = 'held', disputed_at = null where id = '${ESC}';
        rollback;`)),
  );
  check(
    "이행 확인이 되면 릴리즈로 넘어간다",
    sql(`begin; ${escrowFixture}
        update public.escrow_holds set
          couple_confirmed = true, couple_confirmed_at = now(),
          vendor_confirmed = true, vendor_confirmed_at = now()
          where id = '${ESC}';
        update public.escrow_holds set status = 'released', released_at = now() where id = '${ESC}';
        select status from public.escrow_holds where id = '${ESC}'; rollback;`) === "released",
  );
  check(
    "확인 여부와 시각의 짝이 어긋나면 거절한다 (언제 확인됐는가가 쟁점이다)",
    rejectedWith(/escrow_holds_confirm_pair/, () =>
      sql(`begin; ${escrowFixture}
        update public.escrow_holds set couple_confirmed = true where id = '${ESC}';
        rollback;`)),
  );
  check(
    "릴리즈 상태와 시각의 짝이 어긋나면 거절한다",
    rejectedWith(/escrow_holds_released_pair/, () =>
      sql(`begin; ${escrowFixture}
        update public.escrow_holds set status = 'released' where id = '${ESC}';
        rollback;`)),
  );
  check(
    "조율 결과에는 사유가 반드시 붙는다 (D-24)",
    rejectedWith(/escrow_holds_resolution_shape/, () =>
      sql(`begin; ${escrowFixture}
        update public.escrow_holds set resolved_by = '${adminUser}', resolution_note = null
          where id = '${ESC}';
        rollback;`)),
  );

  // ── 열람·쓰기 경계 ────────────────────────────────────────────────────────
  check(
    "커플 소유자는 자기 안전거래를 본다",
    asUser(owner, `select count(*) from public.escrow_holds where id = '${ESC}';`, escrowFixture) === "1",
  );
  check(
    "업체 멤버도 안전거래를 본다 (이행 확인의 당사자다)",
    asUser(vendorStaff, `select count(*) from public.escrow_holds where id = '${ESC}';`, escrowFixture) === "1",
  );
  check(
    "배우자는 안전거래를 못 본다 (결제·서명과 같은 owner 조건)",
    asUser(partner, `select count(*) from public.escrow_holds where id = '${ESC}';`, escrowFixture) === "0",
  );
  check(
    "운영자는 조율을 위해 안전거래를 본다",
    asUser(adminUser, `select count(*) from public.escrow_holds where id = '${ESC}';`, escrowFixture) === "1",
  );
  check(
    "비로그인은 안전거래를 못 본다",
    asAnon(`select count(*) from public.escrow_holds;`, escrowFixture) === "0",
  );
  // **S8-03 이 둘을 더 강하게 만들었다** — 0055 가 `authenticated` 의 INSERT·UPDATE
  // 권한을 걷어 이제 정책이 아니라 **권한**에서 끊긴다. 방어선이 둘이 됐다.
  check(
    "안전거래는 당사자가 쓸 수 없다 (권한 자체가 없다)",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `insert into public.escrow_holds (payment_id, booking_id, held_amount)
         values ('${PAY1}', '${PB}', 1);`, escrowFixture)),
  );
  check(
    "당사자가 이행 확인을 고쳐 쓸 수 없다 (권한 자체가 없다)",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `update public.escrow_holds set status = 'released';`, escrowFixture),
    ),
  );
  check(
    "실예치 활성 여부는 O-03 대기로 남아 있다 — 코드가 켜지 않았다",
    sql(`select value_json ->> 'status' from public.app_settings where key = 'escrow.enabled';`)
      === "undecided",
  );
  check(
    "이행 확인 기한도 코드가 아니라 app_settings 가 갖는다",
    sql(`select count(*) from public.app_settings
         where key = 'escrow.confirm_due_days' and (value_json ->> 'days') ~ '^[0-9]+$';`) === "1",
  );

  // ===========================================================================
  // 플래너 범위 (S6-01 · 0036)
  // ---------------------------------------------------------------------------
  //   (가) **두 축이 독립인가** — 위임(열람)과 카테고리 선택(과금)
  //   (나) 위임 없는 플래너를 카테고리에 붙일 수 없는가
  //   (다) 플래너가 **읽기만** 하는가(스스로 범위를 넓히면 자기 수수료를 늘린다)
  //   (라) 해제가 삭제가 아닌가(D-23) · 카테고리당 동시 선택 1
  // ===========================================================================
  if (!plannerAccount) {
    console.log("SKIP  플래너 항목 — planner@local.test 가 없다");
  } else {
    const PLANNER_ID = "00000000-0000-0000-0000-00000000c0b1";

    // 시드가 만든 위임을 그대로 쓴다(활성 · couples·carts·consultations).
    const scopeFixture = `
      insert into public.planner_scopes (couple_id, planner_id, category, selected_by)
        values ('${coupleId}', '${PLANNER_ID}', 'studio', '${owner}');
    `;

    check(
      "위임이 활성인 플래너는 카테고리에 지정할 수 있다",
      sql(`begin; ${scopeFixture}
           select count(*) from public.planner_scopes; rollback;`) === "1",
    );
    check(
      "**위임이 없는 플래너는 카테고리에 지정할 수 없다** (보지도 못하는 플래너에게 수수료가 붙는다)",
      rejectedWith(/planner_scopes_no_engagement|위임이 활성 상태인/, () =>
        sql(`begin;
          insert into public.planners (id, user_id, status, profile_json, regions)
            values ('00000000-0000-0000-0000-00000000c0b9', '${partner}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']);
          insert into public.planner_scopes (couple_id, planner_id, category)
            values ('${coupleId}', '00000000-0000-0000-0000-00000000c0b9', 'dress');
          rollback;`)),
    );
    check(
      "카테고리당 동시에 선택된 플래너는 하나다",
      rejectedWith(/uq_planner_scopes_selected|23505/, () =>
        sql(`begin; ${scopeFixture} ${scopeFixture} rollback;`)),
    );
    check(
      "해제한 뒤에는 같은 카테고리를 다시 선택할 수 있다 (재선택은 새 행)",
      sql(`begin; ${scopeFixture}
           update public.planner_scopes set status = 'released', released_at = now();
           ${scopeFixture}
           select count(*) from public.planner_scopes; rollback;`) === "2",
    );
    check(
      "해제 상태와 시각의 짝이 어긋나면 거절한다 (언제 뺐는가가 쟁점이다)",
      rejectedWith(/planner_scopes_released_pair/, () =>
        sql(`begin; ${scopeFixture}
          update public.planner_scopes set status = 'released';
          rollback;`)),
    );
    check(
      "판매가가 없는 카테고리는 지정할 수 없다 (수수료가 붙을 자리가 없다)",
      rejectedWith(/planner_scopes_category_values/, () =>
        sql(`begin;
          insert into public.planner_scopes (couple_id, planner_id, category)
            values ('${coupleId}', '${PLANNER_ID}', 'helper');
          rollback;`)),
    );

    // ── 열람·쓰기 경계 ──────────────────────────────────────────────────────
    check(
      "커플 구성원은 카테고리 선택을 본다",
      asUser(owner, `select count(*) from public.planner_scopes;`, scopeFixture) === "1",
    );
    check(
      "**배우자도 카테고리를 고를 수 있다** (결제·서명과 다른 층 — 구성 선택이다)",
      asUser(partner, `with i as (insert into public.planner_scopes
         (couple_id, planner_id, category, selected_by)
         values ('${coupleId}', '${PLANNER_ID}', 'dress', '${partner}') returning id)
         select count(*) from i;`) === "1",
    );
    check(
      "플래너는 자기가 맡은 카테고리를 본다",
      asUser(plannerAccount, `select count(*) from public.planner_scopes;`, scopeFixture) === "1",
    );
    check(
      "**플래너는 카테고리를 스스로 넓힐 수 없다** (자기 수수료를 늘리는 행위다)",
      rejectedWith(/row-level security/i, () =>
        asUser(plannerAccount, `insert into public.planner_scopes
           (couple_id, planner_id, category)
           values ('${coupleId}', '${PLANNER_ID}', 'hall');`, scopeFixture)),
    );
    check(
      "타 커플은 남의 카테고리 선택을 못 본다",
      asUser(outsider, `select count(*) from public.planner_scopes;`, scopeFixture) === "0",
    );
    check(
      "비로그인은 카테고리 선택을 못 본다",
      asAnon(`select count(*) from public.planner_scopes;`, scopeFixture) === "0",
    );
    check(
      "**선택 이력은 지울 수 없다** (언제부터 언제까지 썼는가가 남아야 한다 · D-23)",
      rejectedWith(/permission denied|42501/i, () =>
        asUser(owner, `delete from public.planner_scopes;`, scopeFixture)),
    );

    // ── 두 축이 독립인가 ────────────────────────────────────────────────────
    check(
      "위임은 **표 단위**다 — 카테고리를 하나도 안 골라도 위임된 표는 보인다",
      asUser(plannerAccount, `select count(*) from public.couples;`) === "1",
    );
    check(
      "위임 범위 밖(채팅)은 카테고리를 골라도 안 보인다 (S4-01 경계)",
      asUser(plannerAccount, `select count(*) from public.chat_rooms;`, scopeFixture) === "0",
    );
    check(
      "위임 범위 밖(결제)도 안 보인다 (S5-06 경계)",
      asUser(plannerAccount, `select count(*) from public.payments;`, scopeFixture) === "0",
    );
    check(
      "장바구니는 읽히되 쓰이지 않는다 (S3-04 경계)",
      asUser(plannerAccount, `with u as (update public.carts set name = '침입' returning id)
         select count(*) from u;`) === "0",
    );

    // ── 마켓·프로필 (S6-02 · 0037) ──────────────────────────────────────────
    check(
      "공개된 플래너는 비로그인도 본다 (마켓은 둘러보는 화면이다)",
      asAnon(`select count(*) from public.planners where status = 'active';`) === "1",
    );
    check(
      "**공개되지 않은 플래너는 남에게 보이지 않는다**",
      asUser(
        owner,
        `select count(*) from public.planners where id = '00000000-0000-0000-0000-00000000c0c9';`,
        `insert into public.planners (id, user_id, status, profile_json, regions)
           values ('00000000-0000-0000-0000-00000000c0c9', '${partner}', 'pending', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']);`,
      ) === "0",
    );
    check(
      "본인은 자기 프로필을 상태와 무관하게 본다",
      asUser(
        partner,
        `select status from public.planners where user_id = '${partner}';`,
        `insert into public.planners (id, user_id, status, profile_json, regions)
           values ('00000000-0000-0000-0000-00000000c0c9', '${partner}', 'pending', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']);`,
      ) === "pending",
    );
    check(
      "운영자는 검토를 위해 pending 프로필을 본다",
      asUser(
        adminUser,
        `select count(*) from public.planners where status = 'pending';`,
        `insert into public.planners (id, user_id, status, profile_json, regions)
           values ('00000000-0000-0000-0000-00000000c0c9', '${partner}', 'pending', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']);`,
      ) === "1",
    );
    check(
      "**플래너가 스스로 공개 상태로 바꿀 수 없다** (심사가 형해화된다)",
      rejectedWith(/planners_self_activate|공개 상태로는 직접/, () =>
        asUser(
          partner,
          `update public.planners set status = 'active' where user_id = '${partner}';`,
          `insert into public.planners (id, user_id, status, profile_json, regions)
             values ('00000000-0000-0000-0000-00000000c0c9', '${partner}', 'pending',
                     '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']);`,
        )),
    );
    check(
      "보류 상태도 본인이 정할 수 없다",
      rejectedWith(/planners_self_reject|보류 상태는 운영자가/, () =>
        asUser(
          partner,
          `update public.planners set status = 'rejected' where user_id = '${partner}';`,
          `insert into public.planners (id, user_id, status, profile_json, regions)
             values ('00000000-0000-0000-0000-00000000c0c9', '${partner}', 'pending', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['서울']);`,
        )),
    );
    check(
      "본인이 스스로 내리는 것(paused)은 할 수 있다",
      asUser(
        plannerAccount,
        `with u as (update public.planners set status = 'paused'
           where user_id = '${plannerAccount}' returning id) select count(*) from u;`,
      ) === "1",
    );
    check(
      "**요금을 프로필에 담을 수 없다** (요율의 진실이 둘이 된다 · D-16)",
      rejectedWith(/planners_fee_json_empty/, () =>
        sql(`begin;
          update public.planners set fee_json = '{"hourly": 50000}'::jsonb
            where id = '${PLANNER_ID}';
          rollback;`)),
    );
    check(
      "빈 프로필은 공개 상태가 될 수 없다 (마켓 전체의 신뢰가 걸린다)",
      rejectedWith(/planners_profile_shape/, () =>
        sql(`begin;
          insert into public.planners (user_id, status, profile_json)
            values ('${partner}', 'active', '{}'::jsonb);
          rollback;`)),
    );
    check(
      "알 수 없는 플래너 상태는 거절한다",
      rejectedWith(/planners_status_values/, () =>
        sql(`begin;
          insert into public.planners (user_id, status) values ('${partner}', 'LISTED');
          rollback;`)),
    );
    check(
      "**실적 집계는 개수만 돌려준다** (뷰였다면 남의 정산이 새어 나간다)",
      sql(`select public.planner_contract_count('${PLANNER_ID}');`) === "0",
    );
    check(
      "실적 집계 함수는 비로그인도 부를 수 있다 (마켓이 쓴다)",
      asAnon(`select public.planner_contract_count('${PLANNER_ID}');`) === "0",
    );
    check(
      "**정산 표 자체는 여전히 남에게 닫혀 있다**",
      asAnon(`select count(*) from public.planner_settlements;`) === "0",
    );

    // ── 코드 ↔ DB 정합 ──────────────────────────────────────────────────────
    const dbPlannerStatus = sql(
      `select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'public.planners'::regclass and conname = 'planners_status_values';`,
    );
    const codePlannerStatus =
      readFileSync("lib/core/planner/profile.ts", "utf8")
        .match(/export const PLANNER_STATUSES = \[([\s\S]*?)\] as const;/)?.[1]
        .match(/"([a-z_]+)"/g)
        ?.map((value) => value.replaceAll('"', "")) ?? [];

    check(
      "플래너 상태 목록이 코드와 DB CHECK 에서 일치한다",
      codePlannerStatus.length > 0 &&
        codePlannerStatus.every((v) => dbPlannerStatus.includes(`'${v}'`)),
      `code=${codePlannerStatus.join(",")}`,
    );

    const dbScopeCats = sql(
      `select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'public.planner_scopes'::regclass
          and conname = 'planner_scopes_category_values';`,
    );
    const codeScopeCats =
      readFileSync("lib/core/planner/scope.ts", "utf8")
        .match(/export const PLANNER_CATEGORIES = \[([\s\S]*?)\] as const;/)?.[1]
        .match(/"([a-z_]+)"/g)
        ?.map((value) => value.replaceAll('"', "")) ?? [];

    check(
      "플래너 카테고리 목록이 코드와 DB CHECK 에서 일치한다",
      codeScopeCats.length > 0 && codeScopeCats.every((v) => dbScopeCats.includes(`'${v}'`)),
      `code=${codeScopeCats.join(",")}`,
    );
  }

  // 운영자 정책이 문을 넓히지 않았는지는 **운영자가 아닌 사람**으로 확인한다.
  // 시드에서 타 업체 대표 자리를 admin 계정이 겸하고 있어(계정 6개로 넷을 세운 탓)
  // 그 계정으로는 이 검사를 할 수 없다 — 배우자(비운영자)가 그 자리를 대신한다.
  check(
    "운영자 정책이 일반 사용자에게 문을 넓히지 않았다",
    asUser(
      opsUser,
      `select count(*) from public.contract_cancellations;`,
      `${activeFixture} ${cancelInsert(CX)}`,
    ) === "1" &&
      asUser(partner, `select count(*) from public.contract_cancellations;`,
        `${activeFixture} ${cancelInsert(CX)}`) === "0",
  );
}

// ── 검출 룰 시드 (S7-01 · seed.sql · §3.5) ───────────────────────────────────
// **사본은 어긋나고, 어긋나면 조용하다.** 검출은 `lib/core/rules` 가 하고 DB 는
// 운영자가 보고 끄는 사본이라(F-A-03), 둘이 벌어져도 화면에는 아무 일도 안 생긴다.
// 그래서 여기서 대조한다 — 이 검사가 시드의 유일한 파수꾼이다.
{
  const rulesSrc = readFileSync("lib/core/rules/detect-rules.ts", "utf8");
  const codeRuleCodes = [...rulesSrc.matchAll(/code: "(R-\d\d)"/g)].map((m) => m[1]);
  const codeVersion = rulesSrc.match(/DETECT_RULES_VERSION = "([^"]+)"/)?.[1] ?? "";
  const codeSeverities = [
    ...rulesSrc.matchAll(/code: "(R-\d\d)",[\s\S]*?severity_default: "(\w+)"/g),
  ].map((m) => `${m[1]}=${m[2]}`);
  const codeCategories = [
    ...rulesSrc.matchAll(/code: "(R-\d\d)",[\s\S]*?category: "(\w+)"/g),
  ].map((m) => `${m[1]}=${m[2]}`);

  check(
    "검출 룰 20종이 시드에 들어 있다",
    sql(`select count(*) from public.detect_rules;`) === String(codeRuleCodes.length) &&
      codeRuleCodes.length === 20,
    `code=${codeRuleCodes.length}`,
  );
  check(
    "**코드와 DB 의 룰 코드 집합이 같다** (사본이 벌어지면 조용히 틀린다)",
    sql(`select string_agg(code, ',' order by code) from public.detect_rules;`) ===
      [...codeRuleCodes].sort().join(","),
  );
  check(
    "판본이 코드와 같다 — 판본이 다르면 룰 내용도 달라졌을 수 있다",
    sql(`select count(*) from public.detect_rules where version <> '${codeVersion}';`) === "0",
    `code=${codeVersion}`,
  );
  check(
    "등급이 코드와 일치한다",
    sql(`select string_agg(code || '=' || severity_default::text, ',' order by code)
           from public.detect_rules;`) === [...codeSeverities].sort().join(","),
  );
  check(
    "카테고리가 코드와 일치한다",
    sql(`select string_agg(code || '=' || category, ',' order by code)
           from public.detect_rules;`) === [...codeCategories].sort().join(","),
  );
  check(
    "**검출 조건이 빈 룰이 없다** (빈 칸이면 무엇을 찾는 룰인지 운영자가 알 수 없다)",
    sql(`select count(*) from public.detect_rules
           where pattern_json = '{}'::jsonb
              or not (pattern_json ? 'presence' or pattern_json ? 'absence');`) === "0",
  );
  check(
    "지시문·근거가 빈 룰이 없다",
    sql(`select count(*) from public.detect_rules
           where coalesce(btrim(prompt_fragment), '') = ''
              or coalesce(btrim(basis_ref), '') = '';`) === "0",
  );
  check(
    "**근거에 조항 번호를 적지 않았다** (법무 검수 전 · 부록 D ②)",
    sql(`select count(*) from public.detect_rules where basis_ref ~ '제 *[0-9]+ *조';`) === "0",
  );

  // ── 내부 자산은 열지 않는다 ────────────────────────────────────────────────
  // `prompt_fragment` 는 우리가 쓴 분석 지시문이다. 룰 자체가 서비스의 자산이라
  // 0005 가 정책을 두지 않았고(서비스롤 전용), 스캔은 서버에서만 돈다.
  check(
    // **S8-06 이 0행에서 거절로 바꿨다.** 0061 이 anon 의 SELECT 권한까지 걷어서
    // 이제 정책에 닿기 전에 끊긴다 — 0행은 "안 보인다" 이고 거절은 "읽을 수 없다" 인데,
    // 내부 자산에 필요한 것은 뒤쪽이다.
    "**비로그인은 검출 룰을 못 본다** (지시문은 내부 자산이다)",
    rejectedWith(/permission denied/, () =>
      asAnon(`select count(*) from public.detect_rules;`),
    ),
  );
  check(
    "로그인해도 검출 룰을 못 본다",
    asUser(owner, `select count(*) from public.detect_rules;`) === "0",
  );
  check(
    // **S8-06 이 이 줄의 뜻을 바꿨다.** 그전에는 운영자도 못 봤는데, F-A-03 콘솔이
    // "어떤 룰이 도는가" 를 한 줄씩 보는 화면이라 **운영자에게만** 열었다(0061 · D-115).
    // 소비자·업체·비로그인은 위아래 검사가 그대로 막는다.
    "운영자는 검출 룰을 읽는다 (F-A-03 은 행을 보는 일이다 · S8-06 이 열었다)",
    Number(asUser(adminUser, `select count(*) from public.detect_rules;`)) >= 20,
  );
  check(
    // 0061 이 쓰기 권한을 걷어 이제 0행이 아니라 거절이다.
    "쓰기도 막힌다 — 룰을 고치는 일은 배포로 한다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.detect_rules set is_active = false;`),
    ),
  );

  // ── 위약금 기준은 **일부러 비어 있다** ────────────────────────────────────
  // 0031(S5-08)의 판단이다: 법무 검수 전 가정치를 DB 에 넣으면 그것이 운영 기준처럼
  // 굳는다. 로더가 DB 우선·코드 폴백이라 **행을 넣는 순간** 전환되므로,
  // "비어 있음" 은 방치가 아니라 결정이다. 검사로 그 결정을 붙잡아 둔다.
  check(
    "**위약금 기준은 시드하지 않는다** (가정치가 운영 기준처럼 굳는다 · 0031)",
    sql(`select count(*) from public.penalty_rules;`) === "0",
  );
  check(
    // **S8-06 이 0행에서 거절로 바꿨다.** 0061 이 anon 의 SELECT 권한까지 걷었다 —
    // 밴드가 곧 금액이고, 비어 있는 표라도 스키마를 읽히는 것이 이득이 없다.
    "비로그인은 위약금 기준 표도 못 본다",
    rejectedWith(/permission denied/, () =>
      asAnon(`select count(*) from public.penalty_rules;`),
    ),
  );
}

// ── AI 플래너 대화·툴 호출 감사 (S7-20 · §3.6 · §5.6) ────────────────────────
// **툴이 부르는 조회가 RLS 를 우회하지 않는지**가 이 태스크의 권한 질문이었다.
// 핸들러 쪽은 `lib/ai/tools/boundary.test.ts` 가 소스로 붙잡고(서비스롤을 쥐지
// 않는다), DB 쪽은 여기서 붙잡는다 — 대화·메시지·툴 호출이 **커플 경계 안에서만**
// 보이는가. 이 셋은 툴 호출 인자와 요약을 들고 있어서, 새면 남의 대화가 통째로 샌다.
{
  const CONV = "00000000-0000-0000-0000-0000000000a1";
  const MSG = "00000000-0000-0000-0000-0000000000a2";
  const OTHER_CONV = "00000000-0000-0000-0000-0000000000a3";
  const AI_OTHER_COUPLE = "00000000-0000-0000-0000-0000000000a4";

  /** 우리 커플의 대화 하나 + 메시지 + 툴 호출 하나. */
  const aiFixture = `
    insert into public.ai_conversations (id, couple_id, title)
      values ('${CONV}', '${coupleId}', 'RLS점검 대화');
    insert into public.ai_messages (id, conversation_id, role, content)
      values ('${MSG}', '${CONV}', 'assistant', 'RLS점검');
    insert into public.ai_tool_calls (message_id, tool_name, arguments_json, result_summary, latency_ms)
      values ('${MSG}', 'search_vendors', '{"query":"강남"}'::jsonb, 'ok:2', 12);
  `;

  /** 남의 커플의 대화. 우리 세션에서 보이면 안 된다. */
  const aiForeignFixture = `${aiFixture}
    insert into public.couples (id, owner_id, stage)
      values ('${AI_OTHER_COUPLE}', '${outsider}', 'onboarding');
    insert into public.ai_conversations (id, couple_id, title)
      values ('${OTHER_CONV}', '${AI_OTHER_COUPLE}', '남의 대화');
  `;

  check(
    "당사자는 자기 대화를 본다",
    asUser(owner, `select count(*) from public.ai_conversations;`, aiFixture) === "1",
  );
  check(
    "배우자도 같은 대화를 본다 (커플 공유 · D-19)",
    asUser(partner, `select count(*) from public.ai_conversations;`, aiFixture) === "1",
  );
  check(
    "**남의 커플 대화는 안 보인다**",
    asUser(owner, `select count(*) from public.ai_conversations;`, aiForeignFixture) === "1",
  );
  check(
    "커플이 아닌 사람에게는 아무 대화도 안 보인다",
    asUser(outsider, `select count(*) from public.ai_conversations where id = '${CONV}';`,
      aiFixture) === "0",
  );
  check(
    "비로그인은 대화를 못 본다",
    asAnon(`select count(*) from public.ai_conversations;`, aiFixture) === "0",
  );

  check(
    "당사자는 자기 대화의 메시지를 본다",
    asUser(owner, `select count(*) from public.ai_messages;`, aiFixture) === "1",
  );
  check(
    "**남의 메시지는 안 보인다** (상위 대화 스코프가 전이된다)",
    asUser(outsider, `select count(*) from public.ai_messages;`, aiFixture) === "0",
  );
  check(
    "메시지는 클라이언트가 쓸 수 없다 — 저장은 서버(서비스롤)다",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.ai_messages (conversation_id, role, content)
         values ('${CONV}', 'user', '직접 쓰기');`, aiFixture)),
  );

  check(
    "당사자는 자기 대화의 툴 호출 기록을 본다 (§3.6 감사)",
    asUser(owner, `select count(*) from public.ai_tool_calls;`, aiFixture) === "1",
  );
  check(
    "**남의 툴 호출 기록은 안 보인다** — 인자에 조회 조건이 들어 있다",
    asUser(outsider, `select count(*) from public.ai_tool_calls;`, aiFixture) === "0",
  );
  check(
    "비로그인은 툴 호출 기록을 못 본다",
    asAnon(`select count(*) from public.ai_tool_calls;`, aiFixture) === "0",
  );
  check(
    "툴 호출 기록은 클라이언트가 쓸 수 없다 (감사 기록을 당사자가 만들지 않는다)",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(owner, `insert into public.ai_tool_calls (message_id, tool_name, result_summary)
         values ('${MSG}', 'search_vendors', '지어낸 기록');`, aiFixture)),
  );
  check(
    // **S8-07 이 0행에서 거절로 바꿨다.** 그전에는 정책이 없어 UPDATE 가 0행을
    // 돌려줬고(조용한 무효), 0059 가 권한을 걷은 뒤로는 **문장 자체가 끊긴다.**
    // 뜻이 더 강해진 것이라 검사도 그렇게 고친다 — 0행은 "아무것도 안 바뀌었다"
    // 이지만 거절은 "쓸 수 없다" 이고, 우리가 보장하려던 것은 뒤쪽이다.
    "툴 호출 기록은 고칠 수도 지울 수도 없다 (감사는 append-only)",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(owner, `update public.ai_tool_calls set result_summary = '조작';`, aiFixture),
    ) &&
      rejectedWith(/row-level security|permission denied/i, () =>
        asUser(owner, `delete from public.ai_tool_calls;`, aiFixture),
      ),
  );

  // ── 커뮤니티 (S7-14 · §3.7 · D-26) ─────────────────────────────────────────
  // **모더레이션이 없으면 커뮤니티를 열 수 없다**(T-00f). 그 모더레이션의 경계가
  // 여기 있다 — 작성자가 자기 글을 가릴 수 없고, 운영자는 클라이언트 경로로
  // 가릴 수 없으며(서비스롤 경유), 신고는 신고자와 운영자만 본다.
  {
    const POST = "00000000-0000-0000-0000-0000000000c1";
    const HIDDEN_POST = "00000000-0000-0000-0000-0000000000c2";
    const CMT = "00000000-0000-0000-0000-0000000000c3";
    const RPT = "00000000-0000-0000-0000-0000000000c4";
    const TAGV = "00000000-0000-0000-0000-0000000000c6";

    // 태그 대상 업체를 트랜잭션 안에서 만든다. **승인 상태여야** 태그 트리거를 지난다.
    const communityFixture = `
      insert into public.vendors (id, name, category, status)
        values ('${TAGV}', 'RLS커뮤니티업체', 'hall', 'active');
      insert into public.vendor_members (vendor_id, user_id, vendor_role)
        values ('${TAGV}', '${outsider}', 'owner');
      insert into public.community_posts (id, author_id, board_type, title, body, status)
        values ('${POST}', '${owner}', 'experience', 'RLS점검 글', '본문입니다', 'published'),
               ('${HIDDEN_POST}', '${owner}', 'free', '가려진 글', '본문입니다', 'hidden');
      insert into public.community_comments (id, post_id, author_id, body)
        values ('${CMT}', '${POST}', '${partner}', '댓글입니다');
      insert into public.community_post_tags (post_id, vendor_id, tagged_by, verified_purchase)
        values ('${POST}', '${TAGV}', '${owner}', false);
      insert into public.community_reports (id, target_type, target_id, reporter_id, reason_code)
        values ('${RPT}', 'post', '${POST}', '${partner}', 'spam');
    `;

    check(
      "**비로그인은 공개 글을 읽는다** (SEO·열람이 그 위에 선다)",
      asAnon(`select count(*) from public.community_posts;`, communityFixture) === "1",
    );
    check(
      "**비로그인에게 가려진 글은 안 보인다**",
      asAnon(`select count(*) from public.community_posts where id = '${HIDDEN_POST}';`,
        communityFixture) === "0",
    );
    check(
      "작성자는 가려진 자기 글을 본다 — 그래야 '왜 안 보이나' 를 물을 수 있다",
      asUser(owner, `select count(*) from public.community_posts;`, communityFixture) === "2",
    );
    check(
      "남은 가려진 글을 못 본다",
      asUser(outsider, `select count(*) from public.community_posts;`, communityFixture) === "1",
    );
    check(
      "운영자는 전부 본다",
      asUser(adminUser, `select count(*) from public.community_posts;`, communityFixture) === "2",
    );

    check(
      "**남의 글을 고칠 수 없다**",
      asUser(outsider, `with u as (update public.community_posts set title = '조작' returning id)
         select count(*) from u;`, communityFixture) === "0",
    );
    check(
      "**작성자가 스스로 비공개로 옮길 수 없다** — 그건 모더레이션이다",
      rejectedWith(/비공개 처리는 운영자만/, () =>
        asUser(owner, `update public.community_posts set status = 'hidden' where id = '${POST}';`,
          communityFixture)),
    );
    // 고정·집계는 **열 단위 GRANT** 가 막는다 — 값 비교로 막으면 좋아요 캐시 트리거
    // 자신이 걸린다(이 검사가 실제로 그것을 잡아냈다).
    check(
      "**작성자가 고정할 수 없다**",
      rejectedWith(/permission denied/i, () =>
        asUser(owner, `update public.community_posts set is_pinned = true where id = '${POST}';`,
          communityFixture)),
    );
    check(
      "**집계 값을 손으로 고칠 수 없다** (좋아요는 트리거, 조회수는 함수)",
      rejectedWith(/permission denied/i, () =>
        asUser(owner, `update public.community_posts set like_count = 999 where id = '${POST}';`,
          communityFixture)) &&
        rejectedWith(/permission denied/i, () =>
          asUser(owner, `update public.community_posts set view_count = 999 where id = '${POST}';`,
            communityFixture)),
    );
    check(
      "제목·내용은 고칠 수 있다 — 좁힌 것은 칸이지 수정 자체가 아니다",
      asUser(owner, `with u as (update public.community_posts set title = '고친 제목'
           where id = '${POST}' returning id)
         select count(*) from u;`, communityFixture) === "1",
    );
    check(
      "**운영자도 클라이언트 경로로는 가릴 수 없다** (서비스롤 경유 · 근거 7)",
      asUser(adminUser, `with u as (update public.community_posts set status = 'hidden'
           where id = '${POST}' returning id)
         select count(*) from u;`, communityFixture) === "0",
    );
    // 권한에서 막았으므로 **0행이 아니라 오류**로 끝난다 — 정책만 두면 DELETE 는
    // 조용히 0행이 되고, 그때 호출부는 "지웠다" 고 믿는다(0019·0032 가 쓴 방식).
    check(
      "**글은 지워지지 않는다** — 삭제는 묘비다 (D-23)",
      rejectedWith(/permission denied|row-level security/i, () =>
        asUser(owner, `delete from public.community_posts where id = '${POST}';`, communityFixture)),
    );
    check(
      "작성자는 자기 글을 삭제 상태로 옮길 수 있다",
      asUser(owner, `with u as (update public.community_posts set status = 'deleted'
           where id = '${POST}' returning id)
         select count(*) from u;`, communityFixture) === "1",
    );

    check(
      "좋아요 캐시가 트리거로 유지된다 (행이 권위)",
      asUser(
        owner,
        `insert into public.community_likes (post_id, user_id) values ('${POST}', '${owner}');
         select like_count from public.community_posts where id = '${POST}';`,
        communityFixture,
      ) === "1",
    );
    check(
      "**남이 누른 좋아요 행은 안 보인다** (총합은 like_count 가 이미 공개한다)",
      asUser(
        partner,
        `select count(*) from public.community_likes;`,
        `${communityFixture}
         insert into public.community_likes (post_id, user_id) values ('${POST}', '${owner}');`,
      ) === "0",
    );
    check(
      "**스크랩은 본인만 본다**",
      asUser(
        partner,
        `select count(*) from public.community_scraps;`,
        `${communityFixture}
         insert into public.community_scraps (post_id, user_id) values ('${POST}', '${owner}');`,
      ) === "0",
    );
    check(
      "남의 이름으로 좋아요를 누를 수 없다 (42501)",
      rejectedWith(/row-level security/i, () =>
        asUser(partner, `insert into public.community_likes (post_id, user_id)
           values ('${POST}', '${owner}');`, communityFixture)),
    );

    check(
      "**신고자는 자기 신고를 본다**",
      asUser(partner, `select count(*) from public.community_reports where target_id = '${POST}';`,
        communityFixture) === "1",
    );
    check(
      "**피신고자는 신고를 못 본다** — 보복이 신고를 막는다",
      asUser(owner, `select count(*) from public.community_reports where target_id = '${POST}';`,
        communityFixture) === "0",
    );
    check(
      "운영자는 신고 큐를 본다",
      asUser(adminUser, `select count(*) from public.community_reports where target_id = '${POST}';`,
        communityFixture) === "1",
    );
    check(
      "**신고를 고치거나 지울 수 없다** — 처리 이력이 감사의 근거다",
      rejectedWith(/permission denied|row-level security/i, () =>
        asUser(partner, `update public.community_reports set status = 'rejected'
           where id = '${RPT}';`, communityFixture)) &&
        rejectedWith(/permission denied|row-level security/i, () =>
          asUser(partner, `delete from public.community_reports where id = '${RPT}';`,
            communityFixture)),
    );
    check(
      "**끝난 신고에는 사유가 있어야 한다** (CHECK)",
      rejectedWith(/community_reports_resolution_shape/, () =>
        sql(`insert into public.community_reports
               (target_type, target_id, reporter_id, reason_code, status)
             values ('post', '${POST}', '${partner}', 'spam', 'resolved');`)),
    );
    check(
      "같은 대상을 두 번 신고할 수 없다 (중복이 큐를 채우면 진짜 신고가 묻힌다)",
      rejectedWith(/uq_community_reports_reporter/, () =>
        asUser(partner, `insert into public.community_reports
             (target_type, target_id, reporter_id, reason_code)
           values ('post', '${POST}', '${partner}', 'abuse');`, communityFixture)),
    );

    check(
      "**업체는 자사 태그 글을 찾을 수 있다** (F-V-18)",
      asUser(outsider, `select count(*) from public.community_post_tags;`,
        communityFixture) === "1",
    );
    check(
      "**남의 글에 업체를 태그할 수 없다** — 그 업체 화면에 엉뚱한 글이 뜬다",
      rejectedWith(/row-level security/i, () =>
        asUser(partner, `insert into public.community_post_tags (post_id, vendor_id, tagged_by)
           values ('${POST}', '${TAGV}', '${partner}');`, communityFixture)),
    );
    check(
      "**승인되지 않은 업체는 태그할 수 없다**",
      rejectedWith(/승인된 업체만/, () =>
        asUser(
          owner,
          `insert into public.community_post_tags (post_id, vendor_id, tagged_by)
             values ('${POST}', '${TAGV}', '${owner}');`,
          `${communityFixture}
           delete from public.community_post_tags where post_id = '${POST}';
           update public.vendors set status = 'pending' where id = '${TAGV}';`,
        )),
    );
    check(
      "같은 업체를 두 번 태그할 수 없다",
      rejectedWith(/uq_community_post_tags/, () =>
        asUser(owner, `insert into public.community_post_tags (post_id, vendor_id, tagged_by)
           values ('${POST}', '${TAGV}', '${owner}');`, communityFixture)),
    );

    check(
      "**답글의 답글은 달 수 없다** (2단 제한)",
      rejectedWith(/답글의 답글/, () =>
        sql(`begin;
             ${communityFixture}
             insert into public.community_comments (id, post_id, author_id, parent_id, body)
               values ('00000000-0000-0000-0000-0000000000c5', '${POST}', '${owner}', '${CMT}', '답글');
             insert into public.community_comments (post_id, author_id, parent_id, body)
               values ('${POST}', '${owner}', '00000000-0000-0000-0000-0000000000c5', '답글의 답글');
             rollback;`)),
    );
    check(
      "다른 글의 댓글에는 답글을 달 수 없다",
      rejectedWith(/다른 글의 댓글/, () =>
        sql(`begin;
             ${communityFixture}
             insert into public.community_comments (post_id, author_id, parent_id, body)
               values ('${HIDDEN_POST}', '${owner}', '${CMT}', '남의 글에 답글');
             rollback;`)),
    );
    check(
      "가려진 글의 댓글은 비로그인에게 안 보인다",
      asAnon(`select count(*) from public.community_comments;`,
        `${communityFixture}
         update public.community_posts set status = 'hidden' where id = '${POST}';`) === "0",
    );

    check(
      "조회수는 함수로만 오른다",
      asUser(owner, `select public.bump_post_view('${POST}');
         select view_count from public.community_posts where id = '${POST}';`,
        communityFixture) === "1",
    );
    check(
      "가려진 글의 조회수는 오르지 않는다 — 그 수가 무엇을 뜻하는지 알 수 없다",
      asUser(owner, `select public.bump_post_view('${HIDDEN_POST}');
         select view_count from public.community_posts where id = '${HIDDEN_POST}';`,
        communityFixture) === "0",
    );

    // ── 업체 대응 (S7-16 · F-V-18 · D-24) ────────────────────────────────────
    // **업체는 답변까지다.** 본문을 고치지도 내리지도 못하고 신고만 할 수 있다 —
    // 판정자가 아니라 조율자라는 D-24 가 여기서 권한으로 드러난다.
    check(
      "**태그된 업체는 답변을 달 수 있다** (F-V-18)",
      asUser(
        outsider,
        `with i as (insert into public.community_comments (post_id, author_id, body)
                   values ('${POST}', '${outsider}', '문의 주시면 안내드리겠습니다') returning id)
         select count(*) from i;`,
        communityFixture,
      ) === "1",
    );
    check(
      "**태그되지 않은 업체는 답변할 수 없다** (42501)",
      rejectedWith(/row-level security/i, () =>
        asUser(
          outsider,
          `insert into public.community_comments (post_id, author_id, body)
             values ('${HIDDEN_POST}', '${outsider}', '남의 글에 답변');`,
          communityFixture,
        )),
    );
    check(
      "**업체는 태그된 글의 본문을 고칠 수 없다**",
      asUser(outsider, `with u as (update public.community_posts set body = '업체가 고침'
           where id = '${POST}' returning id)
         select count(*) from u;`, communityFixture) === "0",
    );
    // 정책이 **행을 고르는** 자리라 오류가 아니라 0행으로 끝난다(작성자가 아니므로
    // 애초에 고를 행이 없다). 트리거까지 가지 않는다.
    check(
      "**업체는 태그된 글을 내릴 수 없다** — 내리는 것은 운영자의 일이다",
      asUser(outsider, `with u as (update public.community_posts set status = 'hidden'
           where id = '${POST}' returning id)
         select count(*) from u;`, communityFixture) === "0",
    );
    check(
      "업체도 신고는 할 수 있다 (본인 이름으로)",
      asUser(
        outsider,
        `with i as (insert into public.community_reports
                     (target_type, target_id, reporter_id, reason_code)
                   values ('post', '${POST}', '${outsider}', 'false_info') returning id)
         select count(*) from i;`,
        communityFixture,
      ) === "1",
    );
    check(
      "**업체 답변도 신고 대상이다** — 예외를 두면 신고할 수 없는 글이 생긴다",
      asUser(
        owner,
        `with i as (insert into public.community_reports
                     (target_type, target_id, reporter_id, reason_code)
                   values ('comment', '${CMT}', '${owner}', 'abuse') returning id)
         select count(*) from i;`,
        communityFixture,
      ) === "1",
    );

    // ── 모더레이션 (S7-17 · F-A-18 · D-62) ───────────────────────────────────
    // **운영자는 읽기만 정책으로 연다.** 처리는 서비스롤 경유이며, 그 사실이 여기서
    // 검사로 고정된다 — 정책을 열면 되돌릴 수 없는 권한이 클라이언트에 놓인다.
    check(
      "운영자는 신고 대상 글을 본문까지 본다 (판단하려면 봐야 한다)",
      asUser(adminUser, `select count(*) from public.community_posts where id = '${POST}';`,
        communityFixture) === "1",
    );
    check(
      "**운영자도 클라이언트 경로로는 신고를 닫을 수 없다** (서비스롤 경유)",
      rejectedWith(/permission denied|row-level security/i, () =>
        asUser(adminUser, `update public.community_reports
             set status = 'resolved', resolution = '광고성 문구', resolved_by = '${adminUser}',
                 resolved_at = now()
           where id = '${RPT}';`, communityFixture)),
    );
    check(
      "**서비스롤은 사유와 함께라면 닫을 수 있다**",
      sql(`begin;
           ${communityFixture}
           update public.community_reports
              set status = 'resolved', resolution = '광고성 문구를 확인했습니다',
                  resolved_by = '${adminUser}', resolved_at = now()
            where id = '${RPT}';
           select status from public.community_reports where id = '${RPT}';
           rollback;`) === "resolved",
    );
    check(
      "**사유 없이는 서비스롤도 닫지 못한다** (CHECK 가 마지막 문이다)",
      rejectedWith(/community_reports_resolution_shape/, () =>
        sql(`begin;
             ${communityFixture}
             update public.community_reports set status = 'resolved' where id = '${RPT}';
             rollback;`)),
    );
    check(
      "**운영자가 글을 '삭제' 로 옮기지 않는다** — 화면이 '작성자가 지웠다' 고 거짓말한다",
      sql(`begin;
           ${communityFixture}
           update public.community_posts set status = 'hidden' where id = '${POST}';
           select status from public.community_posts where id = '${POST}';
           rollback;`) === "hidden",
    );
    check(
      "가려진 글의 작성자는 여전히 자기 글을 본다",
      asUser(owner, `select count(*) from public.community_posts where id = '${POST}';`,
        `${communityFixture}
         update public.community_posts set status = 'hidden' where id = '${POST}';`) === "1",
    );

    // ── 공개 플래그 (S7-15 · CLAUDE.md §2.1) ─────────────────────────────────
    // **만들어 두고 켜지 않는다.** 화면·API 는 완성돼 있고 스위치가 꺼져 있다 —
    // 모더레이션 큐(S7-17) 없이 커뮤니티를 열지 않는다는 T-00f 판단을 표가 들고 있다.
    // 0041 이 켰다 — 세 층(필터·모더레이션·라벨링)과 양측 절차가 모두 갖춰졌다.
    check(
      "**커뮤니티 공개 플래그가 켜져 있다** (S7-16 이 마지막 조건을 채웠다)",
      sql(`select enabled from public.feature_flags where key = 'community.enabled';`) === "t",
    );
    check(
      "왜 열렸는지 행이 들고 있다",
      sql(`select rollout_json->>'opened_by' from public.feature_flags
             where key = 'community.enabled';`) === "S7-16",
    );
    check(
      "**비로그인은 플래그를 못 본다** (미공개 기능의 존재를 노출하지 않는다)",
      rejectedWith(/permission denied|row-level security/i, () =>
        asAnon(`select count(*) from public.feature_flags;`)),
    );
    check(
      "로그인해도 플래그를 못 본다 — 판정 결과만 서버가 넘긴다",
      rejectedWith(/permission denied|row-level security/i, () =>
        asUser(owner, `select count(*) from public.feature_flags;`)),
    );

    check(
      "**커뮤니티 운영 파라미터는 값이 비어 있다** (O-14 대기 — 지어낸 기한으로 재촉하지 않는다)",
      sql(`select count(*) from public.app_settings
             where key in ('community.report_sla_hours', 'community.post_daily_limit')
               and value_json->>'value' is null;`) === "2",
    );
  }

  // ── 계약서 검토 (S7-03 · §3.5 · §5.2) ──────────────────────────────────────
  // **원문은 지워도 리포트는 남는다.** 그 남은 것이 남에게 보이면 안 된다 —
  // `findings.clause_excerpt_masked` 는 마스킹본이지만 여전히 그 커플의 계약 내용이다.
  {
    const DOC = "00000000-0000-0000-0000-0000000000b1";
    const ANA = "00000000-0000-0000-0000-0000000000b2";
    const DOC_OTHER_COUPLE = "00000000-0000-0000-0000-0000000000b3";

    const reportFixture = `
      insert into public.documents (id, couple_id, doc_type, storage_path, mime, purge_scheduled_at)
        values ('${DOC}', '${coupleId}', 'contract', '${coupleId}/${DOC}', 'text/plain', now() + interval '24 hours');
      insert into public.document_analyses (id, document_id, status, risk_score)
        values ('${ANA}', '${DOC}', 'done', 40);
      insert into public.findings (analysis_id, rule_code, severity, clause_excerpt_masked, basis_ref, citation_verified)
        values ('${ANA}', 'R-01', 'high'::public.finding_severity, '위약금은 총 금액의 80%로 한다', '소비자분쟁해결기준(예식업)', true);
    `;

    // **픽스처가 넣은 행만 센다.** 이 표에는 흐름 점검이 남긴 행이 있을 수 있고,
    // 전체 개수를 세면 검사가 "언제 돌리느냐" 에 좌우된다.
    check(
      "당사자는 자기 문서를 본다",
      asUser(owner, `select count(*) from public.documents where id = '${DOC}';`, reportFixture) === "1",
    );
    check(
      "배우자도 같은 문서를 본다 (커플 공유 · D-19)",
      asUser(partner, `select count(*) from public.documents where id = '${DOC}';`, reportFixture) === "1",
    );
    check(
      "**남의 문서는 안 보인다**",
      asUser(outsider, `select count(*) from public.documents;`, reportFixture) === "0",
    );
    check(
      "비로그인은 문서를 못 본다",
      asAnon(`select count(*) from public.documents;`, reportFixture) === "0",
    );
    check(
      "당사자는 분석 결과를 본다",
      asUser(owner, `select count(*) from public.document_analyses where id = '${ANA}';`, reportFixture) === "1",
    );
    check(
      "**남의 분석은 안 보인다** (상위 문서 스코프가 전이된다)",
      asUser(outsider, `select count(*) from public.document_analyses;`, reportFixture) === "0",
    );
    check(
      "당사자는 조항 검출 결과를 본다",
      asUser(owner, `select count(*) from public.findings where analysis_id = '${ANA}';`, reportFixture) === "1",
    );
    check(
      "**남의 조항 인용은 안 보인다** — 마스킹본이어도 그 커플의 계약 내용이다",
      asUser(outsider, `select count(*) from public.findings;`, reportFixture) === "0",
    );
    check(
      "비로그인은 조항 검출 결과를 못 본다",
      asAnon(`select count(*) from public.findings;`, reportFixture) === "0",
    );
    check(
      // **S8-07 이 정책 위에 권한까지 걷었다**(0059). 그전에는 정책이 없어 RLS 가
      // 막았고, 이제는 그 앞의 권한에서 끊긴다 — 오류 문구가 바뀌므로 둘 다 받는다.
      // 막히는 이유가 늘어난 것이지 약해진 것이 아니다.
      "분석·조항은 클라이언트가 쓸 수 없다 — 파이프라인(서비스롤)이 만든다",
      rejectedWith(/row-level security|permission denied/i, () =>
        asUser(owner, `insert into public.document_analyses (document_id, status)
           values ('${DOC}', 'done');`, reportFixture)) &&
        rejectedWith(/row-level security|permission denied/i, () =>
          asUser(owner, `insert into public.findings (analysis_id, rule_code, severity)
             values ('${ANA}', 'R-01', 'low'::public.finding_severity);`, reportFixture)),
    );
    check(
      // **S8-07 이 0행에서 거절로 바꿨다.** 정책이 없어 0행이 돌아오던 것이
      // 0059 의 권한 회수 뒤로는 문장 자체가 끊긴다. 0행은 "아무것도 안 바뀌었다"
      // 이고 거절은 "쓸 수 없다" 인데, 리포트가 협상 자료라 필요한 것은 뒤쪽이다.
      "**위험 점수를 당사자가 고칠 수 없다** (권한 회수 · 0059)",
      rejectedWith(/row-level security|permission denied/i, () =>
        asUser(owner, `update public.document_analyses set risk_score = 0;`, reportFixture),
      ),
    );
    check(
      "**남의 커플 id 로 문서를 만들 수 없다** (42501)",
      rejectedWith(/row-level security/i, () =>
        asUser(
          owner,
          `insert into public.documents (couple_id, doc_type, storage_path, purge_scheduled_at)
             values ('${DOC_OTHER_COUPLE}', 'contract', 'x', now());`,
          `insert into public.couples (id, owner_id, stage)
             values ('${DOC_OTHER_COUPLE}', '${outsider}', 'onboarding');`,
        )),
    );
    check(
      "**파기 예약 없이 문서를 만들 수 없다** (NOT NULL · CLAUDE.md §5.1)",
      rejectedWith(/null value|not-null/i, () =>
        asUser(owner, `insert into public.documents (couple_id, doc_type, storage_path)
           values ('${coupleId}', 'contract', 'x');`)),
    );
    check(
      "계약서 원문 버킷은 비공개다 (서명 URL 전용)",
      sql(`select public from storage.buckets where id = 'contracts-raw';`) === "f",
    );
    check(
      "**원문 버킷에 storage 정책이 없다** — 정책이 없다는 것이 곧 '직접 접근 불가' 다",
      sql(`select count(*) from pg_policies
             where schemaname = 'storage' and tablename = 'objects'
               and qual like '%contracts-raw%';`) === "0",
    );
  }

  // ── 대화 시작 권한 (S7-06) ─────────────────────────────────────────────────
  // 화면은 대화를 서버(서비스롤)로 만들지만, **정책 자체가 커플 경계를 지키는지**는
  // 별개다. 남의 커플 id 로 대화를 만들 수 있으면 그 대화의 메시지·툴 호출이 전부
  // 남의 것으로 기록된다 — 라우트의 소유 확인 한 줄이 유일한 방벽이 되면 안 된다.
  check(
    "당사자는 자기 커플로 대화를 만들 수 있다",
    asUser(
      owner,
      `with i as (insert into public.ai_conversations (couple_id, title)
                 values ('${coupleId}', 'RLS점검 생성') returning id)
       select count(*) from i;`,
    ) === "1",
  );
  check(
    "**남의 커플 id 로는 대화를 만들 수 없다** (42501)",
    rejectedWith(/row-level security/i, () =>
      asUser(
        owner,
        `insert into public.ai_conversations (couple_id, title)
           values ('${AI_OTHER_COUPLE}', '남의 커플에 밀어넣기');`,
        `insert into public.couples (id, owner_id, stage)
           values ('${AI_OTHER_COUPLE}', '${outsider}', 'onboarding');`,
      )),
  );
  // anon 은 정책 이전에 **GRANT 에서** 막힌다(T-03 역할별 권한). 둘 중 어느 층이
  // 막든 결과는 같지만, 사유를 하나로 좁혀 두면 권한 구조가 바뀔 때 검사가 엉뚱한
  // 이유로 깨진다 — 여기서 확인하려는 것은 "쓸 수 없다" 이다.
  check(
    "비로그인은 대화를 만들 수 없다 (GRANT 또는 정책)",
    rejectedWith(/row-level security|permission denied/i, () =>
      asAnon(`insert into public.ai_conversations (couple_id, title)
                values ('${coupleId}', '비로그인 생성');`)),
  );

  // ── 상한 파라미터 (§7.4 · S7-20) ────────────────────────────────────────────
  // **키는 있고 값은 비어 있다.** 값이 없으면 대화를 열지 않는다는 결정이 코드에
  // 있으므로(`conversationGate`), 키가 사라지면 그 결정이 조용히 무효가 된다.
  check(
    "AI 상한 파라미터 키가 시드에 있다",
    sql(`select count(*) from public.app_settings
           where key in ('ai.free_daily_turns', 'ai.session_token_cap');`) === "2",
  );
  check(
    "비로그인은 운영 파라미터를 못 본다",
    asAnon(`select count(*) from public.app_settings;`) === "0",
  );
}

// ── 태스크 의존 관계 (S7-18 · §3.2 · IDEA-02) ────────────────────────────────
// **순환은 CHECK 로 못 막는다** — 행 하나만 보기 때문이다. 트리거 + 재귀 CTE 가
// 표준 수단이고, 동시 삽입 구멍은 커플 단위 어드바이저리 락이 닫는다. 그 판정이
// 실제로 도는지 여기서 확인한다 — 코드가 아니라 DB 가 막아야 한다.
{
  const TA = "00000000-0000-0000-0000-0000000000d1";
  const TB = "00000000-0000-0000-0000-0000000000d2";
  const TC = "00000000-0000-0000-0000-0000000000d3";
  const TX = "00000000-0000-0000-0000-0000000000d4"; // 남의 커플 태스크
  const DEP_OTHER_COUPLE = "00000000-0000-0000-0000-0000000000d5";

  const taskFixture = `
    insert into public.tasks (id, couple_id, category, title, status)
      values ('${TA}', '${coupleId}', 'hall', '웨딩홀 계약', 'todo'),
             ('${TB}', '${coupleId}', 'sdm', '스드메 계약', 'todo'),
             ('${TC}', '${coupleId}', 'etc', '청첩장 주문', 'todo');
    insert into public.couples (id, owner_id, stage)
      values ('${DEP_OTHER_COUPLE}', '${outsider}', 'onboarding');
    insert into public.tasks (id, couple_id, category, title, status)
      values ('${TX}', '${DEP_OTHER_COUPLE}', 'hall', '남의 태스크', 'todo');
  `;

  check(
    "당사자는 선행 관계를 만든다",
    asUser(
      owner,
      `with i as (insert into public.task_dependencies (task_id, depends_on_task_id)
                 values ('${TB}', '${TA}') returning task_id)
       select count(*) from i;`,
      taskFixture,
    ) === "1",
  );
  check(
    "배우자도 같은 그래프를 본다 (커플 공유 · D-19)",
    asUser(
      partner,
      `select count(*) from public.task_dependencies;`,
      `${taskFixture}
       insert into public.task_dependencies (task_id, depends_on_task_id) values ('${TB}', '${TA}');`,
    ) === "1",
  );
  check(
    "**남은 우리 그래프를 못 본다**",
    asUser(
      outsider,
      `select count(*) from public.task_dependencies;`,
      `${taskFixture}
       insert into public.task_dependencies (task_id, depends_on_task_id) values ('${TB}', '${TA}');`,
    ) === "0",
  );
  check(
    "비로그인은 그래프를 못 본다",
    asAnon(
      `select count(*) from public.task_dependencies;`,
      `${taskFixture}
       insert into public.task_dependencies (task_id, depends_on_task_id) values ('${TB}', '${TA}');`,
    ) === "0",
  );

  // **BEFORE 트리거가 CHECK·RLS WITH CHECK 보다 먼저 돈다.** 그래서 길이 1 순환은
  // 제약 이름이 아니라 트리거 메시지로 걸린다 — 둘 다 막으므로 어느 쪽이든 통과다.
  // 제약을 남겨 둔 이유는 트리거가 없어지거나 우회될 때의 마지막 문이기 때문이다.
  check(
    "**자기 자신을 선행으로 둘 수 없다** (길이 1 순환)",
    rejectedWith(/task_dependencies_not_self|task_cycle|순환/, () =>
      asUser(owner, `insert into public.task_dependencies (task_id, depends_on_task_id)
         values ('${TA}', '${TA}');`, taskFixture)),
  );
  check(
    "같은 간선을 두 번 넣을 수 없다 (PK)",
    rejectedWith(/task_dependencies_pkey|duplicate key/, () =>
      asUser(owner, `insert into public.task_dependencies (task_id, depends_on_task_id)
           values ('${TB}', '${TA}'), ('${TB}', '${TA}');`, taskFixture)),
  );
  check(
    "**A→B→C→A 순환을 트리거가 막는다** (재귀 CTE)",
    rejectedWith(/task_cycle|순환/, () =>
      asUser(
        owner,
        `insert into public.task_dependencies (task_id, depends_on_task_id)
           values ('${TA}', '${TC}');`,
        `${taskFixture}
         insert into public.task_dependencies (task_id, depends_on_task_id)
           values ('${TB}', '${TA}'), ('${TC}', '${TB}');`,
      )),
  );
  check(
    "**다른 커플의 태스크는 선행으로 둘 수 없다**",
    rejectedWith(/row-level security|task_foreign_couple|다른 커플/, () =>
      asUser(owner, `insert into public.task_dependencies (task_id, depends_on_task_id)
         values ('${TB}', '${TX}');`, taskFixture)),
  );
  // 정책(WITH CHECK)도 막지만 **트리거가 먼저 답한다**(커플 대조). 확인하려는 것은
  // "막힌다" 이지 어느 층이 막았는가가 아니다.
  check(
    "**남의 태스크에 선행을 붙일 수 없다**",
    rejectedWith(/row-level security|task_foreign_couple|다른 커플/i, () =>
      asUser(owner, `insert into public.task_dependencies (task_id, depends_on_task_id)
         values ('${TX}', '${TA}');`, taskFixture)),
  );
  check(
    "**깊이 상한을 넘으면 거절한다** (검사 폭주 방지)",
    rejectedWith(/task_depth_exceeded|상한/, () =>
      sql(`begin;
           ${taskFixture}
           update public.app_settings
              set value_json = '{"value": 1, "unit": "depth"}'::jsonb
            where key = 'tasks.max_dependency_depth';
           insert into public.task_dependencies (task_id, depends_on_task_id) values ('${TB}', '${TA}');
           insert into public.task_dependencies (task_id, depends_on_task_id) values ('${TC}', '${TB}');
           rollback;`)),
  );
  check(
    "**상한이 없으면 간선을 받지 않는다** — 상한 없는 재귀는 사고다",
    rejectedWith(/task_depth_unconfigured|상한이 설정되지/, () =>
      sql(`begin;
           ${taskFixture}
           update public.app_settings
              set value_json = '{"value": null, "unit": "depth"}'::jsonb
            where key = 'tasks.max_dependency_depth';
           insert into public.task_dependencies (task_id, depends_on_task_id) values ('${TB}', '${TA}');
           rollback;`)),
  );
  check(
    "간선은 지울 수 있다 — 순서는 사용자의 판단이다",
    asUser(
      owner,
      `with d as (delete from public.task_dependencies returning task_id)
       select count(*) from d;`,
      `${taskFixture}
       insert into public.task_dependencies (task_id, depends_on_task_id) values ('${TB}', '${TA}');`,
    ) === "1",
  );
  check(
    "**간선을 고칠 수는 없다** — 방향을 바꾸는 일은 지우고 다시 만드는 것이다",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(
        owner,
        `update public.task_dependencies set depends_on_task_id = '${TC}' where task_id = '${TB}';`,
        `${taskFixture}
         insert into public.task_dependencies (task_id, depends_on_task_id) values ('${TB}', '${TA}');`,
      )),
  );
  check(
    "**중간 태스크를 지우면 간선만 사라지고 앞뒤를 잇지 않는다**",
    sql(`begin;
         ${taskFixture}
         insert into public.task_dependencies (task_id, depends_on_task_id)
           values ('${TB}', '${TA}'), ('${TC}', '${TB}');
         delete from public.tasks where id = '${TB}';
         select count(*) from public.task_dependencies;
         rollback;`) === "0",
  );

  // ── 템플릿 순서 — 시드가 순환을 담으면 모든 커플에 복제된다 ─────────────────
  check(
    "템플릿에 안정 키(code)가 붙었다",
    sql(`select count(*) from public.task_templates where code is null;`) === "0",
  );
  check(
    "**템플릿 순서도 순환을 막는다**",
    rejectedWith(/task_template_cycle|순환/, () =>
      sql(`begin;
           insert into public.task_templates (code, category, title, offset_days)
             values ('TT-A', 'hall', 'A', -300), ('TT-B', 'hall', 'B', -200);
           insert into public.task_template_dependencies (template_code, depends_on_code)
             values ('TT-B', 'TT-A');
           insert into public.task_template_dependencies (template_code, depends_on_code)
             values ('TT-A', 'TT-B');
           rollback;`)),
  );
  check(
    "템플릿 순서는 누구나 읽는다 (역산 생성의 근거다)",
    asAnon(`select count(*) from public.task_template_dependencies;`) === "0" ||
      asAnon(`select count(*) from public.task_template_dependencies;`) !== null,
  );
  check(
    "**템플릿 순서를 사용자가 쓸 수 없다** — 시드·운영자의 것이다",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(owner, `insert into public.task_template_dependencies (template_code, depends_on_code)
         values ('TT-X', 'TT-Y');`)),
  );

  check(
    "**선행 미완 완료를 막지 않는다** — 기록일 뿐이다(§3.2)",
    asUser(
      owner,
      `with u as (update public.tasks set status = 'done', completed_out_of_order = true
                 where id = '${TB}' returning id)
       select count(*) from u;`,
      `${taskFixture}
       insert into public.task_dependencies (task_id, depends_on_task_id) values ('${TB}', '${TA}');`,
    ) === "1",
  );
  check(
    "**ready·waiting 컬럼이 없다** — 저장하면 배치 전까지 화면이 거짓말을 한다",
    sql(`select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('ready', 'waiting', 'is_ready', 'is_waiting');`) === "0",
  );
  // ── 역산 템플릿 시드 (S7-08) ───────────────────────────────────────────────
  // **사본은 어긋나고 어긋나면 조용하다.** 진실은 `lib/core/schedule/templates.ts` 이고
  // 시드는 그 사본이라 검출 룰(S7-01)과 같은 방식으로 대조한다.
  {
    const templateSrc = readFileSync("lib/core/schedule/templates.ts", "utf8");
    const codes = [...templateSrc.matchAll(/code: "(T-[a-z-]+)"/g)].map((m) => m[1]);
    const edgeCount = [...templateSrc.matchAll(/dependsOn: \[([^\]]*)\]/g)]
      .map((m) => m[1].split(",").filter((v) => v.trim() !== "").length)
      .reduce((a, b) => a + b, 0);

    check(
      "역산 템플릿이 시드에 들어 있다",
      sql(`select count(*) from public.task_templates;`) === String(codes.length),
      `code=${codes.length}`,
    );
    check(
      "**코드와 DB 의 템플릿 코드 집합이 같다** (사본이 벌어지면 조용히 틀린다)",
      sql(`select string_agg(code, ',' order by code) from public.task_templates;`) ===
        [...codes].sort().join(","),
    );
    check(
      "템플릿 순서 간선 수가 코드와 같다",
      sql(`select count(*) from public.task_template_dependencies;`) === String(edgeCount),
      `code=${edgeCount}`,
    );
    check(
      "**템플릿 순서에 순환이 없다** (시드가 담으면 모든 커플에 복제된다)",
      sql(`with recursive walk(root, code, depth) as (
             select template_code, depends_on_code, 1 from public.task_template_dependencies
             union all
             select w.root, d.depends_on_code, w.depth + 1
               from public.task_template_dependencies d
               join walk w on d.template_code = w.code
              where w.depth < 20
           )
           select count(*) from walk where root = code;`) === "0",
    );
    check(
      "**선행이 나보다 늦게 시작하는 템플릿이 없다** (뒤집힌 순서)",
      sql(`select count(*) from public.task_template_dependencies d
             join public.task_templates t on t.code = d.template_code
             join public.task_templates p on p.code = d.depends_on_code
            where p.offset_days > t.offset_days;`) === "0",
    );
  }

  check(
    "의존 깊이 상한이 파라미터로 있다 (§7.4)",
    sql(`select value_json->>'value' from public.app_settings
           where key = 'tasks.max_dependency_depth';`) === "20",
  );
}

// ── 준비 순서 뷰 (S7-19 · F-C-37 · §6.2 · O-16) ──────────────────────────────
// S7-19 는 **표현과 편집 API** 를 얹었다. DB 층에서 확인할 것은 둘이다 —
// (가) 사용자가 손으로 잇는 간선도 **트리거를 그대로 지난다**(라우트가 우회로가 아니다)
// (나) 표현 스위치가 **행으로 존재한다**(O-16 이 코드를 고치지 않고 끌 수 있어야 한다).
{
  const TA = "00000000-0000-0000-0000-0000000000e1";
  const TB = "00000000-0000-0000-0000-0000000000e2";
  const TC = "00000000-0000-0000-0000-0000000000e3";

  const fixture = `
    insert into public.tasks (id, couple_id, category, title, status)
      values ('${TA}', '${coupleId}', 'hall', '웨딩홀 계약', 'todo'),
             ('${TB}', '${coupleId}', 'sdm', '스드메 계약', 'todo'),
             ('${TC}', '${coupleId}', 'etc', '청첩장 주문', 'todo');
  `;

  check(
    "손으로 이은 간선에 작성자가 남는다 (누가 순서를 정했나 · D-23)",
    asUser(
      owner,
      `with i as (insert into public.task_dependencies (task_id, depends_on_task_id, created_by)
                 values ('${TB}', '${TA}', '${owner}') returning created_by)
       select count(*) from i where created_by = '${owner}';`,
      fixture,
    ) === "1",
  );
  check(
    "**배우자가 지운 순서가 나에게도 사라진다** — 그래프는 커플 것이다 (D-19)",
    asUser(
      partner,
      `with d as (delete from public.task_dependencies where task_id = '${TB}' returning task_id)
       select count(*) from d;`,
      `${fixture}
       insert into public.task_dependencies (task_id, depends_on_task_id, created_by)
         values ('${TB}', '${TA}', '${owner}');`,
    ) === "1",
  );
  check(
    "**남이 우리 순서를 지울 수 없다**",
    asUser(
      outsider,
      `with d as (delete from public.task_dependencies where task_id = '${TB}' returning task_id)
       select count(*) from d;`,
      `${fixture}
       insert into public.task_dependencies (task_id, depends_on_task_id) values ('${TB}', '${TA}');`,
    ) === "0",
  );
  check(
    "**없는 간선을 지워도 오류가 아니다** — 결과가 요청한 대로다 (라우트가 성공으로 답한다)",
    asUser(
      owner,
      `with d as (delete from public.task_dependencies
                   where task_id = '${TB}' and depends_on_task_id = '${TC}' returning task_id)
       select count(*) from d;`,
      fixture,
    ) === "0",
  );
  check(
    "**같은 간선을 다시 넣으면 PK 가 막는다** — 라우트는 그 23505 를 성공으로 옮긴다",
    rejectedWith(/task_dependencies_pkey|duplicate key/, () =>
      asUser(
        owner,
        `insert into public.task_dependencies (task_id, depends_on_task_id) values ('${TB}', '${TA}');`,
        `${fixture}
         insert into public.task_dependencies (task_id, depends_on_task_id) values ('${TB}', '${TA}');`,
      )),
  );

  // **거절 사유가 API 까지 간다**(0044). PostgREST 는 `constraint` 이름을 응답에 싣지
  // 않아서 라우트가 순환·타 커플·깊이를 구분하지 못하고 500 으로 답했다 — 흐름 점검이
  // 잡았고 트리거가 `hint` 에도 사유를 싣도록 갈아 끼웠다. 그 사실을 여기서 붙잡아
  // 둔다: 함수를 다시 손보는 날 `hint` 가 빠지면 화면이 조용히 이유를 잃는다.
  check(
    "**거절 사유가 hint 로도 나간다** — PostgREST 는 constraint 를 싣지 않는다",
    ["task_cycle", "task_foreign_couple", "task_depth_exceeded", "task_depth_unconfigured"].every(
      (name) =>
        sql(`select pg_get_functiondef('public.task_dependency_guard()'::regprocedure);`).includes(
          `hint = '${name}'`,
        ),
    ),
  );

  // ── 표현 스위치 (0043 · O-16) ──────────────────────────────────────────────
  check(
    "표현 스위치 행이 있다 (schedule.views)",
    sql(`select count(*) from public.feature_flags where key = 'schedule.views';`) === "1",
  );
  check(
    "**표현 넷이 다 켜져 있다** — 판정은 S8-01 이후다(O-16). 지금 끄면 판정을 앞지른 것이다",
    sql(`select (rollout_json->>'timeline')::boolean and (rollout_json->>'progress')::boolean
                and (rollout_json->>'next')::boolean and (rollout_json->>'graph')::boolean
           from public.feature_flags where key = 'schedule.views';`) === "t",
  );
  check(
    "**무엇을 근거로 끄는지가 행에 적혀 있다** — 다음 사람이 판정 계획을 읽는다",
    sql(`select rollout_json->>'decided_by' from public.feature_flags
           where key = 'schedule.views';`) === "O-16",
  );
  check(
    "표현 스위치도 사용자에게 보이지 않는다 (미공개 기능의 존재를 노출하지 않는다)",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `select count(*) from public.feature_flags;`)),
  );

  // 코드↔DB 대조. **사본은 어긋나고 어긋나면 조용하다**(검출 룰 S7-01 과 같은 구조).
  {
    const viewSrc = readFileSync("lib/core/schedule/view.ts", "utf8");
    const codes = (viewSrc.match(/export const SCHEDULE_VIEWS = \[([^\]]*)\]/) ?? ["", ""])[1]
      .split(",")
      .map((v) => v.trim().replace(/"/g, ""))
      .filter((v) => v !== "");

    check(
      "**코드의 표현 목록과 플래그의 키가 같다** (하나만 늘면 스위치 없는 표현이 생긴다)",
      sql(`select string_agg(k, ',' order by k) from (
             select jsonb_object_keys(rollout_json) as k from public.feature_flags
              where key = 'schedule.views'
           ) t where k in (${codes.map((c) => `'${c}'`).join(", ")});`) ===
        [...codes].sort().join(","),
      `code=${codes.join("|")}`,
    );
  }
}

// ── 예산 배분·추적 (S7-07 · F-C-05 · §3.2 · §6.2) ────────────────────────────
// 확인할 것 셋 — (가) 커플 스코프가 실제로 막는가 (나) **플래너는 읽기만** 하는가
// (다) 0045 가 세운 불변식(커플당 예산 하나 · 카테고리당 계획 하나 · 어휘)이 도는가.
{
  const BUDGET = "00000000-0000-0000-0000-0000000000b1";
  const OTHER_BUDGET = "00000000-0000-0000-0000-0000000000b2";
  const OTHER_COUPLE = "00000000-0000-0000-0000-0000000000b3";
  const EXPENSE = "00000000-0000-0000-0000-0000000000b4";
  const BUDGET_PLANNER = "00000000-0000-0000-0000-0000000000b5";

  const budgetFixture = `
    insert into public.budgets (id, couple_id) values ('${BUDGET}', '${coupleId}');
    insert into public.budget_items (budget_id, category, planned_amount)
      values ('${BUDGET}', 'hall', 10000000);
    insert into public.expenses (id, couple_id, category, amount, memo)
      values ('${EXPENSE}', '${coupleId}', 'dress', 500000, '가봉비');
  `;

  const foreignFixture = `
    insert into public.couples (id, owner_id, stage)
      values ('${OTHER_COUPLE}', '${outsider}', 'onboarding');
    insert into public.budgets (id, couple_id) values ('${OTHER_BUDGET}', '${OTHER_COUPLE}');
    insert into public.budget_items (budget_id, category, planned_amount)
      values ('${OTHER_BUDGET}', 'hall', 99000000);
  `;

  check(
    "당사자는 자기 예산을 본다",
    asUser(owner, `select count(*) from public.budgets;`, budgetFixture) === "1",
  );
  check(
    "배우자도 같은 예산을 본다 (커플 공유 · D-19)",
    asUser(partner, `select count(*) from public.budget_items;`, budgetFixture) === "1",
  );
  check(
    "**남의 예산은 보이지 않는다**",
    asUser(owner, `select count(*) from public.budgets;`, `${budgetFixture}${foreignFixture}`) === "1",
  );
  check(
    "**남의 카테고리 계획도 보이지 않는다** (상위 budgets 를 통해 스코프가 정해진다)",
    asUser(owner, `select count(*) from public.budget_items;`, `${budgetFixture}${foreignFixture}`) === "1",
  );
  check(
    "**남의 지출은 보이지 않는다**",
    asUser(
      outsider,
      `select count(*) from public.expenses;`,
      budgetFixture,
    ) === "0",
  );
  check(
    "비로그인은 예산을 못 본다",
    asAnon(`select count(*) from public.budgets;`, budgetFixture) === "0",
  );
  check(
    "**남의 예산에 계획을 끼워 넣을 수 없다**",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.budget_items (budget_id, category, planned_amount)
         values ('${OTHER_BUDGET}', 'dress', 1);`, `${budgetFixture}${foreignFixture}`)),
  );
  check(
    "**남의 지출을 지울 수 없다**",
    asUser(
      outsider,
      `with d as (delete from public.expenses returning id) select count(*) from d;`,
      budgetFixture,
    ) === "0",
  );

  // ── 플래너는 읽기만 한다 (§3.9 · D-43) ────────────────────────────────────
  // **시드가 이미 플래너 행을 만들어 두었다**(S6-01 `planner@local.test`). 새로 넣으면
  // `planners_user_id_key` 에 걸린다 — 있는 것을 쓰고 위임만 붙인다.
  const budgetPlannerFixture = `
    ${budgetFixture}
    insert into public.planners (id, user_id, status, profile_json, regions)
      values ('${BUDGET_PLANNER}', '${plannerAccount ?? outsider}', 'active',
              '{"headline":"예산 픽스처","categories":["hall"]}'::jsonb, array['서울'])
      on conflict (user_id) do nothing;
    insert into public.planner_engagements (planner_id, couple_id, scope_json, status, valid_from, valid_to)
      select p.id, '${coupleId}', '{"tables":["budgets","budget_items","expenses"]}'::jsonb,
             'active', now() - interval '1 day', now() + interval '30 days'
        from public.planners p where p.user_id = '${plannerAccount ?? outsider}';
  `;

  if (plannerAccount) {
    check(
      "위임받은 플래너는 예산을 읽는다 (§3.9 플래너 위임)",
      asUser(plannerAccount, `select count(*) from public.budgets;`, budgetPlannerFixture) === "1",
    );
    check(
      "**플래너는 예산을 고칠 수 없다** — 위임은 열람이지 편집이 아니다",
      asUser(
        plannerAccount,
        `with u as (update public.budget_items set planned_amount = 1 returning id)
         select count(*) from u;`,
        budgetPlannerFixture,
      ) === "0",
    );
    check(
      "**플래너는 지출을 적을 수 없다**",
      rejectedWith(/row-level security/i, () =>
        asUser(plannerAccount, `insert into public.expenses (couple_id, category, amount)
           values ('${coupleId}', 'hall', 1);`, budgetPlannerFixture)),
    );
  }

  // ── 0045 불변식 ───────────────────────────────────────────────────────────
  check(
    "**커플당 예산은 하나다** — 둘이면 어느 것이 진짜인지 화면이 답할 수 없다",
    rejectedWith(/uq_budgets_couple|duplicate key/, () =>
      sql(`begin;
           ${budgetFixture}
           insert into public.budgets (couple_id) values ('${coupleId}');
           rollback;`)),
  );
  check(
    "**카테고리당 계획도 하나다** — 두 줄이면 합계가 조용히 두 배가 된다",
    rejectedWith(/uq_budget_items_category|duplicate key/, () =>
      sql(`begin;
           ${budgetFixture}
           insert into public.budget_items (budget_id, category, planned_amount)
             values ('${BUDGET}', 'hall', 1);
           rollback;`)),
  );
  check(
    "**`unmapped` 는 예산 카테고리가 아니다** — '확인 필요' 에 돈을 배정하게 된다",
    rejectedWith(/budget_items_category_vocab|check constraint/, () =>
      sql(`begin;
           ${budgetFixture}
           insert into public.budget_items (budget_id, category, planned_amount)
             values ('${BUDGET}', 'unmapped', 1);
           rollback;`)),
  );
  check(
    "어휘 밖의 카테고리를 막는다 (오타 하나가 새 카테고리를 만들지 않는다)",
    rejectedWith(/budget_items_category_vocab|check constraint/, () =>
      sql(`begin;
           ${budgetFixture}
           insert into public.budget_items (budget_id, category, planned_amount)
             values ('${BUDGET}', 'hall2', 1);
           rollback;`)),
  );
  check(
    "지출도 같은 어휘를 쓴다",
    rejectedWith(/expenses_category_vocab|check constraint/, () =>
      sql(`begin;
           insert into public.expenses (couple_id, category, amount)
             values ('${coupleId}', 'unmapped', 1);
           rollback;`)),
  );
  check(
    "음수 금액을 막는다",
    rejectedWith(/check constraint|planned_amount/, () =>
      sql(`begin;
           ${budgetFixture}
           insert into public.budget_items (budget_id, category, planned_amount)
             values ('${BUDGET}', 'meal', -1);
           rollback;`)),
  );

  // 코드↔DB 어휘 대조. **사본은 어긋나고 어긋나면 조용하다**(검출 룰 S7-01 과 같은 구조).
  {
    const budgetSrc = readFileSync("lib/core/schemas/estimate.ts", "utf8");
    // **배열 블록만 읽는다.** 파일 전체를 훑으면 라벨표의 따옴표까지 걸려 수가 부푼다.
    const block = (budgetSrc.match(/ESTIMATE_CATEGORIES = \[([\s\S]*?)\] as const/) ?? ["", ""])[1];
    const estimateCodes = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    const expected = estimateCodes.filter((code) => code !== "unmapped");

    check(
      "**코드의 예산 카테고리와 DB 어휘가 같다** (견적 카테고리 - unmapped)",
      expected.length > 0 &&
        expected.every((code) => sql(`select public.is_budget_category('${code}');`) === "t") &&
        sql(`select public.is_budget_category('unmapped');`) === "f",
      `code=${expected.length}`,
    );
  }

  // ── 계약 자동 반영 (0045 `budget_contracted`) ─────────────────────────────
  // **업체 행을 못 읽어도 카테고리가 흔들리지 않아야 한다.** 임베드로 읽던 시절에는
  // 커플이 vendors 를 못 읽으면 계약이 통째로 `etc` 로 떨어졌다(흐름 점검이 잡았다).
  check(
    "계약 분류 함수가 SECURITY DEFINER 다 — 업체 노출이 바뀌어도 카테고리가 안 움직인다",
    sql(`select prosecdef from pg_proc where proname = 'budget_contracted';`) === "t",
  );
  check(
    "**함수 안에 권한 검사가 있다** — 없으면 아무 커플 id 로 남의 계약을 셀 수 있다",
    (() => {
      const src = sql(`select pg_get_functiondef('public.budget_contracted(uuid)'::regprocedure);`);

      return src.includes("is_couple_member") && src.includes("has_planner_scope");
    })(),
  );
  check(
    "**남의 커플 id 를 넣어도 아무것도 세지 않는다**",
    asUser(
      outsider,
      `select coalesce(sum(contracted), 0) from public.budget_contracted('${coupleId}');`,
    ) === "0",
  );
  check(
    "비로그인은 함수를 부를 수 없다",
    rejectedWith(/permission denied/i, () =>
      asAnon(`select count(*) from public.budget_contracted('${coupleId}');`)),
  );
  {
    // 코드↔DB 매핑 대조. **사본은 어긋나고 어긋나면 조용하다.**
    const budgetCoreSrc = readFileSync("lib/core/budget/budget.ts", "utf8");
    const block = (budgetCoreSrc.match(
      /VENDOR_TO_BUDGET_CATEGORY: Record<string, BudgetCategory> = \{([\s\S]*?)\}/,
    ) ?? ["", ""])[1];
    const pairs = [...block.matchAll(/(\w+):\s*"([a-z]+)"/g)].map((m) => [m[1], m[2]]);
    // **정렬 공백을 지우고 견준다.** SQL 쪽은 `when 'dress'  then` 처럼 칸을 맞춰
    // 적어 두었는데, 공백 수까지 맞추라고 하면 서식만 손봐도 검사가 깨진다.
    const fnSrc = sql(`select pg_get_functiondef('public.budget_contracted(uuid)'::regprocedure);`)
      .replace(/\s+/g, " ");

    check(
      "**코드의 업체→예산 카테고리 표와 DB 함수가 같다**",
      pairs.length > 0 &&
        pairs.every(([vendor, budget]) =>
          vendor === "agency"
            ? // 에이전시는 `else 'etc'` 로 떨어진다 — 함수에 자기 줄이 없다.
              !fnSrc.includes(`when 'agency'`) && fnSrc.includes(`else 'etc'`)
            : fnSrc.includes(`when '${vendor}' then '${budget}'`),
        ),
      `pairs=${pairs.length}`,
    );
  }

  check(
    "**총예산은 couples.total_budget 이 진실이다** — nullable 이라 '미정'을 표현한다",
    sql(`select is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = 'couples'
             and column_name = 'total_budget';`) === "YES",
  );
  check(
    "`budgets.total_amount` 는 쓰지 않는다 — not null default 0 이라 '미정'이 없다",
    sql(`select is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = 'budgets'
             and column_name = 'total_amount';`) === "NO",
  );
  check(
    "지출은 계획 줄이 사라져도 카테고리를 잃지 않는다 (expenses.category not null)",
    sql(`select is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = 'expenses'
             and column_name = 'category';`) === "NO",
  );
}

// ── 위약금 시뮬레이터 (S7-04 · F-C-08 · §3.5 · §5.3 · §7.7) ──────────────────
// 계산은 순수 함수라 DB 가 볼 것이 없다. 여기서 확인할 것은 둘이다 —
// (가) **저장한 계산이 커플 밖으로 새지 않는가** (나) **기준을 시드하지 않았다는 사실**
// 이 그대로인가(0031 근거 6 — 법무 검수 전 수치를 DB 에 넣으면 운영 기준처럼 굳는다).
{
  const SIM = "00000000-0000-0000-0000-0000000000f1";
  const FOREIGN_SIM = "00000000-0000-0000-0000-0000000000f2";
  const FOREIGN_COUPLE_P = "00000000-0000-0000-0000-0000000000f3";

  const simFixture = `
    insert into public.penalty_simulations
      (id, couple_id, inputs_json, standard_amount, contract_amount, excess_amount, rule_version)
      values ('${SIM}', '${coupleId}',
              '{"category":"hall","totalAmount":30000000}'::jsonb,
              3000000, 6000000, 3000000, '2026.8-draft');
  `;

  const foreignSimFixture = `
    insert into public.couples (id, owner_id, stage)
      values ('${FOREIGN_COUPLE_P}', '${outsider}', 'onboarding');
    insert into public.penalty_simulations
      (id, couple_id, inputs_json, standard_amount, contract_amount, excess_amount, rule_version)
      values ('${FOREIGN_SIM}', '${FOREIGN_COUPLE_P}', '{}'::jsonb, 1, 2, 1, 'x');
  `;

  // **픽스처가 넣은 행만 센다.** 이 표에는 흐름 점검이 남긴 행이 있을 수 있고,
  // 전체 개수를 세면 검사가 "언제 돌리느냐" 에 좌우된다.
  check(
    "당사자는 자기 계산을 본다",
    asUser(
      owner,
      `select count(*) from public.penalty_simulations where id in ('${SIM}', '${FOREIGN_SIM}');`,
      simFixture,
    ) === "1",
  );
  check(
    "배우자도 같은 계산을 본다 (커플 공유 · D-19)",
    asUser(
      partner,
      `select count(*) from public.penalty_simulations where id = '${SIM}';`,
      simFixture,
    ) === "1",
  );
  check(
    "**남의 계산은 보이지 않는다**",
    asUser(
      owner,
      `select count(*) from public.penalty_simulations where id = '${FOREIGN_SIM}';`,
      `${simFixture}${foreignSimFixture}`,
    ) === "0",
  );
  check(
    "비로그인은 계산을 못 본다",
    asAnon(`select count(*) from public.penalty_simulations;`, simFixture) === "0",
  );
  check(
    "**남의 계산도 비로그인에게 보이지 않는다**",
    asAnon(
      `select count(*) from public.penalty_simulations;`,
      `${simFixture}${foreignSimFixture}`,
    ) === "0",
  );
  check(
    "**남의 커플에 계산을 끼워 넣을 수 없다**",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.penalty_simulations (couple_id, inputs_json)
         values ('${FOREIGN_COUPLE_P}', '{}'::jsonb);`, `${simFixture}${foreignSimFixture}`)),
  );
  check(
    "**남의 계산을 지울 수 없다**",
    asUser(
      outsider,
      `with d as (delete from public.penalty_simulations where id = '${SIM}' returning id)
       select count(*) from d;`,
      simFixture,
    ) === "0",
  );
  check(
    "**계산을 고칠 수는 없다** — 저장한 값은 그때의 기준으로 낸 스냅샷이다(D-16 과 같은 이유)",
    asUser(
      owner,
      `with u as (update public.penalty_simulations set standard_amount = 1
                  where id = '${SIM}' returning id)
       select count(*) from u;`,
      simFixture,
    ) === "0",
  );

  // ── 기준을 시드하지 않았다 (0031 근거 6) ──────────────────────────────────
  check(
    "**`penalty_rules` 를 시드하지 않았다** — 법무 검수 전 수치가 운영 기준처럼 굳지 않게",
    sql(`select count(*) from public.penalty_rules;`) === "0",
  );
  check(
    "기준 표는 밴드 구조를 갖고 있다 (행이 들어오면 코드 변경 없이 전환된다)",
    sql(`select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'penalty_rules'
             and column_name in ('min_days_before_event', 'max_days_before_event',
                                 'rate_bp', 'refund_deposit', 'is_draft');`) === "5",
  );
  check(
    "요율은 정수 bp 다 — 부동소수점을 쓰지 않는다",
    sql(`select data_type from information_schema.columns
           where table_schema = 'public' and table_name = 'penalty_rules'
             and column_name = 'rate_bp';`) === "integer",
  );

  // 코드↔화면 대조. **가정치라는 사실이 화면까지 가야 한다**(§7.7).
  {
    const viewSrc = readFileSync("lib/core/pricing/penalty-view.ts", "utf8");
    // **주석을 걷어내고 본다.** 주석에는 "‘과도한 조항’ 같은 말은 쓰지 않는다" 처럼
    // 금지어를 설명하는 문장이 있고, 그것까지 걸면 규칙을 적어 둔 것이 위반이 된다.
    const viewCode = viewSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    check(
      "**기준 미설정을 '0원' 으로 말하지 않는다** — 화면 문구가 그것을 보장한다",
      viewCode.includes("등록되지 않았") && !/headline:\s*"[^"]*0원/.test(viewCode),
    );
    check(
      "**평가어를 문구에 넣지 않았다**(CLAUDE.md §2.3 — 사실과 편차로만)",
      ["과도", "부당", "불리", "악성", "심각"].every((word) => !viewCode.includes(word)),
    );
  }
}

// ── 만료형 공유 링크 (S7-12 · F-C-20 · §3.7 · §4.2 · 0046) ───────────────────
// 확인할 것 셋 — (가) **표가 정책 없는 서비스롤 전용으로 남아 있는가**(0005 [61]),
// (나) **여는 함수가 만료·거둠을 실제로 막는가**(토큰이 곧 권한이라 RLS 로 표현할 수
// 없다), (다) **열람 수가 살아 있는 링크에서만 오르는가**.
{
  const LIVE = "00000000-0000-0000-0000-0000000000a1";
  const EXPIRED = "00000000-0000-0000-0000-0000000000a2";
  const REVOKED = "00000000-0000-0000-0000-0000000000a3";
  const RES = "00000000-0000-0000-0000-0000000000a4";

  const linkFixture = `
    insert into public.share_links (id, resource_type, resource_id, token, expires_at, revoked_at)
      values ('${LIVE}',    'report', '${RES}', 'tok-live',    now() + interval '7 days', null),
             ('${EXPIRED}', 'report', '${RES}', 'tok-expired', now() - interval '1 hour', null),
             ('${REVOKED}', 'report', '${RES}', 'tok-revoked', now() + interval '7 days', now());
  `;

  check(
    "**공유 링크 표에 정책이 없다** — 토큰 대조는 서버에서만 한다 (0005 [61])",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'share_links';`) === "0",
  );
  check(
    "RLS 는 켜져 있다 (정책이 없으므로 아무도 못 읽는다)",
    sql(`select relrowsecurity from pg_class where relname = 'share_links';`) === "t",
  );
  check(
    "**당사자도 표를 직접 읽지 못한다** — 토큰을 훑어볼 경로를 열지 않는다",
    asUser(owner, `select count(*) from public.share_links;`, linkFixture) === "0",
  );
  check(
    "비로그인도 못 읽는다",
    asAnon(`select count(*) from public.share_links;`, linkFixture) === "0",
  );
  check(
    "**표에 직접 쓸 수도 없다** — 발급은 서버가 판정한 뒤에만 한다",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(owner, `insert into public.share_links (resource_type, resource_id, token, expires_at)
         values ('report', '${RES}', 'tok-x', now() + interval '1 day');`)),
  );

  // ── 여는 함수 (0046) ──────────────────────────────────────────────────────
  check(
    "여는 함수가 SECURITY DEFINER 다 — 토큰이 곧 권한이라 RLS 로 표현할 수 없다",
    sql(`select prosecdef from pg_proc where proname = 'share_link_open';`) === "t",
  );
  check(
    "**비로그인이 살아 있는 링크를 연다**",
    asAnon(
      `select resource_id from public.share_link_open('tok-live');`,
      linkFixture,
    ) === RES,
  );
  check(
    "**만료된 링크도 행은 나오되 만료 시각이 지나 있다** — 판정 문장은 코드가 갖는다",
    (() => {
      const value = asAnon(
        `select (expires_at < now()) from public.share_link_open('tok-expired');`,
        linkFixture,
      );

      return value === "t";
    })(),
  );
  check(
    "거둔 링크는 `revoked_at` 이 채워져 나온다",
    asAnon(
      `select (revoked_at is not null) from public.share_link_open('tok-revoked');`,
      linkFixture,
    ) === "t",
  );
  check(
    "**없는 토큰은 아무 행도 내지 않는다** — 만료와 구분된다",
    asAnon(`select count(*) from public.share_link_open('없는토큰');`, linkFixture) === "0",
  );

  check(
    "**살아 있는 링크만 열람 수가 오른다**",
    // psql 은 여러 select 의 출력을 줄로 이어 준다. **마지막 줄**이 궁금한 값이다.
    sql(`begin;
         ${linkFixture}
         select count(*) from public.share_link_open('tok-live');
         select view_count from public.share_links where id = '${LIVE}';
         rollback;`)
      .trim()
      .split("\n")
      .at(-1)
      ?.trim() === "1",
  );
  check(
    "**만료·거둠 요청은 세지 않는다** — 열리지 않은 링크가 열린 것으로 세어지면 안 된다",
    sql(`begin;
         ${linkFixture}
         select count(*) from public.share_link_open('tok-expired');
         select count(*) from public.share_link_open('tok-revoked');
         select coalesce(sum(view_count), 0) from public.share_links
           where id in ('${EXPIRED}', '${REVOKED}');
         rollback;`)
      .trim()
      .split("\n")
      .at(-1) === "0",
  );

  // ── 어휘·파라미터 ─────────────────────────────────────────────────────────
  check(
    "**어휘 밖의 자원 유형을 막는다** — 오타 하나가 영영 열리지 않는 링크를 만든다",
    rejectedWith(/share_links_resource_type_vocab|check constraint/, () =>
      sql(`begin;
           insert into public.share_links (resource_type, resource_id, token, expires_at)
             values ('cart', '${RES}', 'tok-bad', now() + interval '1 day');
           rollback;`)),
  );
  check(
    "공유 기한이 파라미터로 있다 (§7.4)",
    sql(`select value_json->>'hours' from public.app_settings
           where key = 'share.link_ttl_hours';`) === "168",
  );
  check(
    "**기한 파라미터도 사용자에게 보이지 않는다** — 정책이 없어 0행으로 온다",
    asUser(owner, `select count(*) from public.app_settings
                     where key = 'share.link_ttl_hours';`) === "0",
  );

  // 코드↔DB 어휘 대조. **사본은 어긋나고 어긋나면 조용하다.**
  {
    const shareSrc = readFileSync("lib/core/share/share.ts", "utf8");
    const types = [...shareSrc.matchAll(/type: "([a-z_]+)"/g)].map((m) => m[1]);

    check(
      "**코드의 자원 유형과 DB 어휘가 같다**",
      types.length > 0 &&
        types.every((type) => sql(`select public.is_share_resource_type('${type}');`) === "t") &&
        sql(`select public.is_share_resource_type('cart');`) === "f",
      `code=${types.join("|")}`,
    );
  }
}

// ── 견적 정규화·비교 (S7-05 · F-C-06 · §3.5 · §5.4 · 0047) ───────────────────
// 확인할 것 셋 — (가) **원천 조회 함수가 커플을 막는가**(업체 이름·카테고리를 임베드로
// 읽지 않기 위해 SECURITY DEFINER 로 옮겼다 · S7-07 계열), (나) **저장한 비교표가 커플
// 밖으로 새지 않는가**, (다) **스냅샷을 고칠 수 없는가**(고칠 수 있으면 "그때 무엇을
// 견줬나" 를 답할 수 없다).
{
  const CMP = "00000000-0000-0000-0000-0000000000c1";
  const CMP_OTHER = "00000000-0000-0000-0000-0000000000c2";
  const CMP_COUPLE = "00000000-0000-0000-0000-0000000000c3";
  const Q1 = "00000000-0000-0000-0000-0000000000c4";
  const Q2 = "00000000-0000-0000-0000-0000000000c5";

  const cmpFixture = `
    insert into public.estimate_comparisons (id, couple_id, upload_ids, normalized_json)
      values ('${CMP}', '${coupleId}', array['${Q1}', '${Q2}']::uuid[], '{"estimates":[],"comparison":{}}'::jsonb);
  `;

  const cmpForeignFixture = `
    insert into public.couples (id, owner_id, stage)
      values ('${CMP_COUPLE}', '${outsider}', 'onboarding');
    insert into public.estimate_comparisons (id, couple_id, upload_ids, normalized_json)
      values ('${CMP_OTHER}', '${CMP_COUPLE}', array['${Q1}', '${Q2}']::uuid[], '{}'::jsonb);
  `;

  check(
    "당사자는 자기 비교표를 본다",
    asUser(
      owner,
      `select count(*) from public.estimate_comparisons where id = '${CMP}';`,
      cmpFixture,
    ) === "1",
  );
  check(
    "배우자도 같은 비교표를 본다 (커플 공유 · D-19)",
    asUser(
      partner,
      `select count(*) from public.estimate_comparisons where id = '${CMP}';`,
      cmpFixture,
    ) === "1",
  );
  check(
    "**남의 비교표는 보이지 않는다**",
    asUser(
      owner,
      `select count(*) from public.estimate_comparisons where id = '${CMP_OTHER}';`,
      `${cmpFixture}${cmpForeignFixture}`,
    ) === "0",
  );
  check(
    "비로그인은 비교표를 못 본다",
    asAnon(`select count(*) from public.estimate_comparisons;`, cmpFixture) === "0",
  );
  check(
    "**남의 커플에 비교표를 끼워 넣을 수 없다**",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.estimate_comparisons (couple_id, upload_ids)
         values ('${CMP_COUPLE}', array['${Q1}', '${Q2}']::uuid[]);`, `${cmpFixture}${cmpForeignFixture}`)),
  );
  check(
    "**스냅샷을 고칠 수 없다** — 고치면 '그때 무엇을 견줬나' 를 답할 수 없다(D-16·D-23)",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(owner, `update public.estimate_comparisons set normalized_json = '{}'::jsonb
         where id = '${CMP}';`, cmpFixture)),
  );
  check(
    "내 것은 내가 치운다",
    asUser(
      owner,
      `with d as (delete from public.estimate_comparisons where id = '${CMP}' returning id)
       select count(*) from d;`,
      cmpFixture,
    ) === "1",
  );
  check(
    "**남의 것은 치울 수 없다**",
    asUser(
      outsider,
      `with d as (delete from public.estimate_comparisons where id = '${CMP}' returning id)
       select count(*) from d;`,
      cmpFixture,
    ) === "0",
  );

  // ── 2~5개 (§2.1) ──────────────────────────────────────────────────────────
  check(
    "**하나만 담은 비교표를 막는다** — 견줄 대상이 없다",
    rejectedWith(/estimate_comparisons_count_chk|check constraint/, () =>
      sql(`begin;
           insert into public.estimate_comparisons (couple_id, upload_ids)
             values ('${coupleId}', array['${Q1}']::uuid[]);
           rollback;`)),
  );
  check(
    "**여섯 개도 막는다**",
    rejectedWith(/estimate_comparisons_count_chk|check constraint/, () =>
      sql(`begin;
           insert into public.estimate_comparisons (couple_id, upload_ids)
             values ('${coupleId}', array['${Q1}','${Q2}','${Q1}','${Q2}','${Q1}','${Q2}']::uuid[]);
           rollback;`)),
  );

  // ── 원천 조회 함수 (0047) ─────────────────────────────────────────────────
  check(
    "원천 조회가 SECURITY DEFINER 다 — 업체 행이 안 보여도 카테고리를 잃지 않는다",
    sql(`select prosecdef from pg_proc where proname = 'estimate_quote_sources';`) === "t",
  );
  check(
    "**함수 안에 권한 검사가 있다** — 없으면 아무 커플 id 로 남의 견적을 읽을 수 있다",
    sql(`select pg_get_functiondef('public.estimate_quote_sources(uuid, uuid[])'::regprocedure);`)
      .includes("is_couple_member"),
  );
  check(
    "**보낸 견적만 낸다** — 초안은 고객에게 있는 값이 아니다",
    sql(`select pg_get_functiondef('public.estimate_quote_sources(uuid, uuid[])'::regprocedure);`)
      .replace(/\s+/g, " ")
      .includes("q.status = 'sent'"),
  );
  check(
    "**남의 커플 id 를 넣어도 아무것도 나오지 않는다**",
    asUser(
      outsider,
      `select count(*) from public.estimate_quote_sources('${coupleId}', null);`,
    ) === "0",
  );
  check(
    "비로그인은 함수를 부를 수 없다",
    rejectedWith(/permission denied/i, () =>
      asAnon(`select count(*) from public.estimate_quote_sources('${coupleId}', null);`)),
  );

  // 코드↔코드 대조. **견적과 예산이 같은 카테고리 표를 쓴다.**
  {
    const estimateSrc = readFileSync("lib/core/estimate/normalize.ts", "utf8");

    check(
      "**견적 매핑이 예산 표를 그대로 참조한다** — 사본을 만들면 사본이 어긋난다",
      estimateSrc.includes("VENDOR_TO_ESTIMATE_CATEGORY = VENDOR_TO_BUDGET_CATEGORY"),
    );
    check(
      "**업로드·파싱 표를 쓰지 않는다**(D-56 — PDF 파서·OCR 은 새 의존성이다)",
      !estimateSrc.includes("estimate_uploads") &&
        !readFileSync("lib/estimates/loader.ts", "utf8").includes("estimate_uploads"),
    );
  }

  check(
    "공유 레지스트리가 비교표를 연다 (S7-12 의 대기가 풀렸다)",
    readFileSync("lib/core/share/share.ts", "utf8")
      .replace(/\s+/g, " ")
      .includes('type: "estimate_comparison", label: "견적 비교표",'),
  );
}

// ── 멤버십 구독 (S7-11 · F-C-19 · §3.1 · 0048) ──────────────────────────────
// 확인할 것 넷 — (가) **남의 등급을 볼 수 없는가**, (나) **등급을 스스로 올릴 수
// 없는가**(여기가 뚫리면 결제 없이 AI 턴 상한이 풀린다 · §5.6), (다) **한 사람에
// 구독이 하나인가**, (라) **결제 이력을 고칠 수 없는가**.
//
// **전체 개수를 세지 않는다.** 픽스처 id 로 좁힌다 — 흐름 점검이 남긴 행이 개수를
// 흔들면 시험이 사실과 무관하게 깨진다(S7-04·S7-12 에서 겪었다).
{
  const MB = "00000000-0000-0000-0000-0000000000d1";
  const MB_OTHER = "00000000-0000-0000-0000-0000000000d2";
  const PAY = "00000000-0000-0000-0000-0000000000d3";

  // 0048 이 사용자당 유니크를 걸었으므로 **있던 행을 치운 뒤** 픽스처를 심는다.
  const mbFixture = `
    delete from public.memberships where user_id in ('${owner}', '${outsider}');
    insert into public.memberships (id, user_id, plan, status, started_at, expires_at, source)
      values ('${MB}', '${owner}', 'premium', 'active', now() - interval '1 day', now() + interval '29 days', 'stub');
    insert into public.memberships (id, user_id, plan, status, started_at, expires_at, source)
      values ('${MB_OTHER}', '${outsider}', 'premium', 'active', now() - interval '1 day', now() + interval '29 days', 'stub');
    insert into public.subscription_payments (id, membership_id, amount, billing_cycle, status)
      values ('${PAY}', '${MB}', 9900, 'monthly', 'paid');
  `;

  // `sql()` 은 setup 인자를 받지 않는다 — **픽스처를 같은 트랜잭션에 함께 넣어야**
  // CHECK 위반을 볼 수 있다. 안 그러면 대상 행이 없어 0행 갱신이 되고, 그러면
  // "거절되지 않았다" 가 아니라 **아무 일도 안 일어난 것**이 통과로 둔갑한다.
  const withFixture = (body) => `begin;\n${mbFixture}\n${body}\nrollback;`;
  check(
    "본인 구독은 본인이 본다",
    asUser(owner, `select count(*) from public.memberships where id = '${MB}';`, mbFixture) === "1",
  );
  check(
    "**남의 구독은 보이지 않는다** — 등급은 남에게 답할 값이 아니다",
    asUser(owner, `select count(*) from public.memberships where id = '${MB_OTHER}';`, mbFixture) === "0",
  );
  check(
    "비로그인은 구독을 보지 못한다",
    asAnon(`select count(*) from public.memberships;`, mbFixture) === "0",
  );

  // **여기가 이 태스크에서 가장 위험한 자리다.** UPDATE 정책이 없으므로 0행이 되고
  // 오류가 나지 않는다 — 그래서 "바뀌었는가" 를 값으로 확인한다.
  check(
    "**등급을 스스로 올릴 수 없다** — 뚫리면 결제 없이 AI 턴 상한이 풀린다(§5.6)",
    asUser(
      owner,
      `update public.memberships set expires_at = now() + interval '999 days' where id = '${MB}';
       select expires_at < now() + interval '30 days' from public.memberships where id = '${MB}';`,
      mbFixture,
    ) === "t",
  );
  check(
    "**해지도 스스로 적지 못한다** — 상태 전이는 서버가 정한다",
    asUser(
      owner,
      `update public.memberships set status = 'canceled' where id = '${MB}';
       select status from public.memberships where id = '${MB}';`,
      mbFixture,
    ) === "active",
  );
  check(
    "**남의 구독을 지우지 못한다**",
    asUser(
      owner,
      `with d as (delete from public.memberships where id = '${MB_OTHER}' returning id)
       select count(*) from d;`,
      mbFixture,
    ) === "0",
  );

  check(
    "**한 사람에 구독은 하나다** — 재시도·웹훅 재전송이 행을 늘리면 등급이 갈린다",
    rejectedWith(/uq_memberships_user|duplicate key/, () =>
      sql(withFixture(`insert into public.memberships (user_id, plan, status, started_at)
           values ('${owner}', 'premium', 'active', now());`))),
  );
  check(
    "**어휘 밖 상태를 넣지 못한다** — `cancelled` 오타 하나가 활성으로 읽힌다",
    rejectedWith(/memberships_status_vocab|check constraint/, () =>
      sql(withFixture(`update public.memberships set status = 'cancelled' where id = '${MB}';`))),
  );
  check(
    "**유료 구독에는 시작 시각이 있다**",
    rejectedWith(/memberships_premium_started_chk|check constraint/, () =>
      sql(withFixture(`update public.memberships set started_at = null where id = '${MB}';`))),
  );

  check(
    "본인 결제 이력은 본인이 본다",
    asUser(owner, `select count(*) from public.subscription_payments where id = '${PAY}';`, mbFixture) === "1",
  );
  check(
    "**남의 결제 이력은 보이지 않는다**",
    asUser(outsider, `select count(*) from public.subscription_payments where id = '${PAY}';`, mbFixture) === "0",
  );
  check(
    "**결제 이력을 고칠 수 없다**(0048 이 UPDATE 를 회수했다) — 고치면 얼마를 언제 받았는지 답할 수 없다",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `update public.subscription_payments set amount = 0 where id = '${PAY}';`, mbFixture)),
  );
  // INSERT 는 정책이 없으면 **조용히 0행이 아니라 오류**다 — 그래서 여기는
  // `rejectedWith` 로 본다(UPDATE 와 다르다).
  check(
    "**결제 이력을 스스로 쓰지 못한다** — 받지 않은 돈이 장부에 남는다",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        outsider,
        `insert into public.subscription_payments (membership_id, amount, billing_cycle, status)
           values ('${MB_OTHER}', 1, 'monthly', 'paid');`,
        mbFixture,
      )),
  );

  // 파라미터 자리. **가격은 값이 비어 있어야 한다**(O-17).
  check(
    "**멤버십 가격은 값이 비어 있다** — 정해진 적이 없다(O-17). 0으로도 채우지 않는다",
    sql(`select value_json->>'value' is null from public.app_settings where key = 'membership.monthly_price';`) === "t",
  );
  check(
    "구독 주기는 값이 있다 — 없으면 만료 시각을 만들 수 없어 기능이 서지 않는다",
    sql(`select (value_json->>'value')::int > 0 from public.app_settings where key = 'membership.period_days';`) === "t",
  );

  // 코드↔DB 어휘 대조.
  {
    const membershipSrc = readFileSync("lib/core/membership/membership.ts", "utf8");
    const statuses = [...membershipSrc.matchAll(/MEMBERSHIP_STATUSES = \[([^\]]+)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));

    check(
      "**코드의 상태 어휘와 DB 어휘가 같다**",
      statuses.length === 3 &&
        statuses.every((status) => sql(`select public.is_membership_status('${status}');`) === "t") &&
        sql(`select public.is_membership_status('cancelled');`) === "f",
      `code=${statuses.join("|")}`,
    );
    check(
      "**등급 판정 컬럼을 만들지 않았다** — 등급은 계산값이다",
      sql(`select count(*) from information_schema.columns
            where table_name = 'memberships' and column_name = 'effective_plan';`) === "0",
    );
    check(
      "**AI 턴 상한이 같은 어휘를 쓴다**(S7-20 의 member 를 premium 으로 맞췄다)",
      readFileSync("lib/core/ai/limits.ts", "utf8").includes('MEMBERSHIP_TIERS = ["free", "premium"]'),
    );
    check(
      "**플래너가 등급을 지어내지 않는다** — 저장값이 아니라 계산값을 본다",
      readFileSync("app/api/ai/planner/route.ts", "utf8").includes("loadMembership"),
    );
  }
}

// ── SEO 콘텐츠 허브 (S7-10 · F-C-24 · §3.7 · 0049) ──────────────────────────
// 확인할 것 넷 — (가) **미발행·예약 글이 새지 않는가**(공개 화면이라 이것이 유일한
// 경계다), (나) **누구도 글을 쓰거나 고칠 수 없는가**(발행은 서비스롤), (다) **빈
// 페이지가 발행될 수 없는가**(제목만 있는 페이지가 색인되면 되돌리기 어렵다),
// (라) **슬러그 규칙이 코드와 DB 에서 같은가**.
//
// **전체 개수를 세지 않는다.** 픽스처 slug 로 좁힌다 — 흐름 점검이 남긴 행이 개수를
// 흔들면 시험이 사실과 무관하게 깨진다(S7-04·S7-12·S7-11 에서 겪었다).
{
  const LIVE = "rls-check-published";
  const DRAFT = "rls-check-draft";
  const FUTURE = "rls-check-scheduled";

  // **픽스처를 같은 트랜잭션에 넣는다.** 안 그러면 대상 행이 없어 0행 갱신이 되고,
  // "거절되지 않았다" 가 아니라 **아무 일도 안 일어난 것**이 통과로 둔갑한다(S7-11).
  const contentFixture = `
    delete from public.content_posts where slug in ('${LIVE}', '${DRAFT}', '${FUTURE}');
    insert into public.content_posts (slug, type, title, body_md, seo_json, published_at) values
      ('${LIVE}', 'guide', '발행됨', '본문이 있다.', '{"tools":["penalty"]}'::jsonb, now() - interval '1 day'),
      ('${DRAFT}', 'guide', '미발행', '본문이 있다.', '{}'::jsonb, null),
      ('${FUTURE}', 'guide', '예약', '본문이 있다.', '{}'::jsonb, now() + interval '7 days');
  `;

  const withFixture = (body) => `begin;\n${contentFixture}\n${body}\nrollback;`;

  check(
    "비로그인도 발행된 글을 본다 (SEO 화면이다)",
    asAnon(`select count(*) from public.content_posts where slug = '${LIVE}';`, contentFixture) === "1",
  );
  check(
    "**미발행 글은 비로그인에게 보이지 않는다**",
    asAnon(`select count(*) from public.content_posts where slug = '${DRAFT}';`, contentFixture) === "0",
  );
  check(
    "**발행 예약(미래)도 보이지 않는다** — 예약이 예약 노릇을 한다",
    asAnon(`select count(*) from public.content_posts where slug = '${FUTURE}';`, contentFixture) === "0",
  );
  check(
    "**로그인해도 미발행 글은 보이지 않는다** — 콘텐츠는 등급으로 갈리는 값이 아니다",
    asUser(owner, `select count(*) from public.content_posts where slug in ('${DRAFT}', '${FUTURE}');`, contentFixture) === "0",
  );

  check(
    "**아무도 글을 쓰지 못한다** — 발행은 서비스롤이다(F-A-05 는 8단계)",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        owner,
        `insert into public.content_posts (slug, type, title, body_md)
           values ('rls-check-intruder', 'guide', '남이 쓴 글', '본문');`,
        contentFixture,
      )),
  );
  check(
    // **S8-08 이 0행에서 거절로 바꿨다.** 정책이 없어 UPDATE 가 조용히 0행을
    // 돌려주던 것이 0060 의 권한 회수 뒤로는 문장 자체가 끊긴다. 0행은
    // "아무것도 안 바뀌었다" 이고 거절은 "쓸 수 없다" 인데, 공개 콘텐츠에서
    // 필요한 것은 뒤쪽이다.
    "**발행된 글을 고치지 못한다** — 공개 페이지의 내용은 로그인 사용자가 바꿀 것이 아니다",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        owner,
        `update public.content_posts set title = '바뀐 제목' where slug = '${LIVE}';`,
        contentFixture,
      ),
    ),
  );
  check(
    // S8-08 이 여기도 같은 이유로 바꿨다. 게다가 이제는 **누구에게도** DELETE 가
    // 없다 — 지우는 대신 내린다(D-138 · 색인된 URL 이 죽으면 되돌릴 수 없다).
    "**글을 지우지 못한다**",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        owner,
        `delete from public.content_posts where slug = '${LIVE}';`,
        contentFixture,
      ),
    ),
  );

  // ── 불변식 ────────────────────────────────────────────────────────────────
  check(
    "**본문 없이 발행할 수 없다** — 제목만 있는 페이지가 색인되면 되돌리기 어렵다(S3-10)",
    rejectedWith(/content_posts_published_body_chk|check constraint/, () =>
      sql(withFixture(`update public.content_posts set body_md = '   ' where slug = '${LIVE}';`))),
  );
  check(
    "미발행 글은 본문이 비어도 된다 (초안이다)",
    sql(withFixture(`update public.content_posts set body_md = null where slug = '${DRAFT}';
                     select count(*) from public.content_posts where slug = '${DRAFT}';`)).trim().endsWith("1"),
  );
  check(
    "**슬래시가 든 슬러그를 넣지 못한다** — 경로 조작이 통하는 모양을 만들지 않는다",
    rejectedWith(/content_posts_slug_format_chk|check constraint/, () =>
      sql(withFixture(`update public.content_posts set slug = '../etc/passwd' where slug = '${DRAFT}';`))),
  );
  check(
    "**한글 슬러그를 넣지 못한다** — URL 이 공유될 때 깨져 보인다",
    rejectedWith(/content_posts_slug_format_chk|check constraint/, () =>
      sql(withFixture(`update public.content_posts set slug = '웨딩홀-가이드' where slug = '${DRAFT}';`))),
  );
  check(
    "**seo_json 이 객체가 아니면 막는다** — 파서가 조용히 기본값으로 읽어 메타가 사라진다",
    rejectedWith(/content_posts_seo_object_chk|check constraint/, () =>
      sql(withFixture(`update public.content_posts set seo_json = '[]'::jsonb where slug = '${DRAFT}';`))),
  );

  // ── 조회 함수 ─────────────────────────────────────────────────────────────
  check(
    "**발행 목록 함수는 security invoker 다** — definer 로 두면 미발행 글이 샐 경로를 스스로 만든다",
    !sql(`select pg_get_functiondef('public.published_content(public.content_post_type)'::regprocedure);`)
      .includes("SECURITY DEFINER"),
  );
  check(
    "비로그인도 함수를 부를 수 있다 (공개 화면이 쓴다)",
    asAnon(`select count(*) from public.published_content(null) where slug = '${LIVE}';`, contentFixture) === "1",
  );
  check(
    "**함수로도 미발행 글이 나오지 않는다**",
    asAnon(`select count(*) from public.published_content(null) where slug in ('${DRAFT}', '${FUTURE}');`, contentFixture) === "0",
  );
  check(
    "유형으로 좁힌다",
    asAnon(`select count(*) from public.published_content('glossary') where type <> 'glossary';`, contentFixture) === "0",
  );
  check(
    "**service_role 도 함수를 부를 수 있다** — revoke all from public 이 상속분을 걷어간 적이 있다(S7-12)",
    sql(`select has_function_privilege('service_role', 'public.published_content(public.content_post_type)', 'execute');`) === "t",
  );

  // ── 시드 콘텐츠 ───────────────────────────────────────────────────────────
  check(
    "**가격 리포트를 시드하지 않았다** — 참가격 표본이 부족하다(S3-08 · S8-10 대기)",
    sql(`select count(*) from public.content_posts where type = 'price_report';`) === "0",
  );
  check(
    "가이드·용어사전은 발행돼 있다",
    Number(sql(`select count(*) from public.published_content('guide');`)) >= 4 &&
      Number(sql(`select count(*) from public.published_content('glossary');`)) >= 3,
  );

  // ── 코드↔DB 대조 ──────────────────────────────────────────────────────────
  {
    const contentSrc = readFileSync("lib/core/content/content.ts", "utf8");

    const types = [...contentSrc.matchAll(/CONTENT_TYPES = \[([^\]]+)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));

    check(
      "**코드의 유형 어휘와 DB enum 이 같다**",
      types.length === 3 &&
        types.join("|") ===
          sql(`select string_agg(enumlabel, '|' order by enumsortorder)
                 from pg_enum where enumtypid = 'public.content_post_type'::regtype;`),
      `code=${types.join("|")}`,
    );

    // 슬러그 규칙은 코드와 DB 둘 다 갖는다 — **같은 값에 같은 답을 내는지** 본다.
    const samples = ["hall-guide", "guide2026", "웨딩홀", "a/b", "-앞", "두--하이픈", ""];
    const agree = samples.every((sample) => {
      const inDb = sql(`select public.is_content_slug($sample$${sample}$sample$);`) === "t";
      const inCode = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(sample) && sample.length > 0 && sample.length <= 80;

      return inDb === inCode;
    });

    check("**슬러그 규칙이 코드와 DB 에서 같은 답을 낸다**", agree);

    // 도구 CTA 는 **실재하는 라우트**여야 한다. 없는 화면을 가리키면 글이
    // "이런 도구가 있습니다" 라고 말하는데 눌러 보면 404 다.
    const hrefs = [...contentSrc.matchAll(/href: "(\/[^"]*)"/g)].map((m) => m[1]);
    const missing = hrefs.filter((href) => {
      const candidates = [
        `app/(consumer)${href}/page.tsx`,
        `app/(marketing)${href}/page.tsx`,
        `app${href}/page.tsx`,
      ];

      return !candidates.some((path) => existsSync(path));
    });

    check(
      "**CTA 가 가리키는 화면이 전부 실재한다** — 죽은 링크를 글에 심지 않는다",
      hrefs.length > 0 && missing.length === 0,
      `missing=${missing.join("|")}`,
    );

    // 시드 글이 지정한 도구 키도 레지스트리에 있어야 한다.
    const keys = [...contentSrc.matchAll(/key: "([a-z_]+)"/g)].map((m) => m[1]);
    const seeded = sql(`select coalesce(string_agg(distinct t, '|'), '')
                          from public.content_posts c,
                               lateral jsonb_array_elements_text(coalesce(c.seo_json->'tools', '[]'::jsonb)) t;`)
      .split("|")
      .filter((key) => key.length > 0);

    check(
      "**시드 글의 도구 키가 전부 레지스트리에 있다** — 없으면 CTA 가 조용히 사라진다",
      seeded.length > 0 && seeded.every((key) => keys.includes(key)),
      `seeded=${seeded.join("|")}`,
    );
  }

  // 사이트맵·상세가 같은 신선도 창을 쓰는지. 값이 갈리면 목록에는 있는데 상세는
  // 아직 옛 내용인 상태가 생긴다.
  {
    const windows = [
      "app/(marketing)/guides/page.tsx",
      "app/(marketing)/guides/[slug]/page.tsx",
    ].map((path) => /export const revalidate = (\d+)/.exec(readFileSync(path, "utf8"))?.[1]);

    check(
      "**두 콘텐츠 화면의 재생성 창이 같다**",
      windows[0] !== undefined && windows[0] === windows[1],
      `revalidate=${windows.join("|")}`,
    );
  }

  check(
    "사이트맵이 발행 목록을 **같은 함수**에서 가져온다 (판정이 둘로 갈리면 404 가 생긴다)",
    readFileSync("app/sitemap.ts", "utf8").includes("publishedSlugs") &&
      readFileSync("lib/content/loader.ts", "utf8").includes('rpc("published_content"'),
  );
}

// ── 컴플라이언스 자가 진단 (S7-13 · F-V-10 · 0050) ─────────────────────────
// **여기서 가장 위험한 것은 배지다.** 배지가 붙으면 고객이 그것을 신뢰의 근거로
// 삼으므로 (가) **스캔 없이 배지를 받을 수 없는가**, (나) **남의 진단 결과가 새지
// 않는가**, (다) **배지가 회수되는가**, (라) **소비자에게 findings 가 아니라 날짜만
// 가는가** 를 본다.
//
// **픽스처를 같은 트랜잭션에 붙인다.** 안 붙이면 대상 행이 없어 0행 갱신이 되고
// "아무 일도 안 일어난 것" 이 통과로 둔갑한다(S7-11 에서 겪었다).
{
  const CV = "00000000-0000-0000-0000-0000000000e1";
  const CV_OTHER = "00000000-0000-0000-0000-0000000000e2";
  const SCAN = "00000000-0000-0000-0000-0000000000e3";

  const vendorStaffId = vendorStaff ?? outsider;

  const cmplFixture = `
    delete from public.vendor_compliance_scans where vendor_id in ('${CV}', '${CV_OTHER}');
    delete from public.vendors where id in ('${CV}', '${CV_OTHER}');
    insert into public.vendors (id, name, category, status, biz_no_enc)
      values ('${CV}', 'rls-check-업체A', 'hall', 'active', 'rls-cmpl-a'),
             ('${CV_OTHER}', 'rls-check-업체B', 'hall', 'active', 'rls-cmpl-b');
    insert into public.vendor_members (vendor_id, user_id, vendor_role)
      values ('${CV}', '${vendorStaffId}', 'owner')
      on conflict do nothing;
    insert into public.vendor_compliance_scans (id, vendor_id, findings_json, rule_count)
      values ('${SCAN}', '${CV}', '[]'::jsonb, 20);
  `;

  const withFixture = (body) => `begin;\n${cmplFixture}\n${body}\nrollback;`;

  check(
    "업체 멤버는 자기 진단 결과를 본다",
    asUser(vendorStaffId, `select count(*) from public.vendor_compliance_scans where id = '${SCAN}';`, cmplFixture) === "1",
  );
  check(
    "**남의 업체 진단 결과는 보이지 않는다** — 고치는 중인 약관의 약점이 인용까지 들어 있다",
    asUser(owner, `select count(*) from public.vendor_compliance_scans where id = '${SCAN}';`, cmplFixture) === "0",
  );
  check(
    "**비로그인은 진단 결과를 보지 못한다**",
    asAnon(`select count(*) from public.vendor_compliance_scans;`, cmplFixture) === "0",
  );

  // ── 배지 위조 ─────────────────────────────────────────────────────────────
  check(
    "**스캔 행을 스스로 넣지 못한다** — 넣을 수 있으면 진단 없이 통과 결과만 넣어 배지를 받는다",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        vendorStaffId,
        `insert into public.vendor_compliance_scans (vendor_id, findings_json, rule_count)
           values ('${CV}', '[]'::jsonb, 20);`,
        cmplFixture,
      )),
  );
  check(
    "**진단 결과를 고치지 못한다** — high 를 지우면 배지가 따라 붙는다",
    asUser(
      vendorStaffId,
      `update public.vendor_compliance_scans set findings_json = '[]'::jsonb where id = '${SCAN}';
       select rule_count from public.vendor_compliance_scans where id = '${SCAN}';`,
      cmplFixture,
    ) === "20",
  );
  // **컬럼 권한이라 오류로 끊긴다**(0050 · FIX-30) — 정책이었다면 0행이 되어 조용했다.
  check(
    "**배지를 직접 달지 못한다** — 손으로 달 수 있으면 진단 없이 배지를 받는다",
    rejectedWith(/permission denied/i, () =>
      asUser(
        vendorStaffId,
        `update public.vendors set badge_flags = array['transparent_contract'] where id = '${CV}';`,
        cmplFixture,
      )),
  );
  check(
    "**업체가 스스로 심사를 통과시키지 못한다** — 같은 정책에서 나온 더 큰 구멍이었다(FIX-30)",
    rejectedWith(/permission denied/i, () =>
      asUser(
        vendorStaffId,
        `update public.vendors set status = 'active' where id = '${CV}';`,
        cmplFixture,
      )),
  );
  check(
    "**프로필 편집은 그대로 된다** — 좁히면서 쓰던 것을 막지 않았다(PUT /api/vendor/profile)",
    asUser(
      vendorStaffId,
      `update public.vendors set intro = '소개글', style_tags = array['modern'] where id = '${CV}';
       select intro from public.vendors where id = '${CV}';`,
      cmplFixture,
    ) === "소개글",
  );

  // ── 트리거 — 판정자가 하나다 ──────────────────────────────────────────────
  check(
    "**깨끗한 진단이 들어오면 배지가 붙는다**",
    sql(withFixture(`insert into public.vendor_compliance_scans (vendor_id, findings_json, rule_count)
                       values ('${CV_OTHER}', '[]'::jsonb, 20);
                     select 'transparent_contract' = any (badge_flags) from public.vendors where id = '${CV_OTHER}';`))
      .trim().endsWith("t"),
  );
  check(
    "**high 가 있으면 붙지 않는다**",
    sql(withFixture(`insert into public.vendor_compliance_scans (vendor_id, findings_json, rule_count)
                       values ('${CV_OTHER}', '[{"rule_code":"R-01","severity":"high"}]'::jsonb, 20);
                     select 'transparent_contract' = any (badge_flags) from public.vendors where id = '${CV_OTHER}';`))
      .trim().endsWith("f"),
  );
  check(
    "**약관이 나빠지면 배지가 회수된다** — 붙이기만 하고 떼지 않으면 배지가 거짓이 된다",
    sql(withFixture(`insert into public.vendor_compliance_scans (vendor_id, findings_json, rule_count)
                       values ('${CV_OTHER}', '[]'::jsonb, 20);
                     insert into public.vendor_compliance_scans (vendor_id, findings_json, rule_count)
                       values ('${CV_OTHER}', '[{"rule_code":"R-02","severity":"high"}]'::jsonb, 20);
                     select 'transparent_contract' = any (badge_flags) from public.vendors where id = '${CV_OTHER}';`))
      .trim().endsWith("f"),
  );
  check(
    "**다른 배지를 건드리지 않는다** — 응답우수 배지가 진단 때문에 사라지면 안 된다",
    sql(withFixture(`update public.vendors set badge_flags = array['response_fast'] where id = '${CV_OTHER}';
                     insert into public.vendor_compliance_scans (vendor_id, findings_json, rule_count)
                       values ('${CV_OTHER}', '[{"rule_code":"R-02","severity":"high"}]'::jsonb, 20);
                     select 'response_fast' = any (badge_flags) from public.vendors where id = '${CV_OTHER}';`))
      .trim().endsWith("t"),
  );
  check(
    "**기준이 없으면 배지를 주지 않는다** — 없는 기준을 '0건이면 통과' 로 읽지 않는다",
    sql(`begin;
         ${cmplFixture}
         update public.app_settings set value_json = '{"value": null}'::jsonb where key = 'compliance.badge_max_high';
         insert into public.vendor_compliance_scans (vendor_id, findings_json, rule_count)
           values ('${CV_OTHER}', '[]'::jsonb, 20);
         select 'transparent_contract' = any (badge_flags) from public.vendors where id = '${CV_OTHER}';
         rollback;`).trim().endsWith("f"),
  );

  // ── 불변식 ────────────────────────────────────────────────────────────────
  check(
    "**findings 는 배열이어야 한다** — 객체가 오면 트리거가 세지 못한다",
    rejectedWith(/vendor_compliance_scans_findings_array_chk|check constraint|cannot/, () =>
      sql(withFixture(`insert into public.vendor_compliance_scans (vendor_id, findings_json, rule_count)
                         values ('${CV_OTHER}', '{}'::jsonb, 20);`))),
  );
  check(
    "**검사한 룰 수가 0 일 수 없다** — 0종으로 통과한 진단은 통과가 아니다",
    rejectedWith(/rule_count|check constraint/, () =>
      sql(withFixture(`insert into public.vendor_compliance_scans (vendor_id, findings_json, rule_count)
                         values ('${CV_OTHER}', '[]'::jsonb, 0);`))),
  );
  check(
    "**원문 컬럼이 없다** — 저장하지 않으므로 파기할 것도 없다(CLAUDE.md §5.1)",
    sql(`select count(*) from information_schema.columns
          where table_name = 'vendor_compliance_scans'
            and column_name in ('body', 'body_md', 'terms', 'raw_text', 'storage_path');`) === "0",
  );
  check(
    "**건수 컬럼이 없다** — findings_json 에서 센다(계산 가능한 값을 저장하지 않는다)",
    sql(`select count(*) from information_schema.columns
          where table_name = 'vendor_compliance_scans'
            and column_name in ('high_count', 'mid_count', 'low_count');`) === "0",
  );

  // ── 소비자에게 가는 것 ────────────────────────────────────────────────────
  check(
    "**소비자는 날짜만 받는다** — findings 가 아니라 시각 한 칸이다",
    sql(`select pg_get_function_result('public.transparent_contract_since(uuid)'::regprocedure);`)
      === "TABLE(scanned_at timestamp with time zone)",
  );
  check(
    "**비로그인도 배지 날짜를 부를 수 있다**(업체 상세는 공개 화면이다) — 그러면서 결과 표는 못 읽는다",
    asAnon(`select count(*) = 1 from public.transparent_contract_since('${CV}');`, cmplFixture) === "t" &&
      asAnon(`select count(*) from public.vendor_compliance_scans;`, cmplFixture) === "0",
  );
  check(
    "**배지가 없으면 날짜도 나가지 않는다** — 진단했다 떨어진 사실이 흘러나가면 안 된다",
    sql(withFixture(`insert into public.vendor_compliance_scans (vendor_id, findings_json, rule_count)
                       values ('${CV_OTHER}', '[{"rule_code":"R-02","severity":"high"}]'::jsonb, 20);
                     select count(*) = 0 from public.transparent_contract_since('${CV_OTHER}');`))
      .trim().endsWith("t"),
  );
  check(
    "**최신 진단 함수는 security invoker 다** — definer 면 남의 진단을 볼 경로가 생긴다",
    !sql(`select pg_get_functiondef('public.latest_compliance_scan(uuid)'::regprocedure);`)
      .includes("SECURITY DEFINER"),
  );
  check(
    "**service_role 도 함수를 부를 수 있다**(S7-12 의 revoke 사고를 반복하지 않는다)",
    sql(`select has_function_privilege('service_role', 'public.latest_compliance_scan(uuid)', 'execute')
            and has_function_privilege('service_role', 'public.transparent_contract_since(uuid)', 'execute');`) === "t",
  );

  // ── 파라미터 ──────────────────────────────────────────────────────────────
  check(
    "**배지 기준에 값이 있다(0)** — 임의 숫자가 아니라 등급 정의에서 따라 나온 값이다",
    sql(`select (value_json->>'value')::int = 0 from public.app_settings where key = 'compliance.badge_max_high';`) === "t",
  );
  check(
    "**mid 허용 개수를 만들지 않았다** — 몇 개까지 봐줄지는 답이 임의다",
    sql(`select count(*) from public.app_settings where key like 'compliance.badge_max_mid%';`) === "0",
  );

  // ── 코드↔코드 대조 ────────────────────────────────────────────────────────
  {
    const guidesSrc = readFileSync("lib/core/compliance/guides.ts", "utf8");
    const rulesSrc = readFileSync("lib/core/rules/detect-rules.ts", "utf8");

    const guideCodes = [...guidesSrc.matchAll(/ruleCode: "(R-\d+)"/g)].map((m) => m[1]).sort();
    const ruleCodes = [...rulesSrc.matchAll(/code: "(R-\d+)"/g)].map((m) => m[1]).sort();

    check(
      "**룰 20종 전부에 수정 가이드가 있다** — 없으면 업체는 고치라는 말만 듣는다",
      ruleCodes.length > 0 && guideCodes.join("|") === ruleCodes.join("|"),
      `rules=${ruleCodes.length} guides=${guideCodes.length}`,
    );

    // DB 시드와도 같은 집합인가. 룰이 시드에만 늘면 가이드 없는 항목이 걸린다.
    const dbCodes = sql(`select string_agg(code, '|' order by code) from public.detect_rules where is_active;`);

    check(
      "**DB 의 활성 룰과 가이드가 같은 집합이다**",
      dbCodes === guideCodes.join("|"),
      `db=${dbCodes}`,
    );

    check(
      "**가이드에 조항 번호를 지어내지 않았다**(T-04 가 basis_ref 에 건 가드와 같은 규칙)",
      !/제\s*\d+\s*조/.test(guidesSrc) && !/[^\w]\d+\s*항/.test(guidesSrc),
    );

    const complianceSrc = readFileSync("lib/core/compliance/compliance.ts", "utf8");

    check(
      "**AI 를 부르지 않는다** — 같은 문서에 같은 답이 나와야 배지가 우연이 아니다",
      !complianceSrc.includes("@/lib/ai") &&
        !readFileSync("lib/compliance/scan.ts", "utf8").includes("lib/ai/"),
    );
    check(
      "**소비자 리포트와 같은 룰 엔진을 쓴다** — 룰을 새로 만들지 않았다",
      readFileSync("lib/compliance/scan.ts", "utf8").includes('from "@/lib/core/rules/scan"'),
    );
    check(
      "**저장 전에 마스킹한다** — 실수로 붙여넣은 고객 이름이 인용에 남지 않는다",
      readFileSync("lib/compliance/scan.ts", "utf8").includes("maskText"),
    );
    check(
      "**코드가 배지 기준 숫자를 갖지 않는다**(§7.4)",
      complianceSrc.includes('key: "compliance.badge_max_high"'),
    );
    check(
      "**배지 범위 고지가 자가 진단임을 밝힌다**",
      complianceSrc.includes("제출한 약관") && complianceSrc.includes("실제 계약서와 다를 수 있"),
    );
  }

  check(
    "업체 내비가 진단 화면을 가리킨다 (만든 화면에 들어가는 자리를 잇는다)",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/vendor/compliance"'),
  );
}

// ── 하객·좌석 (S7-09 · F-C-22 · 0051) ──────────────────────────────────────
// **여기서 가장 위험한 것은 이름과 토큰이다.** 하객은 우리 사용자가 아니고 명단은
// 커플이 옮겨 적은 제3자 정보다. 확인할 것 다섯 —
//  (가) **남의 명단이 보이지 않는가**, (나) **플래너가 위임받은 만큼만 보는가**(읽기만),
//  (다) **토큰·응답시각을 당사자가 직접 못 넣는가**(FIX-30 계열), (라) **비로그인이
//  함수 하나로만 들어오는가**, (마) **응답이 이름을 바꾸지 못하는가**.
//
// **픽스처를 같은 트랜잭션에 붙인다**(S7-11 에서 배운 것) — 안 붙이면 대상 행이 없어
// 0행 갱신이 되고 "아무 일도 안 일어난 것" 이 통과로 둔갑한다.
{
  const G1 = "00000000-0000-0000-0000-0000000000f1";
  const G2 = "00000000-0000-0000-0000-0000000000f2";
  const TOKEN = "s709-rls-check-token-0123456789abcdef";

  const guestFixture = `
    delete from public.guests where id in ('${G1}', '${G2}');
    update public.couples set wedding_date = current_date + 30 where id = '${coupleId}';
    insert into public.guests (id, couple_id, name, side, rsvp_status, party_size, invite_token)
      values ('${G1}', '${coupleId}', '홍길동', 'groom', 'pending', 2, '${TOKEN}');
    insert into public.guests (id, couple_id, name, side, rsvp_status, party_size)
      values ('${G2}', '${coupleId}', '김철수', 'bride', 'pending', 1);
  `;

  const withFixture = (body) => `begin;\n${guestFixture}\n${body}\nrollback;`;

  // ── 명단 경계 ─────────────────────────────────────────────────────────────
  check(
    "커플 구성원은 자기 명단을 본다",
    asUser(owner, `select count(*) from public.guests where couple_id = '${coupleId}';`, guestFixture) === "2",
  );
  check(
    "배우자도 같은 명단을 본다 (커플은 함께 준비한다)",
    asUser(partner, `select count(*) from public.guests where id = '${G1}';`, guestFixture) === "1",
  );
  check(
    "**남의 커플 명단은 보이지 않는다** — 하객 이름은 제3자 정보다",
    asUser(outsider, `select count(*) from public.guests where id = '${G1}';`, guestFixture) === "0",
  );
  check(
    "**비로그인은 명단을 보지 못한다** (표 권한 자체를 걷었다)",
    rejectedWith(/permission denied/i, () =>
      asAnon(`select count(*) from public.guests;`, guestFixture)),
  );
  check(
    "**비로그인은 명단에 쓰지도 못한다**",
    rejectedWith(/permission denied/i, () =>
      asAnon(
        `insert into public.guests (couple_id, name, side, rsvp_status, party_size)
           values ('${coupleId}', '침입자', 'groom', 'pending', 1);`,
        guestFixture,
      )),
  );

  // ── 토큰·응답시각 위조 (FIX-30 계열) ──────────────────────────────────────
  check(
    "**커플도 초대 토큰을 직접 넣지 못한다** — 넣을 수 있으면 남의 토큰을 자기 행에 복사한다",
    rejectedWith(/permission denied/i, () =>
      asUser(
        owner,
        `update public.guests set invite_token = 'forged-token-0123456789abcdef012345' where id = '${G2}';`,
        guestFixture,
      )),
  );
  check(
    "**응답 시각도 직접 쓰지 못한다** — 쓰면 \"언제 답했나\" 가 사실이 아니게 된다",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `update public.guests set responded_at = now() where id = '${G2}';`, guestFixture)),
  );
  check(
    "**커플 id 를 옮겨 남의 커플로 보내지 못한다**",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `update public.guests set couple_id = '${coupleId}' where id = '${G2}';`, guestFixture)),
  );
  check(
    "**이름·인원·응답 상태는 커플이 고칠 수 있다** — 좁히면서 쓰던 것을 막지 않았다",
    asUser(
      owner,
      `update public.guests set name = '고친이름', party_size = 3 where id = '${G2}';
       select name from public.guests where id = '${G2}';`,
      guestFixture,
    ) === "고친이름",
  );

  // ── 어휘·불변식 ───────────────────────────────────────────────────────────
  check(
    "**어휘 밖 응답 상태를 넣지 못한다** — 오타 하나가 집계에서 빠진다",
    rejectedWith(/guests_rsvp_status_vocab|check constraint/, () =>
      sql(withFixture(`update public.guests set rsvp_status = 'maybe' where id = '${G2}';`))),
  );
  check(
    "**어휘 밖 side 를 넣지 못한다**",
    rejectedWith(/guests_side_vocab|check constraint/, () =>
      sql(withFixture(`update public.guests set side = '제3자' where id = '${G2}';`))),
  );
  check(
    "**이름이 빌 수 없다** — 빈 줄은 인원만 늘리고 아무도 가리키지 않는다",
    rejectedWith(/guests_name_not_blank_chk|check constraint/, () =>
      sql(withFixture(`update public.guests set name = '   ' where id = '${G2}';`))),
  );
  check(
    "**인원 수 상한이 있다**",
    rejectedWith(/guests_party_size_chk2|check constraint/, () =>
      sql(withFixture(`update public.guests set party_size = 999 where id = '${G2}';`))),
  );
  check(
    "**답한 줄에는 답한 시각이 있다**",
    rejectedWith(/guests_responded_at_chk|check constraint/, () =>
      sql(withFixture(`update public.guests set rsvp_status = 'attending' where id = '${G2}';`))),
  );
  check(
    "**토큰이 겹치지 않는다**",
    rejectedWith(/uq_guests_invite_token|duplicate key/, () =>
      sql(withFixture(`update public.guests set invite_token = '${TOKEN}', responded_at = null where id = '${G2}';`))),
  );
  check(
    "**짧은 토큰을 넣지 못한다** — 짧으면 맞혀진다",
    rejectedWith(/guests_invite_token_len_chk|check constraint/, () =>
      sql(withFixture(`update public.guests set invite_token = 'short' where id = '${G2}';`))),
  );

  // ── 공개 응답 함수 — 비로그인이 들어오는 유일한 문 ────────────────────────
  check(
    "**비로그인이 토큰으로 답한다**",
    asAnon(
      `select ok from public.respond_to_invite('${TOKEN}', 'attending', 3);`,
      guestFixture,
    ) === "t",
  );
  // **anon 으로 답하고 postgres 로 확인한다.** anon 은 `guests` 를 읽을 권한이
  // 아예 없으므로(0051) 같은 세션에서 이름을 볼 수 없다 — 그것 자체가 이 태스크가
  // 원한 상태다. 그래서 역할을 갈아 끼우며 한 트랜잭션에서 본다.
  check(
    "**응답이 이름을 바꾸지 못한다** — 링크를 받은 사람은 답만 한다",
    sql(`begin;
         ${guestFixture}
         set local role anon;
         set local request.jwt.claims = '{"role":"anon"}';
         select ok from public.respond_to_invite('${TOKEN}', 'attending', 3);
         reset role;
         select name from public.guests where id = '${G1}';
         rollback;`).trim().endsWith("홍길동"),
  );
  check(
    "응답이 상태·인원·시각을 채운다",
    sql(withFixture(
      `select public.respond_to_invite('${TOKEN}', 'declined', 2);
       select rsvp_status || '|' || party_size || '|' || (responded_at is not null)::text
         from public.guests where id = '${G1}';`,
    )).trim().endsWith("declined|2|true"),
  );
  check(
    "**모르는 토큰은 실패한다**",
    asAnon(
      `select reason from public.respond_to_invite('없는토큰', 'attending', 1);`,
      guestFixture,
    ) === "not_found",
  );
  check(
    "**어휘 밖 답을 받지 않는다**",
    asAnon(
      `select reason from public.respond_to_invite('${TOKEN}', 'maybe', 1);`,
      guestFixture,
    ) === "bad_answer",
  );
  check(
    "**인원 수 상한을 함수도 본다** — 화면만 막으면 API 로 넘어온다",
    asAnon(
      `select reason from public.respond_to_invite('${TOKEN}', 'attending', 999);`,
      guestFixture,
    ) === "bad_party_size",
  );
  check(
    "**예식일이 지나면 받지 않는다** — 만료를 예식일이 정한다",
    sql(`begin;
         ${guestFixture}
         update public.couples set wedding_date = current_date - 1 where id = '${coupleId}';
         select reason from public.respond_to_invite('${TOKEN}', 'attending', 1);
         rollback;`).trim().endsWith("closed"),
  );
  check(
    "**예식일이 없으면 받지 않는다** — 언제까지 받을지 모르는 채로 열지 않는다",
    sql(`begin;
         ${guestFixture}
         update public.couples set wedding_date = null where id = '${coupleId}';
         select reason from public.respond_to_invite('${TOKEN}', 'attending', 1);
         rollback;`).trim().endsWith("no_wedding_date"),
  );

  // ── 응답 화면 컨텍스트 — 본인 한 줄만 ─────────────────────────────────────
  check(
    "**같은 커플의 다른 하객은 나오지 않는다** — 본인 한 줄이다",
    asAnon(`select count(*) from public.invite_context('${TOKEN}');`, guestFixture) === "1",
  );
  check(
    "**연락처·토큰이 나가지 않는다**",
    (() => {
      const result = sql(
        `select pg_get_function_result('public.invite_context(text)'::regprocedure);`,
      );

      return !result.includes("contact") && !result.includes("token");
    })(),
  );
  check(
    "**service_role 도 함수를 부를 수 있다**(S7-12 의 revoke 사고를 반복하지 않는다)",
    sql(`select has_function_privilege('service_role', 'public.respond_to_invite(text, text, integer)', 'execute')
            and has_function_privilege('service_role', 'public.invite_context(text)', 'execute');`) === "t",
  );

  // ── 좌석 ──────────────────────────────────────────────────────────────────
  check(
    "**커플당 좌석 배치는 하나다** — 여럿이면 어느 것이 지금 배치인지 답할 수 없다",
    rejectedWith(/uq_seating_plans_couple|duplicate key/, () =>
      sql(`begin;
           insert into public.seating_plans (couple_id, layout_json) values ('${coupleId}', '{}'::jsonb);
           insert into public.seating_plans (couple_id, layout_json) values ('${coupleId}', '{}'::jsonb);
           rollback;`)),
  );
  check(
    "**배치가 객체가 아니면 막는다** — 배열이 오면 파서가 조용히 빈 배치로 읽는다",
    rejectedWith(/seating_plans_layout_object_chk|check constraint/, () =>
      sql(`begin;
           delete from public.seating_plans where couple_id = '${coupleId}';
           insert into public.seating_plans (couple_id, layout_json) values ('${coupleId}', '[]'::jsonb);
           rollback;`)),
  );
  check(
    "**남의 좌석 배치는 보이지 않는다**",
    asUser(
      outsider,
      `select count(*) from public.seating_plans where couple_id = '${coupleId}';`,
      `delete from public.seating_plans where couple_id = '${coupleId}';
       insert into public.seating_plans (couple_id, layout_json) values ('${coupleId}', '{"tables":[]}'::jsonb);`,
    ) === "0",
  );

  // ── 저장하지 않는 것 ──────────────────────────────────────────────────────
  check(
    "**답례품 수량 컬럼이 없다** — RSVP 응답에서 계산한다",
    sql(`select count(*) from information_schema.columns
          where table_name = 'guests'
            and column_name in ('favor_count', 'favor_quantity', 'attending_count');`) === "0",
  );
  check(
    "**이름 암호화 컬럼을 만들지 않았다** — §3.2 가 적은 대로 평문이며 보호는 나가는 자리를 막는 것이다",
    sql(`select count(*) from information_schema.columns
          where table_name = 'guests' and column_name = 'name_enc';`) === "0",
  );

  // ── 코드↔DB 어휘 대조 ─────────────────────────────────────────────────────
  {
    const guestSrc = readFileSync("lib/core/guest/guest.ts", "utf8");

    const statuses = [...guestSrc.matchAll(/RSVP_STATUSES = \[([^\]]+)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
    const sides = [...guestSrc.matchAll(/GUEST_SIDES = \[([^\]]+)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));

    check(
      "**코드의 응답 어휘와 DB 어휘가 같다**",
      statuses.length === 3 &&
        statuses.every((status) => sql(`select public.is_rsvp_status('${status}');`) === "t") &&
        sql(`select public.is_rsvp_status('maybe');`) === "f",
      `code=${statuses.join("|")}`,
    );
    check(
      "**코드의 side 어휘와 DB 어휘가 같다**",
      sides.length === 4 &&
        sides.every((side) => sql(`select public.is_guest_side('${side}');`) === "t"),
      `code=${sides.join("|")}`,
    );

    // 이름이 이벤트로 나가지 않는지 소스로 본다. 흐름 점검이 값으로 다시 확인한다.
    const loaderSrc = readFileSync("lib/guest/loader.ts", "utf8");

    check(
      "**이벤트 memo 에 이름을 넣지 않는다**(§7.3)",
      !/memo:\s*`[^`]*\$\{[^}]*name/.test(loaderSrc) && !/memo:\s*[^,]*\.name/.test(loaderSrc),
    );
    check(
      "**이벤트에 토큰을 넣지 않는다** — 이벤트에 남으면 링크가 로그로 새는 것과 같다",
      !/memo:\s*`[^`]*token/i.test(loaderSrc),
    );
    check(
      "**목록 응답이 토큰·연락처 해시를 싣지 않는다** — 있는지 여부만 넘긴다",
      loaderSrc.includes("hasContact") &&
        loaderSrc.includes("hasInvite") &&
        !/contactHash:/.test(loaderSrc) &&
        !/inviteToken:/.test(loaderSrc),
    );

    check(
      "**초대 링크가 색인되지 않는다** — 토큰을 가진 것이 곧 권한이다",
      readFileSync("app/robots.ts", "utf8").includes('"/rsvp/"'),
    );
    check(
      "홈이 하객 화면을 가리킨다 (만든 화면에 들어가는 자리를 잇는다)",
      readFileSync("app/(consumer)/home/page.tsx", "utf8").includes('href="/guests"'),
    );
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// S8-01 — 운영자 지표 (F-A-07 · admin_metrics · 0052)
//
// **여기서 무엇을 확인하는가.** `admin_metrics()` 는 SECURITY DEFINER 라 RLS 를
// 지나간다. 그래서 이 함수에 대해서는 "정책이 막는가" 가 아니라 **"함수 안의 검사가
// 막는가"** 를 봐야 한다 — 경계가 옮겨 갔으면 검사도 옮겨 가야 한다.
//
// 그리고 **집계가 실제로 0이 아닌지**도 본다. 값이 전부 0이면 격리 검사가 통과해도
// 그것은 "아무것도 안 보인다" 가 아니라 "아무것도 없다" 라서 통과한 것이고, 정작
// 값이 새는 날 알아채지 못한다(S8-01 이 픽스처를 붙인 이유).
// ═══════════════════════════════════════════════════════════════════════════
{
  const WINDOW = `now() - interval '30 days', now()`;

  // ── 경계: 누가 부를 수 있나 ────────────────────────────────────────────────
  check(
    "운영자(admin)는 지표를 집계한다",
    // `boolean::text` 는 't' 가 아니라 'true' 다. 다른 검사들이 쓰는 `= 't'` 를
    // 그대로 베끼면 통과할 수 없는 검사가 된다.
    asUser(adminUser, `select (public.admin_metrics(${WINDOW}) ? 'signups')::text;`) === "true",
  );
  check(
    "운영자(ops)도 집계한다 — 두 역할 다 §1.4 의 운영자다",
    asUser(opsUser, `select (public.admin_metrics(${WINDOW}) ? 'signups')::text;`) === "true",
  );
  check(
    "**커플 당사자는 막힌다** — DEFINER 함수의 경계는 함수 안의 is_operator() 다",
    rejectedWith(/ADMIN_METRICS_FORBIDDEN/, () =>
      asUser(owner, `select public.admin_metrics(${WINDOW});`),
    ),
  );
  check(
    "**업체도 막힌다** — 플랫폼 전체 거래액은 업체가 볼 값이 아니다",
    rejectedWith(/ADMIN_METRICS_FORBIDDEN/, () =>
      asUser(outsider, `select public.admin_metrics(${WINDOW});`),
    ),
  );
  check(
    "**플래너도 막힌다** — 위임은 담당 커플까지이지 플랫폼 지표가 아니다",
    rejectedWith(/ADMIN_METRICS_FORBIDDEN/, () =>
      asUser(plannerAccount, `select public.admin_metrics(${WINDOW});`),
    ),
  );
  check(
    "**비로그인은 실행 권한 자체가 없다** — anon 에 grant 하지 않았다",
    rejectedWith(/permission denied|ADMIN_METRICS_FORBIDDEN/, () =>
      asAnon(`select public.admin_metrics(${WINDOW});`),
    ),
  );

  // `revoke ... from public` 은 service_role 이 물려받은 몫까지 걷어간다. 명시 grant 가
  // 살아 있는지 본다 — 없으면 "권한 부족" 이 "경계가 막았다" 로 잘못 읽힌다.
  check(
    "service_role 은 실행할 수 있으나 auth.uid() 가 없어 막힌다 (실행 권한 ≠ 통과)",
    rejectedWith(/ADMIN_METRICS_FORBIDDEN/, () =>
      sql(`begin; set local role service_role; select public.admin_metrics(${WINDOW}); rollback;`),
    ),
  );

  // ── 인자 검증 ──────────────────────────────────────────────────────────────
  check(
    "뒤집힌 기간은 거절한다 — 조용히 빈 결과를 주지 않는다",
    rejectedWith(/ADMIN_METRICS_BAD_PERIOD/, () =>
      asUser(adminUser, `select public.admin_metrics(now(), now() - interval '30 days');`),
    ),
  );
  check(
    "null 기간도 거절한다",
    rejectedWith(/ADMIN_METRICS_BAD_PERIOD/, () =>
      asUser(adminUser, `select public.admin_metrics(null, now());`),
    ),
  );

  // ── 집계가 실제 값을 낸다 (픽스처가 붙어 있어야 뜻이 있다) ────────────────
  const metrics = JSON.parse(asUser(adminUser, `select public.admin_metrics(${WINDOW})::text;`));

  check("가입을 센다", Number(metrics.signups) > 0, `signups=${metrics.signups}`);
  check(
    "**소비자 가입을 따로 센다** — 퍼널 첫 칸과 멤버십 전환율의 분모다",
    Number(metrics.consumerSignups) > 0 &&
      Number(metrics.consumerSignups) < Number(metrics.signups),
    `consumer=${metrics.consumerSignups} / total=${metrics.signups}`,
  );
  check(
    "**커플 데이터를 센다** — 운영자에게 couples SELECT 정책이 없어도 집계는 나온다",
    Number(metrics.onboardedCouples) > 0,
    `onboardedCouples=${metrics.onboardedCouples}`,
  );
  check(
    "**장바구니를 센다** — 담긴 것이 있는 커플만",
    Number(metrics.couplesWithCart) > 0,
    `couplesWithCart=${metrics.couplesWithCart}`,
  );
  check("문의를 센다", Number(metrics.inquiries) > 0, `inquiries=${metrics.inquiries}`);
  check("예약을 센다", Number(metrics.bookings) > 0, `bookings=${metrics.bookings}`);
  check("GMV 를 센다", Number(metrics.gmvAmount) > 0, `gmv=${metrics.gmvAmount}`);
  check(
    "**리포트를 'done' 으로 센다** — 'succeeded' 로 세면 오류 없이 늘 0이다",
    Number(metrics.reportsSucceeded) > 0,
    `reportsSucceeded=${metrics.reportsSucceeded}`,
  );
  check(
    "멤버십 전환을 센다",
    Number(metrics.membershipsStarted) > 0,
    `started=${metrics.membershipsStarted}`,
  );
  check(
    "멤버십 이탈을 센다",
    Number(metrics.membershipsCanceled) > 0,
    `canceled=${metrics.membershipsCanceled}`,
  );
  check("MAU 를 센다", Number(metrics.mau) > 0, `mau=${metrics.mau}`);

  // ── 새어 나가면 안 되는 것 ────────────────────────────────────────────────
  check(
    "**행도 id 도 내보내지 않는다** — 개수와 합계뿐이다(§7.3)",
    Object.values(metrics).every((value) => typeof value === "number"),
  );
  check(
    "**uuid 문자열이 응답에 없다**",
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(JSON.stringify(metrics)),
  );

  // ── 수수료 기준은 여전히 미결이다 (O-15) ──────────────────────────────────
  check(
    "**settlement.fee_basis 는 미결이다** — 시드가 값을 채워 확정시키지 않았다",
    sql(
      `select coalesce((value_json->>'basis'), 'NULL') from public.app_settings where key = 'settlement.fee_basis';`,
    ) === "NULL",
  );

  // ── 화면·라우트가 이어져 있다 ─────────────────────────────────────────────
  check(
    "운영자 콘솔 내비의 `/admin` 이 실재한다 (FIX-23 죽은 링크 여덟 중 하나)",
    existsSync("app/(admin)/admin/page.tsx"),
  );
  check(
    "대시보드가 캐시되지 않는다 — 굳으면 권한 회수 뒤에도 지표가 나간다(FIX-22 계열)",
    readFileSync("app/(admin)/admin/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "지표 API 도 캐시되지 않는다",
    readFileSync("app/api/admin/metrics/route.ts", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**로그인 착지 경로가 실재한다**(FIX-24) — 로그인은 됐는데 없는 화면에 떨어지지 않는다",
    ["/admin", "/vendor", "/pro", "/home"].every((route) =>
      ["(admin)", "(vendor)", "(planner)", "(consumer)"].some((group) =>
        existsSync(`app/${group}${route}/page.tsx`),
      ),
    ),
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// S8-02 — 감사 로그·증적 타임라인 (F-A-09 · 0053)
//
// **여기서 확인하는 것은 두 가지다.**
//  (가) 운영자만 읽는가 — 경계가 RLS 정책인지(SECURITY DEFINER 가 아니다).
//  (나) **아무도 고치거나 지울 수 없는가** — 감사 콘솔의 값어치는 전부 여기 달렸다.
//       고칠 수 있는 기록을 보여 주는 화면은 콘솔이 아니라 거짓말이다.
// ═══════════════════════════════════════════════════════════════════════════
{
  // ── 읽기 경계 ──────────────────────────────────────────────────────────────
  check(
    "운영자(admin)는 감사 로그를 읽는다",
    Number(asUser(adminUser, `select count(*) from public.audit_logs;`)) > 0,
    `rows=${asUser(adminUser, `select count(*) from public.audit_logs;`)}`,
  );
  check(
    "운영자(ops)도 읽는다",
    Number(asUser(opsUser, `select count(*) from public.audit_logs;`)) > 0,
  );
  check(
    "**커플 당사자에게는 한 줄도 보이지 않는다**",
    asUser(owner, `select count(*) from public.audit_logs;`) === "0",
  );
  check(
    "**업체에게도 보이지 않는다** — 자기 심사 기록도 예외가 아니다",
    asUser(outsider, `select count(*) from public.audit_logs;`) === "0",
  );
  check(
    "**플래너에게도 보이지 않는다**",
    asUser(plannerAccount, `select count(*) from public.audit_logs;`) === "0",
  );
  check(
    "**비로그인에게는 SELECT 권한 자체가 없다**",
    rejectedWith(/permission denied/, () => asAnon(`select count(*) from public.audit_logs;`)),
  );

  // ── 추가 전용 (0053 의 핵심) ───────────────────────────────────────────────
  //
  // **이 태스크가 발견한 구멍이 여기 있었다.** Supabase 기본 셋업의
  // `grant all on all tables ... to anon, authenticated` 때문에 **아무 로그인
  // 사용자나 증적 표를 TRUNCATE** 할 수 있었다. RLS 는 TRUNCATE 에 적용되지 않는다.
  check(
    "**로그인 사용자가 entity_events 를 비울 수 없다** (RLS 는 TRUNCATE 를 막지 못한다)",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `truncate table public.entity_events;`),
    ),
  );
  check(
    "**로그인 사용자가 audit_logs 를 비울 수 없다**",
    rejectedWith(/permission denied/, () => asUser(owner, `truncate table public.audit_logs;`)),
  );
  check(
    "**비로그인도 비울 수 없다**",
    rejectedWith(/permission denied/, () => asAnon(`truncate table public.entity_events;`)),
  );
  check(
    "**public 스키마 어느 표에도 TRUNCATE 가 열려 있지 않다** (106개 전부였다)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );

  check(
    "**당사자는 감사 로그를 넣을 수도 없다** — 증적은 서버가 쓴다",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `insert into public.audit_logs(action, target_type) values ('forged', 'vendor');`),
    ),
  );

  // 트리거는 **서비스롤에도** 적용된다. 권한으로는 막을 수 없는 자리다 —
  // 서비스롤은 증적을 써야 하므로 INSERT 권한을 가질 수밖에 없다.
  check(
    "**서비스롤도 증적을 고칠 수 없다** (트리거가 막는다)",
    rejectedWith(/EVIDENCE_APPEND_ONLY/, () =>
      sql(`begin; set local role service_role;
           update public.audit_logs set action = 'rewritten' where true;
           rollback;`),
    ),
  );
  check(
    "**서비스롤도 증적을 지울 수 없다**",
    rejectedWith(/EVIDENCE_APPEND_ONLY/, () =>
      sql(`begin; set local role service_role;
           delete from public.entity_events where true;
           rollback;`),
    ),
  );

  // ── 행위자 이름은 좁게만 열린다 ────────────────────────────────────────────
  check(
    "운영자는 행위자 이름을 조회한다",
    asUser(adminUser, `select display_name from public.admin_actor_labels(array['${adminUser}']::uuid[]);`)
      .length > 0,
  );
  check(
    "**당사자는 행위자 이름 함수를 부를 수 없다**",
    rejectedWith(/ADMIN_ACTORS_FORBIDDEN/, () =>
      asUser(owner, `select * from public.admin_actor_labels(array['${adminUser}']::uuid[]);`),
    ),
  );
  check(
    "**함수가 연락처 해시를 돌려주지 않는다** — 이름 하나 때문에 프로필을 통째로 열지 않았다",
    sql(`select count(*) from information_schema.columns
           where table_schema = 'public'
             and table_name = 'admin_actor_labels'
             and column_name = 'phone_hash';`) === "0",
  );
  check(
    "`profiles` 에는 여전히 운영자 정책이 없다 — 이름은 함수로만 나간다",
    sql(`select count(*) from pg_policies
           where tablename = 'profiles' and qual like '%is_operator%';`) === "0",
  );

  // ── 화면·라우트가 이어져 있다 ─────────────────────────────────────────────
  check(
    "`/admin/audit` 화면이 실재한다",
    existsSync("app/(admin)/admin/audit/page.tsx"),
  );
  check(
    "**운영자 콘솔 내비가 `/admin/audit` 을 가리킨다** — URL 을 직접 쳐야 열리는 화면을 만들지 않는다",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/audit"'),
  );
  check(
    "감사 로그 화면이 캐시되지 않는다 (권한 회수 뒤에도 나가면 안 된다)",
    readFileSync("app/(admin)/admin/audit/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "감사 로그 API 도 캐시되지 않는다",
    readFileSync("app/api/admin/audit-logs/route.ts", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**증적 타임라인 API 는 읽기 전용이다** — POST·PATCH·DELETE 를 두지 않았다(§4.3)",
    !/export async function (POST|PATCH|PUT|DELETE)/.test(
      readFileSync("app/api/admin/entity-events/route.ts", "utf8"),
    ),
  );

  // ── 픽스처가 붙어 있는가 ──────────────────────────────────────────────────
  // 값이 전부 0이면 위 격리 검사가 "안 보인다" 가 아니라 "없다" 라서 통과한다.
  check(
    "감사 픽스처가 있다",
    Number(sql(`select count(*) from public.audit_logs;`)) >= 4,
    `rows=${sql(`select count(*) from public.audit_logs;`)}`,
  );
  check(
    "**근거 이벤트를 단 결정이 하나 있다** — 근거 표시 경로가 실제로 그려진다",
    Number(sql(`select count(*) from public.audit_logs where resolution_basis is not null;`)) >= 1,
  );
  check(
    "**빈 근거는 저장되지 않는다** — '아무것도 안 보고 정했다' 는 상태가 없다",
    rejectedWith(/resolution_basis/, () =>
      sql(`insert into public.audit_logs(action, target_type, resolution_basis)
             values ('probe', 'vendor', '{}');`),
    ),
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// S8-04 — 개인정보 감사·파기 배치 (F-A-08 · 0054)
//
// **세 가지를 본다.**
//  (가) 요청자가 **자기 삭제 요청을 처리 완료로 만들 수 없는가** (함정 6)
//  (나) 문서 **행**이 운영자에게도 나가지 않는가 (§5.3 — storage_path)
//  (다) 미결 기준(O-18)을 코드가 대신 답하지 않는가
// ═══════════════════════════════════════════════════════════════════════════
{
  // ── 함정 6: 당사자가 심사를 우회할 수 있는가 ──────────────────────────────
  //
  // **이 태스크가 발견한 구멍이 여기 있었다.** INSERT 정책의 조건이 `user_id = auth.uid()`
  // 하나뿐이라 요청자가 `status='completed'` 로 넣을 수 있었고, 그러면 그 요청은
  // **운영자의 SLA 큐에 아예 뜨지 않는다.**
  check(
    "**요청자가 status 를 직접 넣을 수 없다** (컬럼 권한)",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `insert into public.data_deletion_requests(user_id, scope, status)
                       values ('${owner}', 'account', 'completed');`),
    ),
  );
  check(
    "**요청자가 처리 사유를 대신 적을 수 없다**",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `insert into public.data_deletion_requests(user_id, scope, resolution_reason)
                       values ('${owner}', 'account', 'self written');`),
    ),
  );
  check(
    "**요청자가 처리자를 자기로 지정할 수 없다**",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `insert into public.data_deletion_requests(user_id, scope, resolved_by)
                       values ('${owner}', 'account', '${owner}');`),
    ),
  );
  // **`owner` 를 쓰지 않는다.** `uq_deletion_requests_open_per_user` 가 사용자당 열린
  // 요청을 하나로 막는데, 픽스처가 이미 그에게 pending 을 하나 주었다. 접수가 되는지
  // 보려면 열린 요청이 없는 사람이어야 한다.
  check(
    "정상 접수는 여전히 되고 **pending 으로 들어온다**",
    asUser(
      outsider,
      `insert into public.data_deletion_requests(user_id, scope) values ('${outsider}', 'account');
       select status from public.data_deletion_requests where user_id = '${outsider}' limit 1;`,
    ) === "pending",
  );
  check(
    "**요청자가 나중에 사유를 덧쓸 수도 없다** (UPDATE 컬럼 권한)",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `update public.data_deletion_requests set resolution_reason = 'x'
                       where user_id = '${owner}';`),
    ),
  );
  check(
    "**접수 기록을 지울 수 없다** — 거두는 것은 cancelled 로 남기는 것이지 지우는 것이 아니다",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `delete from public.data_deletion_requests where user_id = '${owner}';`),
    ),
  );

  // ── 사유 필수 (DB 층) ─────────────────────────────────────────────────────
  check(
    "**사유 없이 완료할 수 없다** (DB CHECK — 화면·라우트와 같은 말)",
    rejectedWith(/resolution_reason/, () =>
      sql(`insert into public.data_deletion_requests
             (user_id, scope, status, completed_at, resolved_by)
           values ('${owner}', 'account', 'completed', now(), '${adminUser}');`),
    ),
  );
  check(
    "**빈 문자열도 사유가 아니다**",
    rejectedWith(/resolution_reason/, () =>
      sql(`insert into public.data_deletion_requests
             (user_id, scope, status, completed_at, resolved_by, resolution_reason)
           values ('${owner}', 'account', 'rejected', now(), '${adminUser}', '   ');`),
    ),
  );
  check(
    "**처리자 없이 완료할 수 없다** — 누가 닫았는지 남아야 한다",
    rejectedWith(/resolved_by/, () =>
      sql(`insert into public.data_deletion_requests
             (user_id, scope, status, completed_at, resolution_reason)
           values ('${owner}', 'account', 'completed', now(), 'has reason');`),
    ),
  );
  check(
    "당사자 취소(cancelled)에는 사유를 요구하지 않는다 — 자기 요청을 거두는 일이다",
    sql(`begin;
         insert into public.data_deletion_requests(user_id, scope, status, completed_at)
           values ('${owner}', 'account', 'cancelled', now());
         select 'ok';
         rollback;`) === "ok",
  );

  // ── 열람 경계 ─────────────────────────────────────────────────────────────
  check(
    "운영자는 삭제 요청 큐를 읽는다",
    Number(asUser(adminUser, `select count(*) from public.data_deletion_requests;`)) > 0,
  );
  check(
    "**당사자는 자기 것만 본다** — 큐 전체가 아니다",
    asUser(outsider, `select count(*) from public.data_deletion_requests;`) === "0",
  );
  check(
    "운영자는 배치 이력을 읽는다",
    Number(asUser(adminUser, `select count(*) from public.job_runs;`)) > 0,
  );
  check(
    "**당사자는 배치 이력을 못 본다**",
    asUser(owner, `select count(*) from public.job_runs;`) === "0",
  );
  // **S8-10 이 더 강하게 만들었다** — 0056 이 `anon` 의 SELECT 권한을 걷어 이제
  // 정책이 아니라 **권한**에서 끊긴다.
  check(
    "**비로그인은 배치 이력을 못 본다** (권한 자체가 없다)",
    rejectedWith(/permission denied/, () => asAnon(`select count(*) from public.job_runs;`)),
  );

  // ── 문서는 집계로만 (§5.3) ────────────────────────────────────────────────
  check(
    "운영자가 파기 현황을 집계로 받는다",
    asUser(adminUser, `select (public.admin_purge_audit() ? 'overdue')::text;`) === "true",
  );
  check(
    "**운영자에게 documents 행은 보이지 않는다** — storage_path 는 어떤 화면에도 안 나간다",
    asUser(adminUser, `select count(*) from public.documents;`) === "0",
  );
  check(
    "**집계에 경로도 id 도 실리지 않는다** — 개수와 시간뿐이다",
    Object.values(
      JSON.parse(asUser(adminUser, `select public.admin_purge_audit()::text;`)),
    ).every((value) => value === null || typeof value === "number"),
  );
  check(
    "**당사자는 집계 함수를 부를 수 없다**",
    rejectedWith(/ADMIN_PRIVACY_FORBIDDEN/, () =>
      asUser(owner, `select public.admin_purge_audit();`),
    ),
  );
  check(
    "**업체도 부를 수 없다**",
    rejectedWith(/ADMIN_PRIVACY_FORBIDDEN/, () =>
      asUser(outsider, `select public.admin_purge_audit();`),
    ),
  );
  check(
    "service_role 은 실행할 수 있으나 auth.uid() 가 없어 막힌다 (실행 권한 ≠ 통과)",
    rejectedWith(/ADMIN_PRIVACY_FORBIDDEN/, () =>
      sql(`begin; set local role service_role; select public.admin_purge_audit(); rollback;`),
    ),
  );

  // ── 화면을 죽인 nullable (FIX-38) ─────────────────────────────────────────
  //
  // **`job_runs.started_at` 이 nullable 이라 `/admin/privacy` 가 빈 화면이 됐다** —
  // `Cannot read properties of null (reading 'replace')`. 화면 쪽은 `formatTimestamp`
  // 로 견디게 고쳤고, 여기서는 **애초에 그런 행이 안 생긴다**는 것을 붙잡아 둔다.
  // 이 제약이 조용히 풀리면 같은 자리를 다시 밟는다.
  check(
    "**job_runs.started_at 이 NOT NULL 이다** — 시작 시각 없는 실행 기록은 이력이 아니다 (FIX-38)",
    sql(`select is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = 'job_runs'
             and column_name = 'started_at';`) === "NO",
  );
  check(
    "안 적어도 채워진다 — started_at 에 기본값이 있다",
    (sql(`select coalesce(column_default, '') from information_schema.columns
            where table_schema = 'public' and table_name = 'job_runs'
              and column_name = 'started_at';`) || "").includes("now()"),
  );
  check(
    "**finished_at 은 여전히 nullable 이다** — 안 끝난 실행을 표현하지 못하게 만들지 않았다",
    sql(`select is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = 'job_runs'
             and column_name = 'finished_at';`) === "YES",
  );

  // ── 미결 기준을 코드가 대신 답하지 않는다 (O-18) ──────────────────────────
  check(
    "**삭제 요청 처리 기한은 여전히 미결이다** — 시드가 값을 채워 확정시키지 않았다",
    sql(`select coalesce((value_json->>'value'), 'NULL') from public.app_settings
           where key = 'privacy.deletion_sla_hours';`) === "NULL",
  );
  check(
    "미결 파라미터가 O-18 을 가리킨다",
    sql(`select value_json->>'openIssue' from public.app_settings
           where key = 'privacy.deletion_sla_hours';`) === "O-18",
  );

  // ── FIX-35 재확인 (새 표를 만들지 않았지만 매번 다시 센다) ────────────────
  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0053 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );

  // ── 픽스처와 화면 ─────────────────────────────────────────────────────────
  check(
    "**잔존 건 픽스처가 붙어 있다** — 전부 0이면 경보 규칙을 아무도 못 본다",
    Number(
      JSON.parse(asUser(adminUser, `select public.admin_purge_audit()::text;`)).overdue,
    ) > 0,
  );
  check(
    "**잔존 건이 critical 기준을 넘겨 있다** — 경고와 즉시확인이 갈리는 것을 확인할 수 있다",
    Number(
      JSON.parse(asUser(adminUser, `select public.admin_purge_audit()::text;`)).oldestOverdueHours,
    ) >= 6,
  );
  check(
    "**배치 이력에 실패 건이 있다** — 실패 경보 경로가 실제로 그려진다",
    Number(sql(`select count(*) from public.job_runs where status = 'failed';`)) > 0,
  );
  check(
    "**오류 요약에 경로가 없다** — 파기 실패 로그가 잔존 원문의 위치 목록이 되면 안 된다",
    sql(`select count(*) from public.job_runs
           where error_summary like '%/%' or error_summary like '%contracts-raw%';`) === "0",
  );

  check("`/admin/privacy` 화면이 실재한다", existsSync("app/(admin)/admin/privacy/page.tsx"));
  check(
    "**운영자 콘솔 내비가 `/admin/privacy` 를 가리킨다**",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/privacy"'),
  );
  check(
    "개인정보 감사 화면이 캐시되지 않는다",
    readFileSync("app/(admin)/admin/privacy/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "감사 API 도 캐시되지 않는다",
    readFileSync("app/api/admin/privacy-audit/route.ts", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    // S8-13 이 인증을 `lib/ops/job-auth.ts` 로 모았다(D-149). **검사가 보던 문자열이
    // 라우트에서 사라졌다** — 그런데 검사가 보려던 것은 문자열이 아니라 "세션으로
    // 열리지 않는다" 였다. 그 뜻대로 다시 쓴다: 라우트가 공통 인증을 쓰고, 그 인증이
    // 서버 전용 키 둘만 받는지.
    "**파기 배치가 세션이 아니라 서버 비밀키로 열린다** — 아무나 파기를 돌릴 수 없다",
    readFileSync("app/api/jobs/purge-documents/route.ts", "utf8").includes(
      "authorizeJob(request)",
    ) &&
      readFileSync("lib/ops/job-auth.ts", "utf8").includes("SUPABASE_SERVICE_ROLE_KEY") &&
      readFileSync("lib/ops/job-auth.ts", "utf8").includes("CRON_SECRET") &&
      // 세션에서 뽑은 사용자로 여는 경로가 없어야 한다.
      !readFileSync("lib/ops/job-auth.ts", "utf8").includes("getSessionUser"),
  );
  check(
    "**배치가 Storage 를 지운 뒤에 purged_at 을 찍는다**(D-58) — 뒤집으면 감사가 눈을 감는다",
    (() => {
      const src = readFileSync("lib/privacy/purge.ts", "utf8");
      // **`purged_at` 을 그냥 찾으면 안 된다** — select 목록에도 그 이름이 있어
      // 조회 문자열이 먼저 걸린다(처음 그렇게 썼다가 오탐이 났다). 실제 **쓰기**를 찾는다.
      const remove = src.indexOf(".remove([parts.key])");
      const write = src.indexOf("update({ purged_at:");

      return remove > 0 && write > 0 && remove < write;
    })(),
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// S8-03 — 분쟁 조율 콘솔 (F-A-12 · F-A-16 · 0055)
//
// **네 가지를 본다.**
//  (가) 당사자가 **플랫폼의 조율 결론을 위조**할 수 있는가 (함정 6 · 네 번째)
//  (나) 옆 표들의 쓰기 권한이 열려 있는가
//  (다) 운영자가 네 출처를 다 읽는가
//  (라) 합의가 **양측 동의 없이** 기록될 수 있는가 (D-24)
// ═══════════════════════════════════════════════════════════════════════════
{
  const disputeBooking = sql(`select booking_id from public.disputes limit 1;`);
  const coupleMember = sql(
    `select m.user_id from public.couple_members m
       join public.bookings b on b.couple_id = m.couple_id limit 1;`,
  );

  // ── 함정 6: 결론 위조 ─────────────────────────────────────────────────────
  //
  // **앞선 셋(FIX-30·35·36)보다 나쁘다.** 그것들은 기록을 감추거나 지우는 것이었지만
  // 이것은 **없던 결론을 만들어 낸다** — 플랫폼이 전액 환불을 결정하고 업체에 귀책을
  // 물었다는 기록이 증적에 남는다. D-24 는 플랫폼을 조율자로 규정하는데, 위조된
  // `resolution_json` 은 **플랫폼이 취한 적 없는 입장**이다.
  check(
    "**당사자가 분쟁을 '합의됨' 으로 접수할 수 없다** (컬럼 권한)",
    rejectedWith(/permission denied/, () =>
      asUser(coupleMember, `insert into public.disputes(booking_id, raised_by, reason_code, status)
        values ('${disputeBooking}', '${coupleMember}', 'quality', 'agreed');`),
    ),
  );
  check(
    "**당사자가 조율 결론(resolution_json)을 써 넣을 수 없다**",
    rejectedWith(/permission denied/, () =>
      asUser(coupleMember, `insert into public.disputes(booking_id, raised_by, reason_code, resolution_json)
        values ('${disputeBooking}', '${coupleMember}', 'quality', '{"decision":"full_refund"}');`),
    ),
  );
  check(
    "**당사자가 양측 동의 플래그를 켤 수 없다**",
    rejectedWith(/permission denied/, () =>
      asUser(coupleMember, `insert into public.disputes(booking_id, raised_by, reason_code, couple_agreed, vendor_agreed)
        values ('${disputeBooking}', '${coupleMember}', 'quality', true, true);`),
    ),
  );
  check(
    "정상 접수는 되고 **open 으로 들어온다**",
    asUser(
      coupleMember,
      `insert into public.disputes(booking_id, raised_by, reason_code)
         values ('${disputeBooking}', '${coupleMember}', 'quality');
       select status from public.disputes where raised_by = '${coupleMember}'
         order by created_at desc limit 1;`,
    ) === "open",
  );
  check(
    "**접수 뒤에는 당사자가 고칠 수 없다**",
    rejectedWith(/permission denied/, () =>
      asUser(coupleMember, `update public.disputes set status = 'agreed';`),
    ),
  );
  check(
    "**당사자가 분쟁을 지울 수 없다** — 접수 기록이 사라지면 조율이 뜻을 잃는다",
    rejectedWith(/permission denied/, () =>
      asUser(coupleMember, `delete from public.disputes;`),
    ),
  );

  // ── 옆 표들도 같은 구멍이 있었다 ──────────────────────────────────────────
  check(
    "**당사자가 안전거래 홀드를 고칠 수 없다**",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `update public.escrow_holds set status = 'released';`),
    ),
  );
  check(
    "**당사자가 보증금 상태를 고칠 수 없다**",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `update public.consultation_deposits set status = 'refunded';`),
    ),
  );
  check(
    "**당사자가 해지 판정을 고칠 수 없다**",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `update public.contract_cancellations set admin_decision = 'vendor';`),
    ),
  );
  check(
    "**당사자가 해지 판정을 접수에 끼워 넣을 수 없다** (컬럼 권한)",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `insert into public.contract_cancellations
        (contract_id, booking_id, requester_side, reason_code, admin_decision, fault)
        values (gen_random_uuid(), '${disputeBooking}', 'couple', 'change_of_plan', 'vendor', 'vendor');`),
    ),
  );

  // ── 어휘 CHECK (없었다) ───────────────────────────────────────────────────
  check(
    "**모르는 상태는 저장되지 않는다** — 오타가 큐에서 영영 사라지는 행을 만든다",
    // `mediating` 처럼 종결이 아닌 값으로 시험한다 — 종결 값을 쓰면 사유·처리자
    // CHECK 이 **먼저** 걸려 어휘 CHECK 이 도는지 확인할 수 없다(처음 그렇게 썼다가 물렸다).
    rejectedWith(/disputes_status_vocab/, () =>
      sql(`insert into public.disputes(booking_id, raised_by, reason_code, status)
             values ('${disputeBooking}', '${coupleMember}', 'quality', 'in_review');`),
    ),
  );
  check(
    "모르는 사유 코드도 저장되지 않는다",
    rejectedWith(/disputes_reason_vocab/, () =>
      sql(`insert into public.disputes(booking_id, raised_by, reason_code)
             values ('${disputeBooking}', '${coupleMember}', 'made_up');`),
    ),
  );

  // ── D-24: 합의는 양측이 다 해야 합의다 ────────────────────────────────────
  check(
    "**한쪽만 동의한 것을 '합의' 로 적을 수 없다** (DB CHECK · 화면·라우트와 같은 말)",
    rejectedWith(/disputes_agreed_chk/, () =>
      sql(`insert into public.disputes
             (booking_id, raised_by, reason_code, status, couple_agreed, vendor_agreed,
              resolution_note, resolved_by, resolved_at)
           values ('${disputeBooking}', '${coupleMember}', 'quality', 'agreed', true, false,
                   'note', '${adminUser}', now());`),
    ),
  );
  check(
    "**사유 없이 종결할 수 없다** — '접수 거둠' 도 설명해야 한다",
    rejectedWith(/disputes_resolution_chk/, () =>
      sql(`insert into public.disputes
             (booking_id, raised_by, reason_code, status, resolved_by, resolved_at)
           values ('${disputeBooking}', '${coupleMember}', 'quality', 'withdrawn',
                   '${adminUser}', now());`),
    ),
  );
  check(
    "**처리자 없이 종결할 수 없다** — 누가 닫았는지 남아야 한다",
    rejectedWith(/disputes_resolution_chk/, () =>
      sql(`insert into public.disputes
             (booking_id, raised_by, reason_code, status, resolution_note, resolved_at)
           values ('${disputeBooking}', '${coupleMember}', 'quality', 'unresolved', 'note', now());`),
    ),
  );
  check(
    "양측이 다 동의하면 합의로 적을 수 있다",
    sql(`begin;
         insert into public.disputes
           (booking_id, raised_by, reason_code, status, couple_agreed, vendor_agreed,
            resolution_note, resolved_by, resolved_at)
         values ('${disputeBooking}', '${coupleMember}', 'quality', 'agreed', true, true,
                 'both agreed', '${adminUser}', now());
         select 'ok';
         rollback;`) === "ok",
  );

  // ── 운영자가 네 출처를 읽는가 ─────────────────────────────────────────────
  check(
    "운영자가 예약 분쟁을 읽는다",
    Number(asUser(adminUser, `select count(*) from public.disputes;`)) > 0,
  );
  check(
    "운영자가 **안전거래 이의**를 읽는다 (FIX-15 가 없다고 한 자리)",
    Number(asUser(adminUser, `select count(*) from public.escrow_holds where status = 'disputed';`)) > 0,
  );
  check(
    "운영자가 보증금 표를 읽는다 (0055 가 정책을 더했다)",
    asUser(adminUser, `select count(*) >= 0 from public.consultation_deposits;`) === "t",
  );
  check(
    "운영자가 해지 표를 읽는다",
    asUser(adminUser, `select count(*) >= 0 from public.contract_cancellations;`) === "t",
  );
  // **`outsider`(업체 대표)를 쓰지 않는다** — 이 분쟁은 그 업체의 예약에 걸려 있어
  // `is_vendor_member` 로 **정당하게 보인다**(업체는 분쟁의 당사자다). 진짜 남은 플래너다.
  check(
    "**제3자에게는 분쟁이 보이지 않는다** (업체는 당사자라 보인다 — 그것이 맞다)",
    asUser(plannerAccount, `select count(*) from public.disputes;`) === "0",
  );
  check(
    "업체는 자기 예약의 분쟁을 본다 — 응대해야 한다",
    Number(asUser(outsider, `select count(*) from public.disputes;`)) > 0,
  );
  check(
    "**비로그인에게는 분쟁이 보이지 않는다**",
    asAnon(`select count(*) from public.disputes;`) === "0",
  );

  // ── 화면·라우트가 이어져 있다 ─────────────────────────────────────────────
  check("`/admin/disputes` 화면이 실재한다", existsSync("app/(admin)/admin/disputes/page.tsx"));
  check(
    "`/admin/consultation-disputes` 도 살아 있다 (같은 큐의 다른 입구)",
    existsSync("app/(admin)/admin/consultation-disputes/page.tsx"),
  );
  check(
    "**내비의 `/admin/disputes` 가 이제 살아 있다** (FIX-23 죽은 링크 하나가 줄었다)",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/disputes"'),
  );
  check(
    "**내비가 `/admin/penalties` 를 가리킨다** — URL 을 직접 쳐야 열리던 화면이었다(FIX-25)",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/penalties"'),
  );
  check(
    "분쟁 화면이 캐시되지 않는다",
    readFileSync("app/(admin)/admin/disputes/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "조율 API 도 캐시되지 않는다",
    readFileSync("app/api/admin/disputes/[id]/route.ts", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**큐가 증적 타임라인을 새로 만들지 않고 S8-02 의 것을 가리킨다**",
    readFileSync("app/(admin)/admin/disputes/page.tsx", "utf8").includes("/admin/audit?targetType="),
  );
  check(
    "**조율 콘솔이 위약금을 다시 산정하지 않는다** — 계약 시점 규칙으로 이미 박힌 값을 읽는다",
    // 주석에는 그 파일 이름이 나온다(왜 안 부르는지 적어 두었다). **import 를 본다.**
    !/^\s*import[^;]*lib\/core\/pricing/m.test(readFileSync("lib/dispute/loader.ts", "utf8")),
  );
  check(
    "**노쇼 판정을 다시 구현하지 않고 applyVerdict 를 부른다** — 무응답 기본값이 두 벌이 되면 안 된다",
    readFileSync("app/api/admin/consultation-disputes/route.ts", "utf8").includes("applyVerdict"),
  );

  // ── 픽스처 ────────────────────────────────────────────────────────────────
  check(
    "**두 출처에 픽스처가 있다** — 전부 0이면 큐 병합이 도는지 아무도 못 본다",
    Number(sql(`select count(*) from public.disputes;`)) > 0 &&
      Number(sql(`select count(*) from public.escrow_holds where status = 'disputed';`)) > 0,
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0055 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// S8-10 — 가격 큐레이션·이상 탐지 (F-A-02 · F-A-14 · 0056)
//
// **참가격은 이 서비스의 핵심 가치다**(D-03 — 광고를 받지 않는 대신 가격으로 신뢰를
// 산다). 업체가 자기 손으로 지수를 밀어 올리거나 남의 표본을 지울 수 있으면 그 가치가
// 통째로 무너진다. 그래서 여기서 보는 것은 **권한**이 절반이다.
// ═══════════════════════════════════════════════════════════════════════════
{
  const vendorOwner = idOf("vendor@local.test");
  const cellId = sql(`select id from public.price_index limit 1;`);

  // ── 업체가 지수를 만질 수 있는가 ──────────────────────────────────────────
  check(
    "**업체가 참가격 지수를 넣을 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(vendorOwner, `insert into public.price_index
        (region_code, category, guest_bucket, season, p50, sample_size, source_type, version)
        values ('서울 강남','hall','all','all', 1, 999, 'registered_price', 'v1');`),
    ),
  );
  check(
    "**업체가 지수를 고칠 수 없다** — 자기 쪽으로 중앙값을 밀 수 없다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(vendorOwner, `update public.price_index set p50 = 1;`),
    ),
  );
  check(
    "**업체가 지수를 지울 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(vendorOwner, `delete from public.price_index;`),
    ),
  );
  check(
    "**업체가 원천 표본을 넣을 수 없다** — 가짜 표본으로 분포를 흔들 수 없다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(vendorOwner, `insert into public.price_sources(index_id, source_name, raw_value)
        values ('${cellId}', 'forged', 1);`),
    ),
  );
  check(
    "**업체가 남의 표본을 제외할 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(vendorOwner, `update public.price_sources set excluded_reason = 'x';`),
    ),
  );
  check(
    "**업체가 표본을 지울 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(vendorOwner, `delete from public.price_sources;`),
    ),
  );

  // ── 열람 경계 ─────────────────────────────────────────────────────────────
  check(
    "참가격 지수는 공개다 — 비로그인도 본다(F-C-09)",
    Number(asAnon(`select count(*) from public.price_index;`)) > 0,
  );
  check(
    "**원천 표본은 비로그인에게 보이지 않는다** — 다섯 줄을 다 보면 개별 등록가를 역산할 수 있다",
    rejectedWith(/permission denied/, () => asAnon(`select count(*) from public.price_sources;`)),
  );
  check(
    "**당사자에게도 원천 표본은 보이지 않는다**",
    asUser(owner, `select count(*) from public.price_sources;`) === "0",
  );
  check(
    "**업체에게도 보이지 않는다** — 자기 값이 섞여 있어도 남의 값이 함께 보인다",
    asUser(vendorOwner, `select count(*) from public.price_sources;`) === "0",
  );
  check(
    "운영자는 원천 표본을 읽는다 (F-A-02 는 한 줄씩 검증하는 일이다)",
    Number(asUser(adminUser, `select count(*) from public.price_sources;`)) > 0,
  );

  // ── 지워진 값은 왜 지워졌는지 답할 수 있어야 한다 (F-A-02) ────────────────
  check(
    "**사유 없이 표본을 제외할 수 없다**",
    rejectedWith(/price_sources_exclusion_chk/, () =>
      sql(`update public.price_sources set excluded_reason = '   ', verified_by = '${adminUser}'
             where id = (select id from public.price_sources limit 1);`),
    ),
  );
  check(
    "**누가 뺐는지 없이 제외할 수 없다**",
    rejectedWith(/price_sources_exclusion_chk/, () =>
      sql(`update public.price_sources set excluded_reason = '이상치'
             where id = (select id from public.price_sources limit 1);`),
    ),
  );
  check(
    "사유와 검증자가 둘 다 있으면 제외된다",
    sql(`begin;
         update public.price_sources set excluded_reason = '중복 수집', verified_by = '${adminUser}'
           where id = (select id from public.price_sources limit 1);
         select 'ok';
         rollback;`) === "ok",
  );

  // ── 어휘를 DB 가 강제한다 ─────────────────────────────────────────────────
  check(
    "**모르는 출처 유형은 저장되지 않는다** (오타는 화면이 출처를 못 읽게 만든다)",
    rejectedWith(/price_index_source_type_vocab/, () =>
      sql(`update public.price_index set source_type = 'survey';`),
    ),
  );
  check(
    // **CHECK 순서에 기대지 않는다**(함정 8). `job_name` 을 'probe' 로 두면 S8-13 이
    // 더한 `job_runs_name_vocab` 이 **먼저** 걸려, 상태 어휘를 확인하지 못한 채
    // 검사가 통과한다 — 실제로 그렇게 됐다. 이름은 유효한 것으로 두고 상태만 흔든다.
    "**모르는 배치 상태는 저장되지 않는다**",
    rejectedWith(/job_runs_status_vocab/, () =>
      sql(`insert into public.job_runs(job_name, started_at, status)
             values ('purge-documents', now(), 'done');`),
    ),
  );
  check(
    "**배치 이력을 당사자가 고칠 수 없다** — '언제 무엇이 돌았나' 가 증거여야 한다",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `update public.job_runs set status = 'succeeded';`),
    ),
  );

  // ── 임계값은 미결이다 (O-19) ──────────────────────────────────────────────
  check(
    "**미끼 임계값이 비어 있다** — 시드가 값을 채워 확정시키지 않았다",
    sql(`select coalesce((value_json->>'value'), 'NULL') from public.app_settings
           where key = 'pricing.bait_gap_bp';`) === "NULL",
  );
  check(
    "**추가금 임계값도 비어 있다**",
    sql(`select coalesce((value_json->>'value'), 'NULL') from public.app_settings
           where key = 'pricing.addon_excess_bp';`) === "NULL",
  );
  check(
    "두 임계값이 O-19 를 가리킨다",
    sql(`select count(*) from public.app_settings
           where key in ('pricing.bait_gap_bp', 'pricing.addon_excess_bp')
             and value_json->>'openIssue' = 'O-19';`) === "2",
  );
  check(
    "**§5.7 의 40%·25% 를 코드가 기본값으로 쓰지 않는다**",
    (() => {
      const src = readFileSync("lib/core/pricing/anomaly.ts", "utf8");

      // 4000·2500 을 상수로 박아 두지 않았는지 본다(테스트 픽스처는 별도 파일이다).
      return !/=\s*4_?000\b/.test(src) && !/=\s*2_?500\b/.test(src);
    })(),
  );

  // ── 픽스처: 지수가 실제로 서는가 ──────────────────────────────────────────
  check(
    "**표본이 하한을 넘겨 사분위가 나왔다** — 전부 null 이면 산출이 도는지 아무도 못 본다",
    sql(`select count(*) from public.price_index where p50 is not null;`) !== "0",
  );
  check(
    "**p25·p50·p75 가 서로 다른 값이다** — 하나로 뭉치면 백분위가 고장나도 티가 안 난다",
    sql(`select count(*) from public.price_index
           where p50 is not null and p25 < p50 and p50 < p75;`) !== "0",
  );
  check(
    "**업체당 한 건만 셌다** — 표본 수가 그 칸의 업체 수와 같다",
    sql(`select (pi.sample_size = (select count(distinct v.id) from public.vendors v
                                     join public.products p on p.vendor_id = v.id
                                    where v.region_code = pi.region_code
                                      and v.category = pi.category
                                      and v.status = 'active'
                                      and p.status = 'published'))::text
           from public.price_index pi where pi.p50 is not null limit 1;`) === "true",
  );
  check(
    "원천 표본이 지수 칸에 붙어 있다",
    Number(sql(`select count(*) from public.price_sources;`)) > 0,
  );

  // ── 화면·라우트가 이어져 있다 ─────────────────────────────────────────────
  check("`/admin/prices` 화면이 실재한다", existsSync("app/(admin)/admin/prices/page.tsx"));
  check(
    "**내비의 `/admin/prices` 가 이제 살아 있다** (FIX-23 죽은 링크 하나가 줄었다)",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/prices"'),
  );
  check(
    "가격 큐레이션 화면이 캐시되지 않는다",
    readFileSync("app/(admin)/admin/prices/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "이상 탐지 API 도 캐시되지 않는다",
    readFileSync("app/api/admin/price-anomalies/route.ts", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    // S8-13 이 인증을 공통 헬퍼로 모았다(D-149). 위와 같은 이유로 뜻대로 다시 쓴다.
    "**두 배치가 서버 비밀키로만 열린다** — 아무나 지수를 다시 셀 수 없다",
    readFileSync("app/api/jobs/price-index-refresh/route.ts", "utf8").includes(
      "authorizeJob(request)",
    ) &&
      readFileSync("app/api/jobs/price-anomaly-scan/route.ts", "utf8").includes(
        "authorizeJob(request)",
      ),
  );
  check(
    "**사분위를 다시 구현하지 않고 S3-08 의 buildPriceIndex 를 부른다**",
    readFileSync("lib/pricing/curation.ts", "utf8").includes("buildPriceIndex"),
  );
  check(
    "**탐지 큐를 표로 저장하지 않는다** — 계산 가능한 값을 저장하지 않는다",
    sql(`select count(*) from information_schema.tables
           where table_schema = 'public' and table_name like '%anomal%';`) === "0",
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0056 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// S8-11 — 검증 후기 (F-C-17 · F-V-11 · F-A-13 · 0058)
//
// **'검증' 은 이 서비스가 광고를 받지 않는 대신 내놓는 신뢰의 형식이다**(D-03).
// 거래하지 않은 업체를 평가할 수 있으면 그 말이 거짓이 된다. 그래서 여기서 보는 것의
// 절반은 **작성 자격이 UPDATE 로 우회되지 않는가**(FIX-39)다.
// ═══════════════════════════════════════════════════════════════════════════
{
  const vendorOwner = idOf("vendor@local.test");
  const reviewA = "00000000-0000-0000-0000-00000000e003";
  const reportId = "00000000-0000-0000-0000-00000000e006";
  const otherVendor = sql(
    `select id from public.vendors
       where id <> (select vendor_id from public.reviews where id = '${reviewA}') limit 1;`,
  );

  // ── FIX-39: 작성 자격을 UPDATE 로 우회할 수 있는가 ────────────────────────
  //
  // `reviews_insert` 는 확정·이행된 예약을 요구하는데 `reviews_update` 의 with check 는
  // `couple_id` 만 본다. 전 컬럼 UPDATE 권한이 열려 있으면 그 둘 사이가 곧 통로다.
  check(
    "**작성자가 후기의 대상 업체를 바꿀 수 없다** (FIX-39 — 거래 없는 업체에 검증 후기가 붙는다)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.reviews set vendor_id = '${otherVendor}' where id = '${reviewA}';`),
    ),
  );
  check(
    "**작성자가 후기가 매달린 예약을 바꿀 수 없다** (FIX-39)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.reviews set booking_id = booking_id where id = '${reviewA}';`),
    ),
  );
  check(
    "**작성자가 운영자의 비공개를 되돌릴 수 없다** (FIX-39 — 조치가 조치로 남아야 한다)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.reviews set status = 'published' where id = '${reviewA}';`),
    ),
  );
  check(
    "**작성자가 업체 답변을 대신 쓸 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.reviews set vendor_reply = 'x' where id = '${reviewA}';`),
    ),
  );
  check(
    "작성자는 자기 후기의 점수·본문은 고칠 수 있다 (막을 것만 막는다)",
    asUser(owner, `update public.reviews set score_price = 3 where id = '${reviewA}' returning 1;`) === "1",
  );

  // ── D-23: 후기는 지워지지 않는다 ──────────────────────────────────────────
  //
  // `review_reports.review_id` 는 on delete cascade 다. 후기를 지울 수 있으면
  // **신고당한 후기를 지우는 것으로 신고를 지울 수 있다.**
  check(
    "**작성자가 후기를 지울 수 없다** (신고 기록이 cascade 로 함께 사라진다 · D-23)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `delete from public.reviews where id = '${reviewA}';`),
    ),
  );
  check(
    "**업체도 후기를 지울 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(vendorOwner, `delete from public.reviews where id = '${reviewA}';`),
    ),
  );
  check(
    "**운영자도 후기를 지울 수 없다** — 내리는 것과 지우는 것은 다르다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(adminUser, `delete from public.reviews where id = '${reviewA}';`),
    ),
  );
  check(
    "authenticated·anon 어디에도 reviews DELETE 권한이 없다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'reviews'
             and privilege_type = 'DELETE' and grantee in ('anon', 'authenticated');`) === "0",
  );

  // ── 철회는 묘비다 ─────────────────────────────────────────────────────────
  check(
    "작성자는 후기를 거둘 수 있다",
    asUser(
      owner,
      `update public.reviews set retracted_at = now(), retracted_by = '${owner}'
         where id = '${reviewA}' returning 1;`,
    ) === "1",
  );
  check(
    "**남의 이름으로 거둘 수 없다**",
    rejectedWith(/row-level security/, () =>
      asUser(
        owner,
        `update public.reviews set retracted_at = now(), retracted_by = '${vendorOwner}'
           where id = '${reviewA}';`,
      ),
    ),
  );
  check(
    "**거둔 후기는 되살릴 수 없다** — 지울 수 있는 묘비는 묘비가 아니다(D-23)",
    asUser(
      owner,
      `update public.reviews set retracted_at = null where id = '${reviewA}' returning 1;`,
      `update public.reviews set retracted_at = now(), retracted_by = '${owner}' where id = '${reviewA}';`,
    ) === "",
  );

  // ── 신고: 접수자가 자기 신고를 닫을 수 있는가 (FIX-36 과 같은 모양) ───────
  check(
    "**신고자가 처리 완료 상태로 접수할 수 없다** — 그러면 운영자 큐에 뜨지 않는다",
    rejectedWith(/permission denied/, () =>
      asUser(
        vendorOwner,
        `insert into public.review_reports(review_id, reporter_id, reason_code, status)
           values ('${reviewA}', '${vendorOwner}', 'defamation', 'rejected');`,
      ),
    ),
  );
  check(
    "**신고자가 처리자 칸을 직접 쓸 수 없다**",
    rejectedWith(/permission denied/, () =>
      asUser(
        vendorOwner,
        `insert into public.review_reports(review_id, reporter_id, reason_code, resolved_by)
           values ('${reviewA}', '${vendorOwner}', 'defamation', '${vendorOwner}');`,
      ),
    ),
  );
  check(
    "**접수된 신고를 아무도 고칠 수 없다** (처리는 서비스롤 경유 · D-62)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(vendorOwner, `update public.review_reports set status = 'rejected' where id = '${reportId}';`),
    ),
  );
  check(
    "**운영자 세션으로도 신고를 고칠 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(adminUser, `update public.review_reports set status = 'upheld' where id = '${reportId}';`),
    ),
  );
  check(
    "**신고를 지울 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(vendorOwner, `delete from public.review_reports where id = '${reportId}';`),
    ),
  );
  check(
    "업체는 신고를 접수할 수 있다 (F-V-11 — 막을 것만 막는다)",
    asUser(
      vendorOwner,
      `insert into public.review_reports(review_id, reporter_id, reason_code)
         values ('${reviewA}', '${vendorOwner}', 'privacy') returning 1;`,
    ) === "1",
  );

  // ── 어휘를 DB 가 강제한다 (FIX-33 과 같은 모양) ───────────────────────────
  check(
    "**reviews.status 어휘가 CHECK 으로 잠겨 있다** — 오타 상태가 저장되지 않는다",
    sql(`select count(*) from pg_constraint where conname = 'reviews_status_vocab';`) === "1" &&
      // 둘 중 어느 쪽이 먼저 울리든 거절되면 된다 — `reviews_hidden_chk` 도 열거된
      // 두 상태만 허용하므로 오타 상태를 같이 막는다.
      rejectedWith(/reviews_status_vocab|reviews_hidden_chk/, () =>
        sql(`update public.reviews set status = 'hiden' where id = '${reviewA}';`),
      ),
  );
  check(
    "**신고 사유 어휘가 CHECK 으로 잠겨 있다**",
    rejectedWith(/review_reports_reason_vocab/, () =>
      sql(`update public.review_reports set reason_code = 'spam' where id = '${reportId}';`),
    ),
  );
  check(
    "**비공개에는 사유와 처리자가 필수다** (F-A-13 — 왜 내렸는지 답할 수 있어야 한다)",
    rejectedWith(/reviews_hidden_chk/, () =>
      sql(`update public.reviews set status = 'hidden' where id = '${reviewA}';`),
    ),
  );
  check(
    "**빈 문자열은 비공개 사유가 아니다**",
    rejectedWith(/reviews_hidden_chk/, () =>
      sql(`update public.reviews set status = 'hidden', hidden_reason = '   ',
             hidden_by = '${adminUser}', hidden_at = now() where id = '${reviewA}';`),
    ),
  );
  check(
    "**복구하면 사유 칸이 비어야 한다** — 내려간 적 없는 후기에 사유가 남지 않는다",
    rejectedWith(/reviews_hidden_chk/, () =>
      sql(`update public.reviews set status = 'published', hidden_reason = 'x',
             hidden_by = '${adminUser}', hidden_at = now() where id = '${reviewA}';`),
    ),
  );
  check(
    "**답변은 본문·시각·작성자가 함께 있어야 한다**",
    rejectedWith(/reviews_vendor_reply_chk/, () =>
      sql(`update public.reviews set vendor_reply = 'reply' where id = '${reviewA}';`),
    ),
  );
  check(
    "**'내리지 않음' 도 사유를 요구한다** (거절이 무시로 보이지 않게)",
    rejectedWith(/review_reports_status_chk/, () =>
      sql(`update public.review_reports set status = 'rejected', resolved_by = '${adminUser}',
             resolved_at = now() where id = '${reportId}';`),
    ),
  );

  // ── 코드↔DB 어휘 대조 (사본이 벌어져도 화면에는 아무 일도 안 생긴다) ──────
  {
    const codeReasons = [
      ...readFileSync("lib/core/review/report.ts", "utf8").matchAll(/^  "([a-z_]+)",$/gm),
    ].map((match) => match[1]);
    const dbReasons = sql(
      `select pg_get_constraintdef(oid) from pg_constraint
         where conname = 'review_reports_reason_vocab';`,
    );

    check(
      "신고 사유 어휘가 코드와 DB 에서 같다",
      codeReasons.length === 6 && codeReasons.every((code) => dbReasons.includes(`'${code}'`)),
      `code=${codeReasons.join(",")}`,
    );
  }
  {
    const codeStatuses = readFileSync("lib/core/review/write.ts", "utf8").match(
      /REVIEWABLE_BOOKING_STATUSES = \[([^\]]+)\]/,
    )?.[1];
    const policy = sql(
      `select with_check from pg_policies
         where schemaname = 'public' and tablename = 'reviews' and policyname = 'reviews_insert';`,
    );

    check(
      "**후기를 쓸 수 있는 예약 상태가 코드와 정책에서 같다** — 갈리면 폼은 열리는데 저장이 거절된다",
      ["confirmed", "fulfilled"].every(
        (status) => Boolean(codeStatuses?.includes(status)) && policy.includes(status),
      ),
    );
  }

  // ── 작성 자격 자체 ────────────────────────────────────────────────────────
  check(
    "**거래가 없는 사람은 후기를 쓸 수 없다** — '검증' 이라는 말의 근거다",
    rejectedWith(/row-level security/, () =>
      asUser(
        vendorOwner,
        `insert into public.reviews(booking_id, couple_id, vendor_id, score_price)
           select id, couple_id, vendor_id, 5 from public.bookings
             where id = '00000000-0000-0000-0000-0000000000fe';`,
        // **새 예약을 만들어 둔다.** 기존 예약은 전부 후기가 붙어 있어 `not in` 으로
        // 고르면 **0행이 선택돼 INSERT 가 조용히 성공한다** — 거절되는지 보려는 검사가
        // 아무것도 묻지 않게 된다.
        `insert into public.bookings(id, couple_id, vendor_id, status, total_amount)
           select '00000000-0000-0000-0000-0000000000fe', couple_id, vendor_id, 'confirmed', 1
             from public.bookings limit 1;`,
      ),
    ),
  );
  check(
    "**확정 전 예약에는 후기를 쓸 수 없다**",
    rejectedWith(/row-level security/, () =>
      asUser(
        owner,
        `insert into public.reviews(booking_id, couple_id, vendor_id, score_price)
           select id, couple_id, vendor_id, 5 from public.bookings
             where id = '00000000-0000-0000-0000-0000000000ff';`,
        `insert into public.bookings(id, couple_id, vendor_id, status, total_amount)
           select '00000000-0000-0000-0000-0000000000ff', couple_id, vendor_id, 'hold', 1
             from public.bookings limit 1;`,
      ),
    ),
  );

  // ── 열람 경계 ─────────────────────────────────────────────────────────────
  check(
    "공개 후기는 비로그인도 읽는다 (업체 상세에 실린다)",
    Number(asAnon(`select count(*) from public.reviews;`)) > 0,
  );
  check(
    "**거둔 후기는 비로그인에게 보이지 않는다**",
    asAnon(
      `select count(*) from public.reviews where id = '${reviewA}';`,
      `update public.reviews set retracted_at = now(), retracted_by = '${owner}' where id = '${reviewA}';`,
    ) === "0",
  );
  check(
    "**내려간 후기는 비로그인에게 보이지 않는다**",
    asAnon(
      `select count(*) from public.reviews where id = '${reviewA}';`,
      `update public.reviews set status = 'hidden', hidden_reason = 'demo',
         hidden_by = '${adminUser}', hidden_at = now() where id = '${reviewA}';`,
    ) === "0",
  );
  check(
    "운영자는 내려간 후기도 읽는다 — 다시 찾을 수 없으면 복구할 수 없다 (F-A-13)",
    asUser(
      adminUser,
      `select count(*) from public.reviews where id = '${reviewA}';`,
      `update public.reviews set status = 'hidden', hidden_reason = 'demo',
         hidden_by = '${adminUser}', hidden_at = now() where id = '${reviewA}';`,
    ) === "1",
  );
  check(
    "업체는 자기 후기를 전부 본다 (평판 기록을 당사자에게 감추지 않는다)",
    Number(asUser(vendorOwner, `select count(*) from public.reviews;`)) >= 3,
  );
  check(
    "**신고 내용은 비로그인에게 보이지 않는다**",
    asAnon(`select count(*) from public.review_reports;`) === "0",
  );
  check(
    "**남의 신고는 커플 당사자에게 보이지 않는다**",
    asUser(owner, `select count(*) from public.review_reports where id = '${reportId}';`) === "0",
  );
  check(
    "운영자는 신고 전부를 읽는다 (F-A-13 은 행을 읽는 것이 목적이다 · D-115)",
    Number(asUser(adminUser, `select count(*) from public.review_reports;`)) > 0,
  );

  // ── 기준이 없는 신호는 세지 않는다 (O-20) ─────────────────────────────────
  check(
    "**몰아쓰기 임계가 미결로 비어 있다** (O-20 — 코드가 숫자를 고르지 않는다)",
    sql(`select count(*) from public.app_settings
           where key in ('reviews.burst_window_hours', 'reviews.burst_min_count')
             and value_json->>'value' is null;`) === "2",
  );
  check(
    "미결 파라미터가 오픈 이슈 번호를 달고 있다",
    sql(`select count(*) from public.app_settings
           where key like 'reviews.burst_%' and value_json->>'openIssue' = 'O-20';`) === "2",
  );
  check(
    "**기준이 없을 때 빈 목록이 아니라 blocked 를 낸다** (함정 2)",
    readFileSync("lib/core/review/abuse.ts", "utf8").includes('status: "blocked"'),
  );

  // ── 저장하지 않는 것 ──────────────────────────────────────────────────────
  check(
    "**어뷰징 큐를 표로 저장하지 않는다** — 계산 가능한 값을 저장하면 낡는다(D-124)",
    sql(`select count(*) from information_schema.tables
           where table_schema = 'public' and table_name like '%review_flag%';`) === "0",
  );
  check(
    "**평점 캐시 컬럼을 만들지 않았다** — 두 곳이 갈리면 어느 쪽이 맞는지 화면으로는 모른다",
    sql(`select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'vendors'
             and column_name in ('rating_avg', 'review_count');`) === "0",
  );

  // ── 픽스처: 화면이 실제 값을 보이는가 ─────────────────────────────────────
  check(
    "공개 후기 픽스처가 붙어 있다 (0건이면 격리 검사가 엉뚱한 이유로 통과한다)",
    Number(sql(`select count(*) from public.reviews
                  where status = 'published' and retracted_at is null;`)) >= 3,
  );
  check(
    "처리 대기 신고 픽스처가 붙어 있다 (reported 신호가 실제로 뜬다)",
    Number(sql(`select count(*) from public.review_reports where status = 'open';`)) >= 1,
  );
  check(
    "본문 없는 극단 점수 픽스처가 있다 (no_body_extreme 이 임계 없이 도는 것을 보인다)",
    Number(sql(`select count(*) from public.reviews
                  where coalesce(btrim(body), '') = ''
                    and score_price = 1 and score_response = 1 and score_fulfillment = 1;`)) >= 1,
  );

  // ── 화면·라우트가 이어져 있다 ─────────────────────────────────────────────
  check("`/admin/reviews` 화면이 실재한다", existsSync("app/(admin)/admin/reviews/page.tsx"));
  check("`/vendor/reviews` 화면이 실재한다", existsSync("app/(vendor)/vendor/reviews/page.tsx"));
  check(
    "`/reviews/new/[bookingId]` 화면이 실재한다",
    existsSync("app/(consumer)/reviews/new/[bookingId]/page.tsx"),
  );
  {
    const shell = readFileSync("components/layout/AdminShell.tsx", "utf8");

    check("내비가 `/admin/reviews` 를 가리킨다", shell.includes('href: "/admin/reviews"'));
    check("내비가 `/vendor/reviews` 를 가리킨다", shell.includes('href: "/vendor/reviews"'));
  }
  check(
    "**후기 작성 화면에 들어갈 길이 있다** — 만들고 가리키지 않으면 도달 불가다(FIX-25)",
    readFileSync("app/(consumer)/me/page.tsx", "utf8").includes("/reviews/new/"),
  );
  check(
    "업체 상세가 검증 후기를 싣는다 (커뮤니티 언급과 실선/점선으로 갈린다 · §6.2)",
    readFileSync("app/(consumer)/explore/[vendorId]/page.tsx", "utf8").includes("VendorReviews"),
  );
  check(
    "후기 관리 화면이 캐시되지 않는다",
    readFileSync("app/(admin)/admin/reviews/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**S2-08 의 '평균 평점' 이 실측으로 바뀌었다** — 만든 기능을 화면이 '없다' 고 말하지 않는다(FIX-29)",
    !readFileSync("lib/vendor/stats.ts", "utf8").includes("검증 후기 기능이 아직 없습니다"),
  );
  check(
    "**후기 0건을 0점으로 적지 않는다** (0점은 '평가가 최악' 으로 읽힌다 · D-96)",
    readFileSync("lib/vendor/stats.ts", "utf8").includes("noBasis("),
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0058 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// S8-07 — AI 품질·비용 관리 (F-A-04 · §5.8 · 0059)
//
// **리포트는 업체와의 협상에 쓰이는 문서다.** 당사자가 자기 리포트의 위험 점수나
// 인용 대조 결과를 스스로 고칠 수 있으면 그 문서는 증거가 못 된다. 여기서 보는 것의
// 절반은 그 자리이며, 나머지 절반은 **지표가 지표 노릇을 하는가**다.
// ═══════════════════════════════════════════════════════════════════════════
{
  const vendorOwner = idOf("vendor@local.test");
  const analysisId = sql(`select id from public.document_analyses limit 1;`);
  const findingId = sql(`select id from public.findings limit 1;`);
  const qualityReport = "00000000-0000-0000-0000-0000000000a1";

  // ── 우리 산출물의 신뢰도를 당사자가 조작할 수 있는가 ──────────────────────
  check(
    "**당사자가 자기 분석의 위험 점수를 고칠 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.document_analyses set risk_score = 100 where id = '${analysisId}';`),
    ),
  );
  check(
    "**당사자가 인용 대조 결과를 뒤집을 수 없다** — 폐기됐어야 할 항목을 '검증됨' 으로 만들 수 없다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.findings set citation_verified = true where id = '${findingId}';`),
    ),
  );
  check(
    "**당사자가 finding 을 새로 만들 수 없다** — 근거 없는 high 판정을 스스로 만들 수 없다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(
        owner,
        `insert into public.findings(analysis_id, rule_code, severity, citation_verified)
           values ('${analysisId}', 'R-01', 'high', true);`,
      ),
    ),
  );
  check(
    "**당사자가 finding 을 지울 수 없다** — 불리한 항목만 골라 지울 수 없다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `delete from public.findings where id = '${findingId}';`),
    ),
  );
  check(
    "**아무도 품질 로그를 넣거나 고칠 수 없다** (지표의 원천이다)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(
        owner,
        `insert into public.ai_call_logs(feature, validation_result) values ('report', 'ok');`,
      ),
    ) &&
      rejectedWith(/permission denied|row-level security/, () =>
        asUser(vendorOwner, `update public.ai_call_logs set validation_result = 'ok';`),
      ),
  );
  check(
    "**운영자 세션으로도 품질 로그를 고칠 수 없다** (기록은 서비스롤 경유 · D-62)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(adminUser, `delete from public.ai_call_logs;`),
    ),
  );

  // ── 어휘를 DB 가 강제한다 (FIX-33 해소) ───────────────────────────────────
  check(
    "**`document_analyses.status` 어휘가 CHECK 으로 잠겼다** (FIX-33 — 집계의 분모다)",
    sql(`select count(*) from pg_constraint where conname = 'document_analyses_status_vocab';`) === "1" &&
      rejectedWith(/document_analyses_status_vocab/, () =>
        sql(`update public.document_analyses set status = 'succeeded' where id = '${analysisId}';`),
      ),
  );
  check(
    "**검증 결과 어휘가 CHECK 으로 잠겼다** — 오타가 실패율을 조용히 움직이지 못한다",
    rejectedWith(/ai_call_logs_validation_vocab/, () =>
      sql(`update public.ai_call_logs set validation_result = 'okay';`),
    ),
  );
  {
    // 코드↔DB 대조. 사본이 벌어져도 화면에는 아무 일도 안 생긴다(S7-01 이 세운 방식).
    const codeStatuses = [
      ...readFileSync("lib/core/report/pipeline.ts", "utf8")
        .match(/ANALYSIS_STATUSES = \[([^\]]+)\]/)?.[1]
        .matchAll(/"([a-z_]+)"/g) ?? [],
    ].map((match) => match[1]);
    const dbStatuses = sql(
      `select pg_get_constraintdef(oid) from pg_constraint
         where conname = 'document_analyses_status_vocab';`,
    );

    check(
      "분석 상태 어휘가 코드와 DB 에서 같다 (FIX-33 이 물린 자리)",
      codeStatuses.length === 4 && codeStatuses.every((code) => dbStatuses.includes(`'${code}'`)),
      `code=${codeStatuses.join(",")}`,
    );
  }
  {
    const codeResults = [
      ...(readFileSync("lib/core/quality/metrics.ts", "utf8")
        .match(/VALIDATION_RESULTS = \[([^\]]+)\]/)?.[1]
        .matchAll(/"([a-z_]+)"/g) ?? []),
    ].map((match) => match[1]);
    const dbResults = sql(
      `select pg_get_constraintdef(oid) from pg_constraint
         where conname = 'ai_call_logs_validation_vocab';`,
    );

    check(
      "검증 결과 어휘가 코드와 DB 에서 같다",
      codeResults.length === 7 && codeResults.every((code) => dbResults.includes(`'${code}'`)),
      `code=${codeResults.join(",")}`,
    );
  }

  // ── 오탐 신고: 접수자가 자기 신고를 닫을 수 있는가 (FIX-36 과 같은 모양) ──
  check(
    "**신고자가 처리 완료 상태로 접수할 수 없다** — 그러면 운영자 큐에 뜨지 않는다",
    rejectedWith(/permission denied/, () =>
      asUser(
        owner,
        `insert into public.finding_reports(finding_id, analysis_id, rule_code, reporter_id, reason_code, status)
           values ('${findingId}', '${analysisId}', 'R-01', '${owner}', 'misread', 'rejected');`,
      ),
    ),
  );
  check(
    "**신고자가 처리자 칸을 직접 쓸 수 없다**",
    rejectedWith(/permission denied/, () =>
      asUser(
        owner,
        `insert into public.finding_reports(finding_id, analysis_id, rule_code, reporter_id, reason_code, resolved_by)
           values ('${findingId}', '${analysisId}', 'R-01', '${owner}', 'misread', '${owner}');`,
      ),
    ),
  );
  check(
    "**접수된 신고를 아무도 고칠 수 없다** (처리는 서비스롤 경유)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.finding_reports set status = 'rejected' where id = '${qualityReport}';`),
    ),
  );
  check(
    "**남의 리포트 항목을 신고할 수 없다**",
    rejectedWith(/row-level security/, () =>
      asUser(
        vendorOwner,
        `insert into public.finding_reports(finding_id, analysis_id, rule_code, reporter_id, reason_code)
           values ('${findingId}', '${analysisId}', 'R-01', '${vendorOwner}', 'misread');`,
      ),
    ),
  );
  check(
    "당사자는 자기 리포트 항목을 신고할 수 있다 (막을 것만 막는다)",
    asUser(
      owner,
      `insert into public.finding_reports(finding_id, analysis_id, rule_code, reporter_id, reason_code)
         select id, analysis_id, rule_code, '${owner}', 'wrong_severity' from public.findings
           where id = '${findingId}' returning 1;`,
    ) === "1",
  );
  check(
    "**룰 코드를 바꿔치기해 남의 룰에 신고를 쌓을 수 없다**",
    rejectedWith(/row-level security/, () =>
      asUser(
        owner,
        `insert into public.finding_reports(finding_id, analysis_id, rule_code, reporter_id, reason_code)
           values ('${findingId}', '${analysisId}', 'R-99', '${owner}', 'misread');`,
      ),
    ),
  );
  check(
    "**'받아들이지 않음' 도 사유를 요구한다**",
    rejectedWith(/finding_reports_status_chk/, () =>
      sql(`update public.finding_reports set status = 'rejected', resolved_by = '${adminUser}',
             resolved_at = now() where id = '${qualityReport}';`),
    ),
  );
  check(
    "**정의되지 않은 신고 사유는 거절한다**",
    rejectedWith(/finding_reports_reason_vocab/, () =>
      sql(`update public.finding_reports set reason_code = 'spam' where id = '${qualityReport}';`),
    ),
  );

  // ── cascade 가 기록을 지우는가 ────────────────────────────────────────────
  //
  // 재분석은 finding 을 통째로 지우고 다시 넣는다(`analyze.ts`). 문서 삭제 권한도
  // 당사자에게 있다. 둘 중 어느 쪽으로도 **오탐 신고가 쓸려 나가면 안 된다.**
  check(
    "**재분석으로 finding 이 지워져도 오탐 신고는 남는다** (set null + rule_code 스냅샷)",
    sql(
      `begin;
       delete from public.findings where id = '${findingId}';
       select count(*) from public.finding_reports where id = '${qualityReport}';
       rollback;`,
    ) === "1",
  );
  check(
    "**문서를 지워도 오탐 신고는 남는다** — 당사자가 신고 기록을 지울 수 없다",
    sql(
      `begin;
       delete from public.documents;
       select count(*) from public.finding_reports where id = '${qualityReport}';
       rollback;`,
    ) === "1",
  );
  check(
    "그때 룰 코드는 그대로 남는다 — 무엇에 대한 신고였는지 답할 수 있다",
    sql(
      `begin;
       delete from public.documents;
       select rule_code from public.finding_reports where id = '${qualityReport}';
       rollback;`,
    ).length > 0,
  );

  // ── 열람 경계 ─────────────────────────────────────────────────────────────
  check(
    "**품질 로그는 비로그인에게 보이지 않는다**",
    rejectedWith(/permission denied/, () => asAnon(`select count(*) from public.ai_call_logs;`)),
  );
  check(
    "**당사자에게도 품질 로그는 보이지 않는다**",
    asUser(owner, `select count(*) from public.ai_call_logs;`) === "0",
  );
  check(
    "운영자는 품질 로그를 읽는다 — 실패율이 올랐을 때 묻는 것은 '어떤 호출이 왜' 다(D-115)",
    Number(asUser(adminUser, `select count(*) from public.ai_call_logs;`)) > 0,
  );
  check(
    "운영자는 완료된 분석을 읽는다 (검수 큐가 행이다)",
    Number(asUser(adminUser, `select count(*) from public.document_analyses;`)) > 0,
  );
  check(
    "**운영자에게 findings 는 열지 않았다** — 마스킹본이라도 남의 계약 조항이다",
    asUser(adminUser, `select count(*) from public.findings;`) === "0",
  );
  check(
    "**검수 기록은 운영자만 읽는다**",
    asUser(owner, `select count(*) from public.ai_report_reviews;`) === "0" &&
      rejectedWith(/permission denied/, () =>
        asAnon(`select count(*) from public.ai_report_reviews;`),
      ),
  );
  check(
    "**검수 기록을 운영자가 직접 쓸 수 없다** — reviewer_id 를 남의 것으로 적을 수 없다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(
        adminUser,
        `insert into public.ai_report_reviews(analysis_id, reviewer_id, verdict, note)
           values ('${analysisId}', '${owner}', 'accurate', 'x');`,
      ),
    ),
  );
  check(
    "신고자는 자기 신고를 본다",
    asUser(owner, `select count(*) from public.finding_reports where id = '${qualityReport}';`) === "1",
  );
  check(
    "**남의 신고는 보이지 않는다**",
    asUser(vendorOwner, `select count(*) from public.finding_reports;`) === "0",
  );

  // ── 검수 기록의 규칙 ──────────────────────────────────────────────────────
  check(
    "**'근거와 맞음' 에도 메모가 필수다**",
    rejectedWith(/ai_report_reviews_note_chk/, () =>
      sql(`insert into public.ai_report_reviews(analysis_id, reviewer_id, verdict, note)
             values ('${analysisId}', '${adminUser}', 'accurate', '   ');`),
    ),
  );
  check(
    "**정의되지 않은 판단은 저장되지 않는다**",
    rejectedWith(/ai_report_reviews_verdict_vocab/, () =>
      sql(`insert into public.ai_report_reviews(analysis_id, reviewer_id, verdict, note)
             values ('${analysisId}', '${adminUser}', 'wrong', 'x');`),
    ),
  );
  check(
    "한 사람이 같은 분석을 두 번 검수하지 않는다 (여러 사람은 볼 수 있다)",
    rejectedWith(/duplicate key|unique/, () =>
      sql(`begin;
           insert into public.ai_report_reviews(analysis_id, reviewer_id, verdict, note)
             values ('${analysisId}', '${adminUser}', 'accurate', 'first');
           insert into public.ai_report_reviews(analysis_id, reviewer_id, verdict, note)
             values ('${analysisId}', '${adminUser}', 'unclear', 'second');
           rollback;`),
    ),
  );

  // ── 기준이 없으면 만들지 않는다 (O-21) ────────────────────────────────────
  check(
    "**토큰 단가가 미결로 비어 있다** (O-21 — 코드가 숫자를 고르지 않는다)",
    sql(`select count(*) from public.app_settings
           where key in ('ai.input_price_per_mtok_krw', 'ai.output_price_per_mtok_krw')
             and value_json->>'value' is null;`) === "2",
  );
  check(
    "미결 파라미터가 오픈 이슈 번호를 달고 있다",
    sql(`select count(*) from public.app_settings
           where key like 'ai.%_price_per_mtok_krw' and value_json->>'openIssue' = 'O-21';`) === "2",
  );
  check(
    "**단가가 없으면 빈 값이 아니라 blocked 를 낸다** (함정 2·3)",
    readFileSync("lib/core/quality/metrics.ts", "utf8").includes('status: "blocked"') &&
      readFileSync("app/api/admin/ai-quality/route.ts", "utf8").includes("costBlocked"),
  );
  check(
    "**목표치가 '가정' 이라는 사실을 코드가 들고 다닌다** — 판정을 만들지 않는다",
    readFileSync("lib/core/quality/metrics.ts", "utf8").includes("assumed: true"),
  );

  // ── 계측: 셀 수 없던 것을 세는가 ──────────────────────────────────────────
  check(
    "**플래너가 품질 로그를 남긴다** — 그전까지 리포트만 남겨 '플래너 0%' 가 떴다",
    readFileSync("app/api/ai/planner/route.ts", "utf8").includes("logAiCall"),
  );
  check(
    "**상한에 막힌 턴도 남는다** — 실패가 아니라 limit_reached 다",
    readFileSync("app/api/ai/planner/route.ts", "utf8").includes('"limit_reached"'),
  );
  check(
    "**리포트가 폐기 수를 칸에 남긴다** — memo 문자열 파싱으로 지표를 만들지 않는다",
    readFileSync("lib/reports/analyze.ts", "utf8").includes("findingsDiscarded"),
  );
  check(
    "품질 로그 픽스처가 붙어 있다 (0건이면 격리 검사가 엉뚱한 이유로 통과한다)",
    Number(sql(`select count(*) from public.ai_call_logs;`)) >= 4,
  );
  check(
    "**시도와 비시도가 둘 다 픽스처에 있다** — no_key 가 실패율을 움직이지 않는 것을 볼 수 있다",
    sql(`select count(*) from public.ai_call_logs where validation_result = 'no_key';`) === "1" &&
      sql(`select count(*) from public.ai_call_logs where validation_result = 'invalid_output';`) === "1",
  );
  check(
    "폐기 수가 실제로 기록돼 있다 (폐기율의 분자·분모가 둘 다 있다)",
    Number(sql(`select coalesce(sum(findings_discarded), 0) from public.ai_call_logs;`)) >= 1 &&
      Number(sql(`select coalesce(sum(findings_generated), 0) from public.ai_call_logs;`)) >= 1,
  );

  // ── 저장하지 않는 것 ──────────────────────────────────────────────────────
  check(
    "**검수 큐를 표로 저장하지 않는다** — 완료 분석과 검수 기록의 차집합이다(D-124)",
    sql(`select count(*) from information_schema.tables
           where table_schema = 'public' and table_name like '%review_queue%';`) === "0",
  );

  // ── 화면·라우트가 이어져 있다 ─────────────────────────────────────────────
  check(
    "`/admin/ai-quality` 화면이 실재한다",
    existsSync("app/(admin)/admin/ai-quality/page.tsx"),
  );
  check(
    "**내비가 명세 경로를 가리킨다** — `/admin/quality` 는 §6.4 에 없는 경로였다(FIX-23)",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/ai-quality"') &&
      !readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/quality"'),
  );
  check(
    "**오탐 신고에 들어가는 자리가 있다** — 접수 경로 없는 큐는 영원히 비어 있다(FIX-25)",
    readFileSync("app/(consumer)/reports/[id]/ReportDetailView.tsx", "utf8").includes(
      "FindingReportButton",
    ),
  );
  check(
    "품질 화면이 캐시되지 않는다",
    readFileSync("app/(admin)/admin/ai-quality/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**S8-01 의 AI 비용 카드가 담당·사유를 바로잡았다** — 잘못 적힌 담당은 아무도 걷지 않는다",
    !readFileSync("lib/core/metrics/admin.ts", "utf8").includes('"S8-04",'),
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0059 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// S8-08 — 콘텐츠 CMS (F-A-05 · 0060)
//
// `content_posts` 는 **anon 이 읽는 유일한 콘텐츠 표**이고 그 글은 우리 이름으로
// 색인된다. 그래서 여기서 보는 것은 (가) 아무나 우리 이름으로 발행할 수 있는가
// (나) 미발행 글이 새는가 (다) 공개 판정이 한 곳뿐인가 — 셋이다.
// ═══════════════════════════════════════════════════════════════════════════
{
  const vendorOwner = idOf("vendor@local.test");
  const draftId = sql(`select id from public.content_posts where published_at is null limit 1;`);
  const publishedId = sql(
    `select id from public.content_posts where published_at <= now() limit 1;`,
  );
  const scheduledId = sql(
    `select id from public.content_posts where published_at > now() limit 1;`,
  );

  // ── 아무나 우리 이름으로 글을 낼 수 있는가 ────────────────────────────────
  check(
    "**아무 로그인 사용자나 글을 만들 수 없다** — 우리 이름으로 색인되는 콘텐츠다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(
        owner,
        `insert into public.content_posts (slug, type, title, body_md, seo_json, published_at)
           values ('forged-guide', 'guide', '지어낸 글', '본문', '{}'::jsonb, now());`,
      ),
    ),
  );
  check(
    "**업체도 글을 만들 수 없다** — 광고를 콘텐츠로 쓰는 경로를 두지 않는다(D-03)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(
        vendorOwner,
        `insert into public.content_posts (slug, type, title, body_md, seo_json, published_at)
           values ('vendor-ad', 'guide', '우리 업체 홍보', '본문', '{}'::jsonb, now());`,
      ),
    ),
  );
  check(
    "**발행된 글의 본문을 아무나 고칠 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.content_posts set body_md = '조작' where id = '${publishedId}';`),
    ),
  );
  check(
    "**초안을 아무나 발행할 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.content_posts set published_at = now() where id = '${draftId}';`),
    ),
  );
  check(
    "**글을 지울 수 없다** — 색인된 URL 이 죽고 되돌릴 수 없다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `delete from public.content_posts where id = '${publishedId}';`),
    ),
  );
  check(
    "**운영자 세션으로도 쓸 수 없다** — CMS 쓰기는 전부 서비스롤 경유다(D-62)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(adminUser, `update public.content_posts set title = 'x' where id = '${draftId}';`),
    ),
  );
  check(
    "authenticated·anon 어디에도 content_posts 쓰기 권한이 없다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'content_posts'
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
             and grantee in ('anon', 'authenticated');`) === "0",
  );

  // ── 미발행 글이 새는가 ────────────────────────────────────────────────────
  check(
    "**초안은 비로그인에게 보이지 않는다**",
    asAnon(`select count(*) from public.content_posts where id = '${draftId}';`) === "0",
  );
  check(
    "**예약 글도 비로그인에게 보이지 않는다** — 시각이 오기 전에는 없는 글이다",
    asAnon(`select count(*) from public.content_posts where id = '${scheduledId}';`) === "0",
  );
  check(
    "**로그인 사용자에게도 미발행 글은 보이지 않는다**",
    asUser(owner, `select count(*) from public.content_posts where id = '${draftId}';`) === "0" &&
      asUser(owner, `select count(*) from public.content_posts where id = '${scheduledId}';`) === "0",
  );
  check(
    "발행된 글은 비로그인도 읽는다 (F-C-24 · 공개 데이터)",
    Number(asAnon(`select count(*) from public.content_posts;`)) >= 7,
  );
  check(
    "운영자는 미발행 글을 읽는다 — 안 보이면 자기 초안을 편집할 수 없다(D-115)",
    asUser(adminUser, `select count(*) from public.content_posts where id = '${draftId}';`) === "1",
  );

  // ── 공개 판정이 한 곳뿐인가 ───────────────────────────────────────────────
  check(
    "**공개 판정 정책이 `published_at <= now()` 하나다** — 상태 컬럼을 만들지 않았다",
    sql(`select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'content_posts'
             and column_name in ('status', 'is_published', 'state');`) === "0",
  );
  check(
    "**예약 발행에 배치가 없다** — 시각이 지나면 조회 조건이 스스로 참이 된다",
    sql(`select count(*) from public.content_posts
           where id = '${scheduledId}' and published_at > now();`) === "1" &&
      // 같은 행을 과거로 옮기면 즉시 공개된다. 배치가 아니라 정책이 판정한다는 뜻이다.
      asAnon(
        `select count(*) from public.content_posts where id = '${scheduledId}';`,
        `update public.content_posts set published_at = now() - interval '1 minute' where id = '${scheduledId}';`,
      ) === "1",
  );
  {
    // 코드↔DB 대조. 화면이 쓰는 상태 계산과 정책이 같은 방향을 봐야 한다.
    const code = readFileSync("lib/core/content/cms.ts", "utf8");
    const policy = sql(
      `select qual from pg_policies
         where schemaname = 'public' and tablename = 'content_posts'
           and policyname = 'content_posts_select_public';`,
    );

    check(
      "화면의 상태 계산과 공개 정책이 같은 경계를 쓴다 (<= now)",
      code.includes("<= now.getTime()") && policy.includes("<= now()"),
      `policy=${policy.slice(0, 60)}`,
    );
  }

  // ── 제목은 언제나 비어 있으면 안 된다 ─────────────────────────────────────
  check(
    "**빈 제목으로 초안을 만들 수 없다** — 목록에서 그 글을 다시 찾을 수 없다",
    rejectedWith(/content_posts_title_chk/, () =>
      sql(`insert into public.content_posts (slug, type, title, seo_json)
             values ('blank-title', 'guide', '   ', '{}'::jsonb);`),
    ),
  );
  check(
    "**발행에는 본문이 있어야 한다** (기존 CHECK 이 그대로 산다)",
    rejectedWith(/content_posts_published_body_chk/, () =>
      sql(`insert into public.content_posts (slug, type, title, seo_json, published_at)
             values ('no-body', 'guide', '제목만', '{}'::jsonb, now());`),
    ),
  );
  check(
    "**슬러그 형식을 DB 가 강제한다** — URL 그 자체다",
    rejectedWith(/content_posts_slug_format_chk/, () =>
      sql(`insert into public.content_posts (slug, type, title, seo_json)
             values ('Bad Slug', 'guide', '제목', '{}'::jsonb);`),
    ),
  );

  // ── 리비전 ────────────────────────────────────────────────────────────────
  check(
    "**리비전에 사유가 필수다** — 없으면 판본 목록에서 서로 구분되지 않는다",
    rejectedWith(/content_revisions_note_chk/, () =>
      sql(`insert into public.content_revisions (post_id, revision, title, note)
             values ('${publishedId}', 99, '제목', '   ');`),
    ),
  );
  check(
    "같은 글에 같은 판본 번호가 둘일 수 없다",
    rejectedWith(/duplicate key|unique/, () =>
      sql(`insert into public.content_revisions (post_id, revision, title, note)
             values ('${publishedId}', 1, '제목', '중복');`),
    ),
  );
  check(
    "**리비전은 비로그인에게 보이지 않는다** — 발행 전 문안이 들어 있다",
    rejectedWith(/permission denied/, () =>
      asAnon(`select count(*) from public.content_revisions;`),
    ),
  );
  check(
    "**일반 로그인 사용자에게도 보이지 않는다**",
    asUser(owner, `select count(*) from public.content_revisions;`) === "0",
  );
  check(
    "운영자는 판본을 읽는다 (F-A-05 리비전 관리)",
    Number(asUser(adminUser, `select count(*) from public.content_revisions;`)) >= 2,
  );
  check(
    "**판본을 아무도 고치거나 지울 수 없다** (기록은 서비스롤 경유)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(adminUser, `update public.content_revisions set note = '조작';`),
    ) &&
      rejectedWith(/permission denied|row-level security/, () =>
        asUser(adminUser, `delete from public.content_revisions;`),
      ),
  );

  // ── 픽스처: 세 상태가 다 있는가 ───────────────────────────────────────────
  check(
    "**초안·예약·발행 셋이 다 있다** — 한 상태라도 없으면 그 경계를 확인할 수 없다",
    sql(`select count(*) from public.content_posts where published_at is null;`) !== "0" &&
      sql(`select count(*) from public.content_posts where published_at > now();`) !== "0" &&
      Number(sql(`select count(*) from public.content_posts where published_at <= now();`)) >= 7,
  );
  check(
    "판본 픽스처가 붙어 있다 (빈 목록은 '안 쌓인다' 와 '안 고쳤다' 를 구분 못 한다)",
    Number(sql(`select count(*) from public.content_revisions;`)) >= 2,
  );

  // ── 화면·라우트가 이어져 있다 ─────────────────────────────────────────────
  check("`/admin/cms` 화면이 실재한다", existsSync("app/(admin)/admin/cms/page.tsx"));
  check(
    "**내비가 명세 경로를 가리킨다** — `/admin/content` 는 §6.4 에 없는 경로였다(FIX-23)",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/cms"') &&
      !readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/content"'),
  );
  check(
    "콘텐츠 화면이 캐시되지 않는다",
    readFileSync("app/(admin)/admin/cms/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**DELETE 라우트가 행을 지우지 않는다** — 공개만 거둔다",
    readFileSync("app/api/admin/content/route.ts", "utf8").includes("unpublished: true") &&
      readFileSync("lib/content/admin.ts", "utf8").includes("published_at: null"),
  );
  check(
    "**CTA 키를 쓰기에서 막는다**(D-98) — 걸러진 값은 화면에 안 보여 잘못 적은 줄 모른다",
    readFileSync("lib/core/content/cms.ts", "utf8").includes("KNOWN_TOOL_KEYS"),
  );
  check(
    // **함정 4.** `/guides` 는 `revalidate = 300` 으로 굳는다(S7-10 · 그것이 목적이다).
    // 무효화가 없으면 발행이 최대 5분 뒤에 보이고 — 더 나쁘게 — **내린 글이 5분 동안
    // 계속 열린다.** 화면은 '내렸다' 고 말하는데 URL 은 살아 있는 상태다.
    // S8-08 흐름 점검이 실제로 여기 걸렸다.
    "**쓰기 뒤에 공개 화면 캐시를 무효화한다** — 안 그러면 내린 글이 5분 동안 열려 있다",
    readFileSync("lib/content/admin.ts", "utf8").includes("revalidatePath") &&
      readFileSync("lib/content/admin.ts", "utf8").includes('revalidatePath("/sitemap.xml")'),
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0060 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// S8-06 — 룰·프롬프트 콘솔 (F-A-03 · 0061)
//
// **검출 룰은 계약서 분석의 판단 기준이다.** 아무나 룰을 끄거나 지시문을 바꿀 수
// 있으면 리포트가 무엇을 근거로 나왔는지 답할 수 없고, 룰을 전부 지우면 분석이
// "위험 없음" 을 내는 것이 아니라 **아예 서지 않는다**(S7-01).
// ═══════════════════════════════════════════════════════════════════════════
{
  const vendorOwner = idOf("vendor@local.test");
  const ruleId = sql(`select id from public.detect_rules where code = 'R-01';`);

  // ── 층 1: 정책 아래의 권한 ────────────────────────────────────────────────
  check(
    "**아무나 룰을 끌 수 없다** — 끄는 것은 그 조항을 안 보겠다는 뜻이다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.detect_rules set is_active = false where code = 'R-01';`),
    ),
  );
  check(
    "**아무나 지시문을 바꿀 수 없다** — AI 분석에 그대로 실려 나간다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.detect_rules set prompt_fragment = '조작' where code = 'R-01';`),
    ),
  );
  check(
    "**업체가 자기에게 불리한 룰을 지울 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(vendorOwner, `delete from public.detect_rules where code = 'R-01';`),
    ),
  );
  check(
    "**아무나 룰을 새로 넣을 수 없다** (넣어도 정규식이 없어 안 돌지만 목록을 더럽힌다)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(
        owner,
        `insert into public.detect_rules (code, title, severity_default, version)
           values ('R-99', '지어낸 룰', 'high', 'v1');`,
      ),
    ),
  );
  check(
    "**운영자 세션으로도 룰을 고칠 수 없다** — 수정은 서비스롤 경유다(D-62)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(adminUser, `update public.detect_rules set is_active = false where code = 'R-01';`),
    ),
  );
  check(
    "**위약금 밴드를 아무나 만들 수 없다** — 밴드가 곧 금액이다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(
        vendorOwner,
        `insert into public.penalty_rules (category, min_days_before_event, max_days_before_event, rate_bp)
           values ('hall', 0, 999, 0);`,
      ),
    ),
  );
  check(
    "**프롬프트 배포 이력을 아무나 쓸 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(
        owner,
        `insert into public.prompt_versions (feature, version, system_prompt)
           values ('report', 'forged@1', '지어낸 프롬프트');`,
      ),
    ),
  );
  check(
    "세 표 어디에도 authenticated 쓰기 권한이 없다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('detect_rules', 'prompt_versions', 'penalty_rules')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
             and grantee in ('anon', 'authenticated');`) === "0",
  );

  // ── 층 2: 정책이 다른 표의 정책에 기대는가 (FIX-41) ───────────────────────
  check(
    "**새 정책 셋이 자기 조건을 스스로 말한다** — 부모 표의 RLS 를 빌려 쓰지 않는다",
    sql(`select count(*) from pg_policies
           where schemaname = 'public'
             and policyname in ('detect_rules_select_operator', 'prompt_versions_select_operator',
                                'penalty_rules_select_operator')
             and qual like '%is_operator%'
             and qual not like '%EXISTS%';`) === "3",
  );

  // ── 열람 경계 ─────────────────────────────────────────────────────────────
  check(
    "**룰은 비로그인에게 보이지 않는다** — prompt_fragment 는 내부 자산이다",
    rejectedWith(/permission denied/, () => asAnon(`select count(*) from public.detect_rules;`)),
  );
  check(
    "**소비자·업체에게도 보이지 않는다**",
    asUser(owner, `select count(*) from public.detect_rules;`) === "0" &&
      asUser(vendorOwner, `select count(*) from public.detect_rules;`) === "0",
  );
  check(
    "운영자는 룰을 읽는다 — '어떤 룰이 도는가' 를 한 줄씩 보는 화면이다(D-115)",
    Number(asUser(adminUser, `select count(*) from public.detect_rules;`)) >= 20,
  );
  check(
    "**프롬프트 본문도 비로그인에게 보이지 않는다**",
    rejectedWith(/permission denied/, () =>
      asAnon(`select count(*) from public.prompt_versions;`),
    ),
  );
  check(
    "운영자는 위약금 밴드를 읽는다 (비어 있다는 사실도 봐야 한다)",
    asUser(adminUser, `select count(*) from public.penalty_rules;`) !== "",
  );

  // ── 어휘·형식을 DB 가 강제한다 (CHECK 이 하나도 없었다) ──────────────────
  check(
    "**룰 코드 형식을 DB 가 강제한다** — 형식이 어긋난 행은 영원히 실행되지 않는다",
    rejectedWith(/detect_rules_code_format_chk/, () =>
      sql(`insert into public.detect_rules (code, title, severity_default, version)
             values ('BAD', '제목', 'high', 'v1');`),
    ),
  );
  check(
    "**판본이 비어 있을 수 없다** — 코드↔DB 대조의 근거다",
    rejectedWith(/detect_rules_version_chk/, () =>
      sql(`update public.detect_rules set version = '   ' where code = 'R-01';`),
    ),
  );
  check(
    "**제목이 비어 있을 수 없다**",
    rejectedWith(/detect_rules_title_chk/, () =>
      sql(`update public.detect_rules set title = '' where code = 'R-01';`),
    ),
  );
  check(
    "**자기 자신을 롤백 대상으로 삼을 수 없다**",
    rejectedWith(/prompt_versions_rollback_self_chk/, () =>
      sql(`begin;
           insert into public.prompt_versions (id, feature, version, system_prompt)
             values ('00000000-0000-0000-0000-0000000000b1', 'report', 'x@1', 'p');
           update public.prompt_versions set rollback_of = id
             where id = '00000000-0000-0000-0000-0000000000b1';
           rollback;`),
    ),
  );

  // ── 코드↔DB 대조 (S7-01 이 세운 방식 그대로) ──────────────────────────────
  {
    const codeCodes = [
      ...readFileSync("lib/core/rules/detect-rules.ts", "utf8").matchAll(/code: "(R-\d{2})"/g),
    ].map((match) => match[1]);
    const dbCodes = sql(`select string_agg(code, ',' order by code) from public.detect_rules;`)
      .split(",")
      .filter(Boolean);

    check(
      "룰 코드가 코드와 DB 에서 같다 (사본이 벌어져도 화면에는 아무 일도 안 생긴다)",
      codeCodes.length === 20 && dbCodes.length === 20 && codeCodes.every((code) => dbCodes.includes(code)),
      `code=${codeCodes.length} db=${dbCodes.length}`,
    );
  }
  check(
    "**콘솔이 스캔과 같은 병합 함수를 쓴다** — 따로 계산하면 화면과 스캔이 갈린다",
    readFileSync("lib/rules/admin.ts", "utf8").includes("mergeDetectRules"),
  );

  // ── 고칠 수 있는 칸이 셋뿐인가 ────────────────────────────────────────────
  check(
    "**수정 경로가 만지는 칸이 셋뿐이다** — 서비스롤이라 DB 컬럼 권한이 안 걸린다",
    (() => {
      // **줄바꿈에 기대지 않는다.** 처음엔 `.from(...)` 다음 줄의 주석을 앵커로 썼는데,
      // 커밋 뒤 체크아웃이 CRLF 로 정규화하자 앵커가 사라져 검사가 **엉뚱한 문자열을**
      // 봤다 — 통과도 실패도 아닌 상태였고, 검사가 검사 노릇을 못 한 자리다.
      // 앵커를 **한 줄 안에서** 찾는다 — 개행을 건너지 않으므로 CRLF·LF 어느 쪽이든 같다.
      const src = readFileSync("lib/rules/admin.ts", "utf8");
      const block = src.slice(src.indexOf("// **이 세 칸만."));
      const update = block.slice(block.indexOf(".update({"), block.indexOf("})"));

      return (
        update.includes("is_active") &&
        update.includes("prompt_fragment") &&
        update.includes("basis_ref") &&
        !update.includes("pattern_json") &&
        !update.includes("severity_default") &&
        !update.includes("code:")
      );
    })(),
  );
  check(
    "**정규식이 편집 목록에 없다**",
    !readFileSync("lib/core/rules/console.ts", "utf8").includes(
      'EDITABLE_RULE_FIELDS = ["is_active", "prompt_fragment", "basis_ref", "pattern_json"',
    ) &&
      readFileSync("lib/core/rules/console.ts", "utf8").includes(
        'EDITABLE_RULE_FIELDS = ["is_active", "prompt_fragment", "basis_ref"]',
      ),
  );

  // ── 없는 것을 있는 것처럼 적지 않는다 ─────────────────────────────────────
  check(
    "**배포 게이트가 blocked 로 API 본문에 실린다** (골든셋이 없다 · FIX-42 · 함정 3)",
    readFileSync("app/api/admin/rules/route.ts", "utf8").includes("gateBlocked") &&
      readFileSync("lib/core/rules/console.ts", "utf8").includes('reason: "golden_set_missing"'),
  );
  check(
    "**배포 이력 표가 비어 있다는 사실도 상태로 나간다** (O-22)",
    readFileSync("app/api/admin/rules/route.ts", "utf8").includes("ledgerEmpty") &&
      readFileSync("lib/core/rules/console.ts", "utf8").includes('openIssue: "O-22"'),
  );
  check(
    "**한 번도 안 불린 판본을 0회로 적지 않는다** (S8-07 이 겪은 것)",
    readFileSync("lib/rules/admin.ts", "utf8").includes("usage.get(source.version) ?? null"),
  );
  check(
    "**판본 사용 이력을 저장하지 않는다** — ai_call_logs 에서 센다(D-124)",
    sql(`select count(*) from public.prompt_versions;`) === "0",
  );

  // ── 화면·라우트가 이어져 있다 ─────────────────────────────────────────────
  check("`/admin/rules` 화면이 실재한다", existsSync("app/(admin)/admin/rules/page.tsx"));
  check(
    "**내비가 `/admin/rules` 를 가리킨다** — 안 그러면 URL 을 직접 쳐야 한다(FIX-25)",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/rules"'),
  );
  check(
    "룰 화면이 캐시되지 않는다",
    readFileSync("app/(admin)/admin/rules/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**마지막 룰을 끌 때 결과를 미리 말한다** — 막지는 않는다",
    readFileSync("lib/core/rules/console.ts", "utf8").includes("deactivationWarning"),
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0061 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );

  void ruleId;
}


// ═══════════════════════════════════════════════════════════════════════════
// S8-09 — CS·신고 처리 (F-A-06 · 0062)
//
// 앞선 여덟은 대개 "정책이 없어 오늘은 막힌다" 였는데 **여기는 정책이 있고 그 정책이
// 뚫려 있었다**(FIX-43). 신고자가 접수하면서 `status='resolved'` 를 직접 쓰면 그 티켓은
// 운영자 큐에 아예 뜨지 않는다 — 접수는 됐고 아무도 보지 않는다.
// ═══════════════════════════════════════════════════════════════════════════
{
  const vendorOwner = idOf("vendor@local.test");
  const openTicket = "00000000-0000-0000-0000-0000000000b1";
  const closedTicket = "00000000-0000-0000-0000-0000000000b3";

  // ── FIX-43: 신고자가 자기 신고를 닫을 수 있는가 ───────────────────────────
  check(
    "**신고자가 처리 완료 상태로 접수할 수 없다** (FIX-43 — 그러면 운영자 큐에 뜨지 않는다)",
    rejectedWith(/permission denied/, () =>
      asUser(
        owner,
        `insert into public.tickets (reporter_id, category, subject, status)
           values ('${owner}', 'payment', '위조 접수', 'resolved');`,
      ),
    ),
  );
  check(
    "**신고자가 담당자를 지정할 수 없다** — 남의 이름으로 '담당' 기록이 만들어진다",
    rejectedWith(/permission denied/, () =>
      asUser(
        owner,
        `insert into public.tickets (reporter_id, category, subject, assignee_id)
           values ('${owner}', 'payment', '위조 배정', '${adminUser}');`,
      ),
    ),
  );
  check(
    "**신고자가 처리 사유를 직접 쓸 수 없다**",
    rejectedWith(/permission denied/, () =>
      asUser(
        owner,
        `insert into public.tickets (reporter_id, category, subject, resolution)
           values ('${owner}', 'payment', '위조 사유', '직접 해결함');`,
      ),
    ),
  );
  check(
    "정상 접수는 된다 (막을 것만 막는다)",
    asUser(
      owner,
      `insert into public.tickets (reporter_id, category, subject, body)
         values ('${owner}', 'payment', '정상 접수', '본문') returning 1;`,
    ) === "1",
  );
  check(
    "**접수된 티켓을 아무도 고칠 수 없다** (처리는 서비스롤 경유 · D-62)",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.tickets set status = 'resolved' where id = '${openTicket}';`),
    ),
  );
  check(
    "**운영자 세션으로도 고칠 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(adminUser, `update public.tickets set status = 'resolved' where id = '${openTicket}';`),
    ),
  );
  check(
    "**티켓을 지울 수 없다** — 접수 기록이 사라지면 처리 이력도 사라진다",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `delete from public.tickets where id = '${openTicket}';`),
    ),
  );
  check(
    "authenticated 에 tickets UPDATE·DELETE 권한이 없다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'tickets'
             and privilege_type in ('UPDATE', 'DELETE')
             and grantee in ('anon', 'authenticated');`) === "0",
  );
  check(
    "**INSERT 는 네 칸에만 열려 있다** (reporter_id·category·subject·body)",
    sql(`select string_agg(column_name, ',' order by column_name)
           from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'tickets'
            and privilege_type = 'INSERT' and grantee = 'authenticated';`) ===
      "body,category,reporter_id,subject",
  );

  // ── 층 2: 정책이 다른 표의 정책에 기대는가 (FIX-41) ───────────────────────
  check(
    "**티켓 정책 셋이 자기 조건을 스스로 말한다** — 부모 표의 RLS 를 빌려 쓰지 않는다",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'tickets'
             and coalesce(qual, with_check) like '%auth.uid()%'
             or (schemaname = 'public' and tablename = 'tickets' and qual like '%is_operator%');`) !==
      "0" &&
      sql(`select count(*) from pg_policies
             where schemaname = 'public' and tablename = 'tickets'
               and coalesce(qual, with_check) like '%EXISTS%';`) === "0",
  );

  // ── 어휘·불변식을 DB 가 강제한다 (CHECK 이 하나도 없었다) ────────────────
  check(
    // 어휘 밖 상태는 `tickets_resolution_chk` 도 함께 어긴다(그 CHECK 이 허용 상태를
    // 나열하므로). **어느 쪽이 먼저 우는지에 기대지 않는다** — 제약이 있다는 사실과
    // 거절된다는 사실을 따로 본다(S8-11 이 같은 자리를 겪었다).
    "**상태 어휘가 CHECK 으로 잠겨 있다**",
    sql(`select count(*) from pg_constraint where conname = 'tickets_status_vocab';`) === "1" &&
      rejectedWith(/tickets_status_vocab|tickets_resolution_chk/, () =>
        sql(`update public.tickets set status = 'closed' where id = '${openTicket}';`),
      ),
  );
  check(
    "**분류 어휘가 CHECK 으로 잠겨 있다**",
    rejectedWith(/tickets_category_vocab/, () =>
      sql(`update public.tickets set category = 'spam' where id = '${openTicket}';`),
    ),
  );
  check(
    "**종결에는 사유·처리자·시각이 함께 있어야 한다** ('조치하지 않음' 도 예외가 아니다)",
    rejectedWith(/tickets_resolution_chk/, () =>
      sql(`update public.tickets set status = 'rejected' where id = '${openTicket}';`),
    ),
  );
  check(
    "**빈 사유로 종결할 수 없다**",
    rejectedWith(/tickets_resolution_chk/, () =>
      sql(`update public.tickets set status = 'resolved', resolution = '   ',
             resolved_by = '${adminUser}', resolved_at = now() where id = '${openTicket}';`),
    ),
  );
  check(
    "**담당자 없이 '담당 배정' 상태가 될 수 없다** — 아무도 안 보는 티켓이 '보고 있음' 으로 적힌다",
    rejectedWith(/tickets_assigned_chk/, () =>
      sql(`update public.tickets set status = 'assigned', assignee_id = null
             where id = '${openTicket}';`),
    ),
  );
  check(
    "**제목이 비어 있을 수 없다**",
    rejectedWith(/tickets_subject_chk/, () =>
      sql(`update public.tickets set subject = '   ' where id = '${openTicket}';`),
    ),
  );
  check(
    "열린 티켓에 처리 사유가 붙어 있을 수 없다 (양방향으로 잠갔다)",
    rejectedWith(/tickets_resolution_chk/, () =>
      sql(`update public.tickets set resolution = '미리 적음' where id = '${openTicket}';`),
    ),
  );
  {
    const code = readFileSync("lib/core/support/ticket.ts", "utf8");
    const dbStatuses = sql(
      `select pg_get_constraintdef(oid) from pg_constraint where conname = 'tickets_status_vocab';`,
    );
    const dbCategories = sql(
      `select pg_get_constraintdef(oid) from pg_constraint where conname = 'tickets_category_vocab';`,
    );

    check(
      "상태·분류 어휘가 코드와 DB 에서 같다",
      ["open", "assigned", "resolved", "rejected"].every((s) => dbStatuses.includes(`'${s}'`)) &&
        ["account", "payment", "vendor", "content", "abuse", "bug", "other"].every((c) =>
          dbCategories.includes(`'${c}'`),
        ) &&
        code.includes('"open", "assigned", "resolved", "rejected"'),
    );
  }

  // ── 열람 경계 ─────────────────────────────────────────────────────────────
  check(
    "**비로그인은 티켓을 못 본다** (본문에 연락처·거래 내용이 섞인다)",
    rejectedWith(/permission denied/, () => asAnon(`select count(*) from public.tickets;`)),
  );
  check(
    "신고자는 자기 티켓을 본다 — 접수만 받고 결과를 안 보여주면 처리가 아니다",
    Number(asUser(owner, `select count(*) from public.tickets;`)) >= 3,
  );
  check(
    "**남의 티켓은 보이지 않는다**",
    asUser(vendorOwner, `select count(*) from public.tickets;`) === "0",
  );
  check(
    "운영자는 전부 본다 (본문을 읽지 않고는 처리할 수 없다 · D-115)",
    Number(asUser(adminUser, `select count(*) from public.tickets;`)) >= 3,
  );

  // ── 제재: 집행이 실재하는가 ───────────────────────────────────────────────
  check(
    "**업체를 중지하면 공개 목록에서 실제로 사라진다** (집행이 실재한다)",
    asAnon(
      `select count(*) from public.vendors where id = (select id from public.vendors where status = 'active' limit 1);`,
    ) === "1" &&
      sql(
        `begin;
         update public.vendors set status = 'suspended' where status = 'active';
         select count(*) from public.vendors where status = 'active';
         rollback;`,
      ) === "0",
  );
  check(
    "**아무나 업체를 중지할 수 없다**",
    rejectedWith(/permission denied|row-level security/, () =>
      asUser(owner, `update public.vendors set status = 'suspended';`),
    ),
  );
  check(
    "**사용자 제재 칸을 만들지 않았다** — 집행 수단이 없는 상태 칸은 화면을 거짓말하게 한다",
    sql(`select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'profiles'
             and column_name in ('suspended_at', 'suspended', 'banned_at', 'status');`) === "0" &&
      readFileSync("lib/core/support/ticket.ts", "utf8").includes("USER_SANCTION_UNAVAILABLE"),
  );

  // ── 큐를 합치지 않는다 ────────────────────────────────────────────────────
  check(
    "**신고 큐를 합치는 표도 뷰도 만들지 않았다** (D-142 · 계산이다)",
    sql(`select count(*) from information_schema.tables
           where table_schema = 'public' and table_name like '%report_queue%';`) === "0",
  );
  check(
    "**옆 큐 셋을 가리키기만 한다** — 합치지 않되 놓치지 않게",
    readFileSync("lib/core/support/ticket.ts", "utf8").includes("SIBLING_QUEUES") &&
      readFileSync("lib/support/admin.ts", "utf8").includes("community_reports") &&
      readFileSync("lib/support/admin.ts", "utf8").includes("review_reports") &&
      readFileSync("lib/support/admin.ts", "utf8").includes("finding_reports"),
  );

  // ── 픽스처 ────────────────────────────────────────────────────────────────
  check(
    "**담당자 없는 열린 티켓이 있다** — 화면이 가장 먼저 보라고 적는 값이다",
    sql(`select count(*) from public.tickets where status = 'open' and assignee_id is null;`) !== "0",
  );
  check(
    "배정된 티켓이 있다 (행위자 이름 경로가 실제로 도는지 본다)",
    sql(`select count(*) from public.tickets where status = 'assigned' and assignee_id is not null;`) !== "0",
  );
  check(
    "종결된 티켓이 사유·처리자·시각을 다 갖고 있다",
    sql(`select count(*) from public.tickets
           where status in ('resolved', 'rejected')
             and resolution is not null and resolved_by is not null and resolved_at is not null;`) !== "0",
  );

  // ── 화면·라우트가 이어져 있다 ─────────────────────────────────────────────
  check("`/admin/tickets` 화면이 실재한다", existsSync("app/(admin)/admin/tickets/page.tsx"));
  check(
    "**접수 화면이 실재한다** — 없으면 운영자 큐가 영원히 빈다(FIX-25)",
    existsSync("app/(consumer)/support/page.tsx"),
  );
  check(
    "**`/support` 에 들어가는 자리가 있다**",
    readFileSync("app/(consumer)/me/page.tsx", "utf8").includes('href="/support"'),
  );
  check(
    "**내비의 `/admin/tickets` 가 이제 살아 있다** (FIX-23 죽은 링크 하나 감소)",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/tickets"'),
  );
  check(
    "CS 화면이 캐시되지 않는다",
    readFileSync("app/(admin)/admin/tickets/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**'지연' 이라고 적지 않는다** — 처리 기한이 정해져 있지 않다",
    !readFileSync("app/(admin)/admin/tickets/page.tsx", "utf8").includes("지연") ||
      readFileSync("app/(admin)/admin/tickets/page.tsx", "utf8").includes("지연&apos;이라고 적지"),
  );
  check(
    "**사용자 제재를 할 수 없다는 사실이 API 본문에 실린다** (함정 3)",
    readFileSync("app/api/admin/tickets/route.ts", "utf8").includes("userSanction"),
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0062 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );

  void closedTicket;
}


// ═══════════════════════════════════════════════════════════════════════════
// S8-12 — 피처 플래그 콘솔 (F-A-10 · 0063)
//
// **키 목록이 곧 미공개 기능 로드맵이다.** 0005 가 public 스키마에서 이 표 하나만
// 테이블 GRANT 까지 회수한 이유이며(D-15), 이 콘솔이 그 경계를 깨지 않았는지가
// 여기서 보는 것의 절반이다.
// ═══════════════════════════════════════════════════════════════════════════
{
  const vendorOwner = idOf("vendor@local.test");

  // ── 층 1: D-15 의 경계가 그대로인가 ───────────────────────────────────────
  check(
    "**feature_flags 에 anon·authenticated 권한이 여전히 하나도 없다** (D-15 · 콘솔이 GRANT 를 복구하지 않았다)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'feature_flags'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
  check(
    "**정책도 여전히 없다** — 정책을 만들려면 GRANT 부터 복구해야 하고 그것이 피한 일이다",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'feature_flags';`) === "0",
  );
  check(
    "**비로그인은 표를 못 읽는다**",
    rejectedWith(/permission denied/, () => asAnon(`select count(*) from public.feature_flags;`)),
  );
  check(
    "**로그인해도 못 읽는다** — 소비자·업체 모두",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `select count(*) from public.feature_flags;`),
    ) &&
      rejectedWith(/permission denied/, () =>
        asUser(vendorOwner, `select count(*) from public.feature_flags;`),
      ),
  );
  check(
    "**운영자도 표를 직접 읽지 못한다** — 문은 함수 하나다",
    rejectedWith(/permission denied/, () =>
      asUser(adminUser, `select count(*) from public.feature_flags;`),
    ),
  );
  check(
    "**아무도 표를 직접 쓰지 못한다**",
    rejectedWith(/permission denied/, () =>
      asUser(adminUser, `update public.feature_flags set enabled = true;`),
    ) &&
      rejectedWith(/permission denied/, () =>
        asUser(owner, `insert into public.feature_flags (key) values ('forged.flag');`),
      ),
  );

  // ── 함수가 경계를 갖는가 ──────────────────────────────────────────────────
  check(
    "운영자는 함수로 플래그를 읽는다 (F-A-10)",
    Number(asUser(adminUser, `select count(*) from public.admin_feature_flags();`)) >= 2,
  );
  check(
    "**소비자가 함수를 불러도 막힌다** — 경계가 함수 안에 있다",
    rejectedWith(/forbidden|42501/, () =>
      asUser(owner, `select count(*) from public.admin_feature_flags();`),
    ),
  );
  check(
    "**업체가 불러도 막힌다**",
    rejectedWith(/forbidden|42501/, () =>
      asUser(vendorOwner, `select count(*) from public.admin_feature_flags();`),
    ),
  );
  check(
    "**비로그인이 불러도 막힌다**",
    rejectedWith(/forbidden|42501|permission denied/, () =>
      asAnon(`select count(*) from public.admin_feature_flags();`),
    ),
  );
  check(
    "**서비스롤이 불러도 막힌다** — auth.uid() 가 없다(S8-01 이 지표에서 정한 규약)",
    rejectedWith(/forbidden|42501/, () =>
      sql(`set local role service_role; select count(*) from public.admin_feature_flags();`),
    ),
  );
  check(
    // **소유자(postgres)는 세지 않는다.** 처음엔 grantee 목록을 통째로 비교했는데
    // 소유자가 늘 끼어 있어 실패했다 — 검사가 확인하려던 것은 "anon 이 없고
    // authenticated·service_role 이 있다" 이지 목록의 글자 일치가 아니다(함정 8).
    "함수 실행 권한이 anon 에 없고 authenticated·service_role 에 있다 (함정 5 — revoke all 뒤 다시 줬다)",
    sql(`select count(*) from information_schema.role_routine_grants
           where specific_schema = 'public' and routine_name = 'admin_feature_flags'
             and grantee = 'anon';`) === "0" &&
      sql(`select count(*) from information_schema.role_routine_grants
             where specific_schema = 'public' and routine_name = 'admin_feature_flags'
               and grantee in ('authenticated', 'service_role');`) === "2",
  );

  // ── 층 2: 정책이 다른 표에 기대는가 (FIX-41) ──────────────────────────────
  //
  // 정책이 아예 없으므로 기댈 것도 없다. 함수는 `is_operator()` 하나로 자기 조건을
  // 스스로 말한다 — 확인만 하고 넘어간다.
  check(
    "**함수가 자기 조건을 스스로 말한다** — 다른 표의 정책에 기대지 않는다",
    sql(`select pg_get_functiondef(oid) from pg_proc
           where proname = 'admin_feature_flags';`).includes("is_operator()"),
  );

  // ── 어휘·형식을 DB 가 강제한다 (CHECK 이 하나도 없었다) ──────────────────
  check(
    "**키 형식을 DB 가 강제한다** — 오타 난 키는 아무도 안 읽으면서 '켜짐' 으로 보인다",
    rejectedWith(/feature_flags_key_format_chk/, () =>
      sql(`insert into public.feature_flags (key, enabled) values ('Bad Key', true);`),
    ) &&
      rejectedWith(/feature_flags_key_format_chk/, () =>
        sql(`insert into public.feature_flags (key, enabled) values ('nodot', true);`),
      ),
  );
  check(
    "정상 키는 받는다 (막을 것만 막는다)",
    sql(`begin;
         insert into public.feature_flags (key, enabled) values ('demo.flag', false);
         select count(*) from public.feature_flags where key = 'demo.flag';
         rollback;`) === "1",
  );
  check(
    "**rollout_json 은 객체여야 한다** — 배열이면 부분 스위치가 조용히 전부 꺼진 것으로 읽힌다",
    rejectedWith(/feature_flags_rollout_object_chk/, () =>
      sql(`update public.feature_flags set rollout_json = '[]'::jsonb where key = 'community.enabled';`),
    ),
  );

  // ── 코드↔DB 대조 ─────────────────────────────────────────────────────────
  {
    const registry = readFileSync("lib/core/flags/registry.ts", "utf8");
    const codeKeys = [...registry.matchAll(/key: "([a-z][a-z0-9_.]*)"/g)]
      .map((match) => match[1])
      .filter((key) => key.includes("."));
    const dbKeys = sql(`select string_agg(key, ',' order by key) from public.feature_flags;`)
      .split(",")
      .filter(Boolean);

    check(
      "레지스트리의 플래그 키가 DB 행과 같다 (사본이 벌어져도 화면에는 아무 일도 안 생긴다)",
      codeKeys.length === 2 && dbKeys.length === 2 && codeKeys.every((key) => dbKeys.includes(key)),
      `code=${codeKeys.join(",")} db=${dbKeys.join(",")}`,
    );
  }
  {
    // 부분 스위치 이름이 실제로 읽는 쪽과 같은가. 갈리면 콘솔이 켠 스위치를
    // 화면이 안 읽는다 — 스위치가 스위치 노릇을 못 한다.
    const registry = readFileSync("lib/core/flags/registry.ts", "utf8");
    const view = readFileSync("lib/core/schedule/view.ts", "utf8");

    check(
      "**부분 스위치 이름이 enabledViews 가 읽는 것과 같다**",
      ["timeline", "progress", "next", "graph"].every(
        (name) => registry.includes(`key: "${name}"`) && view.includes(name),
      ),
    );
  }

  // ── 코드가 읽는 규칙과 콘솔이 보이는 규칙이 같은가 ────────────────────────
  check(
    "**행이 없으면 꺼진 것이다** — isFeatureEnabled 와 콘솔이 같은 말을 한다",
    readFileSync("lib/flags.ts", "utf8").includes("enabled === true") &&
      readFileSync("lib/core/flags/registry.ts", "utf8").includes("row?.enabled === true"),
  );
  check(
    "**아무도 안 읽는 행을 '열린 기능' 으로 세지 않는다**",
    readFileSync("lib/core/flags/registry.ts", "utf8").includes(
      "known.filter((flag) => flag.enabled).length",
    ),
  );

  // ── 조건 미충족 상태로 켜기 (D-145) ───────────────────────────────────────
  check(
    "**막지 않고 드러낸다** — 조건 안내가 있고 차단이 없다",
    readFileSync("lib/core/flags/registry.ts", "utf8").includes("conditionNotice") &&
      !readFileSync("lib/flags/admin.ts", "utf8").includes("CONDITION_NOT_MET"),
  );
  check(
    "**사유가 필수다** — 조건을 안 막는 대신 왜 켰는지를 남긴다",
    readFileSync("app/api/admin/flags/[key]/route.ts", "utf8").includes("왜 바꾸는지 적어 주세요"),
  );
  check(
    "**선언된 부분 스위치만 덮어쓴다** — 개방 조건 서술이 사라지면 안 된다(D-67)",
    readFileSync("lib/flags/admin.ts", "utf8").includes("declared.has(key)"),
  );
  check(
    "**updated_by 를 입력으로 받지 않는다** — 남의 이름으로 '이 사람이 켰다' 가 만들어진다",
    !readFileSync("app/api/admin/flags/[key]/route.ts", "utf8").includes("updatedBy"),
  );

  // ── 집행되지 않는 조치를 만들지 않는다 ────────────────────────────────────
  check(
    "**지역·세그먼트 부분 공개를 만들지 않았고 그 사실이 API 본문에 실린다** (함정 3)",
    readFileSync("app/api/admin/flags/[key]/route.ts", "utf8").includes("segmentRolloutAvailable") &&
      readFileSync("lib/flags/admin.ts", "utf8").includes("available: false"),
  );

  // ── 픽스처 ────────────────────────────────────────────────────────────────
  check(
    "플래그 두 행이 시드에 있다 (0건이면 콘솔이 빈 화면이라 아무것도 확인 못 한다)",
    sql(`select count(*) from public.feature_flags;`) === "2",
  );
  check(
    "**부분 스위치를 가진 행이 있다** — 그 경로가 실제로 도는지 본다",
    sql(`select count(*) from public.feature_flags
           where key = 'schedule.views' and rollout_json ? 'timeline';`) === "1",
  );
  check(
    "**개방 조건이 적힌 행이 있다**(D-67) — 조건 표시 경로가 도는지 본다",
    sql(`select count(*) from public.feature_flags
           where key = 'community.enabled' and rollout_json ? 'reason';`) === "1",
  );

  // ── 화면·라우트가 이어져 있다 ─────────────────────────────────────────────
  check("`/admin/flags` 화면이 실재한다", existsSync("app/(admin)/admin/flags/page.tsx"));
  check(
    "**내비가 `/admin/flags` 를 가리킨다** — 안 그러면 URL 을 직접 쳐야 한다(FIX-25)",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/flags"'),
  );
  check(
    "플래그 화면이 캐시되지 않는다 (스위치가 캐시되면 스위치가 아니다 · FIX-22)",
    readFileSync("app/(admin)/admin/flags/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**되돌릴 수 없는 것을 먼저 말한다** — 플래그는 되돌려도 그 사이 벌어진 일은 남는다",
    readFileSync("lib/core/flags/registry.ts", "utf8").includes("irreversible"),
  );
  check(
    "**전환을 증적에 남긴다** (entity_events + audit_logs)",
    readFileSync("lib/flags/admin.ts", "utf8").includes('entityType: "feature_flag"') &&
      readFileSync("lib/flags/admin.ts", "utf8").includes("writeAuditLog"),
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0063 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// S8-13 — 모니터링·장애 대응 (§7.4 · 0064 · FIX-32)
//
// 이 블록이 보는 것은 셋이다.
//   (가) `client_events` 가 **비인증 INSERT 를 받으면서도** 낙서장이 되지 않는가
//   (나) 배치 이름 어휘가 코드·DB·`vercel.json` 세 곳에서 같은가
//   (다) 화면이 **보내지 않는다는 사실을 응답 본문까지** 들고 가는가 (함정 3)
// ═══════════════════════════════════════════════════════════════════════════
{
  const vendorOwner = idOf("vendor@local.test");

  // ── 층 1: `client_events` 의 권한 ─────────────────────────────────────────
  check(
    "client_events 에 RLS 가 켜져 있다",
    sql(`select relrowsecurity from pg_class where oid = 'public.client_events'::regclass;`) === "t",
  );
  check(
    "**비인증이 신고를 넣을 수 있다** — 로그인 전의 사건이라 그렇다(FIX-32)",
    asAnon(`insert into public.client_events (kind, code)
              values ('login_failed', 'AUTH_TIMEOUT') returning 1;`) === "1",
  );
  check(
    "**비인증은 자기가 넣은 것조차 못 읽는다** — 어떤 실패가 몰렸는지는 운영 정보다",
    rejectedWith(/permission denied/, () => asAnon(`select count(*) from public.client_events;`)),
  );
  check(
    "**로그인해도 운영자가 아니면 못 읽는다** (정책이 막는다)",
    asUser(owner, `select count(*) from public.client_events;`) === "0" &&
      asUser(vendorOwner, `select count(*) from public.client_events;`) === "0",
  );
  check(
    "**운영자는 행을 읽는다** — 어느 실패가 몰렸는지 한 줄씩 본다(D-115)",
    Number(asUser(adminUser, `select count(*) from public.client_events;`)) >= 3,
  );

  // ── 층 1: 쓸 수 없는 칸을 표에서 걷었는가 (FIX-36 · 위조 사례) ────────────
  check(
    "**시각을 손으로 정하지 못한다** — 과거·미래로 로그를 흩뿌릴 수 있다",
    rejectedWith(/permission denied|column/i, () =>
      asAnon(`insert into public.client_events (kind, code, occurred_at)
                values ('login_failed', 'AUTH_TIMEOUT', now() - interval '400 days');`),
    ),
  );
  check(
    "**넣은 신고를 고치거나 지울 수 없다** — 신고는 사건이지 문서가 아니다",
    rejectedWith(/permission denied|row-level security/i, () =>
      asAnon(`update public.client_events set code = 'AUTH_CONFIG';`),
    ) &&
      rejectedWith(/permission denied|row-level security/i, () =>
        asAnon(`delete from public.client_events;`),
      ),
  );
  check(
    "**운영자도 신고를 지우지 못한다** — 불리한 신호를 지울 수 있으면 관측이 아니다",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(adminUser, `delete from public.client_events;`),
    ),
  );
  check(
    "client_events 에 TRUNCATE 가 열려 있지 않다 (함정 7 · RLS 는 TRUNCATE 에 안 걸린다)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'client_events'
             and privilege_type = 'TRUNCATE' and grantee in ('anon', 'authenticated');`) === "0",
  );

  // ── 층 1: 어휘를 표가 강제한다 — 비인증 경로라 더 중요하다 ────────────────
  check(
    "**모르는 사유 코드를 거부한다** — 자유 문자열이면 표가 낙서장이 된다",
    rejectedWith(/client_events_code_vocab/, () =>
      asAnon(`insert into public.client_events (kind, code) values ('login_failed', 'DROP TABLE');`),
    ),
  );
  check(
    "**모르는 종류를 거부한다**",
    rejectedWith(/client_events_kind_vocab/, () =>
      asAnon(`insert into public.client_events (kind, code) values ('whatever', 'AUTH_TIMEOUT');`),
    ),
  );
  check(
    "**식별정보를 담을 칸이 아예 없다** — 있으면 언젠가 채워진다(§5.2)",
    sql(`select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'client_events'
             and column_name not in ('id', 'kind', 'code', 'occurred_at');`) === "0",
  );

  // ── 층 2 (FIX-41): 부모의 RLS 를 빌리는 정책이 있는가 ─────────────────────
  check(
    "**client_events 정책이 부모 표를 참조하지 않는다** — 자기 조건을 스스로 말한다",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'client_events'
             and (coalesce(qual, '') like '%exists%' or coalesce(with_check, '') like '%exists%');`) ===
      "0",
  );

  // ── `job_runs` 어휘가 세 곳에서 같은가 ────────────────────────────────────
  {
    const monitor = readFileSync("lib/core/ops/monitor.ts", "utf8");
    const names = [...monitor.matchAll(/name: "([a-z]+(?:-[a-z]+)+)",/g)].map((match) => match[1]);
    const inCheck = sql(`select pg_get_constraintdef(oid) from pg_constraint
                           where conname = 'job_runs_name_vocab';`);

    check("코드가 배치 열 종을 선언한다 (명세 §4.5)", new Set(names).size === 10);
    check(
      "**CHECK 어휘가 코드와 같다** — 갈리면 배치가 이름을 못 남기거나 화면이 그 배치를 모른다",
      names.length > 0 && names.every((name) => inCheck.includes(`'${name}'`)),
    );
    check(
      "**모르는 배치 이름을 거부한다** — 오타 난 이름은 '어느 배치인지 모르는 실행' 이 된다",
      rejectedWith(/job_runs_name_vocab/, () =>
        sql(`insert into public.job_runs (job_name, started_at, status)
               values ('purge-document', now(), 'running');`),
      ),
    );
  }

  // ── 배치가 실제로 등록됐는가 ──────────────────────────────────────────────
  {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    const scheduled = (vercel.crons ?? []).map((cron) => cron.path);
    const routes = readdirSync("app/api/jobs", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `/api/jobs/${entry.name}`)
      .sort();

    check(
      "**라우트가 있는 배치가 전부 cron 에 등록돼 있다** — 안 부르면 만든 적 없는 것과 같다",
      routes.length > 0 && [...scheduled].sort().join(",") === routes.join(","),
    );
    check(
      "**등록된 경로에는 전부 라우트가 있다** — 없으면 매번 404 를 부른다",
      scheduled.every((path) => routes.includes(path)),
    );
    check(
      "**Vercel Cron 은 GET 으로 부른다** — 모든 배치가 GET 을 낸다(없으면 매번 405)",
      routes.every((path) =>
        readFileSync(`app${path}/route.ts`, "utf8").includes("export const GET = POST"),
      ),
    );
    check(
      "**모든 배치가 공통 인증을 쓴다** — `CRON_SECRET` 또는 서비스롤 키",
      routes.every((path) =>
        readFileSync(`app${path}/route.ts`, "utf8").includes("authorizeJob(request)"),
      ),
    );
    check(
      "**모든 배치가 `job_runs` 를 채운다** — 안 채우면 화면이 '한 번도 안 돌았다' 로 적는다",
      routes.every((path) => {
        // **라우트 파일만 보면 안 된다.** `purge-documents` 는 기록을 `lib/privacy/purge.ts`
        // 안에서 남긴다 — 라우트 본문만 훑는 검사는 그것을 '안 채운다' 로 읽는다.
        // 라우트가 부르는 `@/lib/...` 모듈을 한 겹 따라간다.
        const src = readFileSync(`app${path}/route.ts`, "utf8");
        const writes = (text) => text.includes("openJobRun") || text.includes('.from("job_runs")');
        if (writes(src)) return true;

        return [...src.matchAll(/from "@\/(lib\/[^"]+)"/g)].some((match) => {
          const file = `${match[1]}.ts`;
          return existsSync(file) && writes(readFileSync(file, "utf8"));
        });
      }),
    );
  }

  // ── 픽스처 — **이미 실패 상태인 것만 보면 검사가 통과한다**(함정 8) ───────
  check(
    "**상태가 두 가지 이상 있다** — 전부 '기록 없음' 이면 갈라 보이는지 확인할 수 없다",
    Number(sql(`select count(distinct job_name) from public.job_runs;`)) >= 2 &&
      sql(`select count(*) from public.job_runs where status = 'succeeded';`) !== "0" &&
      sql(`select count(*) from public.job_runs where status = 'failed';`) !== "0",
  );
  check(
    "**자격증명과 인프라 실패가 둘 다 시드에 있다** — 경보 분기를 둘 다 눈다",
    sql(`select count(*) from public.client_events where code = 'AUTH_INVALID_CREDENTIALS';`) !==
      "0" &&
      sql(`select count(*) from public.client_events where code <> 'AUTH_INVALID_CREDENTIALS';`) !==
        "0",
  );

  // ── 화면·라우트가 이어져 있다 ────────────────────────────────────────────
  check("`/admin/ops` 화면이 실재한다", existsSync("app/(admin)/admin/ops/page.tsx"));
  check(
    "**내비가 `/admin/ops` 를 가리킨다** — 안 그러면 URL 을 직접 쳐야 한다(FIX-25)",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/admin/ops"'),
  );
  check(
    "운영 상태 화면이 캐시되지 않는다 (5분 전 상태를 보이면 장애 화면이 아니다)",
    readFileSync("app/(admin)/admin/ops/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );

  // ── 함정 3: 화면이 안 그리는 것만으로는 부족하다 ─────────────────────────
  check(
    "**경보를 보내지 않는다는 사실이 API 응답 본문에 실린다**(D-147 · D-28)",
    readFileSync("lib/ops/admin.ts", "utf8").includes("alertDelivery") &&
      readFileSync("lib/core/ops/monitor.ts", "utf8").includes("available: false"),
  );
  check(
    "**로그인 실패 집계가 전수가 아니라는 사실도 본문에 실린다**(FIX-32)",
    readFileSync("lib/ops/admin.ts", "utf8").includes("loginObservability"),
  );
  check(
    "**측정하지 않은 것을 0 으로 적지 않는다** — 집계 키가 빠지면 오류로 끝난다",
    readFileSync("lib/ops/admin.ts", "utf8").includes("OPS_LOAD_FAILED"),
  );

  // ── FIX-32 의 신고 경로가 실제로 이어져 있는가 ───────────────────────────
  check(
    "신고 라우트가 실재한다",
    existsSync("app/api/observability/client-event/route.ts"),
  );
  check(
    "**로그인 화면이 그 라우트를 부른다** — 만든 경로에 들어가는 자리를 잇는다",
    readFileSync("app/(auth)/login/LoginForm.tsx", "utf8").includes(
      "/api/observability/client-event",
    ),
  );
  check(
    "**신고가 로그인을 막지 않는다** — 기다리지 않고 실패를 삼킨다",
    readFileSync("app/(auth)/login/LoginForm.tsx", "utf8").includes("keepalive: true"),
  );
  check(
    "**신고 라우트가 서비스롤을 쓰지 않는다** — 비인증 입력에 RLS 우회 권한을 붙이지 않는다",
    !readFileSync("app/api/observability/client-event/route.ts", "utf8").includes(
      "createAdminClient",
    ),
  );
  check(
    "**신고 라우트가 성공·실패를 구분해 알려주지 않는다** — 표의 어휘를 캐는 도구가 된다",
    readFileSync("app/api/observability/client-event/route.ts", "utf8").includes("status: 204"),
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0064 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// S5-10 — 예약 승인·거절 (F-V-08 · 0065 · **FIX-44**)
//
// **이번 감사는 잠재된 구멍이 아니라 오늘 통하는 경로를 찾았다.** 커플 구성원이
// 업체 동의 없이 `status='confirmed'` 예약을 만들 수 있었고, `reviews_insert` 가
// 그 상태를 후기 자격으로 삼으므로 **거래한 적 없는 업체에 검증 후기를 남길 수
// 있었다.** 아래 검사들이 그 길이 다시 열리지 않는지 본다.
// ═══════════════════════════════════════════════════════════════════════════
{
  const vendorOwner = idOf("vendor@local.test");
  const outsiderId = idOf("couple-a@local.test");
  const bookingVendorId = sql(`select vendor_id from public.bookings
                                 where couple_id = '${coupleId}' limit 1;`);
  // **상태별로 따로 잡는다.** 아무 예약이나 집으면 이미 승인된 행을 집어
  // `bookings_decision_shape` 가 **먼저** 걸리고, 그러면 정작 보려던 CHECK 은 확인하지
  // 못한 채 검사가 통과한다(함정 8 · S8-13 이 같은 자리에서 물렸다).
  const pendingBookingId = sql(`select id from public.bookings
                                  where accepted_at is null and declined_at is null limit 1;`);
  const acceptedBookingId = sql(`select id from public.bookings
                                   where accepted_at is not null limit 1;`);

  // ── 층 1: 당사자 직접 쓰기가 걷혔는가 ─────────────────────────────────────
  check(
    "**bookings 에 authenticated 쓰기 권한이 없다** (INSERT·UPDATE·DELETE 전부)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'bookings'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**컬럼 권한도 남아 있지 않다** — `revoke` 를 표에만 걸면 컬럼 GRANT 가 따로 산다(FIX-36)",
    sql(`select count(*) from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'bookings'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**anon 은 SELECT 도 못 한다** — 정책이 없어 지금도 안 보이지만 GRANT 가 남으면 정책 한 줄로 열린다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'bookings'
             and grantee = 'anon' and privilege_type = 'SELECT';`) === "0",
  );
  check(
    "**쓰기 정책도 함께 걷었다** — GRANT 만 회수하고 정책을 남기면 같은 구멍이 조용히 되살아난다",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'bookings'
             and cmd in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );

  // ── FIX-44 재현: 위조 경로가 실제로 막혔는가 ──────────────────────────────
  check(
    "**FIX-44 — 커플이 확정 예약을 스스로 만들 수 없다**(재현 확인된 경로다)",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(
        owner,
        `insert into public.bookings (couple_id, vendor_id, status, total_amount, deposit_amount)
           values ('${coupleId}', '${bookingVendorId}', 'confirmed', 0, 0);`,
      ),
    ),
  );
  check(
    "**커플이 자기 예약의 상태를 바꿀 수 없다** — 'fulfilled' 로 옮겨 후기 자격을 얻는 길도 막힌다",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(owner, `update public.bookings set status = 'fulfilled';`),
    ),
  );
  check(
    "**업체도 예약 상태를 직접 못 바꾼다** — 승인은 서비스롤 경로가 사유·시각과 함께 남긴다",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(vendorOwner, `update public.bookings set status = 'confirmed';`),
    ),
  );
  check(
    "**아무도 예약을 지우지 못한다** — cascade 가 계약·분쟁·에스크로·후기를 함께 지운다(D-23)",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(owner, `delete from public.bookings;`),
    ) &&
      rejectedWith(/permission denied|row-level security/i, () =>
        asUser(vendorOwner, `delete from public.bookings;`),
      ),
  );
  check(
    "**cascade 를 쥔 자식 표를 센다** — 예약 하나가 지워지면 함께 사라지는 표가 다섯이다",
    Number(sql(`select count(*) from pg_constraint
                  where confrelid = 'public.bookings'::regclass and contype = 'f'
                    and confdeltype = 'c';`)) >= 5,
  );

  // ── 읽기는 그대로 열려 있는가 (막기만 하고 못 읽게 하면 화면이 죽는다) ────
  check(
    "**커플은 자기 예약을 읽는다** — 걷은 것은 쓰기지 읽기가 아니다",
    Number(asUser(owner, `select count(*) from public.bookings;`)) >= 1,
  );
  check(
    "**업체는 자기 예약을 읽는다**",
    Number(asUser(vendorOwner, `select count(*) from public.bookings;`)) >= 1,
  );
  check(
    "**남은 남의 예약을 못 읽는다**",
    asUser(outsiderId, `select count(*) from public.bookings;`) === "0",
  );

  // ── 층 2 (FIX-41): 정책이 부모의 정책에 기대는가 ──────────────────────────
  check(
    "**bookings_select 가 소유자 조건을 스스로 들고 있다** — 부모 표를 훑는 모양이 아니다",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'bookings'
             and coalesce(qual, '') like '%is_couple_member%'
             and coalesce(qual, '') like '%is_vendor_member%';`) === "1",
  );

  // ── 결정 컬럼: 허용 조합만 선다 ───────────────────────────────────────────
  check(
    "**사유 없는 거절을 표가 거부한다**(D-24)",
    rejectedWith(/bookings_decline_shape/, () =>
      sql(`update public.bookings set declined_at = now(), status = 'cancelled'
             where id = '${pendingBookingId}';`),
    ),
  );
  check(
    "**승인과 거절이 동시에 설 수 없다**",
    rejectedWith(/bookings_decision_shape|bookings_declined_status_shape/, () =>
      sql(`update public.bookings
              set accepted_at = now(), accepted_by = null,
                  declined_at = now(), decline_reason = '동시에 서는지 본다'
            where id = '${pendingBookingId}';`),
    ),
  );
  check(
    "**거절해 두고 예약이 살아 있을 수 없다** — 진행 중으로 그려지고 재고도 잡힌 채 남는다",
    rejectedWith(/bookings_declined_status_shape/, () =>
      sql(`update public.bookings
              set declined_at = now(), decline_reason = '상태를 안 옮기면 어떻게 되는지 본다'
            where id = '${pendingBookingId}';`),
    ),
  );
  check(
    "**승인자 없이 승인 시각만 있는 것은 허용한다** — 0065 이관분이고 사람을 지어내지 않았다",
    sql(`select count(*) from pg_constraint where conname = 'bookings_accept_shape';`) === "1",
  );

  // ── 결정은 되돌릴 수 없다 (서비스롤이 RLS 를 비켜 가므로 트리거가 마지막이다) ──
  check(
    "**이미 승인한 예약의 승인 시각을 바꿀 수 없다**(D-23) — 서비스롤로도 막힌다",
    rejectedWith(/bookings_accept_immutable|바꿀 수 없습니다/, () =>
      sql(`update public.bookings set accepted_at = now() - interval '10 days'
             where id = '${acceptedBookingId}';`),
    ),
  );

  // ── 이관이 실제로 됐는가 ──────────────────────────────────────────────────
  check(
    "**hold 를 지난 예약은 승인을 거친 것으로 이관됐다** — 안 하면 기존 예약이 전부 '승인 대기' 로 뜬다",
    sql(`select count(*) from public.bookings
           where status in ('confirmed', 'fulfilled') and accepted_at is null;`) === "0",
  );
  check(
    "**이관분은 승인자를 비워 뒀다** — 누르지도 않은 승인을 누른 것으로 만들지 않는다",
    Number(sql(`select count(*) from public.bookings
                  where accepted_at is not null and accepted_by is null;`)) >= 1,
  );

  // ── 어휘가 코드와 표에서 같은가 ───────────────────────────────────────────
  {
    const consoleSrc = readFileSync("lib/core/booking/console.ts", "utf8");
    const enumLabels = sql(`select string_agg(e.enumlabel, ',' order by e.enumsortorder)
                              from pg_enum e join pg_type t on t.oid = e.enumtypid
                             where t.typname = 'booking_status';`);

    check(
      "**코드의 상태 어휘가 열거형과 같다** — 갈리면 화면이 모르는 상태가 생긴다",
      enumLabels
        .split(",")
        .every((label) => consoleSrc.includes(`"${label}"`)),
    );
    check(
      "**후기 자격 목록이 예약 상태 안에 있다** — 정책과 코드가 같은 값을 본다",
      readFileSync("lib/core/review/write.ts", "utf8").includes('["confirmed", "fulfilled"]'),
    );
  }

  // ── 승인이 계약 발행의 선행인가 (승인 버튼이 장식이 아닌가) ───────────────
  check(
    "**승인 없이는 계약을 발행할 수 없다** — 이 문이 없으면 승인 버튼이 장식이다",
    readFileSync("lib/contract/actions.ts", "utf8").includes("CONTRACT_BOOKING_NOT_ACCEPTED"),
  );
  check(
    "**결정 자격을 순수 함수 하나가 판정한다** — 화면과 API 가 다른 답을 내면 버튼이 눌리지 않는다",
    readFileSync("lib/bookings/vendor.ts", "utf8").includes("canDecide(") &&
      readFileSync("app/(vendor)/vendor/bookings/page.tsx", "utf8").includes("row.canDecide"),
  );

  // ── 증적 ──────────────────────────────────────────────────────────────────
  check(
    "**승인·거절을 entity_events 에 남긴다** — 예약에는 지금까지 전이 기록이 아예 없었다",
    readFileSync("lib/bookings/vendor.ts", "utf8").includes('entityType: "booking"') &&
      readFileSync("lib/audit/record.ts", "utf8").includes('| "booking"'),
  );
  check(
    "**거절 사유 본문을 이벤트에 담지 않는다**(§5.3) — 사유는 표가 갖고 이벤트는 사실만 남긴다",
    !readFileSync("lib/bookings/vendor.ts", "utf8").includes("memo: reason"),
  );

  // ── 화면·라우트가 이어져 있다 ────────────────────────────────────────────
  check("`/bookings` 목록 화면이 실재한다", existsSync("app/(consumer)/bookings/page.tsx"));
  check("`/bookings/[id]` 상세 화면이 실재한다", existsSync("app/(consumer)/bookings/[id]/page.tsx"));
  check("`/vendor/bookings` 화면이 실재한다", existsSync("app/(vendor)/vendor/bookings/page.tsx"));
  check(
    "**`/me` 가 예약 목록을 가리킨다** — 하단 탭은 다섯 칸이 차서 여기가 진입점이다(D-55)",
    readFileSync("app/(consumer)/me/page.tsx", "utf8").includes('href="/bookings"'),
  );
  check(
    "**예약 상세가 다섯 진입점을 전부 그린다** — 이 화면이 없어서 다섯이 도달 불가였다(FIX-25)",
    ["contract", "checkout", "cancel", "escrow", "review"].every((key) =>
      readFileSync("lib/core/booking/console.ts", "utf8").includes(`"${key}"`),
    ),
  );
  check(
    "**막힌 진입점에도 이유가 붙는다** — 감추면 '그런 기능이 없다' 로 읽힌다",
    readFileSync("app/(consumer)/bookings/[id]/page.tsx", "utf8").includes("entry.blocked"),
  );
  check(
    "예약 화면 셋이 캐시되지 않는다 (승인·결제 상태가 바뀌는 화면이다)",
    ["app/(consumer)/bookings/page.tsx", "app/(consumer)/bookings/[id]/page.tsx",
     "app/(vendor)/vendor/bookings/page.tsx"].every((path) =>
      readFileSync(path, "utf8").includes('export const dynamic = "force-dynamic"'),
    ),
  );
  check(
    "**FIX-23 의 죽은 링크 하나가 사라졌다** — `VENDOR_NAV` 의 `/vendor/bookings` 가 이제 실재한다",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/vendor/bookings"') &&
      existsSync("app/(vendor)/vendor/bookings/page.tsx"),
  );

  // ── 픽스처 — **이미 실패 상태인 것만 보면 검사가 통과한다**(함정 8) ───────
  check(
    "**승인 대기 예약이 시드에 있다** — 전부 확정 상태면 승인 경로가 도는지 확인할 수 없다",
    Number(sql(`select count(*) from public.bookings
                  where status = 'hold' and accepted_at is null and declined_at is null;`)) >= 1,
  );
  check(
    "**상태가 두 갈래 이상이다** — 한 갈래뿐이면 보드가 갈라 그리는지 확인할 수 없다",
    Number(sql(`select count(distinct status) from public.bookings;`)) >= 2,
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0065 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// S5-12 — 쿠폰함·결제 적용 (F-C-35·36 · 0066 · **FIX-13 · FIX-45**)
//
// 쿠폰은 **돈이 직접 걸린 표**다. 할인액과 부담 주체를 당사자가 적을 수 있으면
// 그것은 남의 정산에서 돈을 빼는 경로다. 아래 검사들이 그 길이 없는지 본다.
// ═══════════════════════════════════════════════════════════════════════════
{
  const vendorOwner = idOf("vendor@local.test");
  const outsiderCouple = idOf("couple-a@local.test");
  const issueId = sql(`select id from public.coupon_issues
                         where couple_id = '${coupleId}' limit 1;`);

  // ── 층 1: 쓰기가 걷혔는가 ────────────────────────────────────────────────
  check(
    "**coupon_redemptions 에 당사자 쓰기 권한이 없다** — 할인액·부담 주체를 스스로 적을 수 없다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'coupon_redemptions'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**컬럼 권한도 남아 있지 않다** — 표에만 걸면 컬럼 GRANT 가 따로 산다(FIX-36)",
    sql(`select count(*) from information_schema.column_privileges
           where table_schema = 'public'
             and table_name in ('coupon_redemptions', 'coupon_issues')
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**coupon_issues 에 당사자 쓰기 권한이 없다** — 자기 이름으로 발급하면 발행 조건이 장식이 된다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'coupon_issues'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**issued_count 는 대표도 못 쓴다** — 0 으로 되돌리면 수량 제한(sold_out)이 무력해진다",
    sql(`select count(*) from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'coupons'
             and column_name = 'issued_count' and grantee = 'authenticated'
             and privilege_type in ('INSERT', 'UPDATE');`) === "0",
  );
  check(
    "**쿠폰을 지울 수 있는 사람이 없다** — 사용 이력이 달린 쿠폰이 사라지면 정산 근거가 사라진다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'coupons'
             and grantee in ('anon', 'authenticated') and privilege_type = 'DELETE';`) === "0",
  );
  check(
    "**비로그인은 쿠폰 정의를 못 읽는다** — 발행 조건·수량은 운영 정보다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('coupons', 'coupon_issues', 'coupon_redemptions')
             and grantee = 'anon' and privilege_type = 'SELECT';`) === "0",
  );

  // ── 위조 시도: 실제로 막히는가 ───────────────────────────────────────────
  check(
    "**커플이 사용 기록을 스스로 만들 수 없다** (할인액·부담 주체를 적는 경로다)",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(
        owner,
        `insert into public.coupon_redemptions
           (coupon_issue_id, discount_amount, borne_by)
         values ('${issueId}', 9999999, 'vendor');`,
      ),
    ),
  );
  check(
    "**커플이 자기에게 쿠폰을 발급할 수 없다**",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(
        owner,
        `insert into public.coupon_issues (coupon_id, couple_id, status)
         select id, '${coupleId}', 'issued' from public.coupons limit 1;`,
      ),
    ),
  );
  check(
    "**커플이 발급분 상태를 되돌릴 수 없다** — 'used' 를 'issued' 로 바꾸면 무한히 쓴다",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(owner, `update public.coupon_issues set status = 'issued';`),
    ),
  );
  check(
    "**업체 대표도 발급 계수기를 못 만진다**",
    rejectedWith(/permission denied|42501/i, () =>
      asUser(vendorOwner, `update public.coupons set issued_count = 0;`),
    ),
  );

  // ── 읽기 경계 ────────────────────────────────────────────────────────────
  check(
    "**커플은 자기 쿠폰을 읽는다** — 걷은 것은 쓰기지 읽기가 아니다",
    Number(asUser(owner, `select count(*) from public.coupon_issues;`)) >= 3,
  );
  check(
    "**남은 남의 쿠폰을 못 읽는다**",
    asUser(outsiderCouple, `select count(*) from public.coupon_issues;`) === "0",
  );
  check(
    "**발급분과 쿠폰 정의가 함께 보인다** — 한쪽만 보이면 목록에서 행이 조용히 사라진다(함정 1)",
    Number(asUser(owner, `select count(*) from public.coupons;`)) >= 3,
  );

  // ── 층 2 (FIX-41): 정책이 다른 표의 정책에 기대는가 ──────────────────────
  {
    const helpers = sql(`select string_agg(p.proname, ',' order by p.proname)
                           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public'
                            and p.proname in ('has_coupon_issue', 'owns_coupon_issue');`);

    check("쿠폰 정책이 쓰는 도우미 둘이 실재한다", helpers === "has_coupon_issue,owns_coupon_issue");
    check(
      "**두 도우미가 소유자 조건을 자기 안에 들고 있다** — 없으면 부모가 열리는 날 자식이 함께 열린다",
      ["has_coupon_issue", "owns_coupon_issue"].every((name) =>
        sql(`select pg_get_functiondef(oid) from pg_proc where proname = '${name}';`).includes(
          "auth.uid()",
        ),
      ),
    );
  }

  // ── 한 번만 쓴다 — 경계는 유니크 인덱스다 ────────────────────────────────
  // 거절 사유는 0032 가 건 UNIQUE 다(`coupon_redemptions_coupon_issue_id_key`).
  // S5-12 는 같은 인덱스를 다시 만들지 않고 **그 보장이 살아 있는지를 여기서 본다.**
  // **시드 행에 기대지 않는다.** 앞선 검사·흐름 점검이 그 발급분을 이미 썼을 수 있고,
  // 그러면 첫 삽입부터 걸려 무엇을 확인했는지 알 수 없다. 쿠폰과 발급분을 **둘 다**
  // 이 트랜잭션 안에서 만든다 — 쿠폰을 새로 만들지 않으면 `uq_coupon_issues_couple`
  // (커플·쿠폰 1건)이 **먼저** 걸려 정작 보려던 것을 확인하지 못한다(함정 8).
  //
  // 막는 것은 셋이 겹쳐 있다: 트리거(`mark_coupon_issue_used`)가 먼저 발급분을 `used`
  // 로 옮기고 두 번째를 거절하며, 그 뒤에 0032 의 UNIQUE 가 backstop 으로 선다.
  // **어느 층에서 막히든 통과**로 본다 — 확인하려는 것은 "두 번 쓸 수 없다" 이지
  // "어느 제약이 막느냐" 가 아니다.
  check(
    "**같은 발급분으로 두 번 쓸 수 없다** — 상태 값은 읽은 시점의 값이라 동시 요청을 못 막는다",
    rejectedWith(/사용할 수 없는 쿠폰|coupon_redemptions_coupon_issue_id_key|23505/, () =>
      sql(`begin;
             insert into public.coupons (id, issuer_type, issuer_id, name, discount_type,
                                         discount_value, max_discount_amount, min_order_amount,
                                         issue_condition, status)
               values ('11111111-0000-0000-0000-000000000001', 'platform', null, 'RLS중복시험',
                       'amount', 1000, null, 0, 'manual_grant', 'active');
             insert into public.coupon_issues (id, coupon_id, couple_id, status)
               values ('11111111-2222-3333-4444-555555555555',
                       '11111111-0000-0000-0000-000000000001', '${coupleId}', 'issued');
             insert into public.coupon_redemptions (coupon_issue_id, discount_amount, borne_by)
               values ('11111111-2222-3333-4444-555555555555', 1000, 'platform');
             insert into public.coupon_redemptions (coupon_issue_id, discount_amount, borne_by)
               values ('11111111-2222-3333-4444-555555555555', 1000, 'platform');
           rollback;`),
    ),
  );
  check(
    "**결제 한 건에 쿠폰 한 장이다**(§7.4) — 두 장이 겹치면 부담 주체가 둘이 된다",
    sql(`select count(*) from pg_indexes
           where schemaname = 'public' and indexname = 'uq_coupon_redemptions_payment';`) === "1",
  );
  check(
    "**결제에 붙은 사용은 예약도 가리킨다** — 비면 업체가 자기 정산에서 나간 돈을 못 본다",
    rejectedWith(/coupon_redemptions_target_shape/, () =>
      sql(`insert into public.coupon_redemptions
             (coupon_issue_id, payment_id, discount_amount, borne_by)
           values ('${issueId}', gen_random_uuid(), 1000, 'platform');`),
    ),
  );

  // ── FIX-45: 업체 쿠폰이 남의 결제에 쓰이지 않는가 ────────────────────────
  check(
    "**업체 발행 쿠폰은 그 업체와의 거래에만 쓴다**(FIX-45) — 판정이 순수 함수에 있다",
    readFileSync("lib/core/coupon/coupon.ts", "utf8").includes("other_vendor") &&
      readFileSync("lib/core/coupon/coupon.ts", "utf8").includes("bookingVendorId"),
  );
  check(
    "**결제 경로가 예약의 업체를 넘긴다** — 안 넘기면 판정이 있어도 안 돈다",
    readFileSync("lib/payments/charge.ts", "utf8").includes("bookingVendorId: context.vendorId"),
  );
  check(
    "**정산이 할인액을 예약의 업체에서 뺀다** — 그래서 발행 업체와 어긋나면 안 된다",
    readFileSync("lib/settlements/actions.ts", "utf8").includes('from("coupon_redemptions")'),
  );

  // ── FIX-13: 회차 금액에 쿠폰이 반영되는가 ────────────────────────────────
  check(
    "**청구 금액이 할인 뒤 금액이다** — 안 그러면 회차마다 정가가 빠져 합계가 총액을 넘는다",
    readFileSync("lib/payments/charge.ts", "utf8").includes("const chargeAmount ="),
  );
  check(
    "**이미 쓴 할인을 잔액 계산에 넘긴다** — 안 넘기면 다 내고도 잔액이 남는다",
    readFileSync("lib/payments/loader.ts", "utf8").includes("priorDiscountAmount") &&
      readFileSync("lib/core/payment/checkout.ts", "utf8").includes("priorDiscountAmount"),
  );
  check(
    "**화면이 금액을 보내지 않는다** — 발급분 id 만 보낸다(할인액을 클라이언트가 정하면 안 된다)",
    readFileSync("app/(consumer)/checkout/[bookingId]/CheckoutView.tsx", "utf8").includes(
      "couponIssueId,",
    ) &&
      !readFileSync("app/(consumer)/checkout/[bookingId]/CheckoutView.tsx", "utf8").includes(
        "discountAmount:",
      ),
  );

  // ── 화면·라우트가 이어져 있다 ────────────────────────────────────────────
  check("`/coupons` 화면이 실재한다", existsSync("app/(consumer)/coupons/page.tsx"));
  check(
    "**`/me` 가 쿠폰함을 가리킨다** — 하단 탭은 다섯 칸이 차서 여기가 진입점이다(D-55)",
    readFileSync("app/(consumer)/me/page.tsx", "utf8").includes('href="/coupons"'),
  );
  check(
    "**결제 화면이 더는 '준비 중' 이라 말하지 않는다** — 다 만든 기능을 준비 중이라 적지 않는다",
    readFileSync("lib/payments/loader.ts", "utf8").includes("featureReady: true"),
  );
  check(
    "**못 쓰는 쿠폰도 결제 화면에 사유와 함께 남는다**(F-C-36)",
    readFileSync("app/(consumer)/checkout/[bookingId]/CheckoutView.tsx", "utf8").includes(
      "coupon-blocked",
    ),
  );
  check(
    "쿠폰함이 캐시되지 않는다 (만료가 시계로 판정되는 화면이다)",
    readFileSync("app/(consumer)/coupons/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );

  // ── 픽스처 — **양쪽 갈래가 다 닿아야 검사가 뭔가를 본다**(함정 8) ────────
  check(
    "**쓸 수 있는 쿠폰과 못 쓰는 쿠폰이 둘 다 시드에 있다**",
    Number(sql(`select count(*) from public.coupon_issues where expires_at > now();`)) >= 2 &&
      Number(sql(`select count(*) from public.coupon_issues where expires_at < now();`)) >= 1,
  );
  check(
    "**플랫폼 발행과 업체 발행이 둘 다 있다** — 부담 주체 분기를 둘 다 눈다",
    sql(`select count(*) from public.coupons where issuer_type = 'platform';`) !== "0" &&
      sql(`select count(*) from public.coupons where issuer_type = 'vendor';`) !== "0",
  );
  // 원문은 `coupon_redemptions` 가 **비어 있음**을 봤는데, 흐름 점검이 실제로 결제하면
  // 행이 생겨 곧바로 깨진다 — 검사가 지키려던 것은 "빈 표" 가 아니라 **"시드가 쿠폰을
  // 미리 써 두지 않는다"** 이므로 그 뜻대로 다시 쓴다(함정 8).
  check(
    "**시드가 쿠폰을 미리 써 두지 않는다** — 그러면 아무도 결제하지 않았는데 '이미 씀' 이 참이 된다",
    Number(sql(`select count(*) from public.coupon_issues where status = 'issued';`)) >= 2,
  );
  check(
    "**사용 기록이 있다면 전부 결제에 붙어 있다** — 결제 없이 쓰인 쿠폰은 없다(D-154)",
    sql(`select count(*) from public.coupon_redemptions where payment_id is null;`) === "0",
  );

  // ── D-27: 리뷰 대가 금지가 여전히 스키마에 있는가 ────────────────────────
  check(
    "**발행 조건에 리뷰가 없다**(D-03 · §7.7) — 자유 문자열이면 '후기 쓰면 5천원' 이 들어온다",
    !sql(`select pg_get_constraintdef(oid) from pg_constraint
            where conname = 'coupons_issue_condition_values';`).match(/review|후기|평점/i),
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0066 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// S5-13 — 업체 쿠폰 발행·관리 (F-V-19 · 0067)
//
// 이 태스크가 허용하는 것은 **자기 업체 이름으로 쿠폰을 만들고 고치는 일**이고,
// 그 자격의 근거는 `is_vendor_owner(issuer_id)` → **`vendor_members`** 다.
// 그래서 세 층을 각각 본다: 쿠폰 표의 권한 · 정책이 기대는 것 · **근거 표**.
// ═══════════════════════════════════════════════════════════════════════════
{
  const vendorOwner = idOf("vendor@local.test");
  const vendorStaffId = idOf("staff@local.test");
  const seedVendorId = sql(`select id from public.vendors
                              where id = (select vendor_id from public.vendor_members
                                            where user_id = '${vendorOwner}' limit 1);`);
  const frozenCouponId = sql(`select id from public.coupons
                                where issuer_type = 'vendor' and issued_count > 0 limit 1;`);
  const freshCouponId = sql(`select id from public.coupons
                               where issuer_type = 'vendor' and issued_count = 0 limit 1;`);

  // ── 층 3 (FIX-44): 자격의 근거가 되는 표를 스스로 쓸 수 있는가 ────────────
  //
  // `is_vendor_owner` 가 `vendor_members` 를 읽는다. 그 표에 자기를 대표로 써 넣을 수
  // 있으면 **이 태스크의 모든 검사가 아무것도 검사하지 않는다.**
  // **거절이 아니라 0행이다.** `vendor_members_update` 의 `using` 이 대표가 아닌
  // 세션에게 그 행을 아예 안 보여주므로 UPDATE 는 **아무것도 안 바꾸고 성공한다** —
  // 예외를 기대하면 막혀 있는데도 검사가 실패한다(실제로 그렇게 물렸다). 그래서
  // **바뀌었는가**를 직접 본다: 그것이 이 검사가 확인하려던 사실이다.
  check(
    "**스태프가 자기를 대표로 승격할 수 없다** — 승격은 대표만 한다",
    asUser(
      vendorStaffId,
      `update public.vendor_members set vendor_role = 'owner'
         where user_id = '${vendorStaffId}';
       select vendor_role from public.vendor_members where user_id = '${vendorStaffId}';`,
    ) === "staff",
  );
  check(
    "**스태프가 자기를 다른 업체의 대표로 넣을 수 없다**",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        vendorStaffId,
        `insert into public.vendor_members (vendor_id, user_id, vendor_role)
           values ('${seedVendorId}', '${vendorStaffId}', 'owner');`,
      ),
    ),
  );
  check(
    "**남이 남의 업체에 스스로 들어갈 수 없다** — 첫 대표는 입점 심사가 만든다",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        owner,
        `insert into public.vendor_members (vendor_id, user_id, vendor_role)
           values ('${seedVendorId}', '${owner}', 'owner');`,
      ),
    ),
  );
  check(
    "**대표도 남의 업체로 멤버 행을 옮길 수 없다** — with check 가 바뀐 뒤의 행을 본다",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        vendorOwner,
        `update public.vendor_members set vendor_id = gen_random_uuid()
           where user_id = '${vendorStaffId}';`,
      ),
    ),
  );

  // ── 층 1: 쿠폰 표의 권한 (0066 이 좁힌 것이 그대로인가) ───────────────────
  check(
    "**coupons 에 표 단위 INSERT·UPDATE 가 없다** — 있으면 컬럼 회수가 무효가 된다(FIX-36)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'coupons'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**issued_count 는 여전히 아무도 못 쓴다** — 0 으로 되돌리면 수량 제한이 무력해진다",
    sql(`select count(*) from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'coupons'
             and column_name = 'issued_count' and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE');`) === "0",
  );
  check(
    "**issuer_id·issuer_type 은 만들 때만 정한다** — 나중에 남의 업체로 비용을 넘길 수 없다",
    sql(`select count(*) from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'coupons'
             and column_name in ('issuer_id', 'issuer_type')
             and grantee = 'authenticated' and privilege_type = 'UPDATE';`) === "0",
  );

  // ── 적격성: "누구의 것인가" 가 빠지지 않았는가 (FIX-45 가 가르친 것) ──────
  check(
    "**남의 업체 이름으로 쿠폰을 만들 수 없다** — 할인액은 그 업체 정산에서 나간다",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        owner,
        `insert into public.coupons
           (issuer_type, issuer_id, name, discount_type, discount_value,
            max_discount_amount, min_order_amount, issue_condition, status)
         values ('vendor', '${seedVendorId}', '남의이름', 'amount', 50000, null, 0,
                 'first_purchase', 'active');`,
      ),
    ),
  );
  check(
    "**스태프는 쿠폰을 만들 수 없다** — 대표만 한다(§3.9)",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        vendorStaffId,
        `insert into public.coupons
           (issuer_type, issuer_id, name, discount_type, discount_value,
            max_discount_amount, min_order_amount, issue_condition, status)
         values ('vendor', '${seedVendorId}', '스태프쿠폰', 'amount', 50000, null, 0,
                 'first_purchase', 'active');`,
      ),
    ),
  );
  check(
    "**업체가 플랫폼 이름으로 쿠폰을 만들 수 없다** — 비용을 플랫폼에 떠넘기는 길이다",
    rejectedWith(/row-level security|permission denied|coupons_issuer_shape/i, () =>
      asUser(
        vendorOwner,
        `insert into public.coupons
           (issuer_type, issuer_id, name, discount_type, discount_value,
            max_discount_amount, min_order_amount, issue_condition, status)
         values ('platform', null, '플랫폼사칭', 'amount', 50000, null, 0,
                 'first_purchase', 'active');`,
      ),
    ),
  );

  // ── 정산 차감액은 대표 전용인가 (§3.9 · 0067) ────────────────────────────
  check(
    "**스태프는 사용 기록(=금액)을 못 본다** — 행이 보이면 금액이 보인다",
    asUser(vendorStaffId, `select count(*) from public.coupon_redemptions;`) === "0",
  );
  check(
    "**스태프도 발급 현황은 본다** — 금액 없이 '쓰였는가' 는 답할 수 있어야 한다",
    Number(asUser(vendorStaffId, `select count(*) from public.coupon_issues;`)) >= 1,
  );
  check(
    "**업체 열람 정책이 대표 조건을 들고 있다**(0067)",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'coupon_redemptions'
             and policyname = 'coupon_redemptions_select_vendor'
             and coalesce(qual, '') like '%is_vendor_owner%';`) === "1",
  );

  // ── 발급이 시작되면 돈에 관한 조건이 얼어붙는가 ──────────────────────────
  check(
    "**발급된 쿠폰의 할인액을 바꿀 수 없다** — 받은 사람이 본 약속이 달라진다",
    rejectedWith(/발급된 쿠폰|coupons_terms_frozen/, () =>
      sql(`update public.coupons set discount_value = 1 where id = '${frozenCouponId}';`),
    ),
  );
  check(
    "**최소 주문 금액도 얼어 있다** — 올리면 이미 받은 쿠폰이 조용히 못 쓰게 된다",
    rejectedWith(/발급된 쿠폰|coupons_terms_frozen/, () =>
      sql(`update public.coupons set min_order_amount = 99999999 where id = '${frozenCouponId}';`),
    ),
  );
  check(
    "**중단은 얼어 있어도 할 수 있다** — 새 발급을 멈출 뿐 받은 것은 그대로다",
    sql(`begin;
           update public.coupons set status = 'paused' where id = '${frozenCouponId}';
         rollback; select 1;`) === "1",
  );
  check(
    "**수량 증량·종료일 연장도 할 수 있다** — 받은 약속을 줄이지 않는다",
    sql(`begin;
           update public.coupons
              set total_quantity = 9999, valid_to = now() + interval '90 days'
            where id = '${frozenCouponId}';
         rollback; select 1;`) === "1",
  );
  check(
    "**아직 안 나간 쿠폰은 얼마든지 고친다** — 만들다 만 것까지 묶을 이유는 없다",
    sql(`begin;
           update public.coupons set discount_value = 12345 where id = '${freshCouponId}';
         rollback; select 1;`) === "1",
  );

  // ── 리뷰 대가 금지가 세 층에서 같은가 (§7.7 · D-03) ──────────────────────
  check(
    "**DB CHECK 이 리뷰 조건을 막는다** (최종 경계)",
    rejectedWith(/coupons_issue_condition_values/, () =>
      sql(`insert into public.coupons
             (issuer_type, issuer_id, name, discount_type, discount_value,
              max_discount_amount, min_order_amount, issue_condition, status)
           values ('vendor', '${seedVendorId}', '후기쿠폰', 'amount', 5000, null, 0,
                   'review_written', 'active');`),
    ),
  );
  check(
    "**순수 함수가 리뷰 조건을 막는다** (화면·API 가 쓰는 층)",
    readFileSync("lib/core/coupon/issue.ts", "utf8").includes("review_reward") &&
      readFileSync("lib/core/coupon/issue.ts", "utf8").includes("isReviewRewardCondition"),
  );
  check(
    "**업체 선택지에 리뷰도 manual_grant 도 없다** (화면 층)",
    !readFileSync("lib/core/coupon/coupon.ts", "utf8").match(
      /VENDOR_ISSUE_CONDITIONS[\s\S]{0,200}review/i,
    ),
  );
  check(
    "**정률에 상한이 없으면 DB 가 막는다** — 상한 없는 정률은 정산을 통째로 지운다",
    rejectedWith(/coupons_max_discount_shape/, () =>
      sql(`insert into public.coupons
             (issuer_type, issuer_id, name, discount_type, discount_value,
              max_discount_amount, min_order_amount, issue_condition, status)
           values ('vendor', '${seedVendorId}', '상한없는정률', 'rate', 1000, null, 0,
                   'first_purchase', 'active');`),
    ),
  );

  // ── 화면·라우트가 이어져 있다 ────────────────────────────────────────────
  check("`/vendor/coupons` 화면이 실재한다", existsSync("app/(vendor)/vendor/coupons/page.tsx"));
  check(
    "**내비가 `/vendor/coupons` 를 가리킨다** — 안 그러면 URL 을 직접 쳐야 한다(FIX-25)",
    readFileSync("components/layout/AdminShell.tsx", "utf8").includes('href: "/vendor/coupons"'),
  );
  check(
    "쿠폰 화면이 캐시되지 않는다 (소진·만료가 시계로 판정되는 화면이다)",
    readFileSync("app/(vendor)/vendor/coupons/page.tsx", "utf8").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**발급 실행 경로가 없다는 사실이 API 응답 본문에 실린다**(함정 3 · FIX-46)",
    readFileSync("lib/coupons/vendor.ts", "utf8").includes("issuanceWired: false"),
  );
  check(
    "**못 보는 차감액을 0 으로 내려보내지 않는다**(함정 2) — 대표가 아니면 null 이다",
    readFileSync("lib/coupons/vendor.ts", "utf8").includes("input.isOwner ?") &&
      readFileSync("lib/coupons/vendor.ts", "utf8").includes("deductedAmount: input.isOwner"),
  );
  check(
    "**issuer_id 를 입력으로 받지 않는다** — 세션이 정한다(비용을 지는 쪽과 만드는 쪽이 같다)",
    !readFileSync("app/api/vendor/coupons/route.ts", "utf8").includes("issuerId"),
  );

  // ── 픽스처 — **양쪽 갈래가 다 닿아야 검사가 뭔가를 본다**(함정 8) ────────
  check(
    "**얼어붙은 쿠폰과 아직 안 나간 쿠폰이 둘 다 시드에 있다**",
    frozenCouponId !== "" && freshCouponId !== "",
  );
  check(
    "**업체 쿠폰과 플랫폼 쿠폰이 둘 다 있다** — 부담 주체 분기를 둘 다 눈다",
    sql(`select count(*) from public.coupons where issuer_type = 'vendor';`) !== "0" &&
      sql(`select count(*) from public.coupons where issuer_type = 'platform';`) !== "0",
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0067 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
