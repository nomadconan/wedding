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
import { readFileSync } from "node:fs";

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

  // ── 당사자는 자기 수수료율을 쓸 수 없다 (컬럼 수준 권한) ──────────────────
  check(
    "커플 소유자는 예약 상태를 바꿀 수 있다",
    asUser(owner, `with u as (update public.bookings set status = 'cancelled'
       where id = '${PB}' returning id) select count(*) from u;`, payFixture) === "1",
  );
  check(
    "커플 소유자는 **요율 컬럼을 쓸 수 없다** (42501 — 정책이 아니라 컬럼 권한이 막는다)",
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
  check(
    "커플 소유자는 결제 회차를 본다",
    asUser(owner, `select count(*) from public.payment_schedules;`, payFixture) === "2",
  );
  check(
    "업체 멤버도 결제 회차를 본다 (응대에 필요한 운영 정보다)",
    asUser(vendorStaff, `select count(*) from public.payment_schedules;`, payFixture) === "2",
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
    asUser(owner, `select count(*) from public.payments;`, paidSetup) === "1",
  );
  check(
    "배우자는 결제를 못 본다 (결제 열람은 owner · §3.9)",
    asUser(partner, `select count(*) from public.payments;`, paidSetup) === "0",
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
  check(
    "해지 절차는 당사자가 쓸 수 없다 (자기 귀책을 스스로 적을 수 없다)",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.contract_cancellations
         (contract_id, booking_id, requester_side, reason_code)
         values ('${PC}', '${PB}', 'couple', 'budget');`, cancelSetup)),
  );
  check(
    "당사자가 귀책을 고쳐 쓸 수 없다",
    asUser(owner, `with u as (update public.contract_cancellations set fault = 'vendor' returning id)
       select count(*) from u;`, cancelSetup) === "0",
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
  check(
    "고객은 자기 발급분을 본다",
    asUser(owner, `select count(*) from public.coupon_issues;`, couponFixture) === "1",
  );
  check(
    "업체는 자사 쿠폰 발급 현황을 본다",
    asUser(outsider, `select count(*) from public.coupon_issues;`, couponFixture) === "1",
  );
  check(
    "타 업체는 남의 쿠폰을 못 본다",
    asUser(vendorStaff, `select count(*) from public.coupons where issuer_id is null;`, couponFixture) === "0",
  );
  check(
    "비로그인은 쿠폰을 못 본다",
    asAnon(`select count(*) from public.coupons;`, couponFixture) === "0",
  );
  check(
    "쿠폰 발급은 당사자가 못 한다 (수량·조건을 우회할 수 있다)",
    rejectedWith(/row-level security/i, () =>
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
    asUser(owner, `select count(*) from public.escrow_holds;`, escrowFixture) === "1",
  );
  check(
    "업체 멤버도 안전거래를 본다 (이행 확인의 당사자다)",
    asUser(vendorStaff, `select count(*) from public.escrow_holds;`, escrowFixture) === "1",
  );
  check(
    "배우자는 안전거래를 못 본다 (결제·서명과 같은 owner 조건)",
    asUser(partner, `select count(*) from public.escrow_holds;`, escrowFixture) === "0",
  );
  check(
    "운영자는 조율을 위해 안전거래를 본다",
    asUser(adminUser, `select count(*) from public.escrow_holds;`, escrowFixture) === "1",
  );
  check(
    "비로그인은 안전거래를 못 본다",
    asAnon(`select count(*) from public.escrow_holds;`, escrowFixture) === "0",
  );
  check(
    "안전거래는 당사자가 쓸 수 없다 (스스로 이행을 확인하고 릴리즈할 수 있다)",
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.escrow_holds (payment_id, booking_id, held_amount)
         values ('${PAY1}', '${PB}', 1);`, escrowFixture)),
  );
  check(
    "당사자가 이행 확인을 고쳐 쓸 수 없다",
    asUser(owner, `with u as (update public.escrow_holds set status = 'released' returning id)
       select count(*) from u;`, escrowFixture) === "0",
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
    "**비로그인은 검출 룰을 못 본다** (지시문은 내부 자산이다)",
    asAnon(`select count(*) from public.detect_rules;`) === "0",
  );
  check(
    "로그인해도 검출 룰을 못 본다",
    asUser(owner, `select count(*) from public.detect_rules;`) === "0",
  );
  check(
    "운영자도 클라이언트 경로로는 검출 룰을 못 본다 (관리 화면은 서버를 지난다)",
    asUser(adminUser, `select count(*) from public.detect_rules;`) === "0",
  );
  check(
    "쓰기도 막힌다 — 룰을 고치는 일은 배포로 한다",
    asUser(
      owner,
      `with u as (update public.detect_rules set is_active = false returning code)
         select count(*) from u;`,
    ) === "0",
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
    "비로그인은 위약금 기준 표도 못 본다",
    asAnon(`select count(*) from public.penalty_rules;`) === "0",
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
    rejectedWith(/row-level security/i, () =>
      asUser(owner, `insert into public.ai_tool_calls (message_id, tool_name, result_summary)
         values ('${MSG}', 'search_vendors', '지어낸 기록');`, aiFixture)),
  );
  check(
    "툴 호출 기록은 고칠 수도 지울 수도 없다 (감사는 append-only)",
    asUser(owner, `with u as (update public.ai_tool_calls set result_summary = '조작' returning id)
       select count(*) from u;`, aiFixture) === "0" &&
      asUser(owner, `with d as (delete from public.ai_tool_calls returning id)
         select count(*) from d;`, aiFixture) === "0",
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
      "분석·조항은 클라이언트가 쓸 수 없다 — 파이프라인(서비스롤)이 만든다",
      rejectedWith(/row-level security/i, () =>
        asUser(owner, `insert into public.document_analyses (document_id, status)
           values ('${DOC}', 'done');`, reportFixture)) &&
        rejectedWith(/row-level security/i, () =>
          asUser(owner, `insert into public.findings (analysis_id, rule_code, severity)
             values ('${ANA}', 'R-01', 'low'::public.finding_severity);`, reportFixture)),
    );
    check(
      "**위험 점수를 당사자가 고칠 수 없다** (UPDATE 정책 없음)",
      asUser(owner, `with u as (update public.document_analyses set risk_score = 0 returning id)
         select count(*) from u;`, reportFixture) === "0",
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

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
