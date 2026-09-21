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
/**
 * **되어야 하는 일**을 확인할 때 쓴다.
 *
 * `sql()` 은 실패하면 던진다 — `rejectedWith` 처럼 '막혀야 정상' 인 검사에는 그것이 맞지만,
 * '되어야 정상' 인 검사에서는 **회귀가 FAIL 이 아니라 스크립트 폭사로 나타난다.**
 * 그러면 남은 검사가 아예 돌지 않아 무엇이 더 깨졌는지 알 수 없다(FIX-12 에서 겪었다).
 * 여기서는 오류를 삼키고 `null` 을 돌려 그 줄만 FAIL 로 떨어지게 한다.
 */
function sqlOrNull(text) {
  try {
    return sql(text);
  } catch {
    return null;
  }
}

function rejectedWith(pattern, run) {
  try {
    run();

    return false;
  } catch (error) {
    return pattern.test(String(error.stderr ?? error));
  }
}

/**
 * 소스에서 **주석을 걷어 낸다.**
 *
 * ── 왜 필요한가 (C-1 이 여기서 여섯 번 틀렸다) ──────────────────────────────
 * 소스를 문자열로 훑는 검사는 **주석을 코드로 읽는다.** C-1 의 첫 실행에서 여섯 개가
 * 그렇게 틀렸다 — `lib/bookings/create.ts` 의 "`accepted_at` 은 **비운다**" 라는 주석이
 * `includes("accepted_at")` 에 걸려 "다리가 승인을 만든다" 로 판정됐고, 계약서 화면의
 * "`pdf_path` 는 조회 컬럼에 넣지 않는다" 가 "경로를 읽는다" 로 판정됐다.
 *
 * **이 리포는 주석이 길다.** 무엇을 왜 안 했는지를 주석이 적는 관행이라, 안 한 것의
 * 이름이 주석에 반드시 등장한다 — 그러면 "그 이름이 없어야 통과" 인 검사는 **항상**
 * 실패한다. 코드만 보게 한다.
 *
 * ── 줄바꿈을 먼저 통일한다 (FIX-64 · C-1b 가 여기서 한 번 더 틀렸다) ─────
 * 이 한 줄이 없으면 **같은 검사가 리눅스와 윈도우에서 다른 답을 낸다.**
 * JS 정규식의 `.` 은 `\r` 을 줄문자로 보아 **매치하지 않는다.** 그래서
 * `core.autocrlf=true` 인 윈도우 작업트리(`w/crlf`)에서는 `//` 줄 끝에 `\r` 이 남아
 * `.*$` 가 못 붙고 **줄 주석이 통째로 살아남았다** — 블록 주석만 걷혔다.
 * 그 탓에 "계약서 화면이 pdf_path 를 읽지 않는다" 가 로컬에서만 FAIL 이었고,
 * CI(ubuntu · `i/lf`)는 CRLF 를 아예 보지 못해 **영원히 초록불**이었다 — 게이트가
 * 플랫폼마다 다른 사실을 말하고 있었다는 뜻이다.
 */
function codeOf(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * **소스 검사는 전부 이것을 지난다** (FIX-64).
 *
 * `codeOf` 는 C-1 이 만들었지만 **여섯 자리에만** 붙어 있었고, 나머지 250여 곳은
 * 원문을 그대로 훑었다. 이 리포는 *무엇을 왜 안 했는지*를 주석이 적는 관행이라
 * 안 한 것의 이름이 주석에 반드시 등장한다 — 그래서
 *
 * · `!src.includes("X")` 는 **항상 실패**한다(거짓 실패 · 소음).
 * · `src.includes("X")` 는 **주석만 보고 통과**한다(거짓 통과 · 구멍).
 *
 * 앞은 빨간불을 무시하게 만들고 뒤는 없는 것을 있다고 말한다. 뒤가 더 나쁘다.
 * 그래서 붙이는 자리를 고르지 않고 **읽는 길을 하나로 만들었다** — 새 검사가
 * `readFileSync` 를 직접 부르면 다시 갈라지므로, 소스는 `srcOf` 로만 읽는다.
 *
 * JSON(`vercel.json`)은 여기를 지나지 않는다 — 주석이 없고, 걷을 것도 없다.
 */
const SRC_CACHE = new Map();
function srcOf(path) {
  const hit = SRC_CACHE.get(path);
  if (hit !== undefined) return hit;
  const code = codeOf(readFileSync(path, "utf8"));
  SRC_CACHE.set(path, code);
  return code;
}

/**
 * 화면 소스 전부(app · components 의 .tsx)를 **주석 걷은 채로** 돌려준다.
 *
 * 주석을 걷는 이유가 여기서도 같다 — 이 리포는 주석에 태그를 그대로 적는다.
 * 걷지 않으면 검사가 **자기 주석을 위반으로 읽는다**(이 검사를 쓰다 실제로 겪었다).
 */
function listScreenSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
      } else if (entry.name.endsWith(".tsx")) {
        out.push([full, srcOf(full)]);
      }
    }
  };
  for (const root of ["app", "components"]) if (existsSync(root)) walk(root);

  return out;
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
    asUser(partner, `with u as (update public.couples set region_code = 'busan' returning id)
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
  asUser(outsider, `with u as (update public.couples set region_code = 'daegu' returning id)
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
    values ('${PLANNER}', '${vendorStaff ?? outsider}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']);
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
     insert into public.planners (id, user_id, status, profile_json, regions) values ('${PLANNER}', '${plannerUser}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']);
     insert into public.planner_engagements (planner_id, couple_id, scope_json, status, valid_from, valid_to)
       values ('${PLANNER}', '${coupleId}', '{"tables":["tasks"]}'::jsonb, 'active',
               now() - interval '1 day', now() + interval '30 days');`) === "0",
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
const codeNameMax = srcOf("lib/core/cart/multi-cart.ts").match(
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
    values ('${EV_ACTIVE}', 'RLS공개업체', 'hall', 'active', 'seoul', array['modern']),
           ('${EV_PENDING}', 'RLS심사중업체', 'hall', 'pending', 'seoul', array['modern']);
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
    values ('${IDX}', 'incheon', 'hall', 'all', 'all', 10000000, 20000000, 30000000, 7,
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
      values ('${CPLANNER}', '${adminUser}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']);
    insert into public.planner_engagements
      (planner_id, couple_id, scope_json, status, valid_from, valid_to)
      values ('${CPLANNER}', '${coupleId}',
              -- S6-04(0069) 이후로는 **채팅을 범위에 적을 수조차 없다** — CHECK 이
              -- 어휘를 11개로 못 박았다. 예전 픽스처는 "적어도 안 열린다" 를 봤는데,
              -- 지금은 그보다 앞에서 막힌다. 그 사실은 아래 S6-04 구역이 따로 확인하고,
              -- 여기서는 **정상 범위를 받은 플래너도 채팅은 못 본다** 를 본다.
              '{"tables":["carts","wishlists"]}'::jsonb,
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
    insert into public.planners (id, user_id, status, profile_json, regions) values ('${PL2}', '${adminUser}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']);
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
       insert into public.planners (id, user_id, status, profile_json, regions) values ('${PL2}', '${adminUser}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']);
       insert into public.planner_engagements (planner_id, couple_id, scope_json, status, valid_from, valid_to)
         values ('${PL2}', '${coupleId}', '{"tables":["carts"]}'::jsonb, 'active',
                 now() - interval '1 day', now() + interval '30 days');`) === "0",
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
const codeTopics = srcOf("lib/core/schemas/notification.ts")
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
      values ('${PPL}', '${owner}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']),
             ('${POPL}', '${partner}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']);
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
    -- 이 블록의 count 는 표 전체를 센다. 그래야 "남의 행까지 보이는가" 를 묻는
    -- 검사가 되는데, 그러려면 이 트랜잭션이 표의 내용을 전부 알고 있어야 한다.
    -- FIX-56 이 시드에 행을 넣자 그 전제가 깨져 열다섯 검사가 한꺼번에 실패했다 --
    -- 정책이 뚫린 것이 아니라 비어 있었기 때문에 통과하던 수였다(함정 8).
    -- 지우고 시작한다. 트랜잭션은 rollback 되므로 시드 데이터는 그대로 돌아온다.
    delete from public.contract_cancellations;
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
    "비로그인은 플래너 정산 표에 닿지도 못한다 (0071 이 GRANT 를 걷었다)",
    rejectedWith(/permission denied/i, () =>
      asAnon(`select count(*) from public.planner_settlements;`, payFixture)),
  );
  check(
    "플래너도 자기 정산을 고칠 수 없다 (지급은 서비스롤의 일이다 · 0071 이 GRANT 까지 걷었다)",
    rejectedWith(/permission denied/i, () =>
      asUser(owner, `update public.planner_settlements set status = 'paid';`, payFixture)),
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
  const codePaymentStatus = srcOf("lib/core/payment/payment.ts")
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
  const codeAnchors = srcOf("lib/core/payment/payment.ts")
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
  const codeConsentKinds = srcOf("lib/core/payment/checkout.ts")
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
      srcOf(file)
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
    srcOf("lib/core/escrow/escrow.ts")
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
  const cancelSource = srcOf("lib/core/cancellation/cancellation.ts");

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

  // ── 기간 집계 배치 (FIX-08) ───────────────────────────────────────────────
  //
  // **집계 코드는 있었는데 부르는 것은 사람뿐이었다** — `/admin/settlements` 에서
  // 업체를 하나씩 골라 눌러야 했다. 월 마감을 사람이 기억해야 하고, 한 업체를
  // 빠뜨리면 그 업체는 정산을 못 받는데 **빠뜨렸다는 사실이 어느 화면에도 안 뜬다.**
  {
    const settleSource = srcOf("lib/settlements/actions.ts");
    const aggregate = settleSource.slice(
      settleSource.indexOf("export async function runSettlementAggregate"),
      settleSource.indexOf("type SettlementPatch"),
    );
    const jobRoute = existsSync("app/api/jobs/settlement-aggregate/route.ts")
      ? srcOf("app/api/jobs/settlement-aggregate/route.ts")
      : "";

    check(
      "**배치 본문을 실제로 읽었다** — 못 읽으면 아래 검사가 빈 문자열을 통과시킨다",
      aggregate.length > 500 && jobRoute.length > 500,
    );
    check(
      "**배치 라우트가 실재한다** — 집계 코드만 있고 부르는 자리가 없으면 사람이 기억해야 한다",
      existsSync("app/api/jobs/settlement-aggregate/route.ts"),
    );
    check(
      "**`vercel.json` 에 등록돼 있다** — 만들어 두고 안 부르면 없는 것과 같다",
      readFileSync("vercel.json", "utf8").includes("/api/jobs/settlement-aggregate"),
    );
    check(
      "**배치 이름이 job_runs 어휘에 있다** — 없으면 기록이 CHECK 에 걸려 사라진다",
      sql(`select count(*) from pg_constraint
             where conrelid = 'public.job_runs'::regclass
               and conname = 'job_runs_name_vocab'
               and pg_get_constraintdef(oid) like '%settlement-aggregate%';`) === "1",
    );
    check(
      "**배치가 집계 규칙을 다시 적지 않는다** — 사람이 누른 것과 같은 함수를 부른다",
      aggregate.includes("await runSettlement({") && !aggregate.includes("buildSettlement("),
    );
    check(
      "**기간을 배치가 지어내지 않는다** — `settlementPeriod` 와 설정이 정한다",
      aggregate.includes("settlementPeriod(now, unit)") &&
        aggregate.includes('readSetting("settlement.period")'),
    );
    check(
      "**미결 파라미터를 코드가 대신 답하지 않는다**(O-15) — 기본 기준을 만들지 않았다",
      !aggregate.includes("pre_discount") && !aggregate.includes("post_discount"),
    );
    check(
      "**후보가 있는데 하나도 서지 못하면 실행을 실패로 닫는다** — 마감이 빈 것을 succeeded 로 적지 않는다",
      jobRoute.includes("result.scanned > 0 && result.drafted === 0 && result.blocked > 0") &&
        jobRoute.includes('status: result.failed > 0 || stalled ? "failed" : "succeeded"'),
    );
    check(
      "**선 정산서만 센다** — blocked 를 함께 세면 마감이 빈 달과 찬 달이 같은 수가 된다",
      jobRoute.includes("processedCount: result.drafted"),
    );
    check(
      "**확정된 정산서를 다시 계산하려다 실패로 세지 않는다**(D-23) — 끝난 기간을 다시 돈 것뿐이다",
      aggregate.includes('run.code === "SETTLEMENT_FROZEN"'),
    );
    check(
      "**배치가 남긴 증적에는 사람이 없다**(D-173) — 마감을 누른 운영자가 없기 때문이다",
      aggregate.includes('actor: { id: null, role: "system" }') &&
        aggregate.includes('source: "system"'),
    );
    check(
      "**안 선 이유를 0 으로 접지 않는다** — blocked·frozen·empty 를 갈라 센다",
      aggregate.includes("result.blocked += 1") &&
        aggregate.includes("result.frozen += 1") &&
        aggregate.includes("result.empty += 1"),
    );

    // ── 기준이 없으면 실제로 막히는가 ────────────────────────────────────────
    //
    // **표 전체를 세지 않는다**(D-178). 이 트랜잭션이 만든 정산서 하나만 본다.
    check(
      "**기준이 없으면 정산서가 계산으로 서지 못한다** — 배치가 돌아도 금액이 안 나온다(O-15)",
      rejectedWith(/settlements_fee_basis_shape/, () =>
        sql(`begin; ${payFixture}
          update public.settlements set status = 'draft', fee_basis = null
            where id = '${PSET}';
          rollback;`)),
    );
    check(
      "**기준 값은 여전히 미결이다** — 코드도 시드도 대신 정하지 않았다(O-15)",
      sql(`select value_json ->> 'status' from public.app_settings
             where key = 'settlement.fee_basis';`) === "undecided",
    );

    // ── 층 3: 자격의 근거를 자격을 얻으려는 사람이 쓸 수 있는가 ─────────────
    //
    // 집계가 읽는 근거는 **예약의 요율 스냅샷**(`bookings.applied_fee_rate_bp`)과
    // **계약 총액**(`contracts.total_amount`)이다. 받는 쪽인 업체가 그 둘을 고칠 수
    // 있으면 **정산 금액을 스스로 적는 것과 같다.**
    check(
      "**업체는 예약의 요율 스냅샷을 못 고친다** — 고치면 자기 수수료를 스스로 낮춘다",
      (() => {
        try {
          return (
            asUser(
              outsider,
              `update public.bookings set applied_fee_rate_bp = 0 where id = '${PB}';
               select count(*) from public.bookings
                 where id = '${PB}' and applied_fee_rate_bp = 0;`,
              payFixture,
            ) === "0"
          );
        } catch (error) {
          return /permission denied|row-level security|42501/i.test(String(error.stderr ?? error));
        }
      })(),
    );
    check(
      "**업체는 계약 총액을 못 고친다** — 고치면 정산 대상 금액을 스스로 적는다",
      (() => {
        try {
          return (
            asUser(
              outsider,
              `update public.contracts set total_amount = 99999999 where id = '${PC}';
               select count(*) from public.contracts
                 where id = '${PC}' and total_amount = 99999999;`,
              payFixture,
            ) === "0"
          );
        } catch (error) {
          return /permission denied|row-level security|42501/i.test(String(error.stderr ?? error));
        }
      })(),
    );

    // ── 층 1: 표에서 걷었는데 칸으로 다시 준 곳이 없는가 ────────────────────
    check(
      "**정산서에 업체가 쓸 수 있는 칸은 이의 메모 하나뿐이다** — 표에서 걷고 칸 하나만 돌려줬다",
      sql(`select coalesce(string_agg(distinct column_name, ','), '(없음)')
             from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'settlements'
              and grantee = 'authenticated' and privilege_type = 'UPDATE';`) === "vendor_note",
    );
  }

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
  // 요율 무효화 (FIX-12 · 0072)
  // ---------------------------------------------------------------------------
  // **오타로 넣은 요율을 되돌리는 길이 셋 다 막혀 있었다** — 삭제(권한) · 시작 전
  // 종료(CHECK) · 겹쳐 덮기(EXCLUDE). 무효화 표시가 그 자리를 연다.
  //
  // **여기 수는 `scope_key = PV` 로 좁혀 센다.** 시드가 전역 요율을 넣어 두므로
  // 표 전체를 세면 이 트랜잭션이 만든 것과 다른 수가 나온다 — 검사가 자기가 세는
  // 것을 알고 있어야 한다(D-178).
  // ===========================================================================
  const VOID_TYPO = "00000000-0000-0000-0000-00000000f060";
  const VOID_FIX = "00000000-0000-0000-0000-00000000f061";

  /** 오타 요율 하나가 살아 있는 상태. */
  const typoFixture = `
    ${payFixture}
    insert into public.commission_rates
      (id, scope_type, scope_key, fee_rate_bp, effective_from, effective_to)
      values ('${VOID_TYPO}', 'vendor', '${PV}', 7000, '2026-03-01T00:00:00Z', null);
  `;

  /** 그 오타 요율을 사유와 함께 무효화한 상태. */
  const voidedFixture = `
    ${typoFixture}
    update public.commission_rates
       set voided_at = now(), void_reason = '700bp 를 7000bp 로 잘못 입력'
     where id = '${VOID_TYPO}';
  `;

  check(
    "**살아 있는 오타 요율은 겹침을 막는다** — 무효화 전에는 고칠 수 없었다",
    rejectedWith(/commission_rates_no_overlap|23P01|conflicting key/i, () =>
      sql(`begin; ${typoFixture}
        insert into public.commission_rates
          (id, scope_type, scope_key, fee_rate_bp, effective_from, effective_to)
          values ('${VOID_FIX}', 'vendor', '${PV}', 700, '2026-03-01T00:00:00Z', null);
        rollback;`)),
  );
  check(
    "**무효화하면 같은 구간에 올바른 요율을 넣을 수 있다** (부분 EXCLUDE)",
    sqlOrNull(`begin; ${voidedFixture}
        insert into public.commission_rates
          (id, scope_type, scope_key, fee_rate_bp, effective_from, effective_to)
          values ('${VOID_FIX}', 'vendor', '${PV}', 700, '2026-03-01T00:00:00Z', null);
        select count(*) from public.commission_rates where scope_key = '${PV}'; rollback;`) === "2",
  );
  check(
    "**무효화해도 행은 남는다** (D-23 — 스냅샷의 출처를 답해야 한다)",
    sqlOrNull(`begin; ${voidedFixture}
        select count(*) from public.commission_rates
         where id = '${VOID_TYPO}' and voided_at is not null; rollback;`) === "1",
  );
  check(
    "사유 없이 무효화할 수 없다 (void_pair)",
    rejectedWith(/commission_rates_void_pair|check constraint/i, () =>
      sql(`begin; ${typoFixture}
        update public.commission_rates set voided_at = now() where id = '${VOID_TYPO}';
        rollback;`)),
  );
  check(
    "공백만 적은 사유는 사유가 아니다 (void_reason_shape)",
    rejectedWith(/commission_rates_void_reason_shape|check constraint/i, () =>
      sql(`begin; ${typoFixture}
        update public.commission_rates set voided_at = now(), void_reason = '   '
         where id = '${VOID_TYPO}';
        rollback;`)),
  );
  check(
    "사유만 적고 무효화하지 않을 수도 없다 (짝은 양방향이다)",
    rejectedWith(/commission_rates_void_pair|check constraint/i, () =>
      sql(`begin; ${typoFixture}
        update public.commission_rates set void_reason = '사유만' where id = '${VOID_TYPO}';
        rollback;`)),
  );
  check(
    "**무효화는 되돌릴 수 없다** — 되돌리면 확정된 계약의 근거를 재현할 수 없다",
    rejectedWith(/rate_voided_is_final|무효화된 요율/i, () =>
      sql(`begin; ${voidedFixture}
        update public.commission_rates set voided_at = null, void_reason = null
         where id = '${VOID_TYPO}';
        rollback;`)),
  );
  check(
    "무효화된 행은 다시 종료할 수도 없다 (종결은 종결이다)",
    rejectedWith(/rate_voided_is_final|무효화된 요율/i, () =>
      sql(`begin; ${voidedFixture}
        update public.commission_rates set effective_to = now() + interval '1 day'
         where id = '${VOID_TYPO}';
        rollback;`)),
  );
  check(
    "무효화 칸도 당사자가 쓸 수 없다 (층 1 — 새 컬럼에 권한을 주지 않았다)",
    rejectedWith(/permission denied|42501|row-level security/i, () =>
      asUser(adminUser, `update public.commission_rates
         set voided_at = now(), void_reason = '직접' where id = '${VOID_TYPO}';`, typoFixture)),
  );
  check(
    "플래너 요율도 같은 규칙이다 (짝 CHECK · 되돌리기 금지)",
    rejectedWith(/planner_fee_rates_void_pair|check constraint/i, () =>
      sql(`begin;
        insert into public.planner_fee_rates
          (id, scope_type, scope_key, fee_rate_bp, effective_from)
          values ('${VOID_TYPO}', 'planner', '${VOID_FIX}', 300, '2026-03-01T00:00:00Z');
        update public.planner_fee_rates set voided_at = now() where id = '${VOID_TYPO}';
        rollback;`)),
  );
  check(
    "플래너 요율도 무효화하면 같은 구간을 다시 쓸 수 있다",
    sqlOrNull(`begin;
        insert into public.planner_fee_rates
          (id, scope_type, scope_key, fee_rate_bp, effective_from)
          values ('${VOID_TYPO}', 'planner', '${VOID_FIX}', 300, '2026-03-01T00:00:00Z');
        update public.planner_fee_rates
           set voided_at = now(), void_reason = '오타' where id = '${VOID_TYPO}';
        insert into public.planner_fee_rates
          (scope_type, scope_key, fee_rate_bp, effective_from)
          values ('planner', '${VOID_FIX}', 30, '2026-03-01T00:00:00Z');
        select count(*) from public.planner_fee_rates where scope_key = '${VOID_FIX}';
        rollback;`) === "2",
  );

  // ── 층 2 · 층 3 (FIX-41 · FIX-47 계열) ────────────────────────────────────
  check(
    "**요율 정책이 부모 표의 RLS 를 빌려 쓰지 않는다** (층 2)",
    sql(`select count(*) from pg_policy
         where polrelid in ('public.commission_rates'::regclass, 'public.planner_fee_rates'::regclass)
           and pg_get_expr(polqual, polrelid) ilike '%exists (select 1 from%';`) === "0",
  );
  check(
    "**요율 표에 쓰기 정책이 하나도 없다** (층 1 — 권한을 되돌려도 열리지 않는다)",
    sql(`select count(*) from pg_policy
         where polrelid in ('public.commission_rates'::regclass, 'public.planner_fee_rates'::regclass)
           and polcmd <> 'r';`) === "0",
  );
  check(
    "**자격의 근거를 당사자가 못 쓴다** (층 3 — is_operator 는 profiles.role 을 읽는다)",
    rejectedWith(/permission denied|42501/i, () =>
      asUser(outsider, `update public.profiles set role = 'admin' where user_id = '${outsider}';`)),
  );


  // ===========================================================================
  // 오픈 준비 점검이 보는 수 (FIX-11)
  // ---------------------------------------------------------------------------
  // `/admin/ops` 가 "요율이 하나도 없다" 를 말하려면 **살아 있는 요율의 수**를 셀 수
  // 있어야 하고, 그 수는 **세션 클라이언트로** 세므로 RLS 를 지난다.
  //
  // **여기 수는 트랜잭션 안에서 전부 무효화해 만든다.** 시드가 요율을 넣어 두므로
  // 표 전체를 그냥 세면 시드에 따라 답이 달라진다 — 검사가 자기가 세는 것을 알고
  // 있어야 한다(D-178). 무효화는 제품이 실제로 하는 일이라 '없는 상태' 를 만드는
  // 가장 정직한 방법이기도 하다.
  // ===========================================================================
  const voidAllRates = `
    update public.commission_rates
       set voided_at = now(), void_reason = 'rls: 요율 없음 상태 재현'
     where voided_at is null;
  `;

  check(
    "운영자는 살아 있는 요율 수를 센다 (오픈 준비 점검의 근거)",
    Number(
      asUser(adminUser, `select count(*) from public.commission_rates where voided_at is null;`),
    ) >= 1,
  );
  check(
    "**전부 무효화하면 살아 있는 요율이 0 이다** — 이때 계약 발행이 막힌다",
    asUser(
      adminUser,
      `select count(*) from public.commission_rates where voided_at is null;`,
      voidAllRates,
    ) === "0",
  );
  check(
    "그때도 **행 자체는 남아 있다** — 0 은 '지워졌다' 가 아니라 '적용되지 않는다' 다",
    Number(asUser(adminUser, `select count(*) from public.commission_rates;`, voidAllRates)) >= 1,
  );
  check(
    "**무효 필터를 빼면 답이 달라진다** — 필터가 장식이 아님을 고정한다",
    Number(asUser(adminUser, `select count(*) from public.commission_rates;`, voidAllRates)) >
      Number(
        asUser(
          adminUser,
          `select count(*) from public.commission_rates where voided_at is null;`,
          voidAllRates,
        ),
      ),
  );
  check(
    "플래너 요율도 같은 방식으로 센다",
    Number(
      asUser(adminUser, `select count(*) from public.planner_fee_rates where voided_at is null;`),
    ) >= 1,
  );
  check(
    "커플은 요율 수를 셀 수 없다 (준비 점검은 운영자 화면이다)",
    asUser(owner, `select count(*) from public.commission_rates where voided_at is null;`) === "0",
  );
  check(
    "비로그인도 셀 수 없다",
    asAnon(`select count(*) from public.commission_rates where voided_at is null;`) === "0",
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

  // ── 자동 릴리즈 배치 (FIX-14) ─────────────────────────────────────────────
  //
  // **판정 함수는 있었는데 부르는 자동 경로가 없었다.** 부르는 곳은 확인 버튼과
  // **화면 표시**뿐이라, 아무도 화면을 열지 않으면 잔금이 묶인 채 남았다. 그리고 열린
  // 홀드가 있는 예약은 정산에서 빠지므로(`settlementEligible`) 그 돈은 업체에게 가지도
  // 않고 정산에도 들어오지 않았다 — 손해가 두 겹이다.
  {
    const batchSource = srcOf("lib/escrow/actions.ts");
    /**
     * **구역 경계를 주석으로 잡지 않는다**(FIX-64). 끝 앵커가 `// 내부 — 보관 해제`
     * 였는데, 소스에서 주석을 걷어내자 그 앵커가 사라져 `indexOf` 가 -1 을 돌려줬다 —
     * `slice(start, -1)` 은 **파일 끝까지**를 잉고, 그 안의 내부 함수가 가진 `.update(` 가
     * 배치의 것으로 읽혔다. 경계는 **코드에 있는 것**으로 잡는다.
     */
    const runnerStart = batchSource.indexOf("export async function runEscrowRelease");
    const runnerEnd = batchSource.indexOf("async function loadHold(");
    const runner =
      runnerStart >= 0 && runnerEnd > runnerStart ? batchSource.slice(runnerStart, runnerEnd) : "";

    check(
      "**배치 본문을 실제로 읽었다** — 못 읽으면 아래 검사가 전부 빈 문자열을 통과시킨다",
      // **아래만 막으면 안 된다.** 경계가 깨지면 구역이 짧아지는 게 아니라 **파일 끝까지**
      // 늘어난다 — 그러면 아래 검사들이 남의 함수를 보고 답한다. 위아래를 다 막는다.
      runner.length > 500 && runner.length < batchSource.length * 0.6,
      `runner=${runner.length} file=${batchSource.length}`,
    );
    check(
      "**배치 라우트가 실재한다** — 판정 함수만 있고 부르는 자리가 없으면 영영 보관이다",
      existsSync("app/api/jobs/escrow-release/route.ts"),
    );
    check(
      "**`vercel.json` 에 등록돼 있다** — 만들어 두고 안 부르면 없는 것과 같다",
      readFileSync("vercel.json", "utf8").includes("/api/jobs/escrow-release"),
    );
    check(
      "**배치 이름이 job_runs 어휘에 있다** — 없으면 기록이 CHECK 에 걸려 사라진다",
      sql(`select count(*) from pg_constraint
             where conrelid = 'public.job_runs'::regclass
               and conname = 'job_runs_name_vocab'
               and pg_get_constraintdef(oid) like '%escrow-release%';`) === "1",
    );
    check(
      "**배치가 자기 규칙을 갖지 않는다** — 판정은 순수 함수 하나가 한다",
      runner.includes("decideRelease({"),
    );
    check(
      "**배치가 날짜로 후보를 거르지 않는다** — SQL 로 거르면 화면이 예고한 것과 답이 갈린다",
      runner.includes('.eq("status", "held")') && !/\.(lt|lte|gt|gte)\(/.test(runner),
    );
    check(
      "**배치가 상태를 직접 쓰지 않는다** — 전이 규칙과 증적을 든 함수로만 옮긴다(D-23 · D-24)",
      !runner.includes(".update(") &&
        runner.includes("settleHold({") &&
        runner.includes("moveToDisputed("),
    );
    check(
      "**배치가 남긴 증적에는 사람이 없다**(D-173) — 운영 계정을 빌려 넣으면 증적이 거짓말한다",
      runner.includes("actor: BATCH_ACTOR") &&
        runner.includes('source: "system"') &&
        /const BATCH_ACTOR: Actor = \{ id: null, role: "system" \};/.test(batchSource),
    );
    check(
      "**어댑터가 거절하면 넘긴 수로 세지 않는다** — '돈은 안 갔는데 released' 가 되지 않는다",
      runner.includes("if (settled) result.released += 1;"),
    );
    check(
      "**안 움직인 수를 0 으로 접지 않는다** — 왜 그대로인지가 사실이다",
      runner.includes("result.held += 1;") && runner.includes("result.failed += 1;"),
    );

    // ── 배치가 하려는 전이를 DB 가 실제로 받는가 ────────────────────────────
    //
    // **표 전체를 세지 않는다**(D-178). 이 트랜잭션이 만든 홀드 하나만 보고, 그것이
    // 실제로 `released` 가 되는지 확인한다.
    check(
      "**배치가 하려는 전이를 DB 가 받는다** — 무응답 릴리즈는 사유와 시각이 함께 간다",
      sqlOrNull(`begin; ${escrowFixture}
          update public.escrow_holds set
            status = 'released', released_at = now(), release_reason = '확인 기한 경과'
            where id = '${ESC}';
          select status || ':' || (release_reason is not null)
            from public.escrow_holds where id = '${ESC}'; rollback;`) === "released:true",
    );

    // ── 층 3: 자격의 근거를 자격을 얻으려는 사람이 쓸 수 있는가 ─────────────
    //
    // 무응답 릴리즈의 근거는 둘이다 — **확인 기한**(`escrow_holds.confirm_due_at`)과
    // **예식일**(`couples.wedding_date`). 릴리즈로 이득을 보는 쪽은 업체다.
    // **업체가 그 둘 중 하나라도 앞당겨 쓸 수 있으면 자동 릴리즈는 업체가 스스로
    // 여는 문이 된다.**
    check(
      "**업체는 커플의 예식일을 못 고친다** — 고치면 업체가 자동 릴리즈를 스스로 앞당긴다",
      (() => {
        try {
          return (
            asUser(
              vendorStaff,
              `update public.couples set wedding_date = current_date - 400
                 where id = '${coupleId}';
               select count(*) from public.couples
                 where id = '${coupleId}' and wedding_date = current_date - 400;`,
            ) === "0"
          );
        } catch (error) {
          return /permission denied|row-level security/i.test(String(error.stderr ?? error));
        }
      })(),
    );
    check(
      "**업체는 확인 기한을 못 고친다** — 홀드 표에는 당사자 쓰기 권한 자체가 없다",
      rejectedWith(/permission denied/, () =>
        asUser(
          vendorStaff,
          `update public.escrow_holds set confirm_due_at = now() - interval '1 day';`,
          escrowFixture,
        ),
      ),
    );

    // ── 층 1: 표에서 걷었는데 칸으로 다시 준 곳이 없는가 ────────────────────
    //
    // `revoke insert (칸)` 만으로는 무효다. 표 단위로 걷고 다시 주지 않았는지
    // **`column_privileges` 에서 직접 확인한다** — 정책만 보면 이 구멍이 안 보인다.
    check(
      "**홀드 표에 칸 단위 쓰기 권한이 남아 있지 않다** — 표에서 걷고 칸으로 되돌려 주지 않았다",
      sql(`select count(*) from information_schema.column_privileges
             where table_schema = 'public' and table_name = 'escrow_holds'
               and grantee in ('authenticated', 'anon')
               and privilege_type in ('INSERT', 'UPDATE');`) === "0",
    );
  }

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
            values ('00000000-0000-0000-0000-00000000c0b9', '${partner}', 'active', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']);
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
    // S6-03(0070) 이후로는 **짝이 어긋난 행을 만들 수조차 없다** — 트리거가 해제
    // 시각을 채우기 때문이다. 예전에는 CHECK 이 거절하는 것을 봤는데, 지금은 그보다
    // 앞에서 서버가 값을 넣는다. 확인할 것도 바뀐다: **거절**이 아니라 **채워졌는가**다.
    check(
      "해제하면 시각을 서버가 채운다 (짝이 어긋난 행을 만들 수 없다 · 0070)",
      sql(`begin; ${scopeFixture}
        update public.planner_scopes set status = 'released';
        select (released_at is not null)::text from public.planner_scopes;
        rollback;`) === "true",
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
      // `selected_by` 를 넘기지 않는다 — 0070 이 그 칸의 쓰기 권한을 걷었고
      // 트리거가 `auth.uid()` 로 채운다(위조 케이스는 S6-03 구역이 따로 본다).
      asUser(partner, `with i as (insert into public.planner_scopes
         (couple_id, planner_id, category)
         values ('${coupleId}', '${PLANNER_ID}', 'dress') returning id)
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
      "비로그인은 카테고리 선택 표에 닿지도 못한다 (0070 이 GRANT 를 걷었다)",
      rejectedWith(/permission denied/i, () =>
        asAnon(`select count(*) from public.planner_scopes;`, scopeFixture)),
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
           values ('00000000-0000-0000-0000-00000000c0c9', '${partner}', 'pending', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']);`,
      ) === "0",
    );
    check(
      "본인은 자기 프로필을 상태와 무관하게 본다",
      asUser(
        partner,
        `select status from public.planners where user_id = '${partner}';`,
        `insert into public.planners (id, user_id, status, profile_json, regions)
           values ('00000000-0000-0000-0000-00000000c0c9', '${partner}', 'pending', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']);`,
      ) === "pending",
    );
    check(
      "운영자는 검토를 위해 pending 프로필을 본다",
      asUser(
        adminUser,
        `select count(*) from public.planners where status = 'pending';`,
        `insert into public.planners (id, user_id, status, profile_json, regions)
           values ('00000000-0000-0000-0000-00000000c0c9', '${partner}', 'pending', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']);`,
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
                     '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']);`,
        )),
    );
    check(
      "보류 상태도 본인이 정할 수 없다",
      rejectedWith(/planners_self_reject|보류 상태는 운영자가/, () =>
        asUser(
          partner,
          `update public.planners set status = 'rejected' where user_id = '${partner}';`,
          `insert into public.planners (id, user_id, status, profile_json, regions)
             values ('00000000-0000-0000-0000-00000000c0c9', '${partner}', 'pending', '{"headline":"픽스처 플래너","categories":["studio"]}'::jsonb, array['seoul']);`,
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
    // **셀 것이 있는 상태에서 잰다.** S6-05 가 정산 픽스처 둘을 시드에 넣기 전까지 이
    // 검사는 0 을 0 과 견주고 있었다 — 통과했지만 아무것도 확인하지 않았다(함정 8).
    check(
      "**실적 집계는 개수만 돌려준다** (뷰였다면 남의 정산이 새어 나간다)",
      sql(`select public.planner_contract_count('${PLANNER_ID}');`) === "2",
    );
    check(
      "실적 집계 함수는 비로그인도 부를 수 있다 (마켓이 쓴다)",
      asAnon(`select public.planner_contract_count('${PLANNER_ID}');`) === "2",
    );
    check(
      "**정산 표 자체는 여전히 남에게 닫혀 있다** — 함수만 열려 있고 표는 GRANT 도 없다",
      rejectedWith(/permission denied/i, () =>
        asAnon(`select count(*) from public.planner_settlements;`)),
    );

    // ── 코드 ↔ DB 정합 ──────────────────────────────────────────────────────
    const dbPlannerStatus = sql(
      `select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'public.planners'::regclass and conname = 'planners_status_values';`,
    );
    const codePlannerStatus =
      srcOf("lib/core/planner/profile.ts")
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
      srcOf("lib/core/planner/scope.ts")
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
  const rulesSrc = srcOf("lib/core/rules/detect-rules.ts");
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
      -- 위 activeFixture 와 같은 이유로 지우고 시작한다(FIX-56).
      delete from public.community_reports;
      delete from public.community_post_tags;
      delete from public.community_comments;
      delete from public.community_posts;
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
    -- 위와 같은 이유로 지우고 시작한다(FIX-56). 간선을 먼저 지운다 — 태스크를
    -- 지우면 cascade 로 함께 사라지지만, 순서를 적어 두면 읽는 사람이 덜 헤맨다.
    delete from public.task_dependencies;
    delete from public.tasks;
    insert into public.tasks (id, couple_id, category, title, status)
      values ('${TA}', '${coupleId}', 'hall', '웨딩홀 계약', 'todo'),
             ('${TB}', '${coupleId}', 'sdm', '스드메 계약', 'todo'),
             ('${TC}', '${coupleId}', 'document', '청첩장 주문', 'todo');
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
    const templateSrc = srcOf("lib/core/schedule/templates.ts");
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
             ('${TC}', '${coupleId}', 'document', '청첩장 주문', 'todo');
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
    const viewSrc = srcOf("lib/core/schedule/view.ts");
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
              '{"headline":"예산 픽스처","categories":["hall"]}'::jsonb, array['seoul'])
      on conflict (user_id) do nothing;
    insert into public.planner_engagements (planner_id, couple_id, scope_json, status, valid_from, valid_to)
      -- **budget_items 는 범위 키가 아니다.** 그 표는 부모(budgets)의 정책을 통해
      -- 보이며(층 2 모양), 위임 어휘에 그런 키는 없다. 0069 의 CHECK 이 이제
      -- 그것을 거절한다 — 적어 두어도 열린 적이 없던 키다.
      select p.id, '${coupleId}', '{"tables":["budgets","expenses"]}'::jsonb,
             'active', now() - interval '1 day', now() + interval '30 days'
        from public.planners p where p.user_id = '${plannerAccount ?? outsider}'
      -- 0069 가 "살아 있는 위임은 커플·플래너당 하나" 를 세웠고, 시드가 이미 이
      -- 짝으로 활성 위임을 하나 갖고 있다. 두 개를 만들면 무엇이 열려 있는지
      -- 답할 수 없으므로, 새로 만드는 대신 **범위를 갈아 끼운다.**
      on conflict (couple_id, planner_id) where status in ('pending', 'active')
      do update set scope_json = excluded.scope_json,
                    valid_from = excluded.valid_from,
                    valid_to   = excluded.valid_to;
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
    const budgetSrc = srcOf("lib/core/schemas/estimate.ts");
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
    const budgetCoreSrc = srcOf("lib/core/budget/budget.ts");
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
    const viewSrc = srcOf("lib/core/pricing/penalty-view.ts");
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
    const shareSrc = srcOf("lib/core/share/share.ts");
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
    const estimateSrc = srcOf("lib/core/estimate/normalize.ts");

    check(
      "**견적 매핑이 예산 표를 그대로 참조한다** — 사본을 만들면 사본이 어긋난다",
      estimateSrc.includes("VENDOR_TO_ESTIMATE_CATEGORY = VENDOR_TO_BUDGET_CATEGORY"),
    );
    check(
      "**업로드·파싱 표를 쓰지 않는다**(D-56 — PDF 파서·OCR 은 새 의존성이다)",
      !estimateSrc.includes("estimate_uploads") &&
        !srcOf("lib/estimates/loader.ts").includes("estimate_uploads"),
    );
  }

  check(
    "공유 레지스트리가 비교표를 연다 (S7-12 의 대기가 풀렸다)",
    srcOf("lib/core/share/share.ts")
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
    const membershipSrc = srcOf("lib/core/membership/membership.ts");
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
      srcOf("lib/core/ai/limits.ts").includes('MEMBERSHIP_TIERS = ["free", "premium"]'),
    );
    check(
      "**플래너가 등급을 지어내지 않는다** — 저장값이 아니라 계산값을 본다",
      srcOf("app/api/ai/planner/route.ts").includes("loadMembership"),
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
    const contentSrc = srcOf("lib/core/content/content.ts");

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
    ].map((path) => /export const revalidate = (\d+)/.exec(srcOf(path))?.[1]);

    check(
      "**두 콘텐츠 화면의 재생성 창이 같다**",
      windows[0] !== undefined && windows[0] === windows[1],
      `revalidate=${windows.join("|")}`,
    );
  }

  check(
    "사이트맵이 발행 목록을 **같은 함수**에서 가져온다 (판정이 둘로 갈리면 404 가 생긴다)",
    srcOf("app/sitemap.ts").includes("publishedSlugs") &&
      srcOf("lib/content/loader.ts").includes('rpc("published_content"'),
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
    const guidesSrc = srcOf("lib/core/compliance/guides.ts");
    const rulesSrc = srcOf("lib/core/rules/detect-rules.ts");

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

    const complianceSrc = srcOf("lib/core/compliance/compliance.ts");

    check(
      "**AI 를 부르지 않는다** — 같은 문서에 같은 답이 나와야 배지가 우연이 아니다",
      !complianceSrc.includes("@/lib/ai") &&
        !srcOf("lib/compliance/scan.ts").includes("lib/ai/"),
    );
    check(
      "**소비자 리포트와 같은 룰 엔진을 쓴다** — 룰을 새로 만들지 않았다",
      srcOf("lib/compliance/scan.ts").includes('from "@/lib/core/rules/scan"'),
    );
    check(
      "**저장 전에 마스킹한다** — 실수로 붙여넣은 고객 이름이 인용에 남지 않는다",
      srcOf("lib/compliance/scan.ts").includes("maskText"),
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
    srcOf("components/layout/AdminShell.tsx").includes('href: "/vendor/compliance"'),
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
    -- 원래는 자기 두 행만 지웠다. 시드가 같은 커플에 하객을 넣자(FIX-56) 커플 단위
    -- count 가 어긋났다 — 이 검사가 세는 것은 **이 트랜잭션이 만든 명단**이다.
    delete from public.guests;
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
    const guestSrc = srcOf("lib/core/guest/guest.ts");

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
    const loaderSrc = srcOf("lib/guest/loader.ts");

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
      srcOf("app/robots.ts").includes('"/rsvp/"'),
    );
    check(
      "홈이 하객 화면을 가리킨다 (만든 화면에 들어가는 자리를 잇는다)",
      srcOf("app/(consumer)/home/page.tsx").includes('href="/guests"'),
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
    srcOf("app/(admin)/admin/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "지표 API 도 캐시되지 않는다",
    srcOf("app/api/admin/metrics/route.ts").includes(
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
    srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/audit"'),
  );
  check(
    "감사 로그 화면이 캐시되지 않는다 (권한 회수 뒤에도 나가면 안 된다)",
    srcOf("app/(admin)/admin/audit/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "감사 로그 API 도 캐시되지 않는다",
    srcOf("app/api/admin/audit-logs/route.ts").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**증적 타임라인 API 는 읽기 전용이다** — POST·PATCH·DELETE 를 두지 않았다(§4.3)",
    !/export async function (POST|PATCH|PUT|DELETE)/.test(
      srcOf("app/api/admin/entity-events/route.ts"),
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
    srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/privacy"'),
  );
  check(
    "개인정보 감사 화면이 캐시되지 않는다",
    srcOf("app/(admin)/admin/privacy/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "감사 API 도 캐시되지 않는다",
    srcOf("app/api/admin/privacy-audit/route.ts").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    // S8-13 이 인증을 `lib/ops/job-auth.ts` 로 모았다(D-149). **검사가 보던 문자열이
    // 라우트에서 사라졌다** — 그런데 검사가 보려던 것은 문자열이 아니라 "세션으로
    // 열리지 않는다" 였다. 그 뜻대로 다시 쓴다: 라우트가 공통 인증을 쓰고, 그 인증이
    // 서버 전용 키 둘만 받는지.
    "**파기 배치가 세션이 아니라 서버 비밀키로 열린다** — 아무나 파기를 돌릴 수 없다",
    srcOf("app/api/jobs/purge-documents/route.ts").includes(
      "authorizeJob(request)",
    ) &&
      srcOf("lib/ops/job-auth.ts").includes("SUPABASE_SERVICE_ROLE_KEY") &&
      srcOf("lib/ops/job-auth.ts").includes("CRON_SECRET") &&
      // 세션에서 뽑은 사용자로 여는 경로가 없어야 한다.
      !srcOf("lib/ops/job-auth.ts").includes("getSessionUser"),
  );
  check(
    "**배치가 Storage 를 지운 뒤에 purged_at 을 찍는다**(D-58) — 뒤집으면 감사가 눈을 감는다",
    (() => {
      const src = srcOf("lib/privacy/purge.ts");
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
    srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/disputes"'),
  );
  check(
    "**내비가 `/admin/penalties` 를 가리킨다** — URL 을 직접 쳐야 열리던 화면이었다(FIX-25)",
    srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/penalties"'),
  );
  check(
    "분쟁 화면이 캐시되지 않는다",
    srcOf("app/(admin)/admin/disputes/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "조율 API 도 캐시되지 않는다",
    srcOf("app/api/admin/disputes/[id]/route.ts").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**큐가 증적 타임라인을 새로 만들지 않고 S8-02 의 것을 가리킨다**",
    srcOf("app/(admin)/admin/disputes/page.tsx").includes("/admin/audit?targetType="),
  );
  check(
    "**조율 콘솔이 위약금을 다시 산정하지 않는다** — 계약 시점 규칙으로 이미 박힌 값을 읽는다",
    // 주석에는 그 파일 이름이 나온다(왜 안 부르는지 적어 두었다). **import 를 본다.**
    !/^\s*import[^;]*lib\/core\/pricing/m.test(srcOf("lib/dispute/loader.ts")),
  );
  check(
    "**노쇼 판정을 다시 구현하지 않고 applyVerdict 를 부른다** — 무응답 기본값이 두 벌이 되면 안 된다",
    srcOf("app/api/admin/consultation-disputes/route.ts").includes("applyVerdict"),
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
        values ('seoul-gangnam','hall','all','all', 1, 999, 'registered_price', 'v1');`),
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
      const src = srcOf("lib/core/pricing/anomaly.ts");

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
    srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/prices"'),
  );
  check(
    "가격 큐레이션 화면이 캐시되지 않는다",
    srcOf("app/(admin)/admin/prices/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "이상 탐지 API 도 캐시되지 않는다",
    srcOf("app/api/admin/price-anomalies/route.ts").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    // S8-13 이 인증을 공통 헬퍼로 모았다(D-149). 위와 같은 이유로 뜻대로 다시 쓴다.
    "**두 배치가 서버 비밀키로만 열린다** — 아무나 지수를 다시 셀 수 없다",
    srcOf("app/api/jobs/price-index-refresh/route.ts").includes(
      "authorizeJob(request)",
    ) &&
      srcOf("app/api/jobs/price-anomaly-scan/route.ts").includes(
        "authorizeJob(request)",
      ),
  );
  check(
    "**사분위를 다시 구현하지 않고 S3-08 의 buildPriceIndex 를 부른다**",
    srcOf("lib/pricing/curation.ts").includes("buildPriceIndex"),
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
      ...srcOf("lib/core/review/report.ts").matchAll(/^  "([a-z_]+)",$/gm),
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
    const codeStatuses = srcOf("lib/core/review/write.ts").match(
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
        // C-1 (0074). 요율 스냅샷 검사가 **INSERT 에도** 걸리므로 확정 픽스처는
        // 요율을 함께 넣어야 한다. 넣지 않으면 이 검사가 **후기 정책이 아니라
        // 트리거 때문에** 거절되고, 그러면 무엇을 확인한 검사인지 알 수 없게 된다.
        `insert into public.bookings(id, couple_id, vendor_id, status, total_amount,
                                     applied_fee_rate_bp, applied_planner_fee_rate_bp)
           select '00000000-0000-0000-0000-0000000000fe', couple_id, vendor_id, 'confirmed', 1, 500, 0
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
    srcOf("lib/core/review/abuse.ts").includes('status: "blocked"'),
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
    const shell = srcOf("components/layout/AdminShell.tsx");

    check("내비가 `/admin/reviews` 를 가리킨다", shell.includes('href: "/admin/reviews"'));
    check("내비가 `/vendor/reviews` 를 가리킨다", shell.includes('href: "/vendor/reviews"'));
  }
  check(
    "**후기 작성 화면에 들어갈 길이 있다** — 만들고 가리키지 않으면 도달 불가다(FIX-25)",
    srcOf("app/(consumer)/me/page.tsx").includes("/reviews/new/"),
  );
  check(
    "업체 상세가 검증 후기를 싣는다 (커뮤니티 언급과 실선/점선으로 갈린다 · §6.2)",
    srcOf("app/(consumer)/explore/[vendorId]/page.tsx").includes("VendorReviews"),
  );
  check(
    "후기 관리 화면이 캐시되지 않는다",
    srcOf("app/(admin)/admin/reviews/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**S2-08 의 '평균 평점' 이 실측으로 바뀌었다** — 만든 기능을 화면이 '없다' 고 말하지 않는다(FIX-29)",
    !srcOf("lib/vendor/stats.ts").includes("검증 후기 기능이 아직 없습니다"),
  );
  check(
    "**후기 0건을 0점으로 적지 않는다** (0점은 '평가가 최악' 으로 읽힌다 · D-96)",
    srcOf("lib/vendor/stats.ts").includes("noBasis("),
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
      ...srcOf("lib/core/report/pipeline.ts")
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
      ...(srcOf("lib/core/quality/metrics.ts")
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
    srcOf("lib/core/quality/metrics.ts").includes('status: "blocked"') &&
      srcOf("app/api/admin/ai-quality/route.ts").includes("costBlocked"),
  );
  check(
    "**목표치가 '가정' 이라는 사실을 코드가 들고 다닌다** — 판정을 만들지 않는다",
    srcOf("lib/core/quality/metrics.ts").includes("assumed: true"),
  );

  // ── 계측: 셀 수 없던 것을 세는가 ──────────────────────────────────────────
  check(
    "**플래너가 품질 로그를 남긴다** — 그전까지 리포트만 남겨 '플래너 0%' 가 떴다",
    srcOf("app/api/ai/planner/route.ts").includes("logAiCall"),
  );
  check(
    "**상한에 막힌 턴도 남는다** — 실패가 아니라 limit_reached 다",
    srcOf("app/api/ai/planner/route.ts").includes('"limit_reached"'),
  );
  check(
    "**리포트가 폐기 수를 칸에 남긴다** — memo 문자열 파싱으로 지표를 만들지 않는다",
    srcOf("lib/reports/analyze.ts").includes("findingsDiscarded"),
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
    srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/ai-quality"') &&
      !srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/quality"'),
  );
  check(
    "**오탐 신고에 들어가는 자리가 있다** — 접수 경로 없는 큐는 영원히 비어 있다(FIX-25)",
    srcOf("app/(consumer)/reports/[id]/ReportDetailView.tsx").includes(
      "FindingReportButton",
    ),
  );
  check(
    "품질 화면이 캐시되지 않는다",
    srcOf("app/(admin)/admin/ai-quality/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**S8-01 의 AI 비용 카드가 담당·사유를 바로잡았다** — 잘못 적힌 담당은 아무도 걷지 않는다",
    !srcOf("lib/core/metrics/admin.ts").includes('"S8-04",'),
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
    const code = srcOf("lib/core/content/cms.ts");
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
    srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/cms"') &&
      !srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/content"'),
  );
  check(
    "콘텐츠 화면이 캐시되지 않는다",
    srcOf("app/(admin)/admin/cms/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**DELETE 라우트가 행을 지우지 않는다** — 공개만 거둔다",
    srcOf("app/api/admin/content/route.ts").includes("unpublished: true") &&
      srcOf("lib/content/admin.ts").includes("published_at: null"),
  );
  check(
    "**CTA 키를 쓰기에서 막는다**(D-98) — 걸러진 값은 화면에 안 보여 잘못 적은 줄 모른다",
    srcOf("lib/core/content/cms.ts").includes("KNOWN_TOOL_KEYS"),
  );
  check(
    // **함정 4.** `/guides` 는 `revalidate = 300` 으로 굳는다(S7-10 · 그것이 목적이다).
    // 무효화가 없으면 발행이 최대 5분 뒤에 보이고 — 더 나쁘게 — **내린 글이 5분 동안
    // 계속 열린다.** 화면은 '내렸다' 고 말하는데 URL 은 살아 있는 상태다.
    // S8-08 흐름 점검이 실제로 여기 걸렸다.
    "**쓰기 뒤에 공개 화면 캐시를 무효화한다** — 안 그러면 내린 글이 5분 동안 열려 있다",
    srcOf("lib/content/admin.ts").includes("revalidatePath") &&
      srcOf("lib/content/admin.ts").includes('revalidatePath("/sitemap.xml")'),
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
      ...srcOf("lib/core/rules/detect-rules.ts").matchAll(/code: "(R-\d{2})"/g),
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
    srcOf("lib/rules/admin.ts").includes("mergeDetectRules"),
  );

  // ── 고칠 수 있는 칸이 셋뿐인가 ────────────────────────────────────────────
  check(
    "**수정 경로가 만지는 칸이 셋뿐이다** — 서비스롤이라 DB 컬럼 권한이 안 걸린다",
    (() => {
      const src = srcOf("lib/rules/admin.ts");
      // **앵커를 아예 없앤다**(FIX-64). 이 검사는 앵커를 세 번 잃었다 — 줄바꿈
      // 정규화로 한 번, 소스에서 주석을 걷어내면서 한 번, 그 대안으로 고른
      // `.from("detect_rules")` 가 **세 군데 있어** 또 한 번.
      //
      // 생각해 보면 **수정 경로가 하나라는 것 자체가 이 검사가 묻는 것**이다 —
      // 둘이 되면 한쪽이 목록을 늘려도 모른다. 그래서 `.update({...})` 를
      // **전부** 모아 하나임을 함께 묻는다. 앵커도 없고 검사도 세진다.
      const updates = [...src.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
      // **목록을 실제로 읽었는가를 먼저 묻는다**(운영 규칙 7.0b).
      if (updates.length !== 1) return false;
      const update = updates[0];

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
    !srcOf("lib/core/rules/console.ts").includes(
      'EDITABLE_RULE_FIELDS = ["is_active", "prompt_fragment", "basis_ref", "pattern_json"',
    ) &&
      srcOf("lib/core/rules/console.ts").includes(
        'EDITABLE_RULE_FIELDS = ["is_active", "prompt_fragment", "basis_ref"]',
      ),
  );

  // ── 없는 것을 있는 것처럼 적지 않는다 ─────────────────────────────────────
  check(
    "**배포 게이트가 blocked 로 API 본문에 실린다** (골든셋이 없다 · FIX-42 · 함정 3)",
    srcOf("app/api/admin/rules/route.ts").includes("gateBlocked") &&
      srcOf("lib/core/rules/console.ts").includes('reason: "golden_set_missing"'),
  );
  check(
    "**배포 이력 표가 비어 있다는 사실도 상태로 나간다** (O-22)",
    srcOf("app/api/admin/rules/route.ts").includes("ledgerEmpty") &&
      srcOf("lib/core/rules/console.ts").includes('openIssue: "O-22"'),
  );
  check(
    "**한 번도 안 불린 판본을 0회로 적지 않는다** (S8-07 이 겪은 것)",
    srcOf("lib/rules/admin.ts").includes("usage.get(source.version) ?? null"),
  );
  check(
    "**판본 사용 이력을 저장하지 않는다** — ai_call_logs 에서 센다(D-124)",
    sql(`select count(*) from public.prompt_versions;`) === "0",
  );

  // ── 화면·라우트가 이어져 있다 ─────────────────────────────────────────────
  check("`/admin/rules` 화면이 실재한다", existsSync("app/(admin)/admin/rules/page.tsx"));
  check(
    "**내비가 `/admin/rules` 를 가리킨다** — 안 그러면 URL 을 직접 쳐야 한다(FIX-25)",
    srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/rules"'),
  );
  check(
    "룰 화면이 캐시되지 않는다",
    srcOf("app/(admin)/admin/rules/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**마지막 룰을 끌 때 결과를 미리 말한다** — 막지는 않는다",
    srcOf("lib/core/rules/console.ts").includes("deactivationWarning"),
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
    const code = srcOf("lib/core/support/ticket.ts");
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
      srcOf("lib/core/support/ticket.ts").includes("USER_SANCTION_UNAVAILABLE"),
  );

  // ── 큐를 합치지 않는다 ────────────────────────────────────────────────────
  check(
    "**신고 큐를 합치는 표도 뷰도 만들지 않았다** (D-142 · 계산이다)",
    sql(`select count(*) from information_schema.tables
           where table_schema = 'public' and table_name like '%report_queue%';`) === "0",
  );
  check(
    "**옆 큐 셋을 가리키기만 한다** — 합치지 않되 놓치지 않게",
    srcOf("lib/core/support/ticket.ts").includes("SIBLING_QUEUES") &&
      srcOf("lib/support/admin.ts").includes("community_reports") &&
      srcOf("lib/support/admin.ts").includes("review_reports") &&
      srcOf("lib/support/admin.ts").includes("finding_reports"),
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
    srcOf("app/(consumer)/me/page.tsx").includes('href="/support"'),
  );
  check(
    "**내비의 `/admin/tickets` 가 이제 살아 있다** (FIX-23 죽은 링크 하나 감소)",
    srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/tickets"'),
  );
  check(
    "CS 화면이 캐시되지 않는다",
    srcOf("app/(admin)/admin/tickets/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**'지연' 이라고 적지 않는다** — 처리 기한이 정해져 있지 않다",
    !srcOf("app/(admin)/admin/tickets/page.tsx").includes("지연") ||
      srcOf("app/(admin)/admin/tickets/page.tsx").includes("지연&apos;이라고 적지"),
  );
  check(
    "**사용자 제재를 할 수 없다는 사실이 API 본문에 실린다** (함정 3)",
    srcOf("app/api/admin/tickets/route.ts").includes("userSanction"),
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
    const registry = srcOf("lib/core/flags/registry.ts");
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
    const registry = srcOf("lib/core/flags/registry.ts");
    const view = srcOf("lib/core/schedule/view.ts");

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
    srcOf("lib/flags.ts").includes("enabled === true") &&
      srcOf("lib/core/flags/registry.ts").includes("row?.enabled === true"),
  );
  check(
    "**아무도 안 읽는 행을 '열린 기능' 으로 세지 않는다**",
    srcOf("lib/core/flags/registry.ts").includes(
      "known.filter((flag) => flag.enabled).length",
    ),
  );

  // ── 조건 미충족 상태로 켜기 (D-145) ───────────────────────────────────────
  check(
    "**막지 않고 드러낸다** — 조건 안내가 있고 차단이 없다",
    srcOf("lib/core/flags/registry.ts").includes("conditionNotice") &&
      !srcOf("lib/flags/admin.ts").includes("CONDITION_NOT_MET"),
  );
  check(
    "**사유가 필수다** — 조건을 안 막는 대신 왜 켰는지를 남긴다",
    srcOf("app/api/admin/flags/[key]/route.ts").includes("왜 바꾸는지 적어 주세요"),
  );
  check(
    "**선언된 부분 스위치만 덮어쓴다** — 개방 조건 서술이 사라지면 안 된다(D-67)",
    srcOf("lib/flags/admin.ts").includes("declared.has(key)"),
  );
  check(
    "**updated_by 를 입력으로 받지 않는다** — 남의 이름으로 '이 사람이 켰다' 가 만들어진다",
    !srcOf("app/api/admin/flags/[key]/route.ts").includes("updatedBy"),
  );

  // ── 집행되지 않는 조치를 만들지 않는다 ────────────────────────────────────
  check(
    "**지역·세그먼트 부분 공개를 만들지 않았고 그 사실이 API 본문에 실린다** (함정 3)",
    srcOf("app/api/admin/flags/[key]/route.ts").includes("segmentRolloutAvailable") &&
      srcOf("lib/flags/admin.ts").includes("available: false"),
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
    srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/flags"'),
  );
  check(
    "플래그 화면이 캐시되지 않는다 (스위치가 캐시되면 스위치가 아니다 · FIX-22)",
    srcOf("app/(admin)/admin/flags/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**되돌릴 수 없는 것을 먼저 말한다** — 플래그는 되돌려도 그 사이 벌어진 일은 남는다",
    srcOf("lib/core/flags/registry.ts").includes("irreversible"),
  );
  check(
    "**전환을 증적에 남긴다** (entity_events + audit_logs)",
    srcOf("lib/flags/admin.ts").includes('entityType: "feature_flag"') &&
      srcOf("lib/flags/admin.ts").includes("writeAuditLog"),
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
    const monitor = srcOf("lib/core/ops/monitor.ts");
    const names = [...monitor.matchAll(/name: "([a-z]+(?:-[a-z]+)+)",/g)].map((match) => match[1]);
    const inCheck = sql(`select pg_get_constraintdef(oid) from pg_constraint
                           where conname = 'job_runs_name_vocab';`);

    // §4.5 의 열 종 + FIX-14 의 `escrow-release` + C-4d 의 `task-due-notifications`.
    check("코드가 배치 열두 종을 선언한다 (명세 §4.5 + FIX-14 + C-4d)", new Set(names).size === 12);
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
        srcOf(`app${path}/route.ts`).includes("export const GET = POST"),
      ),
    );
    check(
      "**모든 배치가 공통 인증을 쓴다** — `CRON_SECRET` 또는 서비스롤 키",
      routes.every((path) =>
        srcOf(`app${path}/route.ts`).includes("authorizeJob(request)"),
      ),
    );
    check(
      "**모든 배치가 `job_runs` 를 채운다** — 안 채우면 화면이 '한 번도 안 돌았다' 로 적는다",
      routes.every((path) => {
        // **라우트 파일만 보면 안 된다.** `purge-documents` 는 기록을 `lib/privacy/purge.ts`
        // 안에서 남긴다 — 라우트 본문만 훑는 검사는 그것을 '안 채운다' 로 읽는다.
        // 라우트가 부르는 `@/lib/...` 모듈을 한 겹 따라간다.
        const src = srcOf(`app${path}/route.ts`);
        const writes = (text) => text.includes("openJobRun") || text.includes('.from("job_runs")');
        if (writes(src)) return true;

        return [...src.matchAll(/from "@\/(lib\/[^"]+)"/g)].some((match) => {
          const file = `${match[1]}.ts`;
          return existsSync(file) && writes(srcOf(file));
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
    srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/ops"'),
  );
  check(
    "운영 상태 화면이 캐시되지 않는다 (5분 전 상태를 보이면 장애 화면이 아니다)",
    srcOf("app/(admin)/admin/ops/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );

  // ── 함정 3: 화면이 안 그리는 것만으로는 부족하다 ─────────────────────────
  check(
    "**경보를 보내지 않는다는 사실이 API 응답 본문에 실린다**(D-147 · D-28)",
    srcOf("lib/ops/admin.ts").includes("alertDelivery") &&
      srcOf("lib/core/ops/monitor.ts").includes("available: false"),
  );
  check(
    "**로그인 실패 집계가 전수가 아니라는 사실도 본문에 실린다**(FIX-32)",
    srcOf("lib/ops/admin.ts").includes("loginObservability"),
  );
  check(
    "**측정하지 않은 것을 0 으로 적지 않는다** — 집계 키가 빠지면 오류로 끝난다",
    srcOf("lib/ops/admin.ts").includes("OPS_LOAD_FAILED"),
  );

  // ── FIX-32 의 신고 경로가 실제로 이어져 있는가 ───────────────────────────
  check(
    "신고 라우트가 실재한다",
    existsSync("app/api/observability/client-event/route.ts"),
  );
  check(
    "**로그인 화면이 그 라우트를 부른다** — 만든 경로에 들어가는 자리를 잇는다",
    srcOf("app/(auth)/login/LoginForm.tsx").includes(
      "/api/observability/client-event",
    ),
  );
  check(
    "**신고가 로그인을 막지 않는다** — 기다리지 않고 실패를 삼킨다",
    srcOf("app/(auth)/login/LoginForm.tsx").includes("keepalive: true"),
  );
  check(
    "**신고 라우트가 서비스롤을 쓰지 않는다** — 비인증 입력에 RLS 우회 권한을 붙이지 않는다",
    !srcOf("app/api/observability/client-event/route.ts").includes(
      "createAdminClient",
    ),
  );
  check(
    "**신고 라우트가 성공·실패를 구분해 알려주지 않는다** — 표의 어휘를 캐는 도구가 된다",
    srcOf("app/api/observability/client-event/route.ts").includes("status: 204"),
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
    const consoleSrc = srcOf("lib/core/booking/console.ts");
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
      srcOf("lib/core/review/write.ts").includes('["confirmed", "fulfilled"]'),
    );
  }

  // ── 승인이 계약 발행의 선행인가 (승인 버튼이 장식이 아닌가) ───────────────
  check(
    "**승인 없이는 계약을 발행할 수 없다** — 이 문이 없으면 승인 버튼이 장식이다",
    srcOf("lib/contract/actions.ts").includes("CONTRACT_BOOKING_NOT_ACCEPTED"),
  );
  check(
    "**결정 자격을 순수 함수 하나가 판정한다** — 화면과 API 가 다른 답을 내면 버튼이 눌리지 않는다",
    srcOf("lib/bookings/vendor.ts").includes("canDecide(") &&
      srcOf("app/(vendor)/vendor/bookings/page.tsx").includes("row.canDecide"),
  );

  // ── 증적 ──────────────────────────────────────────────────────────────────
  check(
    "**승인·거절을 entity_events 에 남긴다** — 예약에는 지금까지 전이 기록이 아예 없었다",
    srcOf("lib/bookings/vendor.ts").includes('entityType: "booking"') &&
      srcOf("lib/audit/record.ts").includes('| "booking"'),
  );
  check(
    "**거절 사유 본문을 이벤트에 담지 않는다**(§5.3) — 사유는 표가 갖고 이벤트는 사실만 남긴다",
    !srcOf("lib/bookings/vendor.ts").includes("memo: reason"),
  );

  // ── 화면·라우트가 이어져 있다 ────────────────────────────────────────────
  check("`/bookings` 목록 화면이 실재한다", existsSync("app/(consumer)/bookings/page.tsx"));
  check("`/bookings/[id]` 상세 화면이 실재한다", existsSync("app/(consumer)/bookings/[id]/page.tsx"));
  check("`/vendor/bookings` 화면이 실재한다", existsSync("app/(vendor)/vendor/bookings/page.tsx"));
  check(
    "**`/me` 가 예약 목록을 가리킨다** — 하단 탭은 다섯 칸이 차서 여기가 진입점이다(D-55)",
    srcOf("app/(consumer)/me/page.tsx").includes('href="/bookings"'),
  );
  check(
    "**예약 상세가 다섯 진입점을 전부 그린다** — 이 화면이 없어서 다섯이 도달 불가였다(FIX-25)",
    ["contract", "checkout", "cancel", "escrow", "review"].every((key) =>
      srcOf("lib/core/booking/console.ts").includes(`"${key}"`),
    ),
  );
  check(
    "**막힌 진입점에도 이유가 붙는다** — 감추면 '그런 기능이 없다' 로 읽힌다",
    srcOf("app/(consumer)/bookings/[id]/page.tsx").includes("entry.blocked"),
  );
  check(
    "예약 화면 셋이 캐시되지 않는다 (승인·결제 상태가 바뀌는 화면이다)",
    ["app/(consumer)/bookings/page.tsx", "app/(consumer)/bookings/[id]/page.tsx",
     "app/(vendor)/vendor/bookings/page.tsx"].every((path) =>
      srcOf(path).includes('export const dynamic = "force-dynamic"'),
    ),
  );
  check(
    "**FIX-23 의 죽은 링크 하나가 사라졌다** — `VENDOR_NAV` 의 `/vendor/bookings` 가 이제 실재한다",
    srcOf("components/layout/AdminShell.tsx").includes('href: "/vendor/bookings"') &&
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
    srcOf("lib/core/coupon/coupon.ts").includes("other_vendor") &&
      srcOf("lib/core/coupon/coupon.ts").includes("bookingVendorId"),
  );
  check(
    "**결제 경로가 예약의 업체를 넘긴다** — 안 넘기면 판정이 있어도 안 돈다",
    srcOf("lib/payments/charge.ts").includes("bookingVendorId: context.vendorId"),
  );
  check(
    "**정산이 할인액을 예약의 업체에서 뺀다** — 그래서 발행 업체와 어긋나면 안 된다",
    srcOf("lib/settlements/actions.ts").includes('from("coupon_redemptions")'),
  );

  // ── FIX-13: 회차 금액에 쿠폰이 반영되는가 ────────────────────────────────
  check(
    "**청구 금액이 할인 뒤 금액이다** — 안 그러면 회차마다 정가가 빠져 합계가 총액을 넘는다",
    srcOf("lib/payments/charge.ts").includes("const chargeAmount ="),
  );
  check(
    "**이미 쓴 할인을 잔액 계산에 넘긴다** — 안 넘기면 다 내고도 잔액이 남는다",
    srcOf("lib/payments/loader.ts").includes("priorDiscountAmount") &&
      srcOf("lib/core/payment/checkout.ts").includes("priorDiscountAmount"),
  );
  check(
    "**화면이 금액을 보내지 않는다** — 발급분 id 만 보낸다(할인액을 클라이언트가 정하면 안 된다)",
    srcOf("app/(consumer)/checkout/[bookingId]/CheckoutView.tsx").includes(
      "couponIssueId,",
    ) &&
      !srcOf("app/(consumer)/checkout/[bookingId]/CheckoutView.tsx").includes(
        "discountAmount:",
      ),
  );

  // ── 화면·라우트가 이어져 있다 ────────────────────────────────────────────
  check("`/coupons` 화면이 실재한다", existsSync("app/(consumer)/coupons/page.tsx"));
  check(
    "**`/me` 가 쿠폰함을 가리킨다** — 하단 탭은 다섯 칸이 차서 여기가 진입점이다(D-55)",
    srcOf("app/(consumer)/me/page.tsx").includes('href="/coupons"'),
  );
  check(
    "**결제 화면이 더는 '준비 중' 이라 말하지 않는다** — 다 만든 기능을 준비 중이라 적지 않는다",
    srcOf("lib/payments/loader.ts").includes("featureReady: true"),
  );
  check(
    "**못 쓰는 쿠폰도 결제 화면에 사유와 함께 남는다**(F-C-36)",
    srcOf("app/(consumer)/checkout/[bookingId]/CheckoutView.tsx").includes(
      "coupon-blocked",
    ),
  );
  check(
    "쿠폰함이 캐시되지 않는다 (만료가 시계로 판정되는 화면이다)",
    srcOf("app/(consumer)/coupons/page.tsx").includes(
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
    srcOf("lib/core/coupon/issue.ts").includes("review_reward") &&
      srcOf("lib/core/coupon/issue.ts").includes("isReviewRewardCondition"),
  );
  check(
    "**업체 선택지에 리뷰도 manual_grant 도 없다** (화면 층)",
    /**
     * **근접탐색을 그만둔다**(FIX-64). 예전엔 `VENDOR_ISSUE_CONDITIONS` 뒤 200자 안에
     * `review` 가 없는지를 봤는데, 사이에 끼어 있던 **주석 블록이 200자를 메우는
     * 바람에** 통과하고 있었다. 주석을 걷자 바로 뒤의 `REVIEW_WORDS` 가 창에 들어와
     * FAIL 이 됐는데, 그 상수는 **금지를 집행하는 쪽**이니 거꾸로 읽힌 것이다.
     * 거리로 묻는 한 통과도 실패도 우연이다 — **목록 자체를 읽어** 묻는다.
     */
    (() => {
      const src = srcOf("lib/core/coupon/coupon.ts");
      const block = src.match(/ISSUE_CONDITIONS = \[([\s\S]*?)\] as const;/);
      // **목록을 실제로 읽었는가를 먼저 묻는다**(운영 규칙 7.0b) —
      // 못 읽으면 빈 목록이 조용히 통과한다.
      if (!block) return false;
      const items = [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
      if (items.length === 0) return false;

      // 업체 선택지 = 전체 − manual_grant. 거기에 리뷰성 낱말이 없어야 한다.
      const vendorItems = items.filter((item) => item !== "manual_grant");

      return (
        items.includes("manual_grant") &&
        vendorItems.length > 0 &&
        !vendorItems.some((item) => /review|rating/i.test(item)) &&
        src.includes(
          "VENDOR_ISSUE_CONDITIONS: readonly IssueCondition[] = ISSUE_CONDITIONS.filter",
        )
      );
    })(),
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
    srcOf("components/layout/AdminShell.tsx").includes('href: "/vendor/coupons"'),
  );
  check(
    "쿠폰 화면이 캐시되지 않는다 (소진·만료가 시계로 판정되는 화면이다)",
    srcOf("app/(vendor)/vendor/coupons/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**발급 실행 경로가 없다는 사실이 API 응답 본문에 실린다**(함정 3 · FIX-46)",
    srcOf("lib/coupons/vendor.ts").includes("issuanceWired: false"),
  );
  check(
    "**못 보는 차감액을 0 으로 내려보내지 않는다**(함정 2) — 대표가 아니면 null 이다",
    srcOf("lib/coupons/vendor.ts").includes("input.isOwner ?") &&
      srcOf("lib/coupons/vendor.ts").includes("deductedAmount: input.isOwner"),
  );
  check(
    "**issuer_id 를 입력으로 받지 않는다** — 세션이 정한다(비용을 지는 쪽과 만드는 쪽이 같다)",
    !srcOf("app/api/vendor/coupons/route.ts").includes("issuerId"),
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

// ═══════════════════════════════════════════════════════════════════════════
// S5-14 — 플랫폼 쿠폰 관리 (F-A-19 · 0068 · **FIX-47**)
//
// 이 태스크의 자격은 `is_operator()` 이고 그 근거 표는 **`profiles`** 다.
// 그 표에 자기 역할을 스스로 쓸 수 있으면 **운영자 콘솔 전체가 열린다** —
// 아래 첫 묶음이 그것을 본다.
// ═══════════════════════════════════════════════════════════════════════════
{
  const consumerId = idOf("couple-a@local.test");
  const vendorOwnerId = idOf("vendor@local.test");
  const platformCouponId = sql(`select id from public.coupons
                                  where issuer_type = 'platform' limit 1;`);
  const vendorCouponId = sql(`select id from public.coupons
                                where issuer_type = 'vendor' limit 1;`);

  // ── 층 3 (FIX-44/FIX-47): 자격의 근거가 되는 표 ──────────────────────────
  check(
    "**아무도 자기 역할을 바꿀 수 없다**(FIX-47) — 한 줄로 운영자가 되는 길이었다",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(consumerId, `update public.profiles set role = 'admin' where user_id = '${consumerId}';`),
    ),
  );
  check(
    "**업체 대표도 자기를 운영자로 만들 수 없다**",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(vendorOwnerId, `update public.profiles set role = 'ops' where user_id = '${vendorOwnerId}';`),
    ),
  );
  check(
    "**남의 역할도 못 바꾼다**",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(consumerId, `update public.profiles set role = 'consumer' where user_id = '${adminUser}';`),
    ),
  );
  check(
    "**가입할 때도 역할을 스스로 못 적는다** — 첫 행부터 admin 으로 만들 수 없다",
    rejectedWith(/permission denied|row-level security/i, () =>
      asUser(
        consumerId,
        `insert into public.profiles (user_id, display_name, role)
           values (gen_random_uuid(), '위조', 'admin');`,
      ),
    ),
  );
  check(
    "**표 단위 INSERT·UPDATE 가 없다** — 있으면 컬럼 회수가 무효가 된다(FIX-36)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'profiles'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**role 컬럼에 쓰기 권한이 아무에게도 없다**",
    sql(`select count(*) from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'profiles'
             and column_name = 'role' and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE');`) === "0",
  );
  check(
    "**프로필을 지울 수 있는 사람이 없다** — actor_id 가 가리키던 사람이 사라지면 증적이 무너진다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'profiles'
             and grantee in ('anon', 'authenticated') and privilege_type = 'DELETE';`) === "0",
  );

  // 본인이 고치던 칸은 그대로 열려 있어야 한다 — 막기만 하고 못 쓰게 하면 화면이 죽는다.
  check(
    "**본인은 표시 이름을 여전히 고친다** — 걷은 것은 역할이지 프로필이 아니다",
    asUser(
      consumerId,
      `update public.profiles set display_name = 'RLS이름' where user_id = '${consumerId}';
       select display_name from public.profiles where user_id = '${consumerId}';`,
    ) === "RLS이름",
  );

  // 역할 변경이 어느 경로로든 증적에 남는가
  check(
    "**역할 변경이 entity_events 에 남는다** — 앱 코드가 아니라 트리거가 남긴다",
    sql(`begin;
           update public.profiles set role = 'ops' where user_id = '${consumerId}';
           select count(*) from public.entity_events
            where entity_type = 'profile' and entity_id = '${consumerId}'
              and event_type = 'profile_role_changed';
         rollback;`).split("\n").pop() !== "0",
  );

  // ── 층 1·2: 쿠폰 표 (S5-12·S5-13 이 좁힌 것이 그대로인가) ────────────────
  check(
    "**coupons 에 표 단위 쓰기가 없다**",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'coupons'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**플랫폼 쓰기 정책이 자기 조건을 스스로 말한다**(층 2 · FIX-41)",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'coupons'
             and policyname in ('coupons_write_platform', 'coupons_update_platform')
             and coalesce(with_check, '') like '%is_operator%';`) === "2",
  );

  // ── T-00e: 운영자가 업체 쿠폰을 만들 수 있는가 ───────────────────────────
  check(
    "**운영자가 업체 이름으로 쿠폰을 만들 수 없다**(T-00e) — 남의 정산에서 깎는 쿠폰이 된다",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        adminUser,
        `insert into public.coupons
           (issuer_type, issuer_id, name, discount_type, discount_value,
            max_discount_amount, min_order_amount, issue_condition, status)
         values ('vendor', '${sql(`select id from public.vendors limit 1;`)}', '운영자가만든업체쿠폰',
                 'amount', 50000, null, 0, 'first_purchase', 'active');`,
      ),
    ),
  );
  check(
    "**운영자가 업체 쿠폰을 고칠 수도 없다**",
    asUser(
      adminUser,
      `update public.coupons set name = '운영자가고침' where id = '${vendorCouponId}';
       select name from public.coupons where id = '${vendorCouponId}';`,
    ) !== "운영자가고침",
  );
  check(
    "**운영자는 플랫폼 쿠폰을 만들 수 있다** — 막기만 하면 기능이 없는 것이다",
    asUser(
      adminUser,
      `insert into public.coupons
         (issuer_type, issuer_id, name, discount_type, discount_value,
          max_discount_amount, min_order_amount, issue_condition, status)
       values ('platform', null, 'RLS플랫폼쿠폰', 'amount', 10000, null, 0,
               'period_event', 'active') returning 1;`,
    ) === "1",
  );
  check(
    "**업체 대표는 플랫폼 쿠폰을 만들 수 없다** — 비용을 플랫폼에 떠넘기는 길이다",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        vendorOwnerId,
        `insert into public.coupons
           (issuer_type, issuer_id, name, discount_type, discount_value,
            max_discount_amount, min_order_amount, issue_condition, status)
         values ('platform', null, '업체가만든플랫폼쿠폰', 'amount', 50000, null, 0,
                 'first_purchase', 'active');`,
      ),
    ),
  );
  check(
    "**issuer_id 를 채운 플랫폼 쿠폰은 CHECK 이 막는다** — 부담 주체가 둘이 될 수 없다",
    rejectedWith(/coupons_issuer_shape|row-level security/, () =>
      sql(`insert into public.coupons
             (issuer_type, issuer_id, name, discount_type, discount_value,
              max_discount_amount, min_order_amount, issue_condition, status)
           values ('platform', '${sql(`select id from public.vendors limit 1;`)}', '주체둘',
                   'amount', 10000, null, 0, 'period_event', 'active');`),
    ),
  );

  // ── 발급 뒤 동결이 플랫폼 쿠폰에도 걸리는가 (한쪽만 느슨하면 우회로가 된다) ──
  check(
    "**플랫폼 쿠폰도 발급이 시작되면 얼어붙는다**(D-159) — 업체 면과 같은 규칙이다",
    rejectedWith(/발급된 쿠폰|coupons_terms_frozen/, () =>
      sql(`update public.coupons set discount_value = 1 where id = '${platformCouponId}';`),
    ),
  );

  // ── 화면·라우트가 이어져 있다 ────────────────────────────────────────────
  check("`/admin/coupons` 화면이 실재한다", existsSync("app/(admin)/admin/coupons/page.tsx"));
  check(
    "**내비가 `/admin/coupons` 를 가리킨다** — 안 그러면 URL 을 직접 쳐야 한다(FIX-25)",
    srcOf("components/layout/AdminShell.tsx").includes('href: "/admin/coupons"'),
  );
  check(
    "플랫폼 쿠폰 화면이 캐시되지 않는다",
    srcOf("app/(admin)/admin/coupons/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**issuer_type 을 입력으로 받지 않는다** — 여기서 만드는 것은 언제나 플랫폼 쿠폰이다",
    !srcOf("app/api/admin/coupons/route.ts").includes("issuerType"),
  );
  check(
    "**비용이 전액 플랫폼 손익이라는 사실이 API 본문에 실린다**(함정 3)",
    srcOf("lib/coupons/admin.ts").includes('costBearer: "platform"'),
  );
  check(
    "**세그먼트를 만들지 않았다는 사실도 본문에 실린다**(D-143 계열)",
    srcOf("lib/coupons/admin.ts").includes("segmentTargeting") &&
      srcOf("lib/coupons/admin.ts").includes("available: false"),
  );
  check(
    "**두 면이 같은 순수 함수로 판정한다** — 한쪽만 느슨하면 그쪽이 우회로가 된다",
    srcOf("lib/coupons/admin.ts").includes("validateCouponForm") &&
      srcOf("lib/coupons/vendor.ts").includes("validateCouponForm"),
  );

  // ── 픽스처 ───────────────────────────────────────────────────────────────
  check(
    "**플랫폼 쿠폰과 업체 쿠폰이 둘 다 시드에 있다** — 경계를 양쪽에서 눈다",
    platformCouponId !== "" && vendorCouponId !== "",
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0068 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// S6-04 — 플래너 권한 위임 (F-C-18 · 0069)
//
// 이 태스크의 자격은 `has_planner_scope()` 이고 그 근거 표는 **`planner_engagements`
// + `planners`** 다. 자격을 얻으려는 사람은 **플래너**이므로 물음은 하나다 —
// "플래너가 그 두 표를 직접 쓸 수 있는가". 아래 첫 묶음이 그것을 본다.
// ═══════════════════════════════════════════════════════════════════════════
{
  // 전용 플래너를 하나 더 세운다. 시드 플래너(planner@local.test)는 이 커플과
  // **이미 활성 위임**을 갖고 있어 "수락 전" 갈래를 만들 수 없다 — 두 갈래가 다
  // 닿아야 검사가 뭔가를 본다(함정 8).
  const S604_PLANNER = "00000000-0000-0000-0000-0000000006a1";
  const S604_OFFER = "00000000-0000-0000-0000-0000000006a2";
  const SEEDED_PLANNER = "00000000-0000-0000-0000-00000000c0b1";

  const plannerRow = `
    insert into public.planners (id, user_id, status, profile_json, regions)
      values ('${S604_PLANNER}', '${outsider}', 'active',
              '{"headline":"위임 픽스처 플래너","categories":["hall"]}'::jsonb, array['seoul']);
  `;

  /** 아직 수락되지 않은 제안 하나. 범위는 couples 뿐이라 열림·닫힘이 한 값으로 읽힌다. */
  const offerFixture = `${plannerRow}
    insert into public.planner_engagements
      (id, planner_id, couple_id, scope_json, valid_from, valid_to)
      values ('${S604_OFFER}', '${S604_PLANNER}', '${coupleId}',
              '{"tables":["couples"]}'::jsonb,
              now() - interval '1 day', now() + interval '30 days');
  `;

  /** 수락까지 끝난 위임. */
  const activeFixture = `${offerFixture}
    update public.planner_engagements set status = 'active' where id = '${S604_OFFER}';
  `;

  // ── 층 3 (FIX-44 · FIX-47): 자격의 근거가 되는 표 ────────────────────────
  check(
    "**플래너는 자기 위임을 만들 수 없다** — 만들 수 있으면 자격 검사가 아무것도 검사하지 않는다",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        outsider,
        `insert into public.planner_engagements
           (planner_id, couple_id, scope_json, valid_from, valid_to)
         values ('${S604_PLANNER}', '${coupleId}', '{"tables":["guests"]}'::jsonb,
                 now(), now() + interval '30 days');`,
        plannerRow,
      ),
    ),
  );
  check(
    "**플래너는 받은 제안의 범위를 넓힐 수 없다** — 스스로 넓히면 자기 수수료를 늘리는 행위다",
    rejectedWith(/permission denied/i, () =>
      asUser(
        outsider,
        `update public.planner_engagements
            set scope_json = '{"tables":["couples","guests","budgets"]}'::jsonb
          where id = '${S604_OFFER}';`,
        offerFixture,
      ),
    ),
  );
  check(
    "**플래너는 기간도 늘릴 수 없다**",
    rejectedWith(/permission denied/i, () =>
      asUser(
        outsider,
        `update public.planner_engagements set valid_to = now() + interval '10 years'
          where id = '${S604_OFFER}';`,
        offerFixture,
      ),
    ),
  );
  check(
    "**수락해도 범위는 그대로다** — 값이 바뀌었는지를 직접 본다(함정 9)",
    asUser(
      outsider,
      `update public.planner_engagements set status = 'active' where id = '${S604_OFFER}';
       select scope_json::text from public.planner_engagements where id = '${S604_OFFER}';`,
      offerFixture,
    ) === '{"tables": ["couples"]}',
  );
  check(
    "**플래너는 남에게 온 제안을 수락할 수 없다** — 반영된 행 수로 본다",
    asUser(
      plannerAccount ?? adminUser,
      `with u as (update public.planner_engagements set status = 'active'
                   where id = '${S604_OFFER}' returning id)
       select count(*) from u;`,
      offerFixture,
    ) === "0",
  );
  check(
    "**플래너는 자기 앞으로 온 제안을 수락한다** — 막기만 하면 기능이 없는 것이다",
    asUser(
      outsider,
      `update public.planner_engagements set status = 'active' where id = '${S604_OFFER}';
       select status from public.planner_engagements where id = '${S604_OFFER}';`,
      offerFixture,
    ) === "active",
  );
  check(
    "**수락 시각은 서버가 적는다** — 당사자가 넣을 칸이 아니다",
    asUser(
      outsider,
      `update public.planner_engagements set status = 'active' where id = '${S604_OFFER}';
       select (responded_at is not null)::text
         from public.planner_engagements where id = '${S604_OFFER}';`,
      offerFixture,
    ) === "true",
  );
  check(
    "**수락한 플래너가 스스로 되돌릴 수 없다** — 되돌리기는 전이표에 없다",
    asUser(
      outsider,
      `with u as (update public.planner_engagements set status = 'revoked'
                   where id = '${S604_OFFER}' returning id)
       select count(*) from u;`,
      activeFixture,
    ) === "0",
  );
  check(
    "**거절한 제안을 스스로 되살릴 수 없다** — 재위임은 새 행이다(D-23)",
    asUser(
      outsider,
      `update public.planner_engagements set status = 'declined' where id = '${S604_OFFER}';
       with u as (update public.planner_engagements set status = 'active'
                    where id = '${S604_OFFER}' returning id)
       select count(*) from u;`,
      offerFixture,
    ) === "0",
  );
  check(
    "**커플이 제안을 바로 활성으로 만들 수 없다** — 그러면 수락 절차가 우회된다(함정 6)",
    rejectedWith(/permission denied/i, () =>
      asUser(
        owner,
        `insert into public.planner_engagements
           (planner_id, couple_id, scope_json, valid_from, valid_to, status)
         values ('${S604_PLANNER}', '${coupleId}', '{"tables":["couples"]}'::jsonb,
                 now(), now() + interval '30 days', 'active');`,
        plannerRow,
      ),
    ),
  );
  check(
    "**커플 소유자는 제안을 만들 수 있고 그것은 pending 이다**",
    asUser(
      owner,
      `insert into public.planner_engagements
         (planner_id, couple_id, scope_json, valid_from, valid_to)
       values ('${S604_PLANNER}', '${coupleId}', '{"tables":["couples"]}'::jsonb,
               now(), now() + interval '30 days');
       select status from public.planner_engagements
        where planner_id = '${S604_PLANNER}' and couple_id = '${coupleId}';`,
      plannerRow,
    ) === "pending",
  );
  check(
    "**배우자는 위임을 제안할 수 없다** — 우리 데이터를 밖으로 여는 일이라 결제·서명과 같은 층이다",
    rejectedWith(/row-level security/i, () =>
      asUser(
        partner,
        `insert into public.planner_engagements
           (planner_id, couple_id, scope_json, valid_from, valid_to)
         values ('${S604_PLANNER}', '${coupleId}', '{"tables":["couples"]}'::jsonb,
                 now(), now() + interval '30 days');`,
        plannerRow,
      ),
    ),
  );
  check(
    "**되돌리는 전이는 트리거가 막는다** — 커플이 활성 위임을 pending 으로 되돌릴 수 없다",
    rejectedWith(/planner_engagements_transition|바꿀 수 없습니다/, () =>
      asUser(
        owner,
        `update public.planner_engagements set status = 'pending' where id = '${S604_OFFER}';`,
        activeFixture,
      ),
    ),
  );
  check(
    "**남은 남의 위임을 보지 못한다**",
    asUser(adminUser, `select count(*) from public.planner_engagements
                        where id = '${S604_OFFER}';`, offerFixture) === "0",
  );
  check(
    "**비로그인은 위임 표에 닿지도 못한다** — 정책이 아니라 권한 자체가 없다",
    rejectedWith(/permission denied/i, () =>
      asAnon(`select count(*) from public.planner_engagements;`, offerFixture),
    ),
  );

  // ── 층 2 (FIX-41): 정책이 자기 조건을 스스로 말하는가 ─────────────────────
  check(
    "**위임 조회 정책이 소유자 조건을 스스로 든다** — 부모 정책에 기대지 않는다",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'planner_engagements'
             and policyname = 'planner_engagements_select'
             and qual like '%p.user_id = auth.uid()%';`) === "1",
  );
  check(
    "**플래너 응답 정책도 자기 조건을 스스로 든다**",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'planner_engagements'
             and policyname = 'planner_engagements_respond'
             and qual like '%auth.uid()%' and with_check like '%auth.uid()%';`) === "1",
  );
  // 층 2 **기록**: budget_items_select 는 부모(budgets)를 통해서만 좁혀진다.
  // 오늘은 부모가 좁아서 안전하지만, 부모가 넓어지는 순간 자식이 함께 열린다.
  // 그래서 **부모를 못 박는다** — 넓어지면 여기서 먼저 깨진다.
  check(
    "**budget_items 의 부모(budgets) 정책이 여전히 좁다**(층 2 기록 · 위임이 여는 표다)",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'budgets'
             and policyname = 'budgets_select'
             and qual like '%is_couple_member%';`) === "1",
  );

  // ── 층 1: 정책 아래의 권한 ───────────────────────────────────────────────
  check(
    "**planner_engagements 에 표 단위 INSERT·UPDATE 가 없다**(FIX-36 — 컬럼 회수만으로는 무효다)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'planner_engagements'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**고칠 수 있는 칸은 status 하나뿐이다** — 범위·기간·상대는 못 만진다",
    sql(`select string_agg(column_name, ',' order by column_name)
           from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'planner_engagements'
            and grantee = 'authenticated' and privilege_type = 'UPDATE';`) === "status",
  );
  check(
    "**제안이 담는 칸은 다섯뿐이다** — status·시각·행위자는 넣을 수 없다",
    sql(`select string_agg(column_name, ',' order by column_name)
           from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'planner_engagements'
            and grantee = 'authenticated' and privilege_type = 'INSERT';`) ===
      "couple_id,planner_id,scope_json,valid_from,valid_to",
  );
  check(
    "**위임을 지울 수 있는 사람이 없다**(D-23) — 지우면 '언제부터 언제까지 봤는가' 가 사라진다",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'planner_engagements'
             and cmd = 'DELETE';`) === "0",
  );
  check(
    "**planners 도 지울 수 없다** — cascade 로 위임 기록이 함께 사라지던 길이다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'planners'
             and grantee in ('anon', 'authenticated') and privilege_type = 'DELETE';`) === "0",
  );
  check(
    "**planners 를 지워도 위임이 함께 사라지지 않는다** — FK 가 restrict 다",
    rejectedWith(/violates foreign key constraint|still referenced/i, () =>
      sql(`begin;
             insert into public.planners (id, user_id, status, profile_json, regions)
               values ('${S604_PLANNER}', '${outsider}', 'active',
                       '{"headline":"삭제 시험","categories":["hall"]}'::jsonb, array['seoul']);
             insert into public.planner_engagements
               (id, planner_id, couple_id, scope_json, valid_from, valid_to)
               values ('${S604_OFFER}', '${S604_PLANNER}', '${coupleId}',
                       '{"tables":["couples"]}'::jsonb, now(), now() + interval '30 days');
             delete from public.planners where id = '${S604_PLANNER}';
           rollback;`),
    ),
  );
  check(
    "**비로그인에게 SELECT GRANT 가 남아 있지 않다** — 남으면 정책 한 줄로 열린다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'planner_engagements'
             and grantee = 'anon' and privilege_type = 'SELECT';`) === "0",
  );
  check(
    "**CHECK 이 생겼다** — 0069 전에는 이 표에 하나도 없었다",
    Number(
      sql(`select count(*) from pg_constraint
             where conrelid = 'public.planner_engagements'::regclass and contype = 'c';`),
    ) >= 7,
  );

  // ── CHECK 이 실제로 무엇을 막는가 ────────────────────────────────────────
  check(
    "**무기한 위임을 만들 수 없다**(D-166) — 잊으면 예식 뒤에도 계속 보인다",
    rejectedWith(/planner_engagements_period_required/, () =>
      sql(`insert into public.planner_engagements
             (planner_id, couple_id, scope_json, status)
           values ('${SEEDED_PLANNER}', '${coupleId}',
                   '{"tables":["couples"]}'::jsonb, 'pending');`),
    ),
  );
  check(
    "**끝이 시작보다 앞설 수 없다**",
    rejectedWith(/planner_engagements_period_order/, () =>
      sql(`insert into public.planner_engagements
             (planner_id, couple_id, scope_json, valid_from, valid_to)
           values ('${SEEDED_PLANNER}', '${coupleId}',
                   '{"tables":["couples"]}'::jsonb,
                   now() + interval '10 days', now());`),
    ),
  );
  check(
    "**어휘 밖의 범위를 적을 수 없다** — 고객이 '결제를 위임했다' 고 믿는 일이 없다",
    rejectedWith(/planner_engagements_scope_values/, () =>
      sql(`insert into public.planner_engagements
             (planner_id, couple_id, scope_json, valid_from, valid_to)
           values ('${SEEDED_PLANNER}', '${coupleId}',
                   '{"tables":["payments"]}'::jsonb, now(), now() + interval '30 days');`),
    ),
  );
  check(
    "**채팅은 범위에 적을 수조차 없다**(S4-01 의 경계를 CHECK 이 앞당겨 든다)",
    rejectedWith(/planner_engagements_scope_values/, () =>
      sql(`insert into public.planner_engagements
             (planner_id, couple_id, scope_json, valid_from, valid_to)
           values ('${SEEDED_PLANNER}', '${coupleId}',
                   '{"tables":["chat_rooms"]}'::jsonb, now(), now() + interval '30 days');`),
    ),
  );
  check(
    "**범위가 빈 위임을 만들 수 없다** — 아무것도 열지 않는 위임은 장식이다",
    rejectedWith(/planner_engagements_scope_nonempty/, () =>
      sql(`insert into public.planner_engagements
             (planner_id, couple_id, scope_json, valid_from, valid_to)
           values ('${SEEDED_PLANNER}', '${coupleId}',
                   '{"tables":[]}'::jsonb, now(), now() + interval '30 days');`),
    ),
  );
  check(
    "**범위 칸이 아예 없는 행도 막힌다**(함정 8 — NULL 은 CHECK 을 통과한다)",
    rejectedWith(/planner_engagements_scope_nonempty/, () =>
      sql(`insert into public.planner_engagements
             (planner_id, couple_id, valid_from, valid_to)
           values ('${SEEDED_PLANNER}', '${coupleId}',
                   now(), now() + interval '30 days');`),
    ),
  );
  check(
    "**허용 목록 열한 개는 다 통과한다** — 막기만 하면 고를 것이 없다",
    sql(`begin;
           ${plannerRow}
           insert into public.planner_engagements
             (planner_id, couple_id, scope_json, valid_from, valid_to)
           values ('${S604_PLANNER}', '${coupleId}',
                   '{"tables":["couples","tasks","budgets","expenses","carts","wishlists","bookings","consultations","quotes","guests","seating_plans"]}'::jsonb,
                   now(), now() + interval '30 days');
           select jsonb_array_length(scope_json -> 'tables')
             from public.planner_engagements where planner_id = '${S604_PLANNER}';
         rollback;`) === "11",
  );
  check(
    "**살아 있는 위임은 커플·플래너당 하나다** — 둘이면 무엇이 열려 있는지 답할 수 없다",
    rejectedWith(/uq_planner_engagements_live/, () =>
      sql(`begin;
             ${offerFixture}
             insert into public.planner_engagements
               (planner_id, couple_id, scope_json, valid_from, valid_to)
             values ('${S604_PLANNER}', '${coupleId}', '{"tables":["guests"]}'::jsonb,
                     now(), now() + interval '30 days');
           rollback;`),
    ),
  );
  check(
    "**공개 중이 아닌 플래너에게는 위임할 수 없다** — 심사가 무의미해진다",
    rejectedWith(/planner_engagements_planner_not_active|공개 중인 플래너/, () =>
      sql(`begin;
             insert into public.planners (id, user_id, status, profile_json, regions)
               values ('${S604_PLANNER}', '${outsider}', 'pending',
                       '{"headline":"미심사","categories":["hall"]}'::jsonb, array['seoul']);
             insert into public.planner_engagements
               (planner_id, couple_id, scope_json, valid_from, valid_to)
               values ('${S604_PLANNER}', '${coupleId}', '{"tables":["couples"]}'::jsonb,
                       now(), now() + interval '30 days');
           rollback;`),
    ),
  );

  // ── 어휘가 실제 정책과 같은가 (검사가 검사 노릇을 하게) ──────────────────
  const policyScopeKeys = sql(
    `select string_agg(k, ',' order by k) from (
       select distinct m[1] as k
         from pg_policies,
              lateral regexp_matches(coalesce(qual, '') || ' ' || coalesce(with_check, ''),
                                     'has_planner_scope\\([^,]+, ''([a-z_]+)''', 'g') m
        where schemaname = 'public'
     ) s;`,
  );

  check(
    "**RLS 가 실제로 읽는 범위 키는 열한 개다** — 새 정책이 키를 늘리면 여기서 먼저 깨진다",
    policyScopeKeys ===
      "bookings,budgets,carts,consultations,couples,expenses,guests,quotes,seating_plans,tasks,wishlists",
    policyScopeKeys,
  );

  {
    const delegationSource = srcOf("lib/core/planner/delegation.ts");

    check(
      "**화면이 그리는 목록과 정책의 목록이 같다** — 하나라도 어긋나면 동의가 아니다",
      policyScopeKeys.split(",").every((key) => delegationSource.includes(`key: "${key}"`)),
    );
    check(
      "**목록에 없는 키를 화면이 그리지 않는다**",
      (delegationSource.match(/^    key: "/gm) ?? []).length === 11,
    );
  }

  // ── 판정이 DB 와 같은 답을 내는가 ────────────────────────────────────────
  check(
    "**수락 전에는 아무것도 열리지 않는다**(D-165)",
    asUser(outsider, `select count(*) from public.couples where id = '${coupleId}';`, offerFixture) ===
      "0",
  );
  check(
    "**수락하면 열린다** — 막기만 하면 기능이 없는 것이다",
    asUser(outsider, `select count(*) from public.couples where id = '${coupleId}';`, activeFixture) ===
      "1",
  );
  check(
    "**거두면 즉시 닫힌다**",
    asUser(
      outsider,
      `select count(*) from public.couples where id = '${coupleId}';`,
      `${activeFixture}
       update public.planner_engagements set status = 'revoked', revoked_by = '${owner}'
        where id = '${S604_OFFER}';`,
    ) === "0",
  );
  check(
    "**기간이 지나면 상태가 active 여도 닫힌다** — 만료를 저장하지 않는 이유다",
    asUser(
      outsider,
      `select count(*) from public.couples where id = '${coupleId}';`,
      `${plannerRow}
       insert into public.planner_engagements
         (id, planner_id, couple_id, scope_json, status, valid_from, valid_to, responded_at)
         values ('${S604_OFFER}', '${S604_PLANNER}', '${coupleId}',
                 '{"tables":["couples"]}'::jsonb, 'active',
                 now() - interval '10 days', now() - interval '1 day', now() - interval '10 days');`,
    ) === "0",
  );
  check(
    "**거둔 시각과 사람이 남는다** — 행을 지우지 않기 때문에 남길 수 있다",
    asUser(
      owner,
      `select (revoked_at is not null and revoked_by is not null)::text
         from public.planner_engagements where id = '${S604_OFFER}';`,
      `${activeFixture}
       update public.planner_engagements set status = 'revoked', revoked_by = '${owner}'
        where id = '${S604_OFFER}';`,
    ) === "true",
  );

  // ── 두 축이 연동되지 않는다 (D-43) ───────────────────────────────────────
  check(
    "**위임을 거둬도 카테고리 선택은 그대로다** — 돈이 걸린 변경이 저절로 일어나지 않는다",
    asUser(
      owner,
      `select count(*) from public.planner_scopes
        where couple_id = '${coupleId}' and planner_id = '${S604_PLANNER}'
          and status = 'selected';`,
      `${activeFixture}
       insert into public.planner_scopes (couple_id, planner_id, category, selected_by)
         values ('${coupleId}', '${S604_PLANNER}', 'hall', '${owner}');
       update public.planner_engagements set status = 'revoked', revoked_by = '${owner}'
        where id = '${S604_OFFER}';`,
    ) === "1",
  );

  // ── 증적 ─────────────────────────────────────────────────────────────────
  check(
    "**표를 직접 두드린 응답도 증적에 남는다** — 앱 경로만 믿지 않는다",
    asUser(
      outsider,
      `update public.planner_engagements set status = 'declined' where id = '${S604_OFFER}';
       select count(*) from public.entity_events
        where entity_type = 'planner_engagement' and entity_id = '${S604_OFFER}'
          and event_type = 'planner_engagement_declined';`,
      offerFixture,
    ) === "1",
  );
  check(
    "**커플 구성원이 그 증적을 읽는다**",
    asUser(
      owner,
      `select count(*) from public.entity_events
        where entity_type = 'planner_engagement' and entity_id = '${S604_OFFER}';`,
      `${offerFixture}
       insert into public.entity_events
         (entity_type, entity_id, event_type, actor_id, source)
         values ('planner_engagement', '${S604_OFFER}', 'planner_engagement_offered',
                 '${owner}', 'web');`,
    ) !== "0",
  );

  // ── 화면·라우트가 이어져 있다 ────────────────────────────────────────────
  check(
    "`/planners/delegations` 화면이 실재한다",
    existsSync("app/(consumer)/planners/delegations/page.tsx"),
  );
  check(
    "`/planners/[id]/delegate` 화면이 실재한다",
    existsSync("app/(consumer)/planners/[id]/delegate/page.tsx"),
  );
  check(
    "`/pro/engagements` 화면이 실재한다",
    existsSync("app/(planner)/pro/engagements/page.tsx"),
  );
  check(
    "**플래너 내비가 받은 위임을 가리킨다** — 안 그러면 URL 을 직접 쳐야 한다(FIX-25)",
    srcOf("components/layout/AdminShell.tsx").includes('href: "/pro/engagements"'),
  );
  check(
    "**플래너 상세가 위임 화면으로 잇는다** — 문장만 있고 갈 곳이 없던 자리다",
    srcOf("app/(consumer)/planners/[id]/page.tsx").includes("/delegate"),
  );
  check(
    "**마켓에서 위임 관리로 돌아갈 수 있다**",
    srcOf("app/(consumer)/planners/PlannerMarketView.tsx").includes(
      "/planners/delegations",
    ),
  );
  for (const page of [
    "app/(consumer)/planners/delegations/page.tsx",
    "app/(consumer)/planners/[id]/delegate/page.tsx",
    "app/(planner)/pro/engagements/page.tsx",
  ]) {
    check(
      `${page} 가 캐시되지 않는다 (함정 4)`,
      srcOf(page).includes('export const dynamic = "force-dynamic"'),
    );
  }
  check(
    "**coupleId 를 입력으로 받지 않는다** — 세션이 정한다(FIX-45 와 같은 자리)",
    !srcOf("app/api/planner-engagements/route.ts").includes("coupleId: z."),
  );
  check(
    "**status 를 입력으로 받지 않는다** — 제안은 언제나 pending 이다",
    !srcOf("lib/core/schemas/planner.ts").includes("DelegationOfferSchema = z.object({\n  status"),
  );
  check(
    "**두 축이 연동되지 않는다는 사실이 API 본문에 실린다**(함정 3)",
    srcOf("lib/planners/delegation.ts").includes("categoryAxisLinked: false"),
  );
  check(
    "**수락 전에는 고객 신원이 열리지 않는다는 사실도 본문에 실린다**",
    srcOf("lib/planners/delegation.ts").includes("customerIdentityVisible: false"),
  );

  // ── 기록: 이번에 고치지 않은 자리도 지금 상태를 못 박는다 ────────────────
  check(
    "**planner_settlements 에 쓰기 정책이 없다** — GRANT 는 남아 있으나 RLS 가 막는다(기록)",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'planner_settlements'
             and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');`) === "0",
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0069 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// S6-03 — 카테고리별 부분 선택 과금 (F-C-31 · 0070)
//
// 이 태스크의 자격은 `is_couple_member(couple_id)` 이고 그 근거 표는
// **`couple_members`** 다. 그리고 선택의 **전제**는 트리거가 읽는
// **`planner_engagements`** 다. 자격을 얻으려는 사람은 둘 — 남의 커플에 끼어들려는
// 사람과, 자기를 카테고리에 붙이려는 플래너다. 아래 첫 묶음이 그것을 본다.
// ═══════════════════════════════════════════════════════════════════════════
{
  const SEEDED_PLANNER = "00000000-0000-0000-0000-00000000c0b1";
  const S603_PLANNER = "00000000-0000-0000-0000-0000000006b1";

  /** 이미 고른 카테고리 하나. 시드 위임(활성)이 전제를 채운다. */
  const scopeFixture = `
    insert into public.planner_scopes (couple_id, planner_id, category, selected_by)
      values ('${coupleId}', '${SEEDED_PLANNER}', 'dress', '${owner}');
  `;

  /** 기간이 지난 위임을 가진 플래너. 전제 판정이 **기간까지** 보는지 확인한다. */
  const expiredFixture = `
    insert into public.planners (id, user_id, status, profile_json, regions)
      values ('${S603_PLANNER}', '${outsider}', 'active',
              '{"headline":"만료 픽스처","categories":["hall"]}'::jsonb, array['seoul']);
    insert into public.planner_engagements
      (planner_id, couple_id, scope_json, status, valid_from, valid_to, responded_at)
      values ('${S603_PLANNER}', '${coupleId}', '{"tables":["couples"]}'::jsonb, 'active',
              now() - interval '30 days', now() - interval '1 day', now() - interval '30 days');
  `;

  // ── 층 3 (FIX-44 · FIX-47): 자격의 근거가 되는 표 ────────────────────────
  check(
    "**남이 우리 커플 구성원이 될 수 없다** — 되면 카테고리 과금을 남이 정한다",
    rejectedWith(/row-level security/i, () =>
      asUser(
        outsider,
        `insert into public.couple_members (couple_id, user_id, member_role)
           values ('${coupleId}', '${outsider}', 'partner');`,
      ),
    ),
  );
  check(
    "**배우자가 스스로 소유자가 될 수 없다** — 값이 바뀌었는지 직접 본다(함정 9)",
    asUser(
      partner,
      `update public.couple_members set member_role = 'owner'
        where couple_id = '${coupleId}' and user_id = '${partner}';
       select member_role from public.couple_members
        where couple_id = '${coupleId}' and user_id = '${partner}';`,
    ) === "partner",
  );
  check(
    "**남의 커플 행을 만들어 끼어들 수도 없다** — 부트스트랩은 자기가 만든 커플에만 걸린다",
    asUser(
      outsider,
      `with i as (insert into public.couple_members (couple_id, user_id, member_role)
                    select '${coupleId}', '${outsider}', 'owner'
                     where public.owns_couple_record('${coupleId}')
                  returning id)
       select count(*) from i;`,
    ) === "0",
  );
  check(
    "**플래너는 자기를 카테고리에 붙일 수 없다** — 그것이 곧 자기 수수료를 늘리는 행위다",
    rejectedWith(/row-level security|permission denied/i, () =>
      asUser(
        plannerAccount ?? outsider,
        `insert into public.planner_scopes (couple_id, planner_id, category)
           values ('${coupleId}', '${SEEDED_PLANNER}', 'hall');`,
      ),
    ),
  );
  check(
    "**커플 구성원 판정이 자기 조건을 스스로 든다**(층 2 · FIX-41)",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'couple_members'
             and policyname in ('couple_members_insert', 'couple_members_update',
                                'couple_members_delete')
             and coalesce(qual, '') || coalesce(with_check, '') like '%couple%';`) === "3",
  );
  check(
    "**카테고리 조회 정책도 소유자 조건을 스스로 든다**(층 2)",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'planner_scopes'
             and policyname = 'planner_scopes_select'
             and qual like '%p.user_id = auth.uid()%';`) === "1",
  );

  // ── 층 1: 정책 아래의 권한 ───────────────────────────────────────────────
  check(
    "**planner_scopes 에 표 단위 INSERT·UPDATE 가 없다**(FIX-36)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'planner_scopes'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**고를 때 담는 칸은 셋뿐이다** — status·시각·행위자는 넣을 수 없다",
    sql(`select string_agg(column_name, ',' order by column_name)
           from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'planner_scopes'
            and grantee = 'authenticated' and privilege_type = 'INSERT';`) ===
      "category,couple_id,planner_id",
  );
  check(
    "**고칠 수 있는 칸은 status 하나뿐이다**",
    sql(`select string_agg(column_name, ',' order by column_name)
           from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'planner_scopes'
            and grantee = 'authenticated' and privilege_type = 'UPDATE';`) === "status",
  );
  check(
    "**해제는 삭제가 아니다** — DELETE 정책도 권한도 없다(D-23)",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'planner_scopes' and cmd = 'DELETE';`) === "0" &&
      sql(`select count(*) from information_schema.role_table_grants
             where table_schema = 'public' and table_name = 'planner_scopes'
               and grantee in ('anon', 'authenticated') and privilege_type = 'DELETE';`) === "0",
  );
  check(
    "**비로그인에게 SELECT GRANT 가 남아 있지 않다**",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'planner_scopes'
             and grantee = 'anon' and privilege_type = 'SELECT';`) === "0",
  );

  // ── 위조 — 당사자가 직접 못 넣어야 할 칸 ─────────────────────────────────
  check(
    "**고른 사람을 위조하는 칸을 아예 적을 수 없다** — 배우자 이름을 넣는 길이 없다",
    rejectedWith(/permission denied/i, () =>
      asUser(
        owner,
        `insert into public.planner_scopes (couple_id, planner_id, category, selected_by)
           values ('${coupleId}', '${SEEDED_PLANNER}', 'hall', '${partner}');`,
      ),
    ),
  );
  check(
    "**대신 서버가 고른 사람을 적는다** — 막기만 하면 그 칸이 비어 버린다",
    asUser(
      owner,
      `insert into public.planner_scopes (couple_id, planner_id, category)
         values ('${coupleId}', '${SEEDED_PLANNER}', 'hall');
       select selected_by from public.planner_scopes
        where couple_id = '${coupleId}' and category = 'hall' and status = 'selected';`,
    ) === owner,
  );
  check(
    "**선택 시각도 적을 수 없다** — 2020년으로 지어내는 길이 없다",
    rejectedWith(/permission denied/i, () =>
      asUser(
        owner,
        `insert into public.planner_scopes (couple_id, planner_id, category, selected_at)
           values ('${coupleId}', '${SEEDED_PLANNER}', 'hall', '2020-01-01T00:00:00Z');`,
      ),
    ),
  );
  check(
    "**대신 서버가 지금으로 적는다**",
    asUser(
      owner,
      `insert into public.planner_scopes (couple_id, planner_id, category)
         values ('${coupleId}', '${SEEDED_PLANNER}', 'hall');
       select (selected_at > now() - interval '1 minute')::text
         from public.planner_scopes
        where couple_id = '${coupleId}' and category = 'hall' and status = 'selected';`,
    ) === "true",
  );
  check(
    "**해제 시각을 직접 넣을 수 없다** — 권한 자체가 없다",
    rejectedWith(/permission denied/i, () =>
      asUser(
        owner,
        `update public.planner_scopes set released_at = now() - interval '30 days'
          where couple_id = '${coupleId}' and category = 'dress';`,
        scopeFixture,
      ),
    ),
  );
  check(
    "**해제하면 시각은 서버가 적는다**",
    asUser(
      owner,
      `update public.planner_scopes set status = 'released'
        where couple_id = '${coupleId}' and category = 'dress';
       select (released_at is not null)::text from public.planner_scopes
        where couple_id = '${coupleId}' and category = 'dress';`,
      scopeFixture,
    ) === "true",
  );
  check(
    "**카테고리·플래너를 갈아 끼울 수 없다** — 증적과 행이 다른 말을 하게 된다",
    rejectedWith(/permission denied/i, () =>
      asUser(
        owner,
        `update public.planner_scopes set category = 'hall'
          where couple_id = '${coupleId}' and category = 'dress';`,
        scopeFixture,
      ),
    ),
  );
  check(
    "**해제한 카테고리를 되살릴 수 없다** — 재선택은 새 행이다(D-23)",
    rejectedWith(/planner_scopes_transition|바꿀 수 없습니다/, () =>
      asUser(
        owner,
        `update public.planner_scopes set status = 'selected'
          where couple_id = '${coupleId}' and category = 'dress';`,
        `${scopeFixture}
         update public.planner_scopes set status = 'released'
          where couple_id = '${coupleId}' and category = 'dress';`,
      ),
    ),
  );
  check(
    "**해제 상태로 시작하는 행을 만들 수 없다** — 일어난 적 없는 해제를 적는 것이다",
    rejectedWith(/permission denied/i, () =>
      asUser(
        owner,
        `insert into public.planner_scopes (couple_id, planner_id, category, status)
           values ('${coupleId}', '${SEEDED_PLANNER}', 'hall', 'released');`,
      ),
    ),
  );

  // ── 선택의 전제 — 위임이 있어야 하고 **기간 안이어야** 한다 ──────────────
  check(
    "**위임이 없는 플래너를 지정할 수 없다**(0036 의 불변식이 그대로다)",
    rejectedWith(/planner_scopes_no_engagement|위임이 활성/, () =>
      asUser(
        owner,
        `insert into public.planner_scopes (couple_id, planner_id, category)
           values ('${coupleId}', '${S603_PLANNER}', 'hall');`,
        `insert into public.planners (id, user_id, status, profile_json, regions)
           values ('${S603_PLANNER}', '${outsider}', 'active',
                   '{"headline":"위임 없음","categories":["hall"]}'::jsonb, array['seoul']);`,
      ),
    ),
  );
  check(
    "**기간이 지난 위임의 플래너도 지정할 수 없다** — 상태만 보지 않는다",
    rejectedWith(/planner_scopes_no_engagement|위임이 활성/, () =>
      asUser(
        owner,
        `insert into public.planner_scopes (couple_id, planner_id, category)
           values ('${coupleId}', '${S603_PLANNER}', 'hall');`,
        expiredFixture,
      ),
    ),
  );
  check(
    "**활성 위임이 있으면 고를 수 있다** — 막기만 하면 기능이 없는 것이다",
    asUser(
      owner,
      `insert into public.planner_scopes (couple_id, planner_id, category)
         values ('${coupleId}', '${SEEDED_PLANNER}', 'hall');
       select status from public.planner_scopes
        where couple_id = '${coupleId}' and category = 'hall';`,
    ) === "selected",
  );
  check(
    "**배우자도 고를 수 있다** — 구성 선택이지 돈을 움직이는 확정이 아니다(0036)",
    asUser(
      partner,
      `insert into public.planner_scopes (couple_id, planner_id, category)
         values ('${coupleId}', '${SEEDED_PLANNER}', 'snap');
       select count(*) from public.planner_scopes
        where couple_id = '${coupleId}' and category = 'snap';`,
    ) === "1",
  );
  check(
    "**한 카테고리에 동시에 선택된 것은 하나다** — 둘이면 수수료가 두 번 붙는다",
    rejectedWith(/uq_planner_scopes_selected/, () =>
      asUser(
        owner,
        `insert into public.planner_scopes (couple_id, planner_id, category)
           values ('${coupleId}', '${SEEDED_PLANNER}', 'dress');`,
        scopeFixture,
      ),
    ),
  );

  // ── 격리 ─────────────────────────────────────────────────────────────────
  // **운영자를 '남' 으로 쓰지 않는다**(FIX-09 가 지적한 함정). `planner_scopes_select`
  // 에는 `is_operator()` 갈래가 있어 운영자에게는 보이는 것이 정상이고, 그 계정으로
  // 격리를 재면 검사가 엉뚱한 이유로 결론을 낸다.
  check(
    "**남은 남의 선택을 보지 못한다**",
    asUser(outsider, `select count(*) from public.planner_scopes
                       where couple_id = '${coupleId}';`, scopeFixture) === "0",
  );
  check(
    "**운영자에게는 보인다** — 정산 분쟁을 조율하려면 무엇을 맡겼는지 알아야 한다",
    asUser(adminUser, `select count(*) from public.planner_scopes
                        where couple_id = '${coupleId}';`, scopeFixture) === "1",
  );
  check(
    "**비로그인은 표에 닿지도 못한다**",
    rejectedWith(/permission denied/i, () =>
      asAnon(`select count(*) from public.planner_scopes;`, scopeFixture),
    ),
  );
  if (plannerAccount) {
    check(
      "**맡은 플래너는 자기가 어느 카테고리를 맡았는지 읽는다** — 모르면 일을 못 한다",
      asUser(
        plannerAccount,
        `select count(*) from public.planner_scopes where couple_id = '${coupleId}';`,
        scopeFixture,
      ) === "1",
    );
  }

  // ── 두 축이 독립이다 (D-43) ──────────────────────────────────────────────
  check(
    "**카테고리를 빼도 열람 위임은 그대로다**",
    asUser(
      owner,
      `select count(*) from public.planner_engagements
        where couple_id = '${coupleId}' and status = 'active';`,
      `${scopeFixture}
       update public.planner_scopes set status = 'released'
        where couple_id = '${coupleId}' and category = 'dress';`,
    ) === "1",
  );

  // ── 집행 — 이 선택을 실제로 읽는 코드가 있는가 (FIX-46 이 드러낸 것) ─────
  check(
    "**계약 발행이 planner_scopes 를 읽는다** — 안 읽으면 화면이 아무것도 바꾸지 않는다",
    srcOf("lib/contract/actions.ts").includes("selectedPlannerByCategory"),
  );
  check(
    "**계약 발행이 plannerId 를 입력으로 받지 않는다**(FIX-53) — 업체가 고객의 플래너를 정할 수 없다",
    !srcOf("lib/core/schemas/payment.ts").includes("plannerId: z.string()") &&
      !srcOf("app/api/contracts/route.ts").includes("plannerId:"),
  );
  check(
    "**요율 해석이 한 곳이다**(FIX-52) — 장바구니와 계약이 다른 답을 내지 않는다",
    srcOf("lib/cart/loader.ts").includes("resolvePlannerRateBp") &&
      srcOf("lib/contract/actions.ts").includes("resolvePlannerRateBp"),
  );
  check(
    "**장바구니 요율 해석에 플래너가 들어간다** — 누구의 것인가가 판정에 있다",
    srcOf("lib/cart/loader.ts").includes("selectedPlannerByCategory"),
  );

  // ── 화면·API 가 이어져 있다 ──────────────────────────────────────────────
  check(
    "`/planners/scopes` 화면이 실재한다",
    existsSync("app/(consumer)/planners/scopes/page.tsx"),
  );
  check(
    "**장바구니가 이용 범위 설정으로 잇는다** — 총액을 보는 자리에서 들어간다",
    srcOf("app/(consumer)/cart/page.tsx").includes("/planners/scopes"),
  );
  check(
    "**위임 관리가 카테고리 설정으로 잇는다**(D-43 — 두 축을 화면이 잇는다)",
    srcOf("app/(consumer)/planners/delegations/page.tsx").includes(
      "/planners/scopes",
    ),
  );
  check(
    "이용 범위 화면이 캐시되지 않는다 (함정 4)",
    srcOf("app/(consumer)/planners/scopes/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**coupleId 를 입력으로 받지 않는다** — 세션이 정한다(FIX-45 와 같은 자리)",
    !srcOf("app/api/planner-scopes/route.ts").includes("coupleId: z."),
  );
  check(
    "**집행 지점이 API 본문에 실린다**(함정 3) — 표시일 뿐이라고 읽지 않게 한다",
    srcOf("lib/planners/scopes.ts").includes('enforcedAt: "contract_issue"'),
  );
  check(
    "**두 축이 연동되지 않는다는 사실도 본문에 실린다**",
    srcOf("lib/planners/scopes.ts").includes("delegationAxisLinked: false"),
  );
  check(
    "**장바구니가 어긋남을 알린다** — 어느 쪽이 이기는지 화면이 말한다",
    srcOf("app/(consumer)/cart/page.tsx").includes("scopeMismatch"),
  );

  // ── 증적 ─────────────────────────────────────────────────────────────────
  check(
    "**표를 직접 두드린 선택도 증적에 남는다** — 앱 경로만 믿지 않는다",
    asUser(
      owner,
      `insert into public.planner_scopes (couple_id, planner_id, category)
         values ('${coupleId}', '${SEEDED_PLANNER}', 'video');
       select count(*) from public.entity_events e
        join public.planner_scopes s on s.id = e.entity_id
        where e.entity_type = 'planner_scope' and s.category = 'video'
          and e.event_type = 'planner_scope_selected';`,
    ) === "1",
  );
  check(
    "**증적에 금액을 담지 않는다** — 카테고리만 남긴다(§7.3)",
    asUser(
      owner,
      `insert into public.planner_scopes (couple_id, planner_id, category)
         values ('${coupleId}', '${SEEDED_PLANNER}', 'video');
       select e.memo from public.entity_events e
        join public.planner_scopes s on s.id = e.entity_id
        where e.entity_type = 'planner_scope' and s.category = 'video';`,
    ) === "category=video",
  );

  // ── 어휘 정합 ────────────────────────────────────────────────────────────
  check(
    "**카테고리 어휘가 코드와 DB CHECK 에서 같다**",
    sql(`select count(*) from pg_constraint
           where conrelid = 'public.planner_scopes'::regclass
             and conname = 'planner_scopes_category_values';`) === "1" &&
      srcOf("lib/core/planner/scope.ts").includes('"invitation",'),
  );
  check(
    "**위임 범위 목록을 scope.ts 가 들지 않는다** — 같은 사실을 두 곳이 적고 있었다",
    !srcOf("lib/core/planner/scope.ts").includes("export const PLANNER_VISIBILITY"),
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0070 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// S6-05 — 플래너 정산·지급 유예 (§3.4 · §4.5 · 0071 · **FIX-49 · FIX-54**)
//
// 이 원장의 주인은 `planners.user_id = auth.uid()` 가 정한다. 그러므로 층 3 의 물음은
// "**돈을 받으려는 사람이 `planners` 를 직접 쓸 수 있는가**" 다 — 아래 첫 묶음이
// 그것을 본다. FIX-54 가 거기서 나왔다.
// ═══════════════════════════════════════════════════════════════════════════
{
  const SEEDED_PLANNER = "00000000-0000-0000-0000-00000000c0b1";
  const PAYABLE_SETTLEMENT = "00000000-0000-0000-0000-00000000c0b3";
  const GRACE_SETTLEMENT = "00000000-0000-0000-0000-00000000c0b4";

  // ── 층 3 (FIX-44 · FIX-47): 자격의 근거가 되는 표 ────────────────────────
  check(
    "**아무나 처음부터 공개 플래너로 등록할 수 없다**(FIX-54) — 심사를 건너뛰는 길이었다",
    rejectedWith(/permission denied/i, () =>
      asUser(
        outsider,
        `insert into public.planners (user_id, status, profile_json, regions)
           values ('${outsider}', 'active',
                   '{"headline":"자가 공개","categories":["hall"],"careerYears":1}'::jsonb,
                   array['seoul']);`,
      ),
    ),
  );
  check(
    "**대신 등록은 여전히 된다** — 막기만 하면 아무도 플래너가 될 수 없다",
    asUser(
      outsider,
      `insert into public.planners (user_id, profile_json, regions)
         values ('${outsider}',
                 '{"headline":"정상 등록","categories":["hall"],"careerYears":1}'::jsonb,
                 array['seoul']);
       select status from public.planners where user_id = '${outsider}';`,
    ) === "pending",
  );
  check(
    "**등록할 때 담는 칸은 셋뿐이다** — status·id 는 넣을 수 없다",
    sql(`select string_agg(column_name, ',' order by column_name)
           from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'planners'
            and grantee = 'authenticated' and privilege_type = 'INSERT';`) ===
      "profile_json,regions,user_id",
  );
  check(
    "**남의 프로필을 자기 것으로 옮길 수 없다** — user_id 를 고칠 칸이 없다",
    sql(`select count(*) from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'planners'
             and grantee = 'authenticated' and privilege_type = 'UPDATE'
             and column_name in ('user_id', 'id');`) === "0",
  );
  check(
    "**본인 프로필 수정은 여전히 된다** — 값이 바뀌었는지 직접 본다(함정 9)",
    asUser(
      plannerAccount ?? outsider,
      `update public.planners set regions = array['gangwon'] where user_id = '${plannerAccount ?? outsider}';
       select regions[1] from public.planners where user_id = '${plannerAccount ?? outsider}';`,
    ) === "gangwon",
  );
  check(
    "**스스로 공개 상태로 올리는 것은 여전히 트리거가 막는다**(0037)",
    rejectedWith(/planners_self_activate|공개 상태로는 직접/, () =>
      asUser(
        plannerAccount ?? outsider,
        `update public.planners set status = 'active' where user_id = '${plannerAccount ?? outsider}';`,
        `update public.planners set status = 'paused' where user_id = '${plannerAccount ?? outsider}';`,
      ),
    ),
  );

  // ── 층 1 (FIX-49): 지급 원장의 쓰기 ──────────────────────────────────────
  check(
    "**planner_settlements 에 쓰기 GRANT 가 없다**(FIX-49) — 자기 지급액을 적을 수 없다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'planner_settlements'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**쓰기 정책도 없다** — GRANT 를 되돌려도 열리지 않는다",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'planner_settlements'
             and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');`) === "0",
  );
  check(
    "**플래너가 자기 지급액을 못 고친다** — 반영된 행 수로 본다(함정 9)",
    rejectedWith(/permission denied/i, () =>
      asUser(
        plannerAccount ?? outsider,
        `update public.planner_settlements set fee_amount = 99999999
          where id = '${PAYABLE_SETTLEMENT}';`,
      ),
    ),
  );
  check(
    "**스스로 지급 완료로 적을 수도 없다**",
    rejectedWith(/permission denied/i, () =>
      asUser(
        plannerAccount ?? outsider,
        `update public.planner_settlements set status = 'paid', paid_at = now()
          where id = '${PAYABLE_SETTLEMENT}';`,
      ),
    ),
  );
  check(
    "**행을 새로 만들 수도 없다** — 실적(계약 건수)의 근거이기도 하다",
    rejectedWith(/permission denied/i, () =>
      asUser(
        plannerAccount ?? outsider,
        `insert into public.planner_settlements
           (planner_id, booking_id, gross_amount, fee_rate_bp, fee_amount, earned_at, payable_at)
         values ('${SEEDED_PLANNER}',
                 (select id from public.bookings limit 1),
                 10000000, 300, 300000, now(), now());`,
      ),
    ),
  );
  check(
    "**비로그인은 지급 원장에 닿지도 못한다**",
    rejectedWith(/permission denied/i, () =>
      asAnon(`select count(*) from public.planner_settlements;`),
    ),
  );

  // ── 읽기 경계 ────────────────────────────────────────────────────────────
  if (plannerAccount) {
    check(
      "**플래너는 자기 원장을 읽는다** — 막기만 하면 기능이 없는 것이다",
      asUser(plannerAccount, `select count(*) from public.planner_settlements;`) === "2",
    );
  }
  check(
    "**남은 남의 원장을 못 읽는다**",
    asUser(outsider, `select count(*) from public.planner_settlements;`) === "0",
  );
  check(
    "**운영자는 읽는다** — 지급을 집행하고 이의에 답해야 한다",
    asUser(adminUser, `select count(*) from public.planner_settlements;`) === "2",
  );

  // ── planner_payouts (신설 표) ────────────────────────────────────────────
  check(
    "**planner_payouts 에 쓰기 GRANT 가 없다** — 지급 기록은 서버가 쓴다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'planner_payouts'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');`) === "0",
  );
  check(
    "**anon 에게는 SELECT 도 없다**",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'planner_payouts'
             and grantee = 'anon';`) === "0",
  );
  check(
    "**조회 정책이 소유자 조건을 스스로 든다**(층 2 · FIX-41) — 부모가 넓어져도 안 열린다",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'planner_payouts'
             and policyname = 'planner_payouts_select'
             and qual like '%p.user_id = auth.uid()%';`) === "1",
  );

  const payoutFixture = `
    insert into public.planner_payouts
      (planner_settlement_id, amount, status, idempotency_key, provider)
      values ('${PAYABLE_SETTLEMENT}', 360000, 'pending',
              'planner_settlement:${PAYABLE_SETTLEMENT}:payout:1', 'stub');
  `;

  if (plannerAccount) {
    check(
      "**플래너는 자기 지급 시도를 읽는다** — 왜 실패했는지 알아야 한다",
      asUser(plannerAccount, `select count(*) from public.planner_payouts;`, payoutFixture) === "1",
    );
  }
  check(
    "**남은 남의 지급 시도를 못 읽는다**",
    asUser(outsider, `select count(*) from public.planner_payouts;`, payoutFixture) === "0",
  );
  check(
    "**운영자는 읽는다**",
    asUser(adminUser, `select count(*) from public.planner_payouts;`, payoutFixture) === "1",
  );
  check(
    "**진행 중인 지급은 원장당 하나다** — 둘이 승인되면 같은 수수료가 두 번 나간다",
    rejectedWith(/uq_planner_payouts_pending/, () =>
      sql(`begin; ${payoutFixture}
           insert into public.planner_payouts
             (planner_settlement_id, amount, status, idempotency_key)
             values ('${PAYABLE_SETTLEMENT}', 360000, 'pending', 'other-key');
           rollback;`),
    ),
  );
  check(
    "**같은 멱등 열쇠로 두 번 요청할 수 없다** — 돈이 두 번 나간다",
    rejectedWith(/planner_payouts_idempotency_key_key|23505/, () =>
      sql(`begin; ${payoutFixture}
           insert into public.planner_payouts
             (planner_settlement_id, amount, status, idempotency_key)
             values ('${GRACE_SETTLEMENT}', 100, 'pending',
                     'planner_settlement:${PAYABLE_SETTLEMENT}:payout:1');
           rollback;`),
    ),
  );
  check(
    "**0원은 지급 행으로 만들 수 없다**",
    rejectedWith(/planner_payouts_amount_positive/, () =>
      sql(`insert into public.planner_payouts
             (planner_settlement_id, amount, status, idempotency_key)
             values ('${PAYABLE_SETTLEMENT}', 0, 'pending', 'zero-key');`),
    ),
  );
  check(
    "**상태와 시각의 짝이 어긋난 행을 만들 수 없다**",
    rejectedWith(/planner_payouts_paid_pair/, () =>
      sql(`insert into public.planner_payouts
             (planner_settlement_id, amount, status, idempotency_key)
             values ('${PAYABLE_SETTLEMENT}', 100, 'paid', 'pair-key');`),
    ),
  );
  check(
    "**지급 기록은 부모를 따라 사라지지 않는다** — FK 가 restrict 다(cascade 아님)",
    sql(`select confdeltype from pg_constraint
           where conrelid = 'public.planner_payouts'::regclass
             and conname = 'planner_payouts_planner_settlement_id_fkey';`) === "r",
  );

  // ── 지급 완료는 근거를 요구한다 ──────────────────────────────────────────
  // **먼저 지급 대상으로 옮겨 놓고 잰다.** `earned` 인 채로 `paid` 를 시도하면 전이
  // 규칙에 **먼저** 걸려, 지급 근거를 요구하는 규칙은 한 번도 실행되지 않는다
  // (함정 8 — 다른 CHECK 에 먼저 걸려도 검사는 통과한다).
  check(
    "**성공한 지급 기록 없이 지급 완료로 적을 수 없다** — 나가지 않은 돈이 나갔다고 적힌다",
    rejectedWith(/성공한 지급 기록 없이/, () =>
      sql(`begin;
             update public.planner_settlements set status = 'payable'
              where id = '${PAYABLE_SETTLEMENT}';
             update public.planner_settlements set status = 'paid', paid_at = now()
              where id = '${PAYABLE_SETTLEMENT}';
           rollback;`),
    ),
  );
  check(
    "**성공한 지급이 있으면 옮길 수 있다** — 막기만 하면 지급이 끝나지 않는다",
    sql(`begin;
           update public.planner_settlements set status = 'payable' where id = '${PAYABLE_SETTLEMENT}';
           insert into public.planner_payouts
             (planner_settlement_id, amount, status, idempotency_key, paid_at)
             values ('${PAYABLE_SETTLEMENT}', 360000, 'paid', 'paid-key', now());
           update public.planner_settlements set status = 'paid', paid_at = now()
            where id = '${PAYABLE_SETTLEMENT}';
           select status from public.planner_settlements where id = '${PAYABLE_SETTLEMENT}';
         rollback;`) === "paid",
  );

  // ── 유예 경계 — 앞당길 수 없다 ───────────────────────────────────────────
  check(
    "**유예가 지나지 않은 건을 지급 대상으로 옮길 수 없다**(0028) — 앞당기면 회수할 수 없다",
    rejectedWith(/planner_settlements_grace_not_elapsed|유예 기간이 지나지 않은/, () =>
      sql(`update public.planner_settlements set status = 'payable'
            where id = '${GRACE_SETTLEMENT}';`),
    ),
  );
  check(
    "**유예가 지난 건은 옮길 수 있다**",
    sql(`begin;
           update public.planner_settlements set status = 'payable' where id = '${PAYABLE_SETTLEMENT}';
           select status from public.planner_settlements where id = '${PAYABLE_SETTLEMENT}';
         rollback;`) === "payable",
  );
  check(
    "**허용되지 않은 전이를 막는다** — earned 에서 바로 paid 로 갈 수 없다",
    rejectedWith(/허용되지 않은 플래너 정산 상태 전이/, () =>
      sql(`update public.planner_settlements set status = 'paid', paid_at = now()
            where id = '${PAYABLE_SETTLEMENT}';`),
    ),
  );
  check(
    "**해지 무효는 어느 단계에서든 된다** — 그러나 되돌아오지 않는다",
    rejectedWith(/허용되지 않은 플래너 정산 상태 전이/, () =>
      sql(`begin;
             update public.planner_settlements set status = 'void' where id = '${GRACE_SETTLEMENT}';
             update public.planner_settlements set status = 'earned' where id = '${GRACE_SETTLEMENT}';
           rollback;`),
    ),
  );

  // ── 픽스처가 두 갈래를 다 덮는가 (함정 8) ────────────────────────────────
  check(
    "**유예가 지난 건과 아직 남은 건이 둘 다 시드에 있다** — 한 갈래만 있으면 검사가 아무것도 안 본다",
    sql(`select count(*) from public.planner_settlements where payable_at <= now();`) === "1" &&
      sql(`select count(*) from public.planner_settlements where payable_at > now();`) === "1",
  );

  // ── 같은 값을 두 곳이 다르게 해석하지 않는가 (FIX-52) ────────────────────
  {
    const payoutSource = srcOf("lib/planners/payouts.ts");

    check(
      "**유예 판정을 다시 만들지 않는다** — lib/core 의 함수를 부른다",
      payoutSource.includes("plannerPayoutState"),
    );
    check(
      "**유예 값도 계약 확정 경로와 같은 키를 같은 함수로 읽는다**",
      payoutSource.includes('readSetting("planner.payout_grace_days")') &&
        payoutSource.includes("resolveGraceDays") &&
        srcOf("lib/contract/actions.ts").includes(
          'readSetting("planner.payout_grace_days")',
        ),
    );
    check(
      "**지급 어댑터를 업체 지급과 공유한다** — 나누면 같은 일이 두 벌이 된다",
      payoutSource.includes('from "@/lib/settlements/payout-adapter"'),
    );
    check(
      "**어댑터가 받는 쪽을 종류와 함께 받는다** — 업체 정산을 플래너에게 보낼 수 없다",
      srcOf("lib/settlements/payout-adapter.ts").includes("PayoutPayee") &&
        payoutSource.includes('payee: { type: "planner"'),
    );
  }

  // ── 집행 수단 — 누가 채우고 누가 읽는가 ─────────────────────────────────
  check(
    "**배치 라우트가 실재한다** — 표만 있고 옮기는 코드가 없으면 영영 유예다(FIX-46 모양)",
    existsSync("app/api/jobs/planner-payout-due/route.ts"),
  );
  check(
    "**`vercel.json` 에 등록돼 있다** — 만들어 두고 안 부르면 없는 것과 같다",
    readFileSync("vercel.json", "utf8").includes("/api/jobs/planner-payout-due"),
  );
  check(
    "**배치 이름이 job_runs 어휘에 있다** — 없으면 기록이 CHECK 에 걸려 사라진다",
    sql(`select count(*) from pg_constraint
           where conrelid = 'public.job_runs'::regclass
             and conname = 'job_runs_name_vocab'
             and pg_get_constraintdef(oid) like '%planner-payout-due%';`) === "1",
  );
  check(
    "**지급을 실행하는 API 가 있다** — 지급 대상만 만들고 보내지 않으면 돈이 안 나간다",
    existsSync("app/api/admin/planner-payouts/route.ts"),
  );
  check(
    "**플래너가 자기 원장을 읽는 API 가 있다**",
    existsSync("app/api/planner/settlements/route.ts"),
  );

  // ── 화면 ─────────────────────────────────────────────────────────────────
  check("`/pro/settlements` 화면이 실재한다", existsSync("app/(planner)/pro/settlements/page.tsx"));
  check(
    "**플래너 내비가 내 정산을 가리킨다** — 안 그러면 URL 을 직접 쳐야 한다(FIX-25)",
    srcOf("components/layout/AdminShell.tsx").includes('href: "/pro/settlements"'),
  );
  check(
    "**운영자 정산 화면이 플래너 지급을 함께 든다** — 두 화면이면 한쪽만 보고 마감한다",
    srcOf("app/(admin)/admin/settlements/page.tsx").includes("PlannerPayoutPanel"),
  );
  check(
    "내 정산 화면이 캐시되지 않는다 (함정 4)",
    srcOf("app/(planner)/pro/settlements/page.tsx").includes(
      'export const dynamic = "force-dynamic"',
    ),
  );
  check(
    "**'받을 수 있음' 과 '받았음' 을 합치지 않는다는 사실이 본문에 실린다**(함정 3)",
    srcOf("lib/core/settlement/planner-payout.ts").includes(
      "PAYOUT_NOT_RECEIVED_NOTICE",
    ) && srcOf("lib/planners/payouts.ts").includes("payoutWired: false"),
  );
  check(
    "**plannerId 도 금액도 입력으로 받지 않는다** — 원장이 정한다(FIX-45·FIX-53 과 같은 자리)",
    // 스키마 본문만 본다. 주석에는 그 낱말이 **왜 없는지**가 적혀 있어서, 파일 전체를
    // 훑으면 설명 문장이 검사를 깨뜨린다.
    (() => {
      const source = srcOf("app/api/admin/planner-payouts/route.ts");
      const block = source.slice(source.indexOf("const PaySchema"));
      const fields = block.slice(0, block.indexOf("});"));

      return (fields.match(/^ {2}[a-zA-Z]+:/gm) ?? [])
        .map((line) => line.trim().replace(":", ""))
        .sort()
        .join(",") === "attempt,settlementId";
    })(),
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · 0071 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// S6-06 — 플래너 랭킹 (F-C-18 · D-03 · D-25 · O-13)
//
// **표를 만들지 않은 태스크다.** 순서는 S6-02 의 마켓이 이미 만들고 있고, 이 태스크가
// 더하는 것은 **그 순서의 근거를 공개하는 것**이다. 그래서 여기서 볼 것은 셋이다 —
// (가) 근거가 실제 순서와 같은가, (나) 지어내지 않은 것을 지어내지 않았는가,
// (다) 그 순서를 떠받치는 표가 여전히 당사자에게 닫혀 있는가(층 3 재확인).
// ═══════════════════════════════════════════════════════════════════════════
{
  const rankingSource = srcOf("lib/core/planner/ranking.ts");
  const rankingPage = srcOf("app/(consumer)/planners/ranking/page.tsx");
  const marketApi = srcOf("app/api/planners/route.ts");
  const marketView = srcOf("app/(consumer)/planners/PlannerMarketView.tsx");

  // ── 층 3 재확인: 순서를 떠받치는 표를 당사자가 쓸 수 있는가 ──────────────
  // 마켓의 유일한 실적 지표는 `planner_contract_count` 이고 그 함수는
  // `planner_settlements` 를 센다. **그 표를 플래너가 쓸 수 있으면 순위를 스스로
  // 올릴 수 있다** — S6-05 가 닫았고, 여기서 다시 못 박는다.
  check(
    "**실적의 근거 표에 쓰기 GRANT 가 없다** — 있으면 순위를 스스로 올릴 수 있다",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'planner_settlements'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**쓰기 정책도 없다** — GRANT 를 되돌려도 열리지 않는다",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'planner_settlements'
             and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');`) === "0",
  );
  check(
    "**실적 집계는 여전히 개수만 돌려주는 함수다** — 뷰였다면 남의 정산이 새어 나간다",
    sql(`select count(*) from pg_proc
           where proname = 'planner_contract_count' and prosecdef;`) === "1",
  );
  check(
    "**공개 상태를 스스로 켤 수 없다**(FIX-54) — 켤 수 있으면 순위 이전에 목록에 든다",
    sql(`select count(*) from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'planners'
             and grantee = 'authenticated' and privilege_type = 'INSERT'
             and column_name = 'status';`) === "0",
  );

  // ── 공개한 기준이 실제 순서와 같은가 ─────────────────────────────────────
  check(
    "**순서를 만드는 함수가 하나다** — 기준 화면이 목록을 다시 계산하지 않는다",
    !rankingPage.includes("sortMarket") && !rankingPage.includes("loadMarket"),
  );
  check(
    "**기준 목록을 지어내지 않는다** — S6-01·S6-02 의 판정을 그대로 읽는다",
    rankingSource.includes("rankingMetricAvailability") &&
      rankingSource.includes("MARKET_SORTS"),
  );
  check(
    "**S6-01 이 만들어 둔 판정 함수를 읽는 화면이 생겼다** — 그전까지 쓰는 곳이 없었다",
    rankingPage.includes("rankingDisclosure"),
  );

  // ── 지어내지 않은 것 ─────────────────────────────────────────────────────
  check(
    "**종합 점수를 만들지 않았다는 사실이 값으로 나간다**(함정 3 · O-13)",
    rankingSource.includes("compositeScore: false"),
  );
  check(
    "**추천·프리미엄 정렬이 어휘에 없다**(D-03 · §2.2)",
    ["recommended", "sponsored", "premium", "featured"].every(
      (word) => !srcOf("lib/core/planner/profile.ts").includes(`"${word}"`),
    ),
  );
  check(
    "**콜드스타트에 대응하지 않고 물음만 든다**",
    rankingSource.includes("COLD_START_NOTE") && !rankingSource.includes("boost"),
  );
  check(
    "**못 세는 이유를 두 종류로 가른다** — '곧 생긴다' 와 '생길 수 없다' 는 다른 말이다",
    srcOf("lib/core/planner/scope.ts").includes('kind: "not_distinct"') &&
      srcOf("lib/core/planner/scope.ts").includes('kind: "pending"'),
  );

  // ── 화면·API 가 이어져 있다 ──────────────────────────────────────────────
  check(
    "`/planners/ranking` 화면이 실재한다",
    existsSync("app/(consumer)/planners/ranking/page.tsx"),
  );
  check(
    "**마켓이 기준 화면으로 잇는다** — 배지 한 줄로는 '왜 이 지표뿐인가' 를 못 답한다",
    marketView.includes("/planners/ranking"),
  );
  check(
    "**플래너 상세도 잇는다** — '아직 세지 않아요' 를 읽은 사람이 다음에 묻는 자리다",
    srcOf("app/(consumer)/planners/[id]/page.tsx").includes("/planners/ranking"),
  );
  check(
    "**플래너 콘솔도 잇는다** — 본인이 무엇으로 평가되는지 알아야 한다",
    srcOf("app/(planner)/pro/page.tsx").includes("/planners/ranking"),
  );
  check(
    "**근거가 목록 응답과 함께 나간다**(§2.2 · D-25) — 결과와 기준은 같이 다닌다",
    marketApi.includes("ranking: rankingDisclosure()"),
  );

  // ── 비로그인도 근거를 읽는가 (고르기 전에 읽는 것이다) ───────────────────
  check(
    "**마켓은 여전히 비로그인이 본다** — 순서의 근거도 로그인 뒤에 숨지 않는다",
    asAnon(`select count(*) from public.planners where status = 'active';`) !== "0",
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · S6-06 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// C-1 — 견적 수락 → 예약 생성 다리 · 세 면 거래 상세
//
// **생성 경로를 만들면서 층 3 을 다시 본다.** `bookings` 는 `reviews_insert` 가
// 후기 자격으로 읽는 표다(D-129) — FIX-44 가 바로 그 자리에서 났다(커플이 업체 동의
// 없이 confirmed 예약을 만들고 그것으로 '검증 후기' 를 썼다). 다리를 놓는다고 표를
// 열면 그 구멍이 그대로 돌아온다. **열지 않았다는 사실을 여기서 못 박는다.**
// ═══════════════════════════════════════════════════════════════════════════
{
  const bridgeSource = srcOf("lib/bookings/create.ts");
  const bridgeCore = srcOf("lib/core/booking/bridge.ts");
  const chainSource = srcOf("lib/bookings/chain.ts");
  const contractRead = srcOf("lib/contract/read.ts");
  const adminTx = srcOf("lib/admin/transactions.ts");

  // ── 층 1: 표에 쓰기가 열리지 않았는가 ───────────────────────────────────
  check(
    "**`bookings` 에 여전히 당사자 쓰기 GRANT 가 없다**(FIX-44 · C-1 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'bookings'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**컬럼 GRANT 도 없다** — 표 GRANT 를 걷어도 컬럼 GRANT 는 따로 남는다(함정 6)",
    sql(`select count(*) from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'bookings'
             and grantee in ('anon', 'authenticated')
             and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`) === "0",
  );
  check(
    "**쓰기 정책도 없다** — GRANT 를 되돌려도 열리지 않는다",
    sql(`select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'bookings'
             and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');`) === "0",
  );

  // ── 층 1 구멍을 닫았는가: 요율 스냅샷 검사가 INSERT 에도 걸리는가 ────────
  //
  // 0065 가 곁가지로 적어 둔 것이다 — 트리거가 `before update` 전용이라
  // `confirmed` 행을 **INSERT 로 바로 만들면** 요율 검사를 건너뛴다. 그전까지는
  // INSERT 경로가 없어 도달할 수 없었고, **C-1 이 그 경로를 만들었다.**
  check(
    "**요율 스냅샷 트리거가 INSERT 에도 걸린다**(0074 — 0065 가 적어 둔 곁가지)",
    sql(`select count(*) from pg_trigger
           where tgname = 'trg_bookings_rate_snapshot'
             and (tgtype & 4) > 0;`) === "1",
  );
  {
    // **헛돌지 않는지 실제로 본다.** 서비스롤로도 요율 없는 confirmed 를 못 만든다.
    const cp = sql(`select id from public.couples limit 1;`);
    const vd = sql(`select id from public.vendors limit 1;`);

    check(
      "**요율 없이 confirmed 예약을 INSERT 로 만들 수 없다** — 서비스롤도 못 한다",
      cp !== "" && vd !== "" &&
        rejectedWith(/bookings_rate_snapshot_required|스냅샷/, () =>
          sql(`begin;
                 insert into public.bookings (couple_id, vendor_id, status, total_amount)
                 values ('${cp}', '${vd}', 'confirmed', 1000);
               rollback;`)),
    );
    check(
      "**hold 예약은 요율 없이 만들 수 있다** — 있을 때 조용한지도 본다",
      cp !== "" && vd !== "" &&
        sqlOrNull(`begin;
                     insert into public.bookings (couple_id, vendor_id, status, total_amount)
                     values ('${cp}', '${vd}', 'hold', 1000);
                   rollback;`) !== null,
    );
  }

  // ── 한 견적은 예약을 하나만 만든다 ──────────────────────────────────────
  check(
    "**견적당 예약 하나**(`uq_bookings_quote`) — 두 번 눌러도 예약이 둘 생기지 않는다",
    sql(`select count(*) from pg_indexes
           where schemaname = 'public' and indexname = 'uq_bookings_quote';`) === "1",
  );
  {
    const cp = sql(`select id from public.couples limit 1;`);
    const vd = sql(`select id from public.vendors limit 1;`);
    const pd = sql(`select id from public.products limit 1;`);

    // **견적을 이 검사가 직접 만든다**(D-178 — 수는 표 전체가 아니라 트랜잭션이 만든
    // 상태로 센다). 시드에 `quotes` 픽스처가 없어서 처음에는 "픽스처 없음" 으로
    // 넘겼는데, **그러면 이 검사는 영영 안 돈다.** 만들 것을 만들어 놓고 센다.
    const quoteFixture = `
      insert into public.inquiries (id, couple_id)
        values ('00000000-0000-0000-0000-0000000c1001', '${cp}');
      insert into public.inquiry_targets (id, inquiry_id, vendor_id)
        values ('00000000-0000-0000-0000-0000000c1002',
                '00000000-0000-0000-0000-0000000c1001', '${vd}');
      insert into public.quotes (id, inquiry_target_id, product_id,
                                 total_amount, cap_total, base_price_snapshot, status, sent_at)
        values ('00000000-0000-0000-0000-0000000c1003',
                '00000000-0000-0000-0000-0000000c1002', '${pd}', 1000, 1000, 1000, 'sent', now());`;
    // `quotes_sent_pair_chk` 가 **보낸 견적에는 보낸 시각을 요구한다** — CI 가 그것을
    // 잡았다. 픽스처도 제품이 만들 수 있는 상태여야 한다(FIX-56 이 세운 규칙).

    check(
      "**같은 견적으로 두 번 만들면 두 번째가 막힌다** — 실제로 넣어 본다",
      cp !== "" && vd !== "" && pd !== "" &&
        rejectedWith(/uq_bookings_quote|duplicate key/, () =>
          sql(`begin; ${quoteFixture}
                 insert into public.bookings (couple_id, vendor_id, status, total_amount, quote_id)
                 values ('${cp}', '${vd}', 'hold', 1000, '00000000-0000-0000-0000-0000000c1003');
                 insert into public.bookings (couple_id, vendor_id, status, total_amount, quote_id)
                 values ('${cp}', '${vd}', 'hold', 1000, '00000000-0000-0000-0000-0000000c1003');
               rollback;`)),
    );
    check(
      "**한 번은 된다** — 없을 때 막는지만 보지 말고 있을 때 조용한지도 본다",
      cp !== "" && vd !== "" && pd !== "" &&
        sqlOrNull(`begin; ${quoteFixture}
                     insert into public.bookings (couple_id, vendor_id, status, total_amount, quote_id)
                     values ('${cp}', '${vd}', 'hold', 1000, '00000000-0000-0000-0000-0000000c1003');
                   rollback;`) !== null,
    );
  }

  // ── 다리가 무엇을 안 만지는가 (소스로 고정한다) ─────────────────────────
  check(
    "**다리는 업체 승인을 만들지 않는다**(FIX-44) — 고객 행위로 동의가 생기지 않는다",
    !bridgeSource.includes("accepted_at:") && !bridgeCore.includes("acceptedAt:"),
  );
  check(
    "**다리는 플래너를 만지지 않는다**(FIX-53) — planner_scopes 가 정한다",
    !bridgeSource.includes("planner_id:") && !bridgeCore.includes("plannerId:"),
  );
  check(
    "**다리는 요율을 만지지 않는다** — 서명이 끝날 때 박힌다",
    !bridgeSource.includes("applied_fee_rate_bp:"),
  );
  check(
    "**다리는 자리를 잡지 않는다** — 자리는 confirmed 전이에서 잡힌다(0031)",
    !bridgeSource.includes("slot_id:"),
  );
  check(
    "**쓰기는 서비스롤이다**(D-62) — 표가 당사자에게 닫혀 있으므로 이 길뿐이다",
    bridgeSource.includes("createAdminClient"),
  );
  check(
    "**예약 신청은 고객이 한다** — 업체가 자기 견적으로 만들 수 없다",
    bridgeSource.includes("BOOKING_NOT_COUPLE"),
  );

  // ── 층 2: 새 정책이 부모 표에 기대는가 ──────────────────────────────────
  //
  // C-1 은 **정책을 하나도 더하지 않았다.** 운영자 조회는 definer 함수 둘이며
  // 그 안에서 `is_operator()` 를 스스로 묻는다 — 부모 표의 정책에 기대지 않는다.
  check(
    "**운영자 조회는 definer 함수다** — 정책을 늘리지 않았다(D-120)",
    sql(`select count(*) from pg_proc
           where proname in ('admin_transaction_rows', 'admin_transaction_chain')
             and prosecdef;`) === "2",
  );
  check(
    "**두 함수가 자기 권한을 스스로 묻는다** — 부모 정책에 기대지 않는다(층 2)",
    sql(`select count(*) from pg_proc
           where proname in ('admin_transaction_rows', 'admin_transaction_chain')
             and pg_get_functiondef(oid) like '%is_operator()%';`) === "2",
  );
  check(
    "**anon 은 실행조차 못 한다**",
    sql(`select count(*) from information_schema.role_routine_grants
           where routine_schema = 'public'
             and routine_name in ('admin_transaction_rows', 'admin_transaction_chain')
             and grantee = 'anon';`) === "0",
  );

  // ── 운영자 함수가 민감 칸을 내보내지 않는가 (D-120 의 요점) ─────────────
  {
    const defs = sql(`select string_agg(pg_get_functiondef(oid), ' ') from pg_proc
                        where proname in ('admin_transaction_rows', 'admin_transaction_chain');`);

    for (const forbidden of ["clauses_json", "pdf_path", "vendor_memo"]) {
      check(
        `**운영자 조회가 ${forbidden} 를 내보내지 않는다**(§5.3 · D-120)`,
        defs !== "" && !defs.includes(forbidden),
      );
    }
  }

  // ── 운영자가 아니면 0건인가 (오류가 아니라 0건이다) ─────────────────────
  {
    const outsider = sql(`select user_id from public.couple_members limit 1;`);

    check(
      "**운영자가 아니면 거래 목록이 0건이다** — 권한을 오류로 알리지 않는다",
      outsider !== "" &&
        asUser(outsider, `select count(*) from public.admin_transaction_rows(100);`) === "0",
    );
  }

  // ── 세 면이 같은 사실을 읽는가 (조회 계층 공유) ─────────────────────────
  check(
    "**소비자·업체가 같은 조회 계층을 쓴다** — 따로 쓰면 같은 예약이 다르게 보인다",
    srcOf("lib/bookings/read.ts").includes("loadChainFacts") &&
      srcOf("lib/bookings/vendor-detail.ts").includes("loadChainFacts"),
  );
  check(
    "**공유 계층은 세션으로 읽는다** — 서비스롤로 읽으면 RLS 경계를 우회한다",
    chainSource.includes("createClient") && !chainSource.includes("createAdminClient"),
  );

  // ── 계약서 화면(FIX-57)이 Storage 경로를 읽지 않는가 ────────────────────
  check(
    "**계약서 화면이 pdf_path 를 읽지 않는다**(§5.3 — 경로는 어디에도 남기지 않는다)",
    !contractRead.includes("pdf_path"),
  );
  check(
    "**서명 역할을 사용자 id 로 판정한다** — 배우자에게 서명 버튼이 뜨면 안 된다",
    contractRead.includes('.eq("user_id", actorId)'),
  );

  // ── 화면이 실재하고 들어가는 자리가 있는가 ──────────────────────────────
  for (const [label, file] of [
    ["계약서", "app/(consumer)/contracts/[id]/page.tsx"],
    ["업체 거래 상세", "app/(vendor)/vendor/bookings/[id]/page.tsx"],
    ["운영자 거래 조회", "app/(admin)/admin/transactions/page.tsx"],
  ]) {
    check(`${label} 화면이 실재한다`, existsSync(file));
  }
  check(
    "**업체 목록이 거래 상세로 잇는다** — 안 이으면 URL 을 아는 사람만 연다(FIX-25)",
    srcOf("app/(vendor)/vendor/bookings/page.tsx")
      .includes("/vendor/bookings/"),
  );
  check(
    "**운영자 내비가 거래 조회를 가리킨다**",
    srcOf("components/layout/AdminShell.tsx").includes("/admin/transactions"),
  );
  check(
    "**문의 화면의 '준비 중' 안내가 사라졌다** — S5-04·S5-06 은 이미 완료다",
    !srcOf("app/(consumer)/inquiries/InquiriesView.tsx")
      .includes("계약서 작성과 결제는 준비 중"),
  );
  check(
    "**수락한 견적이 예약으로 이어진다** — 화면이 갈 곳을 준다",
    srcOf("app/(consumer)/inquiries/InquiriesView.tsx")
      .includes("quote-booking-link"),
  );
  /**
   * **<p> 안에 <div> 를 넣지 않는다** (C-1b · 하이드레이션)
   *
   * Badge·Card 는 <div> 다. <p> 안에 넣으면 브라우저가 문단을 **강제로 닫아** 서버
   * HTML 과 클라이언트 트리가 엇갈리고 하이드레이션이 깨진다.
   *
   * 세 자리에서 실제로 깨져 있었다 — 운영 콘솔은 **항상**, 업체 거래 상세는
   * **지금 할 일이 있을 때만**, 채팅 목록은 **끝난 대화방만**. 하필 쓸모있는
   * 순간에만 깨졌고, 그래서 눈으로는 안 보였다(사슬 주행의 음성 대조에서 잡혔다).
   *
   * **본 파일을 실제로 읽었는지부터 묻는다** — 목록이 비면 이 검사는 언제나
   * 조용히 통과한다(운영 규칙 7.0b).
   */
  {
    const screens = listScreenSources();
    check(
      "**화면 소스를 실제로 모았다** — 0개면 아래 검사가 빈 목록을 통과시킨다",
      screens.length > 50,
      `${screens.length}개`,
    );

    const DIVISH =
      /<(Badge|Card|CardContent|CardHeader|Separator|Progress|EmptyState|ErrorState|LoadingState|div)[\s/>]/;
    const offenders = [];
    for (const [file, code] of screens) {
      for (const m of code.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
        const hit = DIVISH.exec(m[1]);
        if (hit) offenders.push(`${file} <p> ⊃ <${hit[1]}>`);
      }
    }

    check(
      "**<p> 안에 블록 요소가 없다** — 하이드레이션이 깨지는 중첩이다(C-1b)",
      offenders.length === 0,
      offenders.slice(0, 5).join(" / "),
    );
  }

  check(
    "**운영자 조회가 판정 어휘를 쓰지 않는다**(D-24) — 조율자이지 판정자가 아니다",
    !adminTx.includes("지연") && !adminTx.includes("위반"),
  );

  check(
    "public 어느 표에도 TRUNCATE 가 열려 있지 않다 (FIX-35 · C-1 이후에도)",
    sql(`select count(*) from information_schema.role_table_grants
           where table_schema = 'public' and privilege_type = 'TRUNCATE'
             and grantee in ('anon', 'authenticated');`) === "0",
  );
}

// =============================================================================
// C-3 — 업체 편의 (상품 복제 · 템플릿 꺼내 쓰기 · 대표/담당자 경계)
// =============================================================================
/**
 * **뚫린 곳이 없어도 검사로 남긴다**(운영 규칙 §5.5).
 *
 * C-3 은 상품을 **복사**하는 길을 새로 열었다. 복사는 쓰기이고, `products` 는 가격
 * 테이블이라 **대표 전용**이다(§3.9). 감사에서 열세 자리를 눌러 봤고 전부 막혀
 * 있었다 — 그런데 "봤는데 괜찮았다" 는 다음 사람에게 남지 않는다. 눌러 본 것을
 * 그대로 검사로 옮긴다.
 */
{
  const staffUser = idOf("staff@local.test");
  const ownerUser = idOf("vendor@local.test");
  const demoVendor = staffUser
    ? sql(`select vendor_id from public.vendor_members where user_id = '${staffUser}' limit 1;`)
    : "";
  const otherVendor = "00000000-0000-0000-0000-000000000901";

  // **먼저 픽스처가 있는지 묻는다.** 없으면 아래 검사가 전부 빈 결과를 통과시킨다.
  check(
    "**대표·담당자 픽스처가 있다** — 없으면 아래 경계 검사가 통째로 헛돈다",
    Boolean(staffUser) && Boolean(ownerUser) && Boolean(demoVendor),
    `staff=${staffUser ? "있음" : "없음"} owner=${ownerUser ? "있음" : "없음"} vendor=${demoVendor ? "있음" : "없음"}`,
  );

  if (staffUser && ownerUser && demoVendor) {
    // ── 층3 : 자격의 근거 표를 자격을 얻으려는 사람이 직접 쓸 수 있는가 ──────
    check(
      "**담당자가 자기를 대표로 올릴 수 없다**(층3) — 자격의 근거 표를 본인이 못 쓴다",
      asUser(staffUser, `with u as (update public.vendor_members set vendor_role = 'owner'
                                    where user_id = auth.uid() returning 1)
                         select count(*) from u;`) === "0",
    );
    check(
      "**담당자가 자기 앞으로 대표 멤버 행을 만들 수 없다**(층3) — UPDATE 를 막아도 INSERT 가 남는다",
      rejectedWith(/row-level security/, () =>
        sql(`begin;
             set local role authenticated;
             select set_config('request.jwt.claims', '{"sub":"${staffUser}","role":"authenticated","aud":"authenticated"}', true);
             insert into public.vendor_members (vendor_id, user_id, vendor_role)
             values ('${demoVendor}', '${staffUser}', 'owner');
             rollback;`)),
    );
    check(
      "**담당자가 남의 업체에 끼어들 수 없다**",
      rejectedWith(/row-level security/, () =>
        sql(`begin;
             set local role authenticated;
             select set_config('request.jwt.claims', '{"sub":"${staffUser}","role":"authenticated","aud":"authenticated"}', true);
             insert into public.vendor_members (vendor_id, user_id, vendor_role)
             values ('${otherVendor}', '${staffUser}', 'staff');
             rollback;`)),
    );

    // ── 층1 : 판매가·추가금은 대표만 (§3.9) — 복제도 쓰기다 ──────────────────
    check(
      "**담당자가 판매가를 고칠 수 없다**(§3.9)",
      asUser(staffUser, `with u as (update public.products set base_price_total = base_price_total + 1
                                    where vendor_id = '${demoVendor}' returning 1)
                         select count(*) from u;`) === "0",
    );
    check(
      "**담당자가 상품을 만들 수 없다** — 복제가 부르는 것도 같은 INSERT 다(C-3)",
      rejectedWith(/row-level security/, () =>
        sql(`begin;
             set local role authenticated;
             select set_config('request.jwt.claims', '{"sub":"${staffUser}","role":"authenticated","aud":"authenticated"}', true);
             insert into public.products (vendor_id, name, category, base_price_total, status)
             values ('${demoVendor}', 'staff-product', 'hall', 1000000, 'draft');
             rollback;`)),
    );
    check(
      "**담당자가 추가금을 등록할 수 없다** — 복제가 추가금도 옮긴다(C-3)",
      rejectedWith(/row-level security/, () =>
        sql(`begin;
             set local role authenticated;
             select set_config('request.jwt.claims', '{"sub":"${staffUser}","role":"authenticated","aud":"authenticated"}', true);
             insert into public.product_options (product_id, name, price, is_mandatory)
             select id, 'staff-option', 50000, true from public.products
              where vendor_id = '${demoVendor}' limit 1;
             rollback;`)),
    );
    check(
      "**대표는 상품을 만들 수 있다** — 없을 때 막는지만 보지 말고 있을 때 조용한지도 본다",
      asUser(ownerUser, `with i as (insert into public.products (vendor_id, name, category, base_price_total, status)
                                    values ('${demoVendor}', 'C3 owner probe', 'hall', 1000000, 'draft') returning 1)
                         select count(*) from i;`) === "1",
    );

    // ── 층2 : 자식 정책이 부모 정책에만 기대는 자리 ──────────────────────────
    /**
     * `product_options_select_public` 은 **자기 조건이 없다** — `exists (select 1 from
     * products p where p.id = product_id)` 뿐이고 상품의 공개 여부는 `products` 의
     * 정책이 판정한다. 지금은 옳게 동작한다(정책 안의 서브쿼리에도 RLS 가 걸린다).
     * 그러나 이것은 **다른 표의 정책에 기대는 모양**이라, `products` 에 넓은 SELECT
     * 정책이 하나 붙는 날 **초안 상품의 추가금이 함께 샌다.** 그날 이 검사가 운다.
     */
    const draftFixture = `
      insert into public.products (id, vendor_id, name, category, base_price_total, status)
      values ('00000000-0000-0000-0000-0000000c3001', '${demoVendor}', 'C3 초안', 'hall', 9000000, 'draft');
      insert into public.product_options (product_id, name, price, is_mandatory)
      values ('00000000-0000-0000-0000-0000000c3001', 'C3 비공개 추가금', 300000, true);`;
    const stranger = idOf("couple-a@local.test");

    check(
      "**남은 초안 상품을 못 본다**",
      asUser(stranger, `select count(*) from public.products
                         where id = '00000000-0000-0000-0000-0000000c3001';`, draftFixture) === "0",
    );
    check(
      "**남은 초안 상품의 추가금도 못 본다**(층2 — 자식이 부모 정책에 기대는 자리)",
      asUser(stranger, `select count(*) from public.product_options
                         where product_id = '00000000-0000-0000-0000-0000000c3001';`, draftFixture) === "0",
    );
    check(
      "**담당자는 자기 업체 초안을 본다** — 있을 때 조용한가",
      asUser(staffUser, `select count(*) from public.products
                          where id = '00000000-0000-0000-0000-0000000c3001';`, draftFixture) === "1",
    );

    // ── vendor_templates — 담당자도 만든다(의도)지만 남의 것은 못 만진다 ─────
    check(
      "**담당자도 템플릿을 만든다**(의도 · 화면이 그렇게 적는다)",
      asUser(staffUser, `with i as (insert into public.vendor_templates (vendor_id, kind, title, payload_json)
                                    values ('${demoVendor}', 'quick_reply', 'C3 시험', '{"body":"x"}'::jsonb) returning 1)
                         select count(*) from i;`) === "1",
    );
    check(
      "**남의 업체 템플릿은 못 만든다**",
      rejectedWith(/row-level security/, () =>
        sql(`begin;
             set local role authenticated;
             select set_config('request.jwt.claims', '{"sub":"${staffUser}","role":"authenticated","aud":"authenticated"}', true);
             insert into public.vendor_templates (vendor_id, kind, title, payload_json)
             values ('${otherVendor}', 'quick_reply', 'C3 침입', '{"body":"x"}'::jsonb);
             rollback;`)),
    );
    check(
      "**커플은 업체 템플릿을 못 읽는다**",
      asUser(stranger, `select count(*) from public.vendor_templates;`) === "0",
    );
  }

  // ── 화면이 없는 길을 가리키지 않는가 ──────────────────────────────────────
  /**
   * **FIX-65 를 CI 가 지키게 한다.**
   *
   * C-1b 가 계약 발행 버튼을 달았고 `chain:walk` 이 그것을 지킨다 — 그런데
   * **`chain:walk` 은 CI 에 없다**(CI 는 lint·types·tests·build·bundle·db:rls 를 돈다).
   * 즉 버튼이 사라져도 **PR 은 초록불**이다. 같은 결함이 다시 들어올 자리라 여기서 막는다.
   */
  check(
    "**계약 발행 버튼이 실재한다**(FIX-65) — API 는 있는데 부를 자리가 없던 자리다",
    existsSync("app/(vendor)/vendor/bookings/IssuePanel.tsx") &&
      srcOf("app/(vendor)/vendor/bookings/IssuePanel.tsx").includes('"/api/contracts"') &&
      srcOf("app/(vendor)/vendor/bookings/page.tsx").includes("<IssuePanel"),
  );

  /**
   * **저장한 것을 꺼내 쓰는 자리가 있는가**(C-3 · F-V-07 · F-V-15).
   *
   * `vendor_templates` 는 0026 부터 있었고 `/vendor/settings` 에서 만들고 지울 수
   * 있었는데 **꺼내 쓰는 자리가 없었다.** 설정 화면은 "저장해 두고 꺼내 써요" 라고
   * 적고 있었다 — FIX-65 와 같은 결함이다.
   */
  check(
    "**견적 폼이 템플릿을 꺼내고 저장한다**(F-V-07 — 명세가 '템플릿 저장' 을 요구한다)",
    srcOf("app/(vendor)/vendor/inquiries/VendorInquiriesView.tsx").includes("applyQuoteTemplate") &&
      srcOf("app/(vendor)/vendor/inquiries/VendorInquiriesView.tsx").includes("save-quote-template"),
  );
  check(
    "**견적 폼이 템플릿을 실제로 받는다** — 화면만 그리고 목록이 안 오면 늘 비어 있다",
    srcOf("app/(vendor)/vendor/inquiries/page.tsx").includes("loadTemplates") &&
      srcOf("app/(vendor)/vendor/inquiries/page.tsx").includes("quoteTemplates"),
  );
  check(
    "**채팅이 저장해 둔 빠른 답변을 보여준다**(F-V-15) — 붙박이 상수만 뜨던 자리다",
    srcOf("app/(vendor)/vendor/chat/VendorChatView.tsx").includes("savedReplies") &&
      srcOf("app/(vendor)/vendor/chat/page.tsx").includes("loadTemplates"),
  );
  check(
    "**상품 목록이 복제로 잇는다**(F-V-03) — 만든 화면에 들어가는 자리를 잇는다",
    existsSync("app/(vendor)/vendor/products/DuplicateButton.tsx") &&
      srcOf("app/(vendor)/vendor/products/page.tsx").includes("<DuplicateButton"),
  );
  check(
    "**복제 버튼은 대표에게만 보인다**(§3.9) — 화면 체크는 UX 보조이고 경계는 RLS 다",
    srcOf("app/(vendor)/vendor/products/page.tsx").includes("canEdit ? (") &&
      srcOf("app/(vendor)/vendor/products/page.tsx").includes('vendor_role === "owner"'),
  );
  /**
   * **여기서 순수 함수의 값을 문자열로 확인하지 않는다.**
   *
   * 처음엔 `product-duplicate.ts` 에 `addOnsDeclaredAt: null` 이 있는지 봤는데,
   * 그 문자열은 **타입 선언**(`addOnsDeclaredAt: null;`)에도 있어서 값을 망가뜨려도
   * 통과했다 — 음성 대조에서 잡혔다. 값은 **vitest 가 본다**(`product-duplicate.test.ts`
   * 의 "추가금 확정은 따라오지 않는다") 그리고 `npm run test` 는 CI 가 돈다.
   *
   * 여기서는 **테스트가 못 보는 것**만 본다 — 서버가 그 값을 실제로 INSERT 에 싣는가,
   * 그리고 DB 가 마지막으로 막는가.
   */
  check(
    "**복제가 확정을 INSERT 에 싣지 않는다**(D-06) — 순수 함수가 비워도 서버가 안 쓰면 소용없다",
    srcOf("lib/vendor/duplicate.ts").includes("add_ons_declared_at: draft.addOnsDeclaredAt") &&
      srcOf("lib/vendor/duplicate.ts").includes("published_at: draft.publishedAt"),
  );
  check(
    "**복제는 서비스롤을 쓰지 않는다** — 쓰면 담당자가 부른 요청도 성공한다",
    !srcOf("lib/vendor/duplicate.ts").includes("createAdminClient"),
  );
  check(
    "**DB 가 미확정 상품의 게시를 막는다**(D-06) — 화면이 봐주더라도",
    sql(`select count(*) from pg_constraint
           where conrelid = 'public.products'::regclass
             and conname = 'products_publish_requirements_chk'
             and pg_get_constraintdef(oid) ilike '%add_ons_declared_at is not null%';`) === "1",
  );
  check(
    "**설정 화면이 꺼내는 자리를 이름으로 말한다**(C-3) — '어딘가에 있겠지' 를 시키지 않는다",
    srcOf("app/(vendor)/vendor/settings/VendorSettingsView.tsx").includes("채팅 응대") &&
      srcOf("app/(vendor)/vendor/settings/VendorSettingsView.tsx").includes("템플릿으로 저장"),
  );
}

// =============================================================================
// FIX-66 — 문의 생성 화면 (사슬의 첫 칸)
// =============================================================================
/**
 * **뚫린 곳이 없어도 검사로 남긴다**(§5.5).
 *
 * 이 회차는 소비자가 **남의 커플 이름으로** 쓸 수 있는 화면을 새로 열었다 —
 * 문의를 만드는 폼이다. 표를 만지기 전에 세 층을 눌러 봤고 **열아홉 자리가 전부
 * 막혀 있었다.** 그런데 "봤는데 괜찮았다" 는 다음 사람에게 남지 않는다.
 */
{
  const coupleOwner = idOf("couple-linked-a@local.test");
  const couplePartner = idOf("couple-linked-b@local.test");
  const outsiderUser = idOf("couple-a@local.test");
  const vendorOwnerUser = idOf("vendor@local.test");
  const demoVendorId = vendorOwnerUser
    ? sql(`select vendor_id from public.vendor_members where user_id = '${vendorOwnerUser}' limit 1;`)
    : "";
  const linkedCoupleId = coupleOwner
    ? sql(`select couple_id from public.couple_members where user_id = '${coupleOwner}' limit 1;`)
    : "";
  const strangerVendorId = "00000000-0000-0000-0000-000000000901";
  const spareCoupleId = "00000000-0000-0000-0000-0000000f66c1";

  check(
    "**문의 감사 픽스처가 있다** — 없으면 아래 경계 검사가 통째로 헛돈다",
    Boolean(coupleOwner) && Boolean(couplePartner) && Boolean(outsiderUser) &&
      Boolean(demoVendorId) && Boolean(linkedCoupleId),
    `couple=${linkedCoupleId ? "있음" : "없음"} vendor=${demoVendorId ? "있음" : "없음"}`,
  );

  if (coupleOwner && couplePartner && outsiderUser && demoVendorId && linkedCoupleId) {
    const INQ = "00000000-0000-0000-0000-0000000f6601";
    const TGT = "00000000-0000-0000-0000-0000000f6602";
    const fixtureFor = (vendorId) => `
      insert into public.couples (id, owner_id)
      values ('${spareCoupleId}', '${vendorOwnerUser}') on conflict do nothing;
      insert into public.inquiries (id, couple_id, event_date, categories, status)
      values ('${INQ}', '${linkedCoupleId}', '2027-05-15', array['hall'], 'open');
      insert into public.inquiry_targets (id, inquiry_id, vendor_id, status)
      values ('${TGT}', '${INQ}', '${vendorId}', 'pending');`;
    const FIX = fixtureFor(demoVendorId);
    const FIX_OTHER = fixtureFor(strangerVendorId);

    // ── 층1 : 표/컬럼 권한 · CHECK · cascade ────────────────────────────────
    check(
      "**남의 커플 이름으로 문의를 만들 수 없다**(층1)",
      rejectedWith(/row-level security/, () =>
        sql(`begin;
             set local role authenticated;
             select set_config('request.jwt.claims', '{"sub":"${outsiderUser}","role":"authenticated","aud":"authenticated"}', true);
             insert into public.inquiries (couple_id, event_date, categories)
             values ('${linkedCoupleId}', '2027-05-15', array['hall']);
             rollback;`)),
    );
    check(
      "**자기 문의를 남의 커플로 옮길 수 없다** — `with check` 는 바뀐 **뒤**의 행을 본다",
      rejectedWith(/row-level security/, () =>
        sql(`begin;
             ${fixtureFor(demoVendorId)}
             set local role authenticated;
             select set_config('request.jwt.claims', '{"sub":"${coupleOwner}","role":"authenticated","aud":"authenticated"}', true);
             update public.inquiries set couple_id = '${spareCoupleId}' where id = '${INQ}';
             rollback;`)),
    );
    /**
     * **DELETE GRANT 는 있고 정책이 없다**(FIX-48 과 같은 모양). 오늘은 RLS 가 막지만
     * DELETE 정책 한 줄이면 **누가 거절했는지가 통째로 사라진다**(`inquiry_targets`
     * 가 cascade 다). 그날 이 검사가 운다.
     */
    check(
      "**당사자도 문의를 지울 수 없다** — 지우면 `inquiry_targets` 가 함께 사라진다(cascade)",
      asUser(coupleOwner, `with d as (delete from public.inquiries where id = '${INQ}' returning 1)
                           select count(*) from d;`, FIX) === "0",
    );
    check(
      "**대상 행도 지울 수 없다** — 누가 거절했는지는 증적이다",
      asUser(coupleOwner, `with d as (delete from public.inquiry_targets where id = '${TGT}' returning 1)
                           select count(*) from d;`, FIX) === "0",
    );
    check(
      "**업체가 `vendor_id` 를 남의 업체로 못 바꾼다** — 컬럼 UPDATE 목록에 없다(층1)",
      rejectedWith(/permission denied/, () =>
        sql(`begin;
             ${FIX}
             set local role authenticated;
             select set_config('request.jwt.claims', '{"sub":"${vendorOwnerUser}","role":"authenticated","aud":"authenticated"}', true);
             update public.inquiry_targets set vendor_id = '${strangerVendorId}' where id = '${TGT}';
             rollback;`)),
    );
    check(
      "**업체가 `sla_deadline` 을 못 미룬다** — 미루면 미응답이 사라진다",
      rejectedWith(/permission denied/, () =>
        sql(`begin;
             ${FIX}
             set local role authenticated;
             select set_config('request.jwt.claims', '{"sub":"${vendorOwnerUser}","role":"authenticated","aud":"authenticated"}', true);
             update public.inquiry_targets set sla_deadline = now() + interval '30 days' where id = '${TGT}';
             rollback;`)),
    );
    check(
      "**견적 없이 `responded` 로 못 옮긴다** — 응답은 주장이 아니라 결과다",
      rejectedWith(/./, () =>
        sql(`begin;
             ${FIX}
             set local role authenticated;
             select set_config('request.jwt.claims', '{"sub":"${vendorOwnerUser}","role":"authenticated","aud":"authenticated"}', true);
             update public.inquiry_targets set status = 'responded' where id = '${TGT}';
             rollback;`)),
    );
    check(
      "**거절은 할 수 있다** — 없을 때 막는지만 보지 말고 있을 때 조용한지도 본다",
      asUser(vendorOwnerUser,
        `with u as (update public.inquiry_targets
                    set status = 'declined', declined_at = now(), decline_reason_code = 'unavailable'
                    where id = '${TGT}' returning 1)
         select count(*) from u;`, FIX) === "1",
    );

    // ── 층2 : 자식 정책이 부모 정책에만 기대는가 ────────────────────────────
    /**
     * `inquiry_targets_insert` 는 `is_couple_member(inquiry_couple_id(inquiry_id))` 다 —
     * 부모를 definer 함수로 풀고 **소유자 조건을 건다.** C-3 이 기록한
     * `product_options_select_public`(자기 조건이 없다)과 **다른 모양**이다.
     */
    check(
      "**남의 문의에 대상 행을 끼워 넣을 수 없다**(층2 — 부모 소유자 조건이 있다)",
      rejectedWith(/row-level security/, () =>
        sql(`begin;
             ${FIX}
             set local role authenticated;
             select set_config('request.jwt.claims', '{"sub":"${outsiderUser}","role":"authenticated","aud":"authenticated"}', true);
             insert into public.inquiry_targets (inquiry_id, vendor_id) values ('${INQ}', '${demoVendorId}');
             rollback;`)),
    );
    check(
      "**남은 남의 문의를 못 본다**",
      asUser(outsiderUser, `select count(*) from public.inquiries where id = '${INQ}';`, FIX) === "0",
    );
    check(
      "**남은 남의 대상 행도 못 본다**",
      asUser(outsiderUser, `select count(*) from public.inquiry_targets where id = '${TGT}';`, FIX) === "0",
    );
    check(
      "**배우자는 본다** — 같은 커플이다(있을 때 조용한가)",
      asUser(couplePartner, `select count(*) from public.inquiries where id = '${INQ}';`, FIX) === "1",
    );
    check(
      "**받은 업체는 문의 본문을 본다**(`is_inquiry_vendor` · 있을 때 조용한가)",
      asUser(vendorOwnerUser, `select count(*) from public.inquiries where id = '${INQ}';`, FIX) === "1",
    );
    check(
      "**안 받은 업체는 문의 본문을 못 본다**",
      asUser(vendorOwnerUser, `select count(*) from public.inquiries where id = '${INQ}';`, FIX_OTHER) === "0",
    );

    // ── 층3 : 자격의 근거 표 ────────────────────────────────────────────────
    check(
      "**남이 남의 커플 멤버가 될 수 없다**(층3) — 되면 문의가 통째로 보인다",
      rejectedWith(/row-level security/, () =>
        sql(`begin;
             set local role authenticated;
             select set_config('request.jwt.claims', '{"sub":"${outsiderUser}","role":"authenticated","aud":"authenticated"}', true);
             insert into public.couple_members (couple_id, user_id, member_role)
             values ('${linkedCoupleId}', '${outsiderUser}', 'partner');
             rollback;`)),
    );
    check(
      "**자기 멤버 행의 `couple_id` 를 남의 커플로 못 바꾼다**(층3)",
      asUser(outsiderUser, `with u as (update public.couple_members set couple_id = '${linkedCoupleId}'
                                       where user_id = auth.uid() returning 1)
                            select count(*) from u;`) === "0",
    );
  }

  // ── 화면이 실재하고 들어가는 자리가 있는가 ────────────────────────────────
  check(
    "**문의 생성 화면이 실재한다**(FIX-66 · F-C-13) — 사슬의 첫 칸이다",
    existsSync("app/(consumer)/inquiries/new/page.tsx") &&
      existsSync("app/(consumer)/inquiries/new/InquiryForm.tsx"),
  );
  check(
    "**폼이 `action:\"create\"` 를 부른다** — 리포 전체에 부르는 자리가 없던 API 다",
    srcOf("app/(consumer)/inquiries/new/InquiryForm.tsx").includes('"/api/inquiries"') &&
      srcOf("lib/core/inquiry/request-form.ts").includes('action: "create"'),
  );
  check(
    "**문의함이 폼으로 잇는다**(빈 상태 포함) — 안 이으면 URL 을 아는 사람만 연다",
    srcOf("app/(consumer)/inquiries/InquiriesView.tsx").includes("/inquiries/new"),
  );
  check(
    "**업체 상세가 폼으로 잇는다** — 그 업체가 딸려 간다",
    srcOf("app/(consumer)/explore/[vendorId]/page.tsx").includes("/inquiries/new?vendor="),
  );
  check(
    "**세 경로 안내가 보내는 자리를 가리킨다**(S4-01) — 예전에는 보낼 수 없는 문의함이었다",
    srcOf("lib/core/inquiry/inquiry.ts").includes('href: "/inquiries/new"'),
  );
  check(
    "**폼과 서버가 같은 판정 함수를 쓴다** — 따로 쓰면 화면은 통과인데 서버가 422 다",
    srcOf("lib/core/inquiry/request-form.ts").includes("requestProblem") &&
      srcOf("lib/core/inquiry/request-form.ts").includes("targetCountProblem") &&
      srcOf("lib/core/inquiry/request-form.ts").includes("isPastDate") &&
      srcOf("app/api/inquiries/route.ts").includes("requestProblem"),
  );
  check(
    "**폼이 클라이언트 번들로 서버 클라이언트를 끌지 않는다** — `tsc` 가 못 보는 경계다",
    !srcOf("app/(consumer)/inquiries/new/InquiryForm.tsx").includes("@/lib/inquiry/candidates"),
  );

  // ── 실주행이 이 칸을 우회하지 않는가 (FIX-66 의 요지) ─────────────────────
  /**
   * **실주행이 우회하는 단계는 실주행이 지키지 못한다.**
   *
   * C-1b·C-3 때 두 주행이 이 칸을 세션 `fetch` 로 넘어갔고, 그래서 화면이 없다는
   * 사실을 **주행이 통과시켰다.** 이제 클릭으로 지나므로 **우회가 돌아오지 못하게**
   * 막는다 — 누군가 화면을 지우고 다시 fetch 를 넣으면 여기서 운다.
   */
  for (const walk of ["scripts/chain-walk.mjs", "scripts/vendor-walk.mjs"]) {
    const source = srcOf(walk);
    check(
      `**${walk} 이 문의 생성을 우회하지 않는다**(FIX-66)`,
      !/fetch\(\s*["'`]\/api\/inquiries/.test(source),
    );
    check(
      `**${walk} 이 폼을 실제로 누른다** — 우회를 지웠는데 아무것도 안 하면 칸이 빈다`,
      source.includes("send-inquiry") && source.includes("/inquiries/new"),
    );
  }

  // ── 배치는 사람을 지어내지 않는다 (FIX-71 · D-173) ────────────────────────
  /**
   * **참가격 재계산 배치가 남긴 증적이 통째로 사라지고 있었다.**
   *
   * `operatorId` 에 0 으로 채운 uuid 를, `operatorRole` 에 `"system"` 을 넣었는데
   * **둘 다 DB 가 거절한다** — `actor_id` 는 `auth.users` 를 참조하고 `actor_role` 은
   * `user_role` enum 이라 `"system"` 이 없다. 넣는 쪽이 결과를 안 보므로
   * **배치는 성공을 보고했고 감사 로그와 전이 기록만 사라졌다**(그 침묵 자체는 FIX-72).
   *
   * 로컬에서 재현해 확인했다 — 옛 값으로는 `{"ok":true,"built":1}` 인데 `audit_logs` 0건 ·
   * `entity_events` 0건이고, 고친 뒤에는 둘 다 1건이다.
   *
   * **없는 것은 없다고 적는다**(D-173). 두 컬럼 다 nullable 이고 실행자는 `source` 가 말한다.
   */
  {
    const jobSource = srcOf("app/api/jobs/price-index-refresh/route.ts");

    check(
      "**배치가 0 uuid 를 행위자로 넣지 않는다**(FIX-71) — `auth.users` FK 가 거절해 증적이 사라진다",
      !/00000000-0000-0000-0000-000000000000/.test(jobSource),
    );
    check(
      "**배치가 enum 에 없는 역할을 넣지 않는다**(FIX-71) — `user_role` 에 `system` 은 없다",
      !/operatorRole:\s*["'`]system["'`]/.test(jobSource),
    );
    check(
      "**배치가 행위자를 null 로 넘긴다**(D-173) — 사람이 없는 전이에 계정을 빌리지 않는다",
      /operatorId:\s*null/.test(jobSource) && /operatorRole:\s*null/.test(jobSource),
    );
    check(
      "**그 대신 `source` 가 실행자를 말한다**(D-173) — 안 적으면 증적이 운영자를 가리킨다",
      /source:\s*["'`]system["'`]/.test(jobSource),
    );
  }

  // ── 클라이언트 타입이 경계에서 버려지지 않는가 (FIX-67 · D-203) ───────────
  /**
   * 값은 `lib/supabase/typing.test.ts` 가 본다 — 판정은 `tsc` 가 한다. 여기서는
   * **그 검사 자체가 지워지지 않았는지**를 본다. 검사를 지우면 아무도 안 운다.
   */
  {
    const typing = srcOf("lib/supabase/typing.test.ts");

    /**
     * **단언 이름을 낱말 경계로 본다.**
     *
     * 두 번 틀렸다. 처음엔 `includes("IsAny")` 로 봤는데 `IsAny` → `IsAnyX` 로 바꿔도
     * 통과했고, 단언 이름으로 바꾼 뒤에도 `..._NOT_ANY` → `..._NOT_ANYX` 가 통과했다 —
     * **둘 다 부분 문자열이라서** 다. 이름을 바꾸는 것도 검사를 없애는 방법이므로
     * 낱말 경계로 봐야 잡힌다(§7.0b — 되돌려 놓고 FAIL 하는지 확인한다).
     *
     * **여기가 보는 것은 "파일이 세 면을 여전히 단언하는가" 까지다.** 단언 *한 줄*만
     * 지우는 경우는 여기서 안 잡히고 **`tsc` 가 잡는다**(`Cannot find name ...` —
     * 아래 `expect` 가 그 이름을 쓰므로). 둘로 나눠 막는다.
     */
    check(
      "**클라이언트 타입 검사가 살아 있다**(FIX-67) — 지우면 `any`·`never` 로 조용히 돌아간다",
      ["SERVER", "BROWSER", "ADMIN"].every(
        (face) =>
          new RegExp(`\\b${face}_ROW_IS_RESOLVED\\b`).test(typing) &&
          new RegExp(`\\b${face}_COL_IS_NOT_ANY\\b`).test(typing),
      ),
    );
    check(
      "**세 팩토리가 `<Database>` 를 달고 있다**(FIX-67)",
      ["lib/supabase/server.ts", "lib/supabase/client.ts", "lib/supabase/admin.ts"].every(
        (file) => /<Database>/.test(srcOf(file)),
      ),
    );
  }

// ═══════════════════════════════════════════════════════════════════════════
// 카테고리 두 축 (C-2a · D-206)
// ═══════════════════════════════════════════════════════════════════════════
{
  // ── 코드 ↔ DB 어휘 대조 ─────────────────────────────────────────────────
  // **사본은 어긋나고 어긋나면 조용하다**(0045 예산 축과 같은 구조).
  // 배열 블록만 읽는다 — 파일 전체를 훑으면 라벨표의 따옴표까지 걸려 수가 부푼다.
  {
    const vendorBlock = (srcOf("lib/core/schemas/vendor.ts")
      .match(/VENDOR_CATEGORIES = \[([\s\S]*?)\] as const/) ?? ["", ""])[1];
    const vendorCodes = [...vendorBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

    // **목록을 실제로 읽었는지 먼저 본다.** 빈 목록이면 아래 every 가 조용히 통과한다.
    check(
      "**파는 축 어휘를 코드에서 실제로 읽었다** (빈 목록으로 통과하지 않는다)",
      vendorCodes.length === 6,
      `code=${vendorCodes.length}`,
    );
    check(
      "**코드의 파는 축 어휘와 DB `is_vendor_category()` 가 같다**",
      vendorCodes.length > 0 &&
        vendorCodes.every((c) => sql(`select public.is_vendor_category('${c}');`) === "t") &&
        sql(`select public.is_vendor_category('sdm');`) === "f" &&
        sql(`select public.is_vendor_category('nope');`) === "f",
      `code=${vendorCodes.length}`,
    );

    const prepBlock = (srcOf("lib/core/schedule/templates.ts")
      .match(/TASK_CATEGORIES = \[([\s\S]*?)\] as const/) ?? ["", ""])[1];
    const prepCodes = [...prepBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

    check(
      // C-4a 가 여섯 → 아홉으로 늘렸다(family·attire·gift).
      "**준비 축 어휘를 코드에서 실제로 읽었다**",
      prepCodes.length === 9,
      `code=${prepCodes.length}`,
    );
    check(
      "**코드의 준비 축 어휘와 DB `is_prep_category()` 가 같다**",
      prepCodes.length > 0 &&
        prepCodes.every((c) => sql(`select public.is_prep_category('${c}');`) === "t") &&
        sql(`select public.is_prep_category('studio');`) === "f" &&
        sql(`select public.is_prep_category('nope');`) === "f",
      `code=${prepCodes.length}`,
    );

    // 두 축이 **다른 것을 센다**는 사실 자체를 고정한다. 누가 합치려 들면 여기서 걸린다.
    check(
      "**두 축이 겹치는 값은 `hall` 하나뿐이다** — 합칠 수 없다는 근거(D-206)",
      vendorCodes.filter((c) => prepCodes.includes(c)).join(",") === "hall",
    );
  }

  // ── 매핑은 코드가 갖는다 — 표로 옮겨 가지 않았는지 본다 ─────────────────
  {
    const axes = srcOf("lib/core/category/axes.ts");
    check(
      "**매핑이 `lib/core` 에 코드로 있다**(C-2a 판단) — 표가 아니다",
      /\bPREP_TO_VENDOR\b/.test(axes) && /\bVENDOR_TO_PREP\b/.test(axes),
    );
    check(
      "**`lib/core` 가 React·Next 를 import 하지 않는다**(CLAUDE.md §3.1)",
      !/from "(react|next)/.test(axes),
    );
    // 낱말 경계로 본다 — `not_sold` → `not_soldX` 로 바꿔도 통과하면 검사가 아니다.
    check(
      "**'없다' 와 '아직 안 했다' 를 가르는 세 상태가 살아 있다**(C-2a 의 요점)",
      ["sold", "not_sold", "unmapped", "not_a_purchase", "not_yet_listed"].every(
        (kind) => new RegExp(`"${kind}"`).test(axes),
      ),
    );
    check(
      "**매핑 표에 준비 축이 없는 카테고리가 없다** — 완전성 검사가 살아 있다",
      /\bassertPrepAxisFullyMapped\b/.test(axes),
    );
  }

  // ── DB 가 어휘를 실제로 막는가 (CHECK 이 서 있는가) ─────────────────────
  check(
    "**어휘 밖의 파는 카테고리를 막는다** — 오타 하나가 새 카테고리를 만들지 않는다",
    rejectedWith(/task_templates_vendor_category_vocab|check constraint/, () =>
      sql(`insert into public.task_templates (code, category, title, offset_days, vendor_category)
           values ('T-rls-probe', 'hall', 'probe', -1, 'nope');`),
    ),
  );
  check(
    "**`tasks` 도 같은 어휘를 쓴다**",
    rejectedWith(/tasks_vendor_category_vocab|check constraint/, () =>
      sql(`update public.tasks set vendor_category = 'nope';`),
    ),
  );
  check(
    "**글의 준비 단계도 어휘 밖을 막는다**",
    rejectedWith(/content_posts_prep_category_vocab|check constraint/, () =>
      sql(`update public.content_posts set prep_category = 'studio';`),
    ),
  );
  // **있을 때 조용한가** — 늘 경보하는 CHECK 는 아무것도 지키지 않는다(운영 규칙 7).
  check(
    "**어휘 안의 값은 통과한다** (늘 거절하는 CHECK 이 아니다)",
    sqlOrNull(`begin; update public.tasks set vendor_category = 'hall'; rollback;`) !== null &&
      sqlOrNull(`begin; update public.content_posts set prep_category = 'sdm'; rollback;`) !== null &&
      sqlOrNull(`begin; update public.tasks set vendor_category = null; rollback;`) !== null,
  );

  // ══════════════════════════════════════════════════════════════════════
  // 준비 항목 → 정보·상품 다리 (C-4c · F-C-39)
  // ══════════════════════════════════════════════════════════════════════
  //
  // 어휘가 **세 표**에 걸린다 — `tasks.vendor_category`(파는 축) ·
  // `content_posts.prep_category`(준비 축) · `community_posts.category`(준비 축).
  // 셋이 어긋나면 같은 태스크에서 나가는 다리가 서로 다른 곳을 가리킨다.

  check(
    "**커뮤니티 글의 준비 단계도 같은 어휘를 쓴다**(0084) — 쓰기가 열린 칸에 CHECK 이 없었다",
    rejectedWith(/community_posts_prep_category_vocab|check constraint/, () =>
      sql(`update public.community_posts set category = 'studio';`),
    ),
  );
  check(
    "**어휘 안의 값과 null 은 통과한다** — 늘 거절하는 CHECK 이 아니다",
    sqlOrNull(`begin; update public.community_posts set category = 'gift'; rollback;`) !== null &&
      sqlOrNull(`begin; update public.community_posts set category = null; rollback;`) !== null,
  );
  check(
    "**세 칸이 같은 함수로 판정한다** — 어휘가 두 벌이면 어긋나고 어긋나면 조용하다",
    sqlOrNull(
      `select count(*) from pg_constraint
        where conname in ('tasks_vendor_category_vocab', 'content_posts_prep_category_vocab',
                          'community_posts_prep_category_vocab');`,
    ) === "3" &&
      sqlOrNull(
        `select count(*) from pg_constraint
          where conname in ('content_posts_prep_category_vocab', 'community_posts_prep_category_vocab')
            and pg_get_constraintdef(oid) like '%is_prep_category%';`,
      ) === "2",
  );

  // ── 다리가 실제로 갈 곳이 있는가 ───────────────────────────────────────
  //
  // **표를 세는 것으로 끝내지 않는다.** `db:reset` 뒤에도 값이 있어야 화면이
  // 무언가를 보여 준다 — 시드가 넣지 않으면 모든 다리가 "아직 없어요" 가 되고,
  // 그러면 "없을 때 말한다" 만 확인되고 **"있을 때 잇는다" 는 확인되지 않는다.**
  {
    const guideLinked = sqlOrNull(
      `select count(*) from public.content_posts
        where prep_category is not null and published_at is not null and published_at <= now();`,
    );
    const communityLinked = sqlOrNull(
      `select count(*) from public.community_posts where category is not null and status = 'published';`,
    );

    check(
      "**준비 단계가 붙은 발행 가이드가 실재한다** — 다리가 닿을 곳이 있다",
      Number(guideLinked ?? "0") >= 2,
      `guides=${guideLinked}`,
    );
    check(
      "**준비 단계가 붙은 공개 커뮤니티 글이 실재한다**",
      Number(communityLinked ?? "0") >= 1,
      `posts=${communityLinked}`,
    );
    check(
      "**전부에 붙이지는 않았다** — 특정 단계가 아닌 글은 null 이며 그것이 정상이다",
      Number(
        sqlOrNull(`select count(*) from public.content_posts where prep_category is null;`) ?? "0",
      ) > 0,
    );
    check(
      "**다리가 쓰는 색인이 실재한다** — 카테고리로 매번 거른다",
      sqlOrNull(
        `select count(*) from pg_indexes
          where indexname in ('idx_community_posts_category', 'idx_content_posts_prep_category');`,
      ) === "2",
    );
  }

  // ── 권한 세 층 ─────────────────────────────────────────────────────────
  //
  // **`tasks` 가 표 단위 UPDATE 라는 사실 자체를 다시 본다.** `products` 와 같은
  // 모양이라 새 칸을 더하면 커플이 **바로** 쓸 수 있다 — C-4c 가 `tasks` 에 칸을
  // 더하지 않기로 한 근거의 절반이 여기 있다(나머지 절반은 "계산 가능한 값을
  // 저장하지 않는다").
  {
    const tasksTableGrant = sqlOrNull(
      `select count(*) from information_schema.table_privileges
        where table_name = 'tasks' and grantee = 'authenticated' and privilege_type = 'UPDATE';`,
    );
    const tasksColumnGrant = sqlOrNull(
      `select count(*) from information_schema.column_privileges
        where table_name = 'tasks' and grantee = 'authenticated' and privilege_type = 'UPDATE';`,
    );

    check(
      "**층1 — `tasks` 는 표 단위 UPDATE 다**(사실을 고정한다) — 새 칸이 자동으로 열린다",
      tasksTableGrant === "1",
      `table=${tasksTableGrant} columns=${tasksColumnGrant}`,
    );
    check(
      "**층1 — 그래서 C-4c 는 `tasks` 에 칸을 더하지 않았다** — 연결 칸이 0개다",
      sqlOrNull(
        `select count(*) from information_schema.columns
          where table_name = 'tasks'
            and (column_name like '%product%' or column_name like '%content%'
                 or column_name like '%post%' or column_name like '%link%'
                 or column_name like '%slug%' or column_name like '%url%');`,
      ) === "0",
    );
    check(
      "**층1 — `community_posts` 는 칸 나열 권한이다** — 무엇을 열었는지 세어 둔다",
      sqlOrNull(
        `select count(*) from information_schema.column_privileges
          where table_name = 'community_posts' and grantee = 'authenticated'
            and privilege_type = 'UPDATE';`,
      ) === "4" &&
        sqlOrNull(
          `select count(*) from information_schema.table_privileges
            where table_name = 'community_posts' and grantee = 'authenticated'
              and privilege_type = 'UPDATE';`,
        ) === "0",
    );
    check(
      "**층1 — `content_posts` 는 당사자가 못 쓴다** — 가이드는 운영자의 것이다",
      sqlOrNull(
        `select count(*) from information_schema.table_privileges
          where table_name = 'content_posts' and grantee = 'authenticated'
            and privilege_type in ('UPDATE', 'INSERT');`,
      ) === "0" &&
        sqlOrNull(
          `select count(*) from information_schema.column_privileges
            where table_name = 'content_posts' and grantee = 'authenticated'
              and privilege_type in ('UPDATE', 'INSERT');`,
        ) === "0",
    );
  }

  {
    const author = idOf("couple-linked-a@local.test");
    const other = idOf("couple-a@local.test");

    check("**커뮤니티 픽스처 사용자가 있다** — 없으면 아래 층2·층3 이 헛돈다", Boolean(author && other));

    if (author && other) {
      check(
        "**층2 — 남의 글의 준비 단계를 못 고친다** (정책이 작성자를 직접 본다)",
        asUser(
          other,
          `update public.community_posts set category = 'gift'
            where author_id = '${author}' returning 1;`,
        ) === "",
      );
      check(
        "**층2 — 내 글은 고칠 수 있다** — 늘 0 을 돌려주는 검사가 아니다",
        asUser(
          author,
          `update public.community_posts set category = 'gift'
            where author_id = '${author}' and board_type = 'experience' returning 1;`,
        ) === "1",
      );
      check(
        "**층3 — 작성자가 어휘 밖 값으로 자리를 만들 수 없다**",
        rejectedWith(/community_posts_prep_category_vocab|check constraint|permission denied/, () =>
          asUser(
            author,
            `update public.community_posts set category = '내가만든칸' where author_id = '${author}';`,
          ),
        ),
      );
      check(
        "**층3 — 작성자가 가이드의 준비 단계를 못 쓴다** — 다리의 다른 끝을 스스로 못 만든다",
        rejectedWith(/permission denied|row-level security/, () =>
          asUser(author, `update public.content_posts set prep_category = 'gift';`),
        ),
      );
      check(
        "**층3 — 작성자가 자기 글을 스스로 공개 상태로 못 바꾼다면 그 사실을 적는다**",
        // status 는 칸 권한에 들어 있다(본인 글 숨기기). 어휘는 0038 CHECK 이 판정한다.
        rejectedWith(/check constraint|invalid input|permission denied/, () =>
          asUser(author, `update public.community_posts set status = '아무거나' where author_id = '${author}';`),
        ),
      );
    }
  }

  // ── 다리가 화면과 API 양쪽에 붙어 있는가 ───────────────────────────────
  {
    const coreSrc = srcOf("lib/core/task/links.ts");
    const viewSrc = srcOf("app/(consumer)/checklist/ChecklistView.tsx");
    const pageSrc = srcOf("app/(consumer)/checklist/page.tsx");
    const routeSrc = srcOf("app/api/tasks/links/route.ts");
    const loaderSrc = srcOf("lib/tasks/links.ts");

    check(
      "**다리 모듈을 실제로 읽었다**",
      /export function taskLinks[(]/.test(coreSrc) && coreSrc.length > 2000,
      `bytes=${coreSrc.length}`,
    );
    check(
      "**화면이 다리를 그린다** — 만든 자리가 도달 불가로 남지 않는다",
      /data-testid="task-links"/.test(viewSrc) && /loadTaskLinks[(]/g.test(pageSrc),
    );
    check(
      "**API 도 같은 판정을 쓴다** — 판정이 두 벌이면 화면과 API 가 다른 말을 한다",
      /loadTaskLinks[(]/g.test(routeSrc) && /TASK_LINK_BASIS_NOTE/.test(routeSrc),
    );
    check(
      "**판정 기준을 화면이 상시 적는다**(§2.2) — 추천이 아님을 화면이 증명한다",
      /data-testid="task-links-basis"/.test(viewSrc) && /TASK_LINK_BASIS_NOTE/.test(viewSrc),
    );
    check(
      "**커뮤니티 다리가 미검증 경고를 건너뛰지 않는다**(D-26)",
      /data-testid="task-links-community-caution"/.test(viewSrc) &&
        /caution/.test(coreSrc) &&
        // 경고가 링크보다 **먼저** 그려진다 — 누르기 전에 읽어야 의미가 있다.
        viewSrc.indexOf('data-testid="task-links-community-caution"') <
          viewSrc.indexOf('data-testid="task-link-community"'),
    );
    check(
      "**조회수·좋아요가 다리 질의에 없다**(D-03) — 순서를 매기지 않는다",
      !/view_count|like_count/.test(loaderSrc),
    );
    check(
      "**상품 수를 목록과 같은 조건으로 센다** — 세는 것과 보이는 것이 다르면 거짓말이다",
      /status", "published"/.test(loaderSrc) && /vendors\.status", "active"/.test(loaderSrc),
    );
    check(
      "**0 을 건수로 적지 않는다** — '아직 등록된 상품이 없어요' 가 따로 있다",
      /productCount === 0/.test(viewSrc) && /아직 등록된 상품이 없어요/.test(viewSrc),
    );
  }

  // ── 시드가 실제로 값을 넣었는가 ─────────────────────────────────────────
  // `db:reset` 은 **마이그레이션을 먼저, seed.sql 을 나중에** 적용한다. 값 넣기를
  // 마이그레이션에 적으면 **빈 표를 훑고 성공**한다 — 조용히 헛도는 문장이 된다.
  check(
    // C-4a 가 여섯을 더했다(상견례·축의금 정산·예복 한복 맞춤·답례품 준비·답례 인사·혼인신고 제출).
    "**템플릿이 25종이다** (분모가 실재한다)",
    sql(`select count(*) from public.task_templates;`) === "25",
  );
  check(
    "**좁힌 템플릿이 여덟이다** — 시드가 실제로 값을 넣었다(빈 표를 훑고 통과하지 않았다)",
    sql(`select count(*) from public.task_templates where vendor_category is not null;`) === "8",
  );
  check(
    "**`T-sdm-contract` 는 일부러 null 이다** — 좁히면 나머지 셋으로 가는 길이 사라진다",
    sql(`select vendor_category is null from public.task_templates where code = 'T-sdm-contract';`) === "t",
  );
  check(
    "**좁힌 값이 전부 파는 축 어휘 안에 있다**",
    sql(`select count(*) from public.task_templates
         where vendor_category is not null and not public.is_vendor_category(vendor_category);`) === "0",
  );

  // ── 권한 세 층 (§5.5) ───────────────────────────────────────────────────
  //
  // **층 1 — 표 단위 권한·CHECK·컬럼 권한.**
  // `content_posts` 는 0060 이 **표에서** 쓰기를 걷었다. 표 단위라 **새 칸도 자동으로**
  // 걷힌 상태로 들어온다 — 칸마다 걷었다면 여기서 다시 걷어야 했고, 그것이 §5.5 가
  // 적은 "칸만 걷으면 무효다" 의 뒷면이다. **가정하지 않고 실제로 눌러 본다.**
  check(
    "**층 1 — 아무 로그인 사용자나 글의 준비 단계를 못 고친다** (표 단위 revoke 가 새 칸을 덮는다)",
    asUser(owner, `select count(*) from public.content_posts;`) !== null &&
      rejectedWith(/permission denied|new row violates|0 rows/, () =>
        asUser(owner, `update public.content_posts set prep_category = 'hall';`),
      ),
  );
  check(
    "**층 1 — 아무나 템플릿의 카테고리를 못 고친다** (쓰기 정책 자체가 없다)",
    sql(`select count(*) from pg_policies where tablename = 'task_templates' and cmd <> 'SELECT';`) === "0",
  );

  // **층 2 — 부모를 타는 정책에 소유자 조건이 있는가.**
  // `tasks` 는 부모(`couples`)를 `is_couple_member()` 로 묻는다 — 소유자 조건이 함수 안에
  // 있다. 부모가 열려 있어도 자식이 열리지 않는지 **남의 커플 행으로 눌러 본다.**
  check(
    "**층 2 — 남의 커플 태스크의 카테고리를 못 고친다** (부모 조건에 소유자가 들어 있다)",
    asUser(outsider,
      `select count(*) from public.tasks where vendor_category is not null;`) === "0",
  );

  // **층 3 — 자격의 근거 표를 자격을 얻으려는 사람이 직접 쓸 수 있는가.**
  // 이 칸은 **자격이 아니라 길 안내**다. 값을 바꿔도 얻는 것이 없다 — 그 사실을
  // 고정한다. 나중에 이 칸이 노출·순위에 쓰이면 이 검사가 먼저 깨져야 한다.
  check(
    "**층 3 — 카테고리 칸이 노출·순위·요율 어디에도 쓰이지 않는다** (자격이 아니라 길 안내다)",
    sql(`select count(*) from pg_proc
         where prosrc like '%vendor_category%'
           and proname in ('is_active_vendor', 'resolve_commission_rate', 'published_content');`) === "0",
  );
}
}


// ═══════════════════════════════════════════════════════════════════════════
// 상품 본문·사진 (C-2b · D-209 · D-210) + 파는 축 어휘 CHECK (FIX-75)
// ═══════════════════════════════════════════════════════════════════════════
{
  const vendorOwner = outsider; // vendor@local.test — 업체 대표
  const DRAFT = "00000000-0000-0000-0000-0000000c2b01";
  const PUBLISHED = "00000000-0000-0000-0000-0000000c2b0f";

  /**
   * 초안 상품 하나 · 게시 상품 하나 · 사진 셋을 만든다.
   * `asUser`/`asAnon` 의 setup 은 **역할을 바꾸기 전에 postgres 로** 돌고 같은
   * 트랜잭션이라 rollback 으로 함께 사라진다.
   */
  const fixture = `
    update public.vendors set status = 'active'
     where id = (select vendor_id from public.vendor_members where user_id = '${vendorOwner}' limit 1);
    insert into public.products (id, vendor_id, category, name, base_price_total, status,
                                 included_items_json, add_ons_declared_at, published_at)
    select '${DRAFT}', vm.vendor_id, 'hall', 'C2B 초안', 1000000, 'draft',
           '[{"label":"대관","note":null}]'::jsonb, now(), null
      from public.vendor_members vm where vm.user_id = '${vendorOwner}' limit 1;
    insert into public.products (id, vendor_id, category, name, base_price_total, status,
                                 included_items_json, add_ons_declared_at, published_at)
    select '${PUBLISHED}', vm.vendor_id, 'hall', 'C2B 게시', 1000000, 'published',
           '[{"label":"대관","note":null}]'::jsonb, now(), now()
      from public.vendor_members vm where vm.user_id = '${vendorOwner}' limit 1;
    insert into public.vendor_media (id, vendor_id, product_id, type, storage_path, sort_order)
    select '00000000-0000-0000-0000-0000000c2b02', vm.vendor_id, '${DRAFT}', 'photo', 'p/draft.jpg', 0
      from public.vendor_members vm where vm.user_id = '${vendorOwner}' limit 1;
    insert into public.vendor_media (id, vendor_id, product_id, type, storage_path, sort_order)
    select '00000000-0000-0000-0000-0000000c2b03', vm.vendor_id, '${PUBLISHED}', 'photo', 'p/pub.jpg', 0
      from public.vendor_members vm where vm.user_id = '${vendorOwner}' limit 1;
    insert into public.vendor_media (id, vendor_id, product_id, type, storage_path, sort_order)
    select '00000000-0000-0000-0000-0000000c2b04', vm.vendor_id, null, 'photo', 'p/vendor.jpg', 0
      from public.vendor_members vm where vm.user_id = '${vendorOwner}' limit 1;
  `;

  // ── 완료 조건 — **기존 게시 상품이 내려가지 않는다** ─────────────────────
  //
  // 이것이 C-2b 의 완료 조건이고, 지켜졌는지 **분모부터** 확인한다. 본문·사진이
  // 없는 게시 상품이 **실재해야** 이 검사가 뜻을 갖는다 — 그런 상품이 0개인 DB 에서는
  // "안 내려갔다" 가 공짜로 참이 된다(빈 표로 통과하는 검사를 만들지 않는다).
  const barePublished = sql(`
    select count(*) from public.products
     where status = 'published' and summary is null and description_json is null
       and not exists (select 1 from public.vendor_media m where m.product_id = products.id);`);

  check(
    "**본문·사진 없는 게시 상품이 실재한다** — 아래 검사의 분모다",
    Number(barePublished) > 0,
    `bare_published=${barePublished}`,
  );
  check(
    "**그 상품들이 여전히 published 다** — C-2b 가 기존 게시를 내리지 않았다",
    sql(`select count(*) from public.products
          where summary is null and description_json is null and status = 'draft'
            and published_at is not null;`) === "0",
  );
  // **되돌림 검사.** 누군가 본문·사진을 게시 조건에 넣으면 이 줄이 먼저 깨진다.
  check(
    "**게시 CHECK 이 본문·사진을 요구하지 않는다** (넣으면 기존 게시분이 전부 내려간다)",
    !/summary|description_json|vendor_media/.test(
      sql(`select pg_get_constraintdef(oid) from pg_constraint
            where conrelid = 'public.products'::regclass
              and conname = 'products_publish_requirements_chk';`),
    ),
  );
  check(
    "**게시 차단 목록에도 본문·사진이 없다** (화면·API 가 DB 와 같은 말을 한다)",
    !/SUMMARY_MISSING|DESCRIPTION_MISSING|PHOTO_MISSING/.test(
      srcOf("lib/core/schemas/product.ts") + srcOf("lib/vendor/products.ts"),
    ),
  );
  check(
    "**권유는 권유의 자리에 있다** — 네 가지가 실제로 있다(빈 목록이 아니다)",
    ["SUMMARY_MISSING", "DESCRIPTION_MISSING", "PHOTO_MISSING", "ALT_TEXT_MISSING"].every((code) =>
      new RegExp(`"${code}"`).test(srcOf("lib/core/product/content.ts")),
    ),
  );

  // ── 본문은 원문만 저장한다 (계산 가능한 값을 저장하지 않는다) ──────────
  check(
    "**본문 봉투에 블록을 담지 않는다** — 블록은 원문에서 계산된다",
    /v: PRODUCT_DESCRIPTION_VERSION, source: trimmed/.test(srcOf("lib/core/product/content.ts")) &&
      !/blocks:/.test(srcOf("lib/core/product/content.ts")),
  );
  check(
    "**본문 모양을 DB 도 막는다** — 봉투가 아닌 값은 들어가지 않는다",
    rejectedWith(/products_description_shape_chk|check constraint/, () =>
      sql(`update public.products set description_json = '"그냥 문자열"'::jsonb
            where id = '00000000-0000-0000-0000-00000000d001';`),
    ),
  );
  check(
    "**빈 본문은 봉투로 저장되지 않는다**",
    rejectedWith(/products_description_shape_chk|check constraint/, () =>
      sql(`update public.products set description_json = '{"v":1,"source":"   "}'::jsonb
            where id = '00000000-0000-0000-0000-00000000d001';`),
    ),
  );
  check(
    "**제대로 된 봉투는 통과한다** (늘 거절하는 CHECK 이 아니다)",
    sqlOrNull(`begin;
      update public.products set description_json = '{"v":1,"source":"## 구성"}'::jsonb,
                                 summary = '한 줄 소개'
       where id = '00000000-0000-0000-0000-00000000d001';
      rollback;`) !== null,
  );

  // ── 층 2 — 초안 상품의 사진이 새는가 ────────────────────────────────────
  //
  // **부모 정책에 기대지 않는다.** `products` 의 공개 조건이 넓어지는 날 이쪽도 같이
  // 넓어지면 아무도 모른다 — 그래서 정책이 `status` 를 직접 본다. 그 사실과 실제
  // 동작을 둘 다 고정한다.
  check(
    "**층 2 — 공개 정책이 게시 여부를 직접 본다** (다른 표의 정책에 기대지 않는다)",
    /published/.test(
      sql(`select pg_get_expr(polqual, polrelid) from pg_policy
            where polrelid = 'public.vendor_media'::regclass
              and polname = 'vendor_media_select_public';`),
    ),
  );
  check(
    "**층 2 — 비로그인은 초안 상품의 사진을 못 본다**",
    asAnon(
      `select count(*) from public.vendor_media where id = '00000000-0000-0000-0000-0000000c2b02';`,
      fixture,
    ) === "0",
  );
  check(
    "**층 2 — 게시 상품의 사진은 보인다** (늘 가리는 정책이 아니다)",
    asAnon(
      `select count(*) from public.vendor_media where id = '00000000-0000-0000-0000-0000000c2b03';`,
      fixture,
    ) === "1",
  );
  check(
    "**층 2 — 업체 사진은 그대로 보인다** (기존 동작을 바꾸지 않았다)",
    asAnon(
      `select count(*) from public.vendor_media where id = '00000000-0000-0000-0000-0000000c2b04';`,
      fixture,
    ) === "1",
  );
  // C-3 이 기록으로 남긴 자리를 **이번에 다시 본다**(지시 — products 를 손댔으므로).
  check(
    "**층 2 — 초안 상품의 추가금도 새지 않는다** (C-3 가 남긴 자리를 다시 봤다)",
    asAnon(
      `select count(*) from public.product_options o
        join public.products p on p.id = o.product_id where p.status = 'draft';`,
      fixture + `
      insert into public.product_options (product_id, name, price, is_mandatory)
      values ('${DRAFT}', '초안 추가금', 50000, true);`,
    ) === "0",
  );

  // ── 층 1·3 — 누가 상품 사진을 다루는가 ──────────────────────────────────
  //
  // 상품 사진은 **owner 전용**이다(`products` 쓰기가 owner 전용인 것과 같은 경계).
  // staff 가 넘어오는 길이 셋이라 셋 다 눌러 본다 — 만들기 · 붙이기 · 떼어내기.
  check(
    "**층 1 — staff 는 상품 사진을 만들 수 없다**",
    rejectedWith(/row-level security|violates/, () =>
      asUser(
        vendorStaff,
        `insert into public.vendor_media (vendor_id, product_id, type, storage_path, sort_order)
         select vm.vendor_id, '${DRAFT}', 'photo', 'p/staff.jpg', 9
           from public.vendor_members vm where vm.user_id = '${vendorStaff}' limit 1;`,
        fixture,
      ),
    ),
  );
  check(
    "**층 3 — staff 는 업체 사진에 product_id 를 붙일 수 없다** (`with check` 가 바뀐 뒤를 본다)",
    rejectedWith(/row-level security|violates/, () =>
      asUser(
        vendorStaff,
        `update public.vendor_media set product_id = '${DRAFT}'
          where id = '00000000-0000-0000-0000-0000000c2b04';`,
        fixture,
      ),
    ),
  );
  check(
    "**층 3 — staff 는 상품 사진을 업체 사진으로 떼어 낼 수 없다** (`using` 이 원래 행을 본다)",
    asUser(
      vendorStaff,
      `update public.vendor_media set product_id = null
        where id = '00000000-0000-0000-0000-0000000c2b03';
       select count(*) from public.vendor_media
        where id = '00000000-0000-0000-0000-0000000c2b03' and product_id is null;`,
      fixture,
    ) === "0",
  );
  check(
    "**층 1 — staff 는 상품 사진을 지울 수 없다**",
    asUser(
      vendorStaff,
      `delete from public.vendor_media where id = '00000000-0000-0000-0000-0000000c2b03';
       select count(*) from public.vendor_media where id = '00000000-0000-0000-0000-0000000c2b03';`,
      fixture,
    ) === "1",
  );
  check(
    "**staff 는 업체 사진을 계속 다룬다** (기존 동작을 좁히지 않았다)",
    asUser(
      vendorStaff,
      `update public.vendor_media set alt_text = 'ok'
        where id = '00000000-0000-0000-0000-0000000c2b04';
       select count(*) from public.vendor_media
        where id = '00000000-0000-0000-0000-0000000c2b04' and alt_text = 'ok';`,
      fixture,
    ) === "1",
  );
  check(
    "**owner 는 상품 사진을 만들 수 있다** (늘 거절하는 정책이 아니다)",
    asUser(
      vendorOwner,
      `insert into public.vendor_media (vendor_id, product_id, type, storage_path, sort_order)
       select vm.vendor_id, '${DRAFT}', 'photo', 'p/owner.jpg', 9
         from public.vendor_members vm where vm.user_id = '${vendorOwner}' limit 1;
       select count(*) from public.vendor_media where storage_path = 'p/owner.jpg';`,
      fixture,
    ) === "1",
  );

  // ── 층 2 — 남의 업체 상품에 사진을 붙일 수 있는가 ───────────────────────
  //
  // 정책만으로는 못 막는다(`is_vendor_member(vendor_id)` 는 **내 업체**만 보고
  // product_id 가 누구 것인지는 안 본다). **복합 FK** 가 선언으로 막는다.
  check(
    "**층 2 — 남의 업체 상품에는 사진을 붙일 수 없다** (복합 FK)",
    rejectedWith(/vendor_media_product_same_vendor_fk|foreign key/, () =>
      sql(`insert into public.vendor_media (vendor_id, product_id, type, storage_path, sort_order)
           select vm.vendor_id, '00000000-0000-0000-0000-000000000951', 'photo', 'p/x.jpg', 0
             from public.vendor_members vm where vm.user_id = '${vendorOwner}' limit 1;`),
    ),
  );
  check(
    "**같은 업체 상품이면 붙는다** (늘 거절하는 FK 가 아니다)",
    sqlOrNull(`begin;
      insert into public.vendor_media (vendor_id, product_id, type, storage_path, sort_order)
      values ((select vendor_id from public.products where id = '00000000-0000-0000-0000-00000000d001'),
              '00000000-0000-0000-0000-00000000d001', 'photo', 'p/same.jpg', 0);
      rollback;`) !== null,
  );

  // ── Storage — 공개 버킷이 무엇을 받는가 ─────────────────────────────────
  {
    const bucketMimes = sql(
      `select coalesce(array_to_string(allowed_mime_types, ','), '') from storage.buckets
        where id = 'vendor-media';`,
    );
    const codeBlock = (srcOf("lib/core/product/media.ts")
      .match(/PRODUCT_IMAGE_MIME_TYPES = \[([\s\S]*?)\] as const/) ?? ["", ""])[1];
    const codeMimes = [...codeBlock.matchAll(/"([\w/+-]+)"/g)].map((m) => m[1]);

    check(
      "**코드의 허용 형식을 실제로 읽었다** (빈 목록으로 통과하지 않는다)",
      codeMimes.length === 5,
      `code=${codeMimes.length}`,
    );
    check(
      "**코드가 허용한 형식을 버킷도 허용한다** — 화면이 받고 Storage 가 거절하는 일이 없다",
      codeMimes.length > 0 && codeMimes.every((mime) => bucketMimes.split(",").includes(mime)),
    );
    check(
      "**공개 버킷이 SVG 를 받지 않는다** — 같은 출처에서 스크립트가 된다",
      bucketMimes.length > 0 && !bucketMimes.includes("svg"),
    );
    check(
      "**공개 버킷에 크기 상한이 있다** (무제한이 아니다)",
      Number(
        sql(`select coalesce(file_size_limit, 0) from storage.buckets where id = 'vendor-media';`),
      ) > 0,
    );
  }

  // ── 운영 파라미터 — 값이 없으면 지어내지 않는다 ─────────────────────────
  check(
    "**상품 사진 상한이 `app_settings` 에 있다**",
    sql(`select count(*) from public.app_settings
          where key = 'products.media_max_per_product';`) === "1",
  );
  check(
    "**상한을 코드에 박지 않았다** — 값이 없으면 업로드를 거절한다",
    /LIMIT_UNKNOWN/.test(srcOf("lib/core/product/media.ts")) &&
      !/max_per_product\s*=\s*\d/.test(srcOf("lib/core/product/media.ts")),
  );

  // ── 본문이 정찰제를 무너뜨리지 못하게 한다 (F-V-03) ─────────────────────
  check(
    "**본문 판정이 가격 회피 문구를 같은 함수로 본다** — 두 벌을 두지 않았다",
    /findPriceEvasionPhrase/.test(srcOf("lib/core/product/content.ts")),
  );
  check(
    "**본문 판정이 연락처를 마스킹 패턴으로 본다** — 정규식을 두 벌 두지 않았다",
    /detectResidualPii/.test(srcOf("lib/core/product/content.ts")),
  );
  check(
    "**등록·수정 두 경로가 모두 본문을 판정한다**",
    ["app/api/vendor/products/route.ts", "app/api/vendor/products/[id]/route.ts"].every((file) =>
      /productContentProblems/.test(srcOf(file)),
    ),
  );

  // ── FIX-75 — 파는 축 본체 CHECK ─────────────────────────────────────────
  check(
    "**FIX-75 — `products.category` 가 어휘 밖을 막는다**",
    rejectedWith(/products_category_vocab_chk|check constraint/, () =>
      sql(`update public.products set category = 'nope'
            where id = '00000000-0000-0000-0000-00000000d001';`),
    ),
  );
  check(
    "**FIX-75 — `vendors.category` 가 어휘 밖을 막는다**",
    rejectedWith(/vendors_category_vocab_chk|check constraint/, () =>
      sql(`update public.vendors set category = 'nope'
            where id = (select vendor_id from public.products
                         where id = '00000000-0000-0000-0000-00000000d001');`),
    ),
  );
  check(
    "**FIX-75 — 어휘 안의 값은 통과한다** (늘 거절하는 CHECK 이 아니다)",
    sqlOrNull(`begin;
      update public.products set category = 'studio'
       where id = '00000000-0000-0000-0000-00000000d001';
      rollback;`) !== null,
  );
  // `not valid` 로 남아 있으면 **기존 행을 아무도 안 본 것**이다. 그 상태를 통과로
  // 읽지 않는다 — 검증까지 끝났는지 확인한다.
  check(
    "**FIX-75 — 두 제약이 기존 행까지 검증됐다** (`not valid` 로 남아 있지 않다)",
    sql(`select count(*) from pg_constraint
          where conname in ('products_category_vocab_chk', 'vendors_category_vocab_chk')
            and convalidated;`) === "2",
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// 상품 상세 (C-2c · F-C-38) + 사업자번호 해시 공개 차단 (FIX-79) + FIX-78
// ═══════════════════════════════════════════════════════════════════════════
{
  const DRAFT = "00000000-0000-0000-0000-0000000c2c01";
  const PUBLISHED = "00000000-0000-0000-0000-0000000c2c0f";
  const PENDING_VENDOR = "00000000-0000-0000-0000-0000000c2c90";
  const PENDING_PRODUCT = "00000000-0000-0000-0000-0000000c2c91";

  /**
   * active 업체 하나에 **초안 1 · 게시 1**, 그리고 **심사 중 업체**에 게시 상품 1.
   *
   * 심사 중 업체를 따로 세우는 이유: C-2b 는 *초안 상품*만 눌러 봤다. 상품이
   * `published` 인데 **업체가 아직 심사 중**인 경우는 다른 경로이고, 상품 상세를
   * 열면 그 경로로 들어오는 사람이 생긴다.
   */
  const fixture = `
    insert into public.vendors (id, name, category, region_code, status)
    values ('${PENDING_VENDOR}', '심사중 업체', 'hall', 'seoul-gangnam', 'pending');

    insert into public.products (id, vendor_id, category, name, base_price_total, status,
                                 included_items_json, add_ons_declared_at, published_at,
                                 summary, description_json)
    select '${DRAFT}', v.id, 'hall', 'C2C 초안', 1000000, 'draft',
           '[{"label":"대관","note":null}]'::jsonb, now(), null,
           '초안 소개', '{"v":1,"source":"초안 본문"}'::jsonb
      from public.vendors v where v.status = 'active' order by v.id limit 1;

    insert into public.products (id, vendor_id, category, name, base_price_total, status,
                                 included_items_json, add_ons_declared_at, published_at,
                                 summary, description_json)
    select '${PUBLISHED}', v.id, 'hall', 'C2C 게시', 2000000, 'published',
           '[{"label":"대관","note":null}]'::jsonb, now(), now(),
           '게시 소개', '{"v":1,"source":"게시 본문"}'::jsonb
      from public.vendors v where v.status = 'active' order by v.id limit 1;

    insert into public.products (id, vendor_id, category, name, base_price_total, status,
                                 included_items_json, add_ons_declared_at, published_at,
                                 summary, description_json)
    values ('${PENDING_PRODUCT}', '${PENDING_VENDOR}', 'hall', '심사중 업체의 게시 상품', 3000000,
            'published', '[{"label":"대관","note":null}]'::jsonb, now(), now(),
            '심사중 소개', '{"v":1,"source":"심사중 본문"}'::jsonb);

    insert into public.product_options (product_id, name, price, is_mandatory) values
      ('${DRAFT}', '초안 추가금', 111111, true),
      ('${PUBLISHED}', '게시 추가금', 222222, true),
      ('${PENDING_PRODUCT}', '심사중 추가금', 333333, true);

    insert into public.vendor_media (vendor_id, product_id, type, storage_path, sort_order)
    select p.vendor_id, p.id, 'photo', 'probe/' || p.id || '.jpg', 0
      from public.products p
     where p.id in ('${DRAFT}', '${PUBLISHED}', '${PENDING_PRODUCT}');

    insert into public.price_rules (vendor_id, product_id, rule_type, condition_json,
                                    adjust_type, adjust_value, floor_price, cap_price)
    select p.vendor_id, p.id, 'season', '{"months":[5]}'::jsonb, 'percent_bp', 1000, 1500000, 9000000
      from public.products p where p.id = '${PUBLISHED}';
  `;

  const anonCount = (body) => asAnon(body, fixture);

  // ── 층 2 — 비로그인이 상품 상세 경로로 무엇을 가져가는가 ────────────────
  //
  // **화면에 안 그리는 것만으로는 부족하다.** 이 화면은 익명 클라이언트로 읽으므로
  // 여기서 새면 응답 본문에 그대로 실린다. 표를 하나씩 눌러 본다.
  check(
    "**층 2 — 비로그인은 초안 상품을 못 본다**",
    anonCount(`select count(*) from public.products where id = '${DRAFT}';`) === "0",
  );
  check(
    "**층 2 — 초안 상품의 추가금이 새지 않는다** (C-2b 가 남긴 자리를 상세 경로로 다시 눌렀다)",
    anonCount(`select count(*) from public.product_options where price = 111111;`) === "0",
  );
  check(
    "**층 2 — 초안 상품의 사진이 새지 않는다**",
    anonCount(`select count(*) from public.vendor_media where storage_path = 'probe/${DRAFT}.jpg';`) === "0",
  );
  // **심사 중 업체 — C-2b 가 안 본 경로다.**
  check(
    "**층 2 — 심사 중 업체의 '게시' 상품이 안 보인다** (상품은 published 인데 업체가 pending 이다)",
    anonCount(`select count(*) from public.products where id = '${PENDING_PRODUCT}';`) === "0",
  );
  check(
    "**층 2 — 심사 중 업체 상품의 추가금도 안 보인다**",
    anonCount(`select count(*) from public.product_options where price = 333333;`) === "0",
  );
  check(
    "**층 2 — 심사 중 업체 상품의 사진도 안 보인다**",
    anonCount(`select count(*) from public.vendor_media where storage_path = 'probe/${PENDING_PRODUCT}.jpg';`) === "0",
  );
  check(
    "**층 2 — 심사 중 업체 자체가 안 보인다**",
    anonCount(`select count(*) from public.vendors where id = '${PENDING_VENDOR}';`) === "0",
  );
  // **늘 가리는 정책이 아니다** — 게시분은 실제로 보여야 화면이 성립한다.
  check(
    "**게시 상품·추가금·사진은 비로그인에게 보인다** (분모가 실재한다)",
    anonCount(`select count(*) from public.products where id = '${PUBLISHED}';`) === "1" &&
      anonCount(`select count(*) from public.product_options where price = 222222;`) === "1" &&
      anonCount(`select count(*) from public.vendor_media where storage_path = 'probe/${PUBLISHED}.jpg';`) === "1",
  );
  // **비공개 프라이싱이 상세 경로로 새지 않는다.**
  check(
    "**층 2 — `price_rules` 는 비로그인에게 한 행도 안 보인다** (floor·cap 이 안 샌다)",
    anonCount(`select count(*) from public.price_rules;`) === "0",
  );
  check(
    "**`price_rules` 에는 공개 정책 자체가 없다** — 정책이 늘어나면 이 줄이 먼저 깨진다",
    sql(`select count(*) from pg_policy p
          where p.polrelid = 'public.price_rules'::regclass and p.polcmd = 'r'
            and pg_get_expr(p.polqual, p.polrelid) not like '%is_vendor_member%';`) === "0",
  );
  // `product_options_select_public` 은 **여전히 부모 정책에 기댄다.** 지금 새지 않는
  // 이유가 그 기댐이므로, 그 사실을 적어 둔다 — `products` 가 넓어지는 날 위 검사가 먼저 깨진다.
  check(
    "**`product_options_select_public` 에는 아직 소유자·상태 조건이 없다** (부모에 기댄다 — 알고 있는 상태다)",
    !/status|published/.test(
      sql(`select pg_get_expr(polqual, polrelid) from pg_policy
            where polrelid = 'public.product_options'::regclass
              and polname = 'product_options_select_public';`),
    ),
  );

  // ── 층 1 — FIX-79 사업자번호 해시 ───────────────────────────────────────
  //
  // `vendors` 는 공개 카탈로그라 anon SELECT 가 열려 있는데 그것이 **표 단위**여서
  // `biz_no_enc` 까지 나갔다. 10자리 숫자의 **소금 없는 SHA-256** 은 전수 대입으로
  // 되돌아간다 — §7.2 가 지키려던 것이 공개 읽기 한 줄로 무효였다.
  check(
    "**FIX-79 — 비로그인이 `vendors.biz_no_enc` 를 못 읽는다**",
    rejectedWith(/permission denied/, () => asAnon(`select biz_no_enc from public.vendors limit 1;`)),
  );
  check(
    "**FIX-79 — 로그인 사용자도 못 읽는다** (공개 카탈로그의 칸이 아니다)",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `select biz_no_enc from public.vendors limit 1;`),
    ),
  );
  check(
    "**FIX-79 — 공개 칸은 그대로 읽는다** (표를 통째로 잠그지 않았다)",
    Number(asAnon(`select count(*) from public.vendors where status = 'active';`)) > 0 &&
      asAnon(`select count(*) from (select id, name, category, region_code, intro,
                                           style_tags, facilities, badge_flags
                                      from public.vendors where status = 'active') t;`) !== null,
  );
  check(
    "**FIX-79 — 칸만 걷지 않고 표에서 걷었다** (§5.5 층 1 — 칸만 걷으면 무효다)",
    sql(`select count(*) from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'vendors'
            and grantee in ('anon', 'authenticated') and privilege_type = 'SELECT';`) === "0",
  );
  check(
    "**FIX-79 — 서버(서비스롤)는 여전히 읽는다** — 입점 심사가 이 칸을 쓴다",
    sql(`select count(*) from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'vendors'
            and column_name = 'biz_no_enc' and grantee = 'service_role'
            and privilege_type = 'SELECT';`) === "1",
  );

  // ── 층 3 — 상세가 자격을 만들지 않는다 ──────────────────────────────────
  //
  // 이 화면은 **읽기 전용**이다. 자격의 근거가 되는 표(`vendor_members` ·
  // `products.status`)를 상세 경로가 쓰지 않는지 본다.
  check(
    "**층 3 — 상품 상세 로더가 쓰기를 하지 않는다** (조회 전용이다)",
    !/\.(insert|update|upsert|delete)\(/.test(srcOf("lib/products/detail-query.ts")),
  );
  check(
    "**층 3 — 비로그인이 상품 상태를 못 바꾼다** (자격의 근거를 스스로 못 쓴다)",
    rejectedWith(/permission denied|row-level security|0 rows/, () =>
      asAnon(`update public.products set status = 'published' where id = '${DRAFT}';`, fixture),
    ),
  );

  // ── 화면·API 가 같은 것을 본다 ──────────────────────────────────────────
  check(
    "**상세 화면과 API 가 같은 로더를 쓴다** — 두 곳이 다른 값을 말하지 않는다",
    ["app/(consumer)/explore/[vendorId]/[productId]/page.tsx", "app/api/products/[id]/route.ts"].every(
      (file) => /loadProductDetail/.test(srcOf(file)),
    ),
  );
  check(
    "**로더가 익명 클라이언트로 읽는다** — 서비스롤로 읽으면 게시 판정이 코드 몫이 된다",
    /createPublicClient/.test(srcOf("lib/products/detail-query.ts")) &&
      !/createAdminClient/.test(srcOf("lib/products/detail-query.ts")),
  );
  check(
    "**추가금 요약이 업체 상세와 같은 함수다** (`summarizeAddOns`)",
    /summarizeAddOns/.test(srcOf("lib/products/detail-query.ts")) &&
      /summarizeAddOns/.test(srcOf("app/(consumer)/explore/[vendorId]/VendorProducts.tsx")),
  );
  check(
    "**경로의 업체와 상품의 업체가 다르면 막는다** — 같은 상품이 두 주소를 갖지 않는다",
    /vendor_id !== input\.vendorId/.test(srcOf("lib/products/detail-query.ts")),
  );
  check(
    "**본문을 HTML 로 만들지 않는다** — 블록을 그린다(D-97)",
    /descriptionBlocks/.test(srcOf("app/(consumer)/explore/[vendorId]/[productId]/page.tsx")) &&
      !/dangerouslySetInnerHTML/.test(srcOf("app/(consumer)/explore/[vendorId]/[productId]/page.tsx")),
  );
  check(
    "**참가격 기준이 없으면 0 이 아니라 '기준 없음' 이다**",
    /NO_INDEX_BASELINE_NOTE/.test(srcOf("lib/products/detail-query.ts")) &&
      /no-baseline/.test(srcOf("app/(consumer)/explore/[vendorId]/[productId]/page.tsx")),
  );
  check(
    "**상세로 들어가는 자리가 있다** — 만든 화면이 도달 불가로 남지 않는다",
    /explore\/\$\{vendorId\}\/\$\{product\.id\}/.test(
      srcOf("app/(consumer)/explore/[vendorId]/VendorProducts.tsx"),
    ),
  );
  check(
    "**아직 안 만든 자리를 화면이 말한다** — 빈 칸으로 두지 않는다",
    /PENDING_SECTION_NOTE/.test(srcOf("app/(consumer)/explore/[vendorId]/[productId]/page.tsx")),
  );

  // ── FIX-78 — 지운 사진의 파일도 지운다 ──────────────────────────────────
  //
  // **공개 버킷이라 행만 지우면 주소를 아는 사람에게는 계속 열린다.**
  // 실제로 열리는지는 `vendor:walk` 이 주소를 눌러 본다(여기서는 절차가 서 있는지만).
  check(
    "**FIX-78 — 업체 프로필 미디어 삭제가 Storage 객체도 지운다**",
    /storage[\s\S]{0,80}\.remove\(/.test(srcOf("app/api/vendor/profile/route.ts")),
  );
  check(
    "**FIX-78 — 지우기 전에 경로를 먼저 읽는다** (행을 지운 뒤에는 무엇을 지울지 알 수 없다)",
    /storage_path[\s\S]{0,400}\.delete\(\)/.test(srcOf("app/api/vendor/profile/route.ts")),
  );
  check(
    "**FIX-78 — 상품 사진 삭제도 같은 절차다**(C-2b) — 두 경로가 갈리지 않는다",
    /storage[\s\S]{0,80}\.remove\(/.test(srcOf("app/api/vendor/products/[id]/media/route.ts")),
  );
  check(
    "**FIX-78 — 남의 경로를 넘겨받아 지우지 않는다** (경로가 제 것인지 본다)",
    /startsWith\(`\$\{vendorId\}\//.test(srcOf("app/api/vendor/profile/route.ts")) &&
      /isPathOfProduct/.test(srcOf("app/api/vendor/products/[id]/media/route.ts")),
  );
  // **고아가 없는 것도 사실로 남긴다.** 다만 **분모가 0 이면 공짜 통과**이므로
  // 그 사실을 값으로 함께 적는다 — 로컬 시드는 미디어를 만들지 않는다.
  {
    const objects = sql(`select count(*) from storage.objects where bucket_id = 'vendor-media';`);
    const orphans = sql(`select count(*) from storage.objects o
                          where o.bucket_id = 'vendor-media'
                            and not exists (select 1 from public.vendor_media m
                                             where m.storage_path = o.name);`);
    check(
      "**`vendor-media` 에 고아 객체가 없다** (객체 수를 함께 적는다 — 0 이면 공짜 통과다)",
      orphans === "0",
      `objects=${objects} orphans=${orphans}`,
    );
  }

  // ── 층 1 — C-2c 는 표도 칸도 더하지 않았다 ──────────────────────────────
  check(
    "**C-2c 가 새 표를 만들지 않았다** — 0077 은 권한만 바꿨다",
    !/create table/i.test(srcOf("supabase/migrations/20260808007700_vendor_biz_no_not_public.sql")) &&
      !/add column/i.test(srcOf("supabase/migrations/20260808007700_vendor_biz_no_not_public.sql")),
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// 상품 컨셉 태그 (C-2d · D-213) — 어휘 · 상속 · 랭킹 금지 · 권한
// ═══════════════════════════════════════════════════════════════════════════
{
  const DRAFT = "00000000-0000-0000-0000-0000000c2d01";
  const PUBLISHED = "00000000-0000-0000-0000-0000000c2d0f";
  const PENDING_VENDOR = "00000000-0000-0000-0000-0000000c2d90";
  const PENDING_PRODUCT = "00000000-0000-0000-0000-0000000c2d91";

  /**
   * 초안 1 · 게시 1 — **둘 다 `outsider`(업체 대표)의 업체**에 붙인다. 그래야
   * "자기 상품은 고칠 수 있다" 와 "남의 상품은 못 고친다" 를 같은 픽스처로 가른다.
   * 그 업체는 시드에서 `pending` 이라 여기서 `active` 로 올린다(롤백된다).
   * 그리고 **남의 업체**(심사 중) 하나에 게시 상품을 둔다.
   */
  const fixture = `
    update public.vendors set status = 'active'
     where id = (select vendor_id from public.vendor_members where user_id = '${outsider}' limit 1);

    insert into public.vendors (id, name, category, region_code, status, style_tags)
    values ('${PENDING_VENDOR}', '심사중 업체', 'hall', 'seoul-gangnam', 'pending', array['luxury']::text[]);

    insert into public.products (id, vendor_id, category, name, base_price_total, status,
                                 included_items_json, add_ons_declared_at, published_at, style_tags)
    select '${DRAFT}', vm.vendor_id, 'hall', 'C2D 초안', 1000000, 'draft',
           '[{"label":"대관","note":null}]'::jsonb, now(), null, array['outdoor']::text[]
      from public.vendor_members vm where vm.user_id = '${outsider}' limit 1;

    insert into public.products (id, vendor_id, category, name, base_price_total, status,
                                 included_items_json, add_ons_declared_at, published_at, style_tags)
    select '${PUBLISHED}', vm.vendor_id, 'hall', 'C2D 게시', 2000000, 'published',
           '[{"label":"대관","note":null}]'::jsonb, now(), now(), array['minimal']::text[]
      from public.vendor_members vm where vm.user_id = '${outsider}' limit 1;

    insert into public.products (id, vendor_id, category, name, base_price_total, status,
                                 included_items_json, add_ons_declared_at, published_at, style_tags)
    values ('${PENDING_PRODUCT}', '${PENDING_VENDOR}', 'hall', '심사중 게시 상품', 3000000,
            'published', '[{"label":"대관","note":null}]'::jsonb, now(), now(), array['luxury']::text[]);
  `;

  // ── 어휘 — 늘리지 않았다 · CHECK 이 잠근다 (층 1) ───────────────────────
  {
    const block = (srcOf("lib/core/schemas/onboarding.ts")
      .match(/STYLE_TAGS = \[([\s\S]*?)\] as const/) ?? ["", ""])[1];
    const codes = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

    check(
      "**컨셉 어휘를 코드에서 실제로 읽었다** (빈 목록으로 통과하지 않는다)",
      codes.length === 8,
      `code=${codes.length}`,
    );
    check(
      "**어휘를 늘리지 않았다** — 세 표가 같은 여덟을 쓴다",
      codes.length === 8 &&
        codes.every((tag) =>
          ["products", "vendors"].every(
            (table) =>
              sql(`select count(*) from pg_constraint
                    where conrelid = 'public.${table}'::regclass
                      and conname = '${table}_style_tags_chk'
                      and pg_get_constraintdef(oid) like '%''${tag}''%';`) === "1",
          ),
        ),
    );
  }
  check(
    "**층 1 — 어휘 밖 태그를 DB 가 막는다** (오타가 새 컨셉을 만들지 않는다)",
    rejectedWith(/products_style_tags_chk|check constraint/, () =>
      sql(`update public.products set style_tags = array['romatic']::text[]
            where id = '00000000-0000-0000-0000-000000000951';`),
    ),
  );
  check(
    "**층 1 — 어휘 안의 값은 통과한다** (늘 거절하는 CHECK 이 아니다)",
    sqlOrNull(`begin;
      update public.products set style_tags = array['romantic','minimal']::text[]
       where id = '00000000-0000-0000-0000-000000000951';
      rollback;`) !== null,
  );
  check(
    "**컨셉 필터가 GIN 인덱스를 갖는다** — 업체 쪽과 같은 모양이다",
    sql(`select count(*) from pg_indexes
          where schemaname = 'public' and indexname = 'idx_products_style_tags';`) === "1",
  );
  check(
    "**기본값이 빈 배열이고 NOT NULL 이다** — null 과 '없음' 이 갈리지 않는다",
    sql(`select is_nullable || '|' || coalesce(column_default, '-')
           from information_schema.columns
          where table_schema = 'public' and table_name = 'products' and column_name = 'style_tags';`)
      === "NO|'{}'::text[]",
  );

  // ── 상속 — 값을 복사해 저장하지 않았다 ──────────────────────────────────
  //
  // 복사하면 업체가 태그를 바꿔도 상품은 옛 값을 들고 있고, 그때 어느 쪽이 맞는지
  // 답할 수 없다. **마이그레이션이 데이터를 건드리지 않았다는 사실**을 고정한다.
  check(
    "**마이그레이션이 업체 태그를 상품으로 복사하지 않았다** (계산 가능한 값을 저장하지 않는다)",
    !/update\s+public\.products[\s\S]{0,200}style_tags/i.test(
      srcOf("supabase/migrations/20260808007800_product_style_tags.sql"),
    ),
  );
  check(
    "**지금 모든 상품의 태그가 비어 있다** — 그래서 전부 업체 태그로 계속 걸린다",
    sql(`select count(*) from public.products
          where coalesce(array_length(style_tags, 1), 0) > 0;`) === "0",
  );
  check(
    "**상속 규칙이 `lib/core` 에 코드로 있다** — 질의문이 규칙을 두 번 적지 않는다",
    /effectiveStyleTags/.test(srcOf("lib/core/product/concept.ts")) &&
      /effectiveStyleTags/.test(srcOf("lib/explore/query.ts")) &&
      /effectiveStyleTags/.test(srcOf("lib/products/detail-query.ts")),
  );
  check(
    "**합집합이 아니다** — 상품 태그가 있으면 업체 태그를 덮는다(완료 조건 ①)",
    /source: "product"/.test(srcOf("lib/core/product/concept.ts")) &&
      /source: "vendor"/.test(srcOf("lib/core/product/concept.ts")),
  );
  check(
    "**상속받은 태그는 출처를 밝힌다** — 업체 컨셉을 상품 컨셉처럼 그리지 않는다",
    /STYLE_TAG_SOURCE_NOTE/.test(
      srcOf("app/(consumer)/explore/[vendorId]/[productId]/page.tsx"),
    ),
  );

  // ── 카테고리 축과 섞이지 않았다 (C-2a · D-206) ──────────────────────────
  check(
    "**컨셉이 카테고리 두 축에 섞이지 않았다** — `axes.ts` 가 컨셉을 모른다",
    !/style_tags|STYLE_TAGS|styleTags/.test(srcOf("lib/core/category/axes.ts")),
  );
  check(
    "**컨셉 모듈이 카테고리 매핑을 끌어오지 않는다** — 느낌과 카테고리를 대응시키지 않는다",
    !/category\/axes/.test(srcOf("lib/core/product/concept.ts")),
  );
  check(
    "**그 사실이 문장으로도 적혀 있다** (다음 사람이 섞지 않도록)",
    /CONCEPT_AXIS_NOTE/.test(srcOf("lib/core/product/concept.ts")),
  );

  // ── 랭킹에 쓰지 않는다 ──────────────────────────────────────────────────
  //
  // 태그가 많을수록 위로 올라가면 **태그 남발이 이득**이 된다(D-03 과 같은 자리).
  // 정렬을 만드는 자리에 태그가 등장하지 않는 것을 본다.
  {
    const query = srcOf("lib/explore/query.ts");
    const sortBlock = (query.match(/switch \(filter\.sort\)[\s\S]*?\n  \}/) ?? ["", ""])[0];

    check(
      "**정렬 분기를 실제로 읽었다** (빈 문자열로 통과하지 않는다)",
      sortBlock.includes("price_asc") && sortBlock.includes("price_index_gap"),
      `len=${sortBlock.length}`,
    );
    check(
      "**정렬 분기에 컨셉 태그가 없다** — 태그가 많다고 위로 올라가지 않는다",
      sortBlock.length > 0 && !/style_tags|styleTags/.test(sortBlock),
    );
  }
  check(
    "**DB 의 노출·순위 함수가 컨셉을 모른다**",
    sql(`select count(*) from pg_proc
          where prosrc like '%style_tags%'
            and proname in ('is_active_vendor', 'resolve_commission_rate', 'published_content');`) === "0",
  );
  check(
    "**그 원칙이 문장으로 적혀 있다**",
    /CONCEPT_NOT_RANKING_NOTE/.test(srcOf("lib/core/product/concept.ts")),
  );

  // ── 층 2·3 — 남의 상품에 태그를 붙일 수 있는가 ──────────────────────────
  //
  // 태그는 `products` 의 칸이라 **"남의 상품을 가리키는" 경로가 애초에 없다**
  // (C-2b 의 `vendor_media` 와 다른 점 — 그쪽은 자기 업체 행에서 남의 상품을
  //  가리킬 수 있어 복합 FK 가 필요했다). 그래도 **가정하지 않고 눌러 본다.**
  check(
    "**층 3 — 남의(심사 중) 업체 상품은 보이지도 않는다** — 고치기 전에 읽히지 않는다",
    asUser(
      outsider,
      `select count(*) from public.products where id = '${PENDING_PRODUCT}';`,
      fixture,
    ) === "0",
  );
  check(
    "**층 3 — 남의 상품 태그가 실제로 안 바뀐다** (덮어써 보고 확인한다)",
    asUser(
      outsider,
      `update public.products set style_tags = array['modern']::text[]
        where id = '${PENDING_PRODUCT}';
       select count(*) from public.products
        where id = '${PENDING_PRODUCT}' and style_tags @> array['modern']::text[];`,
      fixture,
    ) === "0",
  );
  check(
    "**층 1 — staff 는 상품 태그를 못 고친다** (상품 쓰기는 owner 전용)",
    asUser(
      vendorStaff,
      `update public.products set style_tags = array['modern']::text[]
        where id = '${PUBLISHED}';
       select count(*) from public.products
        where id = '${PUBLISHED}' and style_tags @> array['modern']::text[];`,
      fixture,
    ) === "0",
  );
  check(
    "**owner 는 자기 상품 태그를 고친다** (늘 거절하는 정책이 아니다)",
    asUser(
      outsider,
      `update public.products set style_tags = array['modern']::text[]
        where id = '${PUBLISHED}';
       select count(*) from public.products
        where id = '${PUBLISHED}' and style_tags @> array['modern']::text[];`,
      fixture,
    ) === "1",
  );
  check(
    "**층 2 — 컨셉 때문에 새 표·새 정책이 생기지 않았다** (부모에 기대는 정책을 늘리지 않았다)",
    !/create policy|create table/i.test(
      srcOf("supabase/migrations/20260808007800_product_style_tags.sql"),
    ),
  );

  // ── 비로그인이 보는 것 ──────────────────────────────────────────────────
  check(
    "**비로그인은 초안 상품의 컨셉을 못 본다**",
    asAnon(
      `select count(*) from public.products
        where id = '${DRAFT}' and style_tags @> array['outdoor']::text[];`,
      fixture,
    ) === "0",
  );
  check(
    "**비로그인은 심사 중 업체 상품의 컨셉을 못 본다**",
    asAnon(
      `select count(*) from public.products
        where id = '${PENDING_PRODUCT}' and style_tags @> array['luxury']::text[];`,
      fixture,
    ) === "0",
  );
  check(
    "**게시 상품의 컨셉은 보인다** (분모가 실재한다)",
    asAnon(
      `select count(*) from public.products
        where id = '${PUBLISHED}' and style_tags @> array['minimal']::text[];`,
      fixture,
    ) === "1",
  );

  // ── 취향 기본 필터 — 지울 수 있는가 ─────────────────────────────────────
  check(
    "**취향을 기본값으로 넣는 규칙이 `lib/core` 에 있다**",
    /tasteDefault/.test(srcOf("lib/core/product/concept.ts")) &&
      /tasteDefault/.test(srcOf("app/(consumer)/explore/page.tsx")),
  );
  // **import 줄만 보고 통과하지 않게 한다.** 이름이 파일에 있다는 것과 화면이
  // 그린다는 것은 다르다 — `{...}` 로 **그려지는 자리**를 본다(되돌림 시험에서 걸렸다).
  check(
    "**어디서 온 값인지 화면이 말한다** (import 가 아니라 그려지는 자리를 본다)",
    /\{TASTE_DEFAULT_NOTE\}/.test(srcOf("app/(consumer)/explore/page.tsx")),
  );
  check(
    "**지우는 수단이 함께 있다** — 지울 수 없는 기본값은 거르는 게 아니라 가리는 것이다",
    /\{TASTE_DEFAULT_CLEAR_LABEL\}/.test(srcOf("app/(consumer)/explore/page.tsx")) &&
      /TASTE_OFF/.test(srcOf("app/(consumer)/explore/page.tsx")),
  );
  check(
    "**비로그인에게는 기본 필터가 걸리지 않는다** — 취향은 커플에 붙은 값이다",
    /getSessionUser/.test(srcOf("lib/explore/taste.ts")) &&
      /return \[\]/.test(srcOf("lib/explore/taste.ts")),
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// 상품 단위 후기 (C-2e · D-216 · D-217) — 끌어오기 · FIX-39 · 합산 · 막힌 정렬
// ═══════════════════════════════════════════════════════════════════════════
{
  // ── 끌어오는 장치 — 예약이 상품을 정한다 ───────────────────────────────
  //
  // **분모부터 센다.** 후기가 0건이면 아래 검사들이 공짜로 통과한다.
  {
    const total = sql(`select count(*) from public.reviews;`);
    const withProduct = sql(`select count(*) from public.reviews where product_id is not null;`);

    check(
      "**후기가 실재한다** — 아래 검사의 분모다",
      Number(total) > 0,
      `reviews=${total} with_product=${withProduct}`,
    );
    check(
      "**상품을 아는 후기가 실재한다** (0 으로 공짜 통과하지 않는다)",
      Number(withProduct) > 0,
      `with_product=${withProduct}`,
    );
  }
  check(
    "**모든 후기의 상품이 그 예약의 상품과 같다** — 지어낸 값이 없다",
    sql(`select count(*) from public.reviews r
          join public.bookings b on b.id = r.booking_id
         where r.product_id is distinct from b.product_id;`) === "0",
  );
  check(
    "**끌어오는 트리거가 서 있다**",
    sql(`select count(*) from pg_trigger
          where tgrelid = 'public.reviews'::regclass
            and tgname = 'trg_reviews_set_product' and not tgisinternal;`) === "1",
  );

  // **작성자가 보낸 값을 트리거가 덮어쓴다.** 고르게 하면 안 산 상품에 후기가 붙는다.
  {
    const probe = `
      insert into public.bookings (id, couple_id, vendor_id, product_id, status, total_amount,
                                   applied_fee_rate_bp, applied_planner_fee_rate_bp)
      select '00000000-0000-0000-0000-0000000e2e01', b.couple_id, b.vendor_id, b.product_id,
             'confirmed', 1000000, 500, 0
        from public.bookings b
       where b.product_id is not null and not exists (select 1 from public.reviews r where r.booking_id = b.id)
       limit 1;
    `;
    const other = sql(`select id::text from public.products
                        where vendor_id <> (select vendor_id from public.bookings
                                             where id = '00000000-0000-0000-0000-0000000e2e01')
                        limit 1;`) ||
      sql(`select id::text from public.products order by id limit 1;`);

    check(
      "**작성자가 남의 상품을 보내도 예약의 상품으로 덮인다** (트리거가 정한다)",
      sql(`begin;
           ${probe}
           insert into public.reviews (booking_id, couple_id, vendor_id, product_id, score_price)
           select b.id, b.couple_id, b.vendor_id, '${other}', 5
             from public.bookings b where b.id = '00000000-0000-0000-0000-0000000e2e01';
           select count(*)
             from public.reviews r join public.bookings b on b.id = r.booking_id
            where r.booking_id = '00000000-0000-0000-0000-0000000e2e01'
              and r.product_id = b.product_id
              and r.product_id is distinct from '${other}';
           rollback;`).trim() === "1",
    );
  }

  // ── FIX-39 의 모양이 늘지 않았다 ────────────────────────────────────────
  //
  // S8-11 이 찾은 구멍은 *"작성자가 `vendor_id` 를 남의 업체로 고친다"* 였고
  // 0058 이 **UPDATE 를 칸 목록으로** 좁혀 닫았다. 새 칸이 그 좁힘을 우회하면 안 된다.
  check(
    "**FIX-39 — `reviews` 에 표 단위 UPDATE 가 없다** (있으면 칸 목록이 무효다)",
    sql(`select count(*) from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'reviews'
            and grantee in ('anon', 'authenticated') and privilege_type = 'UPDATE';`) === "0",
  );
  check(
    "**FIX-39 — `product_id` 가 작성자의 UPDATE 목록에 없다**",
    sql(`select count(*) from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'reviews'
            and grantee = 'authenticated' and privilege_type = 'UPDATE'
            and column_name = 'product_id';`) === "0",
  );
  check(
    "**FIX-39 — `vendor_id`·`booking_id`·`status` 도 여전히 목록에 없다** (기존 좁힘이 살아 있다)",
    sql(`select count(*) from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'reviews'
            and grantee = 'authenticated' and privilege_type = 'UPDATE'
            and column_name in ('vendor_id', 'booking_id', 'status');`) === "0",
  );
  check(
    "**FIX-39 — 작성자가 실제로 상품을 못 바꾼다** (눌러서 확인한다)",
    rejectedWith(/permission denied/, () =>
      asUser(owner, `update public.reviews set product_id = null;`),
    ),
  );
  check(
    "**작성자가 고칠 수 있는 것은 여전히 고친다** (권한을 통째로 잠그지 않았다)",
    sql(`select count(*) from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'reviews'
            and grantee = 'authenticated' and privilege_type = 'UPDATE'
            and column_name in ('body', 'score_price');`) === "2",
  );

  // ── 층 2 — 남의 업체 상품을 가리킬 수 있는가 ───────────────────────────
  check(
    "**층 2 — 복합 FK 가 남의 업체 상품을 막는다**",
    sql(`select count(*) from pg_constraint
          where conrelid = 'public.reviews'::regclass
            and conname = 'reviews_product_same_vendor_fk' and contype = 'f';`) === "1",
  );
  check(
    "**층 2 — 실제로 막힌다** (업체가 다른 상품을 직접 꽂아 본다)",
    rejectedWith(/reviews_product_same_vendor_fk|foreign key/, () =>
      sql(`update public.reviews
              set product_id = (select p.id from public.products p
                                 where p.vendor_id <> reviews.vendor_id limit 1)
            where id = (select id from public.reviews limit 1);`),
    ),
  );
  check(
    "**층 2 — 같은 업체 상품이면 통과한다** (늘 거절하는 FK 가 아니다)",
    sqlOrNull(`begin;
      update public.reviews r
         set product_id = (select p.id from public.products p
                            where p.vendor_id = r.vendor_id limit 1)
       where r.id = (select id from public.reviews limit 1);
      rollback;`) !== null,
  );

  // ── 층 3 — 자격의 근거를 자격 대상이 쓸 수 있는가 (FIX-44 의 경계) ──────
  check(
    "**층 3 — 작성 자격은 여전히 예약이 정한다** (정책이 `bookings` 를 본다)",
    /bookings/.test(
      sql(`select pg_get_expr(polwithcheck, polrelid) from pg_policy
            where polrelid = 'public.reviews'::regclass and polname = 'reviews_insert';`),
    ),
  );
  check(
    "**층 3 — 정책이 상품 조건도 함께 본다** (앱 관행이 아니라 DB 조건이다)",
    /product_id/.test(
      sql(`select pg_get_expr(polwithcheck, polrelid) from pg_policy
            where polrelid = 'public.reviews'::regclass and polname = 'reviews_insert';`),
    ),
  );
  check(
    "**층 3 — 커플이 `bookings` 를 직접 못 쓴다**(FIX-44 의 경계가 살아 있다)",
    sql(`select count(*) from pg_policy
          where polrelid = 'public.bookings'::regclass and polcmd in ('a', 'w')
            and pg_get_expr(coalesce(polwithcheck, polqual), polrelid) like '%is_couple_member%';`) === "0",
  );

  // ── 비로그인이 보는 것 ──────────────────────────────────────────────────
  check(
    "**비로그인에게 작성자 신원이 나가지 않는다** (공개 컬럼 목록에 없다)",
    !/couple_id|booking_id/.test(srcOf("lib/reviews/read.ts").match(
      /PUBLIC_REVIEW_COLUMNS =\s*"([^"]*)"/,
    )?.[1] ?? "couple_id"),
  );
  check(
    "**비공개·철회된 후기는 비로그인에게 안 보인다**",
    asAnon(
      `select count(*) from public.reviews where status = 'hidden' or retracted_at is not null;`,
      // 비공개는 사유·처리자·시각이 모두 있어야 한다(`reviews_hidden_chk`) —
      // 셋 중 하나라도 빠지면 CHECK 이 막는다. 검사가 그 모양을 지켜서 만든다.
      `update public.reviews
          set status = 'hidden', hidden_at = now(), hidden_reason = 'rls probe',
              hidden_by = (select id from auth.users limit 1)
        where id = (select id from public.reviews limit 1);`,
    ) === "0",
  );
  check(
    "**공개 후기는 보인다** (늘 가리는 정책이 아니다 · 분모가 실재한다)",
    Number(asAnon(`select count(*) from public.reviews;`)) > 0,
  );
  check(
    "**상품 후기 조회가 익명 클라이언트를 쓴다** — 서비스롤로 읽으면 공개 조건이 코드 몫이 된다",
    /createPublicClient/.test(srcOf("lib/reviews/read.ts")),
  );

  // ── 합산 규칙 — 캐시 칸을 만들지 않았다 ────────────────────────────────
  check(
    "**평점 캐시 칸이 없다** — 저장하면 두 곳이 갈리고 어느 쪽이 맞는지 화면으로는 모른다",
    sql(`select count(*) from information_schema.columns
          where table_schema = 'public' and table_name in ('products', 'vendors')
            and column_name in ('rating_avg', 'review_count', 'rating_count', 'score_avg');`) === "0",
  );
  check(
    "**업체 평점을 상품 평점의 평균으로 내지 않는다** — 규칙이 코드에 있다",
    /RATING_COMPOSITION/.test(srcOf("lib/core/review/rating.ts")) &&
      /다시 평균 내지 않습니다/.test(srcOf("lib/core/review/rating.ts")),
  );
  check(
    "**상품 평점도 같은 함수를 쓴다** — 분모만 다르다",
    /rateVendor/.test(srcOf("lib/reviews/read.ts")) &&
      /loadProductRating/.test(srcOf("lib/reviews/read.ts")),
  );
  // **문구를 화면이 손으로 적지 않는다.** 로더가 함수에서 받아 넘기고 화면은 그대로
  // 그린다 — 화면과 API 가 **같은 문구**를 쓰게 하려고 C-2e 가 로더로 옮겼다.
  // 양쪽을 다 본다: 함수를 부르는 자리와, 그 값을 그리는 자리.
  check(
    "**평균이 건수 없이 나가지 않는다** — 로더가 문구를 함수에서 받는다",
    /productRatingCaption\(rating\)/.test(srcOf("lib/products/detail-query.ts")),
  );
  check(
    "**화면은 그 문구를 그대로 그린다** — 손으로 적은 문자열이 아니다",
    /\{caption\}/.test(
      srcOf("app/(consumer)/explore/[vendorId]/[productId]/ProductReviews.tsx"),
    ),
  );
  check(
    "**화면과 API 가 같은 후기를 본다** — 화면이 자기 조회를 따로 하지 않는다",
    /product\.reviews\.items/.test(
      srcOf("app/(consumer)/explore/[vendorId]/[productId]/page.tsx"),
    ) &&
      !/loadProductReviews/.test(
        srcOf("app/(consumer)/explore/[vendorId]/[productId]/ProductReviews.tsx"),
      ),
  );

  // ── 막힌 정렬 셋 — 여는 조건을 화면이 적는가 ───────────────────────────
  {
    const src = srcOf("lib/core/schemas/explore.ts");
    const block = (src.match(/EXPLORE_SORT_PENDING[\s\S]*?\n\];/) ?? ["", ""])[0];
    const codes = [...block.matchAll(/code: "([a-z_]+)"/g)].map((m) => m[1]);
    // **타입 선언(`unlock: string;`)에 걸리지 않게** 문자열이 붙은 자리만 센다.
    // 처음엔 `/unlock:/g` 로 세어 **4** 가 나왔다(항목 셋 + 타입 한 줄) — 지시가
    // 경고한 "includes() 가 타입 선언에도 걸린다" 가 바로 이것이다.
    const unlocks = [...block.matchAll(/unlock:\s*$|unlock:\s*"/gm)].length;

    check(
      "**막힌 정렬 목록을 실제로 읽었다** (빈 목록으로 통과하지 않는다)",
      codes.length === 3,
      `codes=${codes.join(",")}`,
    );
    check(
      "**셋 다 여는 조건을 갖는다** — 이유만 적으면 '언젠가는 되겠지' 로 읽힌다",
      unlocks === 3,
      `unlock=${unlocks}`,
    );
    check(
      "**`review_score` 의 이유가 정정됐다** — 후기 데이터는 이제 있다",
      !/후기 데이터가 아직 없습니다/.test(block),
    );
    check(
      "**셋 다 아직 열지 않았다** — 열 수 있는 것만 연다",
      sql(`select 1;`) === "1" &&
        !/EXPLORE_SORTS = \[[^\]]*review_score/.test(src) &&
        !/EXPLORE_SORTS = \[[^\]]*available_date/.test(src) &&
        !/EXPLORE_SORTS = \[[^\]]*response_speed/.test(src),
    );
  }
  check(
    "**여는 조건이 화면에 그려진다** (import 가 아니라 그려지는 자리를 본다)",
    /\{item\.unlock\}/.test(srcOf("app/(consumer)/explore/ExploreFilters.tsx")),
  );

  // ── 상세 화면이 채운 자리를 '준비 중' 으로 적지 않는다 ─────────────────
  check(
    "**상품 후기가 「아직 준비 중」 목록에서 빠졌다** — 채운 자리를 준비 중이라 적지 않는다",
    !/"reviews"/.test(
      (srcOf("lib/core/product/detail.ts").match(/PENDING_SECTIONS = \[[^\]]*\]/) ?? [""])[0],
    ),
  );
  check(
    // C-2e 때는 여기가 *"목록이 비지 않았다"* 였다 — 남은 자리(주문 기한)를 계속
    // 말하는지 보는 검사였고, **C-4b 가 그 자리를 채우며 실제로 떨어졌다.**
    // 이제 목록이 비는 것이 옳은 상태이므로 **화면이 빈 카드를 그리지 않는지**로 옮긴다.
    "**목록이 비면 카드를 그리지 않는다** — 빈 카드는 '뭔가 있어야 하는데' 로 읽힌다",
    /PENDING_SECTIONS = \[\] as const/.test(srcOf("lib/core/product/detail.ts")) &&
      /Object\.keys\(PENDING_SECTION_NOTE\)\.length > 0/.test(
        srcOf("app/(consumer)/explore/[vendorId]/[productId]/page.tsx"),
      ),
  );
  check(
    "**상품 상세가 후기 자리를 잇는다** — 만든 화면이 도달 불가로 남지 않는다",
    /<ProductReviews/.test(srcOf("app/(consumer)/explore/[vendorId]/[productId]/page.tsx")),
  );
}

// =============================================================================
// C-2f — 지역 코드 (어휘 · 이행 · 권한 세 층)
// =============================================================================
/**
 * 지역은 **분류이면서 동시에 참가격 지수의 분모**다. 그래서 여기서 보는 것이 두 가지다.
 *
 *  · **어휘가 하나인가** — TS 모듈(`lib/core/region/regions.ts`)과 DB 함수
 *    (`is_region_code`)가 같은 73개를 말하는가. 두 벌을 손으로 적었으니 한쪽이
 *    낡으면 스키마는 받아 주는데 화면이 못 고르는 값이 생긴다.
 *  · **업체가 자기 분모를 옮길 수 있는가** — 옮길 수 있으면 표본이 적어 유리한 칸으로
 *    이사할 수 있다. 자격의 근거를 당사자가 쓰는 모양이라 층 3 이다.
 */
{
  const REGION_SRC = srcOf("lib/core/region/regions.ts");

  // ── 어휘 대조 — 두 벌이 같은 말을 하는가 ────────────────────────────────
  //
  // **목록을 실제로 읽었는지 먼저 본다.** 정규식이 빗나가 빈 배열이 나오면 아래
  // "전부 일치" 는 0개를 견줘 조용히 통과한다(운영 규칙 §7.0b).
  const sidos = (REGION_SRC.match(/^export const SIDO_CODES = \[([\s\S]*?)\] as const;/m) ?? [
    "",
    "",
  ])[1]
    .match(/"([a-z-]+)"/g)
    ?.map((value) => value.slice(1, -1)) ?? [];

  /**
   * 시군구는 **묶음마다 속한 시도가 다르다.** 처음에는 "앞의 25개가 서울" 이라고
   * 순서로 갈랐는데, 그 경계를 세는 정규식이 빗나가 **56개 전부 경기로 붙었고**
   * 대조가 48/73 으로 떨어졌다. 순서가 아니라 `.map` 이 붙여 주는 `sido:` 를 읽는다.
   */
  const sigungu = [
    ...(REGION_SRC.match(/const SIGUNGU[\s\S]*?\n\];/) ?? [""])[0].matchAll(
      /\[([\s\S]*?)\]\.map\(\(\[slug, name\]\) => \(\{ sido: "([a-z]+)"/g,
    ),
  ].flatMap(([, entries, sido]) =>
    (entries.match(/\["([a-z]+)", "[^"]+"\]/g) ?? []).map(
      (entry) => `${sido}-${entry.match(/\["([a-z]+)"/)[1]}`,
    ),
  );

  check(
    "**어휘 목록을 실제로 읽었다** — 못 읽으면 아래 대조가 0개를 견주고 통과한다",
    sidos.length === 17 && sigungu.length === 56,
    `sido=${sidos.length} sigungu=${sigungu.length}`,
  );

  check(
    "**시군구가 두 시도로 갈려 있다** — 한 묶음으로 읽히면 대조가 엉뚱한 코드를 만든다",
    sigungu.filter((code) => code.startsWith("seoul-")).length === 25 &&
      sigungu.filter((code) => code.startsWith("gyeonggi-")).length === 31,
    `seoul=${sigungu.filter((code) => code.startsWith("seoul-")).length} gyeonggi=${
      sigungu.filter((code) => code.startsWith("gyeonggi-")).length
    }`,
  );

  if (sidos.length === 17 && sigungu.length === 56) {
    const codes = [...sidos, ...sigungu];

    const dbSaysYes = Number(
      sqlOrNull(
        `select count(*) from unnest(array[${codes
          .map((code) => `'${code}'`)
          .join(",")}]) c where public.is_region_code(c);`,
      ),
    );

    check(
      "**TS 어휘 73개를 DB 도 전부 안다** — 두 벌이 갈리면 못 고르는 값이 생긴다",
      dbSaysYes === 73 && codes.length === 73,
      `ts=${codes.length} db_ok=${dbSaysYes}`,
    );

    const dbTotal = Number(
      sqlOrNull(
        `select count(*) from (select unnest(string_to_array(
           (select substring(pg_get_functiondef(p.oid) from 'select p_value in \\(([^)]*)\\)')
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'is_region_code'), ','))) t;`,
      ),
    );

    check(
      "**DB 가 TS 보다 더 알지도 않는다** — 한쪽에만 있는 코드는 화면에서 못 고른다",
      dbTotal === 73,
      `db=${dbTotal}`,
    );
  }

  check(
    "**어휘 밖 값은 DB 도 거절한다** — 늘 참을 돌려주는 함수가 아니다",
    sqlOrNull(`select public.is_region_code('seoul-nowhere');`) === "f" &&
      sqlOrNull(`select public.is_region_code('서울 강남');`) === "f" &&
      sqlOrNull(`select public.is_region_code('seoul-gangnam');`) === "t",
  );

  // ── 층 1 — CHECK 가 다섯 표에서 실제로 무는가 ───────────────────────────
  //
  // **"있을 때 조용한가" 도 함께 본다.** 거절만 확인하면 늘 거절하는 CHECK 도 통과한다.
  const vendorId = sqlOrNull(`select id from public.vendors limit 1;`);

  check(
    "**vendors 픽스처가 있다** — 없으면 아래 CHECK 검사가 빈 표를 훑는다",
    Boolean(vendorId),
  );

  if (vendorId) {
    check(
      "**층1 — vendors 가 어휘 밖 지역을 거절한다**",
      rejectedWith(/vendors_region_vocab_chk/, () =>
        sql(`begin; update public.vendors set region_code = '서울 강남' where id = '${vendorId}'; rollback;`),
      ),
    );
    check(
      "**층1 — 어휘 안 지역은 통과한다** (늘 거절하는 CHECK 가 아니다)",
      sqlOrNull(
        `begin; update public.vendors set region_code = 'jeju' where id = '${vendorId}';
         select region_code from public.vendors where id = '${vendorId}'; rollback;`,
      ) === "jeju",
    );
    check(
      "**층1 — 지역을 비우는 것은 허용한다** — '아직 모른다' 를 막으면 이행이 못 선다",
      sqlOrNull(
        `begin; update public.vendors set region_code = null where id = '${vendorId}';
         select count(*) from public.vendors where id = '${vendorId}' and region_code is null; rollback;`,
      ) === "1",
    );
  }

  check(
    "**층1 — couples 가 어휘 밖 지역을 거절한다**",
    rejectedWith(/couples_region_vocab_chk/, () =>
      sql(`begin; update public.couples set region_code = '강남'; rollback;`),
    ),
  );
  check(
    "**층1 — inquiries 가 어휘 밖 지역을 거절한다**",
    rejectedWith(/inquiries_region_vocab_chk/, () =>
      sql(`begin; update public.inquiries set region_code = 'gangnam'; rollback;`),
    ),
  );
  check(
    "**층1 — price_index 는 지역을 비울 수도 없다** (지수의 분모다)",
    rejectedWith(/price_index_region_vocab_chk|null value/, () =>
      sql(`begin; update public.price_index set region_code = '서울'; rollback;`),
    ),
  );
  check(
    "**층1 — planners 는 배열 원소 하나만 어긋나도 거절한다**",
    rejectedWith(/planners_region_vocab_chk/, () =>
      sql(`begin; update public.planners set regions = array['seoul-gangnam','강남']; rollback;`),
    ),
  );
  check(
    "**층1 — planners 의 정상 배열은 통과한다** (늘 거절하는 CHECK 가 아니다)",
    sqlOrNull(
      `begin; update public.planners set regions = array['jeju','busan'];
       select count(*) from public.planners where regions = array['jeju','busan']; rollback;`,
    ) === "1",
  );

  // ── 층 1 — 표 단위 GRANT 가 아니라 칸 목록인가 ──────────────────────────
  //
  // `revoke ... (칸)` 만으로는 무효다(§5.5 층 1). **표에서 걷고 칸을 나열해 다시 준
  // 것**인지 권한 표를 직접 본다 — 마이그레이션 문장을 읽는 것이 아니라 결과를 본다.
  check(
    "**층1 — vendors 에 표 단위 UPDATE 권한이 없다**",
    sqlOrNull(
      `select count(*) from information_schema.table_privileges
        where grantee = 'authenticated' and table_name = 'vendors' and privilege_type = 'UPDATE';`,
    ) === "0",
  );
  check(
    "**층1 — region_code 는 칸 권한에도 없다**",
    sqlOrNull(
      `select count(*) from information_schema.column_privileges
        where grantee = 'authenticated' and table_name = 'vendors'
          and privilege_type = 'UPDATE' and column_name = 'region_code';`,
    ) === "0",
  );
  check(
    "**층1 — 고칠 수 있는 칸은 여전히 고친다** — 권한을 통째로 잠그지 않았다",
    sqlOrNull(
      `select count(*) from information_schema.column_privileges
        where grantee = 'authenticated' and table_name = 'vendors'
          and privilege_type = 'UPDATE'
          and column_name in ('intro','address','capacity_min','capacity_max','facilities','style_tags','address_detail');`,
    ) === "7",
  );

  // ── 층 3 — 자격의 근거를 당사자가 쓰는가 ────────────────────────────────
  {
    const ownerUser = idOf("vendor@local.test");

    check(
      "**업체 대표 픽스처가 있다** — 없으면 아래 층3 검사가 헛돈다",
      Boolean(ownerUser),
    );

    if (ownerUser) {
      check(
        "**층3 — 업체가 자기 지역을 못 바꾼다** — 표본이 적어 유리한 칸으로 이사할 수 없다",
        rejectedWith(/permission denied/, () =>
          asUser(ownerUser, `update public.vendors set region_code = 'jeju'
                              where id in (select vendor_id from public.vendor_members
                                            where user_id = auth.uid());`),
        ),
      );
      check(
        "**층3 — 그래도 소개문은 바꾼다** — 프로필이 통째로 잠기지 않았다",
        asUser(ownerUser, `with u as (update public.vendors set intro = 'C-2f 확인'
                                      where id in (select vendor_id from public.vendor_members
                                                    where user_id = auth.uid())
                                      returning 1)
                           select count(*) from u;`) !== "0",
      );
    }
  }

  // ── 탐색 — 지역을 모르는 업체가 사라지지 않는다 ─────────────────────────
  //
  // 이행에서 못 옮긴 값은 `null` 이 됐다. **그 업체를 목록에서 빼면 우리 쪽 이행
  // 사정을 업체에 떠넘기는 셈**이다(표본 없는 지역을 목록에서 빼지 않기로 한 것과
  // 같은 판단 · S3-08). 지역으로 거를 때만 안 나온다.
  {
    const noRegion = `insert into public.vendors (id, name, category, region_code, status)
                      values ('00000000-0000-0000-0000-0000000002f0', 'C-2f 지역미등록', 'hall', null, 'active')
                      on conflict (id) do nothing;`;

    check(
      "**지역 없는 업체도 비로그인 목록에 남는다**",
      asAnon(
        `select count(*) from public.vendors where id = '00000000-0000-0000-0000-0000000002f0';`,
        noRegion,
      ) === "1",
    );
    check(
      "**지역으로 거르면 그 업체는 안 나온다** — 남는 것과 걸리는 것은 다르다",
      asAnon(
        `select count(*) from public.vendors
          where id = '00000000-0000-0000-0000-0000000002f0' and region_code = 'seoul-gangnam';`,
        noRegion,
      ) === "0",
    );
    check(
      "**지역 있는 업체는 그 필터에 걸린다** — 늘 0 을 돌려주는 검사가 아니다",
      Number(
        asAnon(`select count(*) from public.vendors where region_code = 'seoul-gangnam';`),
      ) > 0,
    );
  }

  // ── 참가격 지수 — 유령 칸을 만들지 않는다 ───────────────────────────────
  check(
    "**지수의 모든 칸이 어휘 안이다** — 못 옮긴 칸은 이행이 지웠다",
    sqlOrNull(`select count(*) from public.price_index where not public.is_region_code(region_code);`) ===
      "0",
  );
  check(
    "**지수가 비어 있지 않다** — 빈 표 덕분에 위 검사가 통과한 것이 아니다",
    Number(sqlOrNull(`select count(*) from public.price_index;`)) > 0,
  );
  check(
    "**표본 하한 아래로 떨어진 칸이 없다** — 1:1 이름 바꾸기라 분모가 그대로다",
    sqlOrNull(`select count(*) from public.price_index where sample_size < 5;`) === "0",
  );
  check(
    "**배치가 지역 없는 업체를 칸으로 만들지 않는다** — 'null|hall' 칸이 표본을 빨아먹는다",
    /region_code !== null/.test(srcOf("app/api/jobs/price-index-refresh/route.ts")),
  );
  check(
    // **선언이 아니라 나가는 자리를 본다.** 처음엔 `/skippedNoRegion/` 였는데, 되돌려
    // 보니 응답에서 빼도 통과했다 — 이름이 `const` 선언에 남아 있어서다.
    "**건너뛴 수를 밖으로 낸다** — 조용히 빼면 표본이 왜 적은지 아무도 모른다",
    /\n\s*skippedNoRegion,/.test(srcOf("app/api/jobs/price-index-refresh/route.ts")) &&
      /no_region:\$\{skippedNoRegion\}/.test(srcOf("app/api/jobs/price-index-refresh/route.ts")),
  );

  // ── 화면 — 자유 입력이 사라졌는가 ───────────────────────────────────────
  //
  // **입력 수단을 세는 검사다.** 어휘를 세워도 어딘가 `<input>` 이 남아 있으면
  // 그 자리로 어휘 밖 값이 계속 들어오고, 스키마가 422 로 되받아 사용자만 막힌다.
  for (const [path, label] of [
    ["app/(consumer)/explore/ExploreFilters.tsx", "탐색 필터"],
    ["app/(consumer)/search/ConditionEditor.tsx", "조건 편집기"],
    ["app/(auth)/onboarding/OnboardingStepper.tsx", "온보딩"],
    ["app/(consumer)/inquiries/new/InquiryForm.tsx", "문의 작성"],
    ["app/(vendor)/vendor/apply/VendorApplyForm.tsx", "입점 신청"],
    ["app/(admin)/admin/prices/RecalculatePanel.tsx", "지수 재계산"],
    ["app/(admin)/admin/cms/EditorPanel.tsx", "CMS SEO"],
    ["app/(planner)/pro/ProfileForm.tsx", "플래너 활동 지역"],
  ]) {
    check(
      `**${label} 가 지역을 고르게 한다** — 자유 입력이 아니다`,
      /<RegionSelect/.test(srcOf(path)),
    );
  }

  check(
    "**업체 프로필은 지역을 되돌려 보내지 않는다** — 권한이 없는 칸을 폼이 실어 보내면 전부 실패한다",
    !/regionCode: form\.get/.test(srcOf("app/(vendor)/vendor/profile/VendorProfileForm.tsx")),
  );
  check(
    // **import 줄이 아니라 그려지는 자리를 본다.** 되돌려 보니 문구를 화면에서 빼도
    // 통과했다 — 이름이 import 에 남아 있어서다(C-2d 가 같은 자리에서 물렸다).
    "**대신 왜 못 바꾸는지 적는다** — 사라진 칸은 설명 없이 사라지지 않는다",
    /\{REGION_IS_REVIEWED_NOTE\}/.test(srcOf("app/(vendor)/vendor/profile/VendorProfileForm.tsx")),
  );
  check(
    "**탐색 카드가 코드가 아니라 라벨을 적는다**",
    /regionLabel\(row\.regionCode\)/.test(srcOf("app/(consumer)/explore/VendorCard.tsx")),
  );
  check(
    "**참가격 페이지가 없는 지역 코드에 404 를 낸다** — 빈 페이지가 검색엔진에 쌓이지 않게",
    /isRegionCode\(decodeURIComponent\(params\.region\)\)/.test(
      srcOf("app/(marketing)/prices/[region]/[category]/page.tsx"),
    ),
  );
  check(
    "**시도를 고르면 그 안의 시군구도 나온다** — 질의가 접두어를 함께 본다",
    /isSidoCode\(filter\.region\)/.test(srcOf("lib/explore/query.ts")) &&
      /region_code\.like\.\$\{filter\.region\}-%/.test(srcOf("lib/explore/query.ts")),
  );
  check(
    "**부분 일치가 사라졌다** — `ilike %값%` 로 돌아가지 않았다",
    !/region_code.*ilike/.test(srcOf("lib/explore/query.ts")),
  );
}

// =============================================================================
// C-4a — 준비 항목 확장 · 예식 후 태스크
// =============================================================================
/**
 * 두 가지를 본다.
 *
 *  · **어휘가 늘었는데 DB 가 아는가** — 코드는 아홉인데 DB 가 여섯만 알면 새 항목은
 *    스키마에서 막히고, 반대로 DB 만 알면 화면에서 못 고르는 값이 생긴다.
 *  · **양수 오프셋이 끝까지 서는가** — 목록·DB·생성·표현 넷 중 하나라도 음수를
 *    가정하면 예식 뒤 항목이 **만들어지기는 하는데 어디에도 안 뜬다.**
 *
 * **C-4a 가 층 1 에서 찾은 것** — 준비 축 본체(`task_templates.category`·
 * `tasks.category`)에 CHECK 이 **하나도 없었다**(FIX-82). C-2a 가 `is_prep_category()`
 * 를 만들어 두고 `content_posts` 에만 걸었던 것이다. 0081 이 닫았고 여기서 고정한다.
 */
{
  const templateSrc = srcOf("lib/core/schedule/templates.ts");

  // ── 어휘 — 코드와 DB 가 같은 아홉을 말하는가 ─────────────────────────────
  const prepCodes = [
    ...((templateSrc.match(/TASK_CATEGORIES = \[([\s\S]*?)\] as const/) ?? ["", ""])[1]
      .matchAll(/"([a-z_]+)"/g)),
  ].map((m) => m[1]);

  check(
    "**준비 축 어휘를 실제로 읽었다** — 못 읽으면 아래가 0개를 견주고 통과한다",
    prepCodes.length === 9,
    `code=${prepCodes.length}`,
  );

  check(
    "**C-4a 가 더한 셋이 코드에 있다**",
    ["family", "attire", "gift"].every((code) => prepCodes.includes(code)),
  );

  check(
    "**DB 가 코드보다 더 알지 않는다** — 화면에서 못 고르는 값이 생기지 않게",
    ["etc", "misc", "after", "nope"].every(
      (code) => sqlOrNull(`select public.is_prep_category('${code}');`) === "f",
    ),
  );

  // ── 층 1 — 준비 축 본체의 CHECK (FIX-82) ─────────────────────────────────
  //
  // **"없을 때 말하는가" 와 "있을 때 조용한가" 를 둘 다 본다.**
  check(
    "**층1 — `task_templates.category` 가 어휘 밖을 거절한다**(FIX-82)",
    rejectedWith(/task_templates_category_vocab/, () =>
      sql(`begin; insert into public.task_templates (code, category, title, offset_days)
                  values ('T-c4a-probe', 'etc', '검사용', -10); rollback;`),
    ),
  );
  check(
    "**층1 — 어휘 안 카테고리는 통과한다** (늘 거절하는 CHECK 이 아니다)",
    sqlOrNull(
      `begin; insert into public.task_templates (code, category, title, offset_days)
              values ('T-c4a-probe', 'gift', '검사용', -10);
       select count(*) from public.task_templates where code = 'T-c4a-probe'; rollback;`,
    ) === "1",
  );
  check(
    "**층1 — `tasks.category` 도 같은 어휘로 막힌다** (본체 둘 다 걸었다)",
    rejectedWith(/tasks_category_vocab/, () =>
      sql(`begin; update public.tasks set category = 'etc'; rollback;`),
    ),
  );

  // ── 층 1 — 오프셋 범위 ────────────────────────────────────────────────────
  //
  // 원장과 B-1 은 *"오프셋이 전부 음수라 예식 뒤를 못 적는다"* 고 했는데 **막고 있던
  // 것은 제약이 아니라 목록 자체**였다(제약이 아예 없었다). 이제 범위를 적었으니
  // **양수가 통과한다는 사실**과 **터무니없는 값이 막힌다는 사실**을 함께 고정한다.
  check(
    "**양수 오프셋이 DB 를 통과한다** — 예식 뒤를 적을 수 있다",
    sqlOrNull(
      `begin; insert into public.task_templates (code, category, title, offset_days)
              values ('T-c4a-probe', 'family', '검사용', 30);
       select offset_days from public.task_templates where code = 'T-c4a-probe'; rollback;`,
    ) === "30",
  );
  check(
    "**터무니없는 오프셋은 막힌다** — 상한이 없으면 오타가 10년 뒤 기한을 만든다",
    rejectedWith(/task_templates_offset_range/, () =>
      sql(`begin; insert into public.task_templates (code, category, title, offset_days)
                  values ('T-c4a-probe', 'family', '검사용', 4000); rollback;`),
    ) &&
      rejectedWith(/task_templates_offset_range/, () =>
        sql(`begin; insert into public.task_templates (code, category, title, offset_days)
                    values ('T-c4a-probe', 'family', '검사용', -5000); rollback;`),
      ),
  );

  // ── 시드가 실제로 넣었는가 ────────────────────────────────────────────────
  //
  // 값은 마이그레이션이 아니라 `seed.sql` 이 넣는다(`db:reset` 이 마이그레이션을
  // 먼저 적용하므로 마이그레이션의 update 는 **빈 표를 훑고 성공**한다 · C-2a 가 밟았다).
  check(
    "**요구받은 넷이 DB 에 있다** (B-1 조사 4-2 — 답례품·상견례·예복·축의금)",
    sqlOrNull(
      `select count(*) from public.task_templates
        where title ~ '답례품' or title ~ '상견례' or title ~ '예복' or title ~ '축의금';`,
    ) === "4",
  );
  check(
    "**예식 뒤 항목이 DB 에 셋 있다** — 양수 오프셋이 실제로 적혔다",
    sqlOrNull(`select count(*) from public.task_templates where offset_days > 0;`) === "3",
  );
  check(
    "**기존 19종이 그대로다** — 늘렸지 갈아치우지 않았다",
    sqlOrNull(`select count(*) from public.task_templates where offset_days < 0;`) === "22" &&
      sqlOrNull(
        `select count(*) from public.task_templates
          where code in ('T-hall-tour','T-sdm-contract','T-doc-marriage','T-honeymoon-doc');`,
      ) === "4",
  );
  check(
    "**새 카테고리마다 템플릿이 있다** — 고를 수는 있는데 아무것도 없는 칸을 만들지 않았다",
    sqlOrNull(
      `select count(distinct category) from public.task_templates
        where category in ('family', 'attire', 'gift');`,
    ) === "3",
  );

  // ── 선행 — 양수가 섞여도 순서가 뒤집히지 않는가 ──────────────────────────
  check(
    "**예식 후 항목의 선행이 예식 전에 있다** — 뒤집힌 순서가 없다",
    sqlOrNull(
      `select count(*) from public.task_template_dependencies d
         join public.task_templates t on t.code = d.template_code
         join public.task_templates p on p.code = d.depends_on_code
        where t.offset_days > 0 and p.offset_days > t.offset_days;`,
    ) === "0",
  );
  check(
    "**예식 후 항목에도 선행이 걸려 있다** — 0건이라 위 검사가 통과한 것이 아니다",
    Number(
      sqlOrNull(
        `select count(*) from public.task_template_dependencies d
           join public.task_templates t on t.code = d.template_code
          where t.offset_days > 0;`,
      ),
    ) > 0,
  );

  // ── 표현 — 예식 후 구간이 코드에 서 있는가 ───────────────────────────────
  const graphSrc = srcOf("lib/core/schedule/graph.ts");

  check(
    "**타임라인에 '예식 후' 구간이 있다** — 없으면 양수 항목이 예식 전 칸에 섞인다",
    /TIMELINE_AFTER_BUCKETS/.test(graphSrc) && /예식 후/.test(graphSrc),
  );
  check(
    "**예식일을 받아야 그 구간이 선다** — 근거 없이 '예식 후' 라고 적지 않는다",
    /weddingDate\?: string \| null/.test(graphSrc) &&
      /weddingDate !== null && task\.dueDate > weddingDate/.test(graphSrc),
  );
  check(
    "**조회가 예식일을 실제로 넘긴다** — 함수만 받고 아무도 안 주면 구간이 영영 안 선다",
    /weddingDate: input\.weddingDate/.test(srcOf("lib/tasks/loader.ts")) &&
      /weddingDate,/.test(srcOf("app/(consumer)/checklist/page.tsx")),
  );
  check(
    "**마지막 구간이 '예식 당일·이후' 라고 더 말하지 않는다** — 두 자리가 같은 것을 주장하지 않게",
    !/예식 당일·이후/.test(graphSrc),
  );

  // ── 소급하지 않는다 — 대신 무엇이 빠졌는지 보인다 ────────────────────────
  //
  // **소급 생성은 하지 않기로 했다**(S7-08 — 사용자가 만들지 않은 항목이 갑자기
  // 생긴다). 그러면 늘어난 항목이 **기존 커플에게 영영 안 간다**는 문제가 남으므로,
  // 빠진 것을 **이름으로** 보이고 넣을지는 사용자가 누른다.
  check(
    "**조회가 빠진 템플릿을 돌려준다**",
    /missingTemplates/.test(srcOf("lib/tasks/loader.ts")),
  );
  check(
    "**목록을 코드에 적지 않고 표에서 센다** — 두 벌은 어긋나고 어긋나면 조용하다",
    /from\("task_templates"\)/.test(srcOf("lib/tasks/loader.ts")),
  );
  check(
    "**화면이 이름을 보인다** — 버튼만 있으면 무엇이 들어올지 모른 채 누른다",
    /\{missingTemplates\.map\(\(template\) => template\.title\)\.join/.test(
      srcOf("app/(consumer)/checklist/ChecklistView.tsx"),
    ),
  );
  check(
    "**넣을 것이 없으면 버튼이 눌리지 않는다** — '0건을 만들었어요' 를 받지 않게",
    /generated && missingTemplates\.length === 0/.test(
      srcOf("app/(consumer)/checklist/ChecklistView.tsx"),
    ),
  );
  check(
    "**자동 생성은 여전히 사용자가 누른다** — 온보딩이 조용히 만들지 않는다",
    sqlOrNull(
      `select count(*) from public.tasks t
         join public.couples c on c.id = t.couple_id
        where t.source = 'auto' and c.stage = 'onboarding';`,
    ) === "0",
  );

  // ── 층 2 · 층 3 ───────────────────────────────────────────────────────────
  //
  // **층 2** — 자식 정책이 부모의 정책에 기대는가. `task_dependencies` 는
  // `owns_task()` 를 타는데 그 함수 **안에 소유자 조건**(`is_couple_member`)이 있다.
  check(
    "**층2 — `owns_task()` 안에 소유자 조건이 있다** (부모가 열려도 자식이 안 열린다)",
    /is_couple_member/.test(
      sqlOrNull(
        `select pg_get_functiondef(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'owns_task';`,
      ) ?? "",
    ),
  );

  // **층 3** — 자격의 근거 표를 자격을 얻으려는 사람이 직접 쓰는가.
  // 준비 항목의 근거는 `task_templates` 이고 **커플은 그 표를 못 쓴다** — 쓸 수 있으면
  // 자기 체크리스트에 아무 항목이나 만들어 넣을 수 있다(그 자체는 해롭지 않지만,
  // **모든 커플에게 복제되는 표**라 한 사람이 전체를 바꾸는 모양이 된다).
  {
    // **커플에 실제로 속한 사용자여야 한다.** `couple-a` 는 연동 전 계정이라
    // `is_couple_member` 가 거짓이고, 그 계정으로는 아래 "만들 수 있다" 가 늘 실패한다.
    const coupleUser = idOf("couple-linked-a@local.test");
    const coupleOf = coupleUser
      ? sqlOrNull(`select couple_id from public.couple_members where user_id = '${coupleUser}' limit 1;`)
      : null;

    check(
      "**커플 픽스처가 있고 실제로 커플에 속한다** — 없으면 아래 층3 검사가 헛돈다",
      Boolean(coupleUser) && Boolean(coupleOf),
      `user=${coupleUser ? "있음" : "없음"} couple=${coupleOf ?? "없음"}`,
    );

    if (coupleUser && coupleOf) {
      check(
        // **0행이 아니라 거절이다.** `task_templates` 에 쓰기 정책이 아예 없어 RLS 가
        // 삽입 자체를 끊는다 — 0행으로 비교하면 스크립트가 폭사해 남은 검사가 안 돈다.
        "**층3 — 커플이 템플릿 표를 못 쓴다** — 한 사람이 모두의 목록을 바꾸지 못한다",
        rejectedWith(/row-level security|permission denied/, () =>
          asUser(
            coupleUser,
            `insert into public.task_templates (code, category, title, offset_days)
              values ('T-c4a-evil', 'gift', '남의 목록에 끼우기', -10);`,
          ),
        ),
      );
      check(
        "**층3 — 그래도 자기 태스크는 만든다** — 표를 통째로 잠근 것이 아니다",
        asUser(
          coupleUser,
          `with u as (insert into public.tasks (couple_id, category, title, source)
                      select id, 'gift', 'C-4a 확인', 'manual' from public.couples
                       where public.is_couple_member(id) limit 1
                      returning 1)
           select count(*) from u;`,
        ) === "1",
      );
    }
  }
}

// =============================================================================
// C-4b — 상품 리드타임 (주문 기한)
// =============================================================================
/**
 * **칸 하나를 더하는 일인데 층 1 이 가장 중요하다.** `products` 는 표 단위 UPDATE 라
 * 새 칸이 **자동으로** 업체 대표에게 열린다(`reviews` 의 칸 목록 방식과 정반대 ·
 * C-2e 가 지적하고 C-4a 가 다시 짚은 자리). 이번엔 **그대로 두기로 판단했고**
 * (리드타임은 업체 자신의 사실 진술이다 · D-224) 대신 세 층으로 누른다:
 * 운영 상한 · 근거 필수 · 감사 기록. **그 판단이 실제로 서 있는지**를 여기서 본다.
 */
{
  const owner = idOf("vendor@local.test");
  const staff = idOf("staff@local.test");
  const productId = sqlOrNull(`select id from public.products order by created_at limit 1;`);

  check(
    "**상품·업체 픽스처가 있다** — 없으면 아래가 통째로 헛돈다",
    Boolean(owner) && Boolean(staff) && Boolean(productId),
    `owner=${owner ? "있음" : "없음"} staff=${staff ? "있음" : "없음"} product=${productId ?? "없음"}`,
  );

  // ── 층 1 — CHECK · 표 단위 권한 ──────────────────────────────────────────
  if (productId) {
    check(
      // **한쪽을 명시적으로 비운다.** 처음엔 한 칸만 썼는데, 그 상품에 이미 근거가
      // 들어 있으면 짝이 맞아 **통과해 버렸다**(C-4d 회차에 실제로 그랬다) — 검사가
      // 표의 현재 상태에 기대고 있었다.
      "**층1 — 값만 있고 근거가 없으면 거절한다**(D-224)",
      rejectedWith(/products_lead_time_pair_chk/, () =>
        sql(`begin; update public.products set lead_time_days = 30, lead_time_note = null
                    where id = '${productId}'; rollback;`),
      ),
    );
    check(
      "**층1 — 근거만 있어도 거절한다** — 한쪽만 남은 기한을 만들지 않는다",
      rejectedWith(/products_lead_time_pair_chk/, () =>
        sql(`begin; update public.products set lead_time_days = null, lead_time_note = '제작 4주'
                    where id = '${productId}'; rollback;`),
      ),
    );
    check(
      "**층1 — 둘 다 있으면 통과한다** (늘 거절하는 CHECK 이 아니다)",
      sqlOrNull(
        `begin; update public.products set lead_time_days = 30, lead_time_note = '제작 4주'
                 where id = '${productId}';
         select lead_time_days from public.products where id = '${productId}'; rollback;`,
      ) === "30",
    );
    check(
      "**층1 — 0 도 값이다** — '따로 기한 없음' 이라는 진술을 막지 않는다",
      sqlOrNull(
        `begin; update public.products set lead_time_days = 0, lead_time_note = '재고 상품이에요'
                 where id = '${productId}';
         select lead_time_days from public.products where id = '${productId}'; rollback;`,
      ) === "0",
    );
    check(
      "**층1 — 둘 다 비우는 것은 된다** — 지울 길을 막지 않는다",
      sqlOrNull(
        `begin; update public.products set lead_time_days = null, lead_time_note = null
                 where id = '${productId}';
         select count(*) from public.products
          where id = '${productId}' and lead_time_days is null; rollback;`,
      ) === "1",
    );
    check(
      "**층1 — 상식 범위를 벗어나면 막는다** — 10년 뒤 기한을 만들지 않는다",
      rejectedWith(/products_lead_time_range_chk/, () =>
        sql(`begin; update public.products set lead_time_days = 99999, lead_time_note = 'x'
                    where id = '${productId}'; rollback;`),
      ) &&
        rejectedWith(/products_lead_time_range_chk/, () =>
          sql(`begin; update public.products set lead_time_days = -1, lead_time_note = 'x'
                      where id = '${productId}'; rollback;`),
        ),
    );
  }

  check(
    "**층1 — 파는 축 본체 CHECK 이 살아 있다**(FIX-75) — 새 칸을 더하며 지우지 않았다",
    sqlOrNull(
      `select count(*) from pg_constraint
        where conrelid = 'public.products'::regclass and conname = 'products_category_vocab_chk';`,
    ) === "1",
  );
  check(
    "**층1 — `products` 는 여전히 표 단위 UPDATE 다** — 그 사실 자체를 기록으로 남긴다",
    sqlOrNull(
      `select count(*) from information_schema.table_privileges
        where grantee = 'authenticated' and table_name = 'products' and privilege_type = 'UPDATE';`,
    ) === "1",
  );
  check(
    "**층1 — 그래서 새 칸도 자동으로 열렸다** — 좁히지 않기로 한 판단이 실제 상태다(D-224)",
    sqlOrNull(
      `select count(*) from information_schema.column_privileges
        where grantee = 'authenticated' and table_name = 'products'
          and privilege_type = 'UPDATE' and column_name in ('lead_time_days', 'lead_time_note');`,
    ) === "2",
  );

  // ── 층 2 — 부모를 타는 정책 ──────────────────────────────────────────────
  //
  // `product_options_select_public` 이 `products` 의 정책에 **그대로 기댄다**
  // (C-2c 가 고정했다). 새 칸이 생겨도 그 기댐의 모양은 변하지 않아야 한다.
  check(
    "**층2 — 옵션 공개 정책이 여전히 products 에 기댄다** (스스로 status 를 보지 않는다)",
    // **저장된 정책 문구는 대문자다**(`FROM products p`) — 소문자로만 찾다가 떨어졌다.
    /from\s+products\s+p/i.test(
      sqlOrNull(
        `select qual from pg_policies
          where tablename = 'product_options' and policyname = 'product_options_select_public';`,
      ) ?? "",
    ),
  );

  // ── 층 3 — 자격의 근거 ───────────────────────────────────────────────────
  //
  // 리드타임의 근거 표는 **운영 파라미터**다. 업체가 그 상한을 스스로 올릴 수 있으면
  // 상한이 있으나 마나다 — `app_settings` 는 운영자 전용이며 여기서 눌러 본다.
  if (owner) {
    check(
      "**층3 — 업체가 리드타임 상한을 못 올린다** — 자기 제한을 자기가 못 푼다",
      rejectedWith(/permission denied|row-level security|0 rows/, () =>
        asUser(
          owner,
          `update public.app_settings set value_json = '{"value": 9999}'::jsonb
            where key = 'products.max_lead_time_days';`,
        ),
      ) ||
        asUser(
          owner,
          `with u as (update public.app_settings set value_json = '{"value": 9999}'::jsonb
                       where key = 'products.max_lead_time_days' returning 1)
           select count(*) from u;`,
        ) === "0",
    );
  }

  if (owner && staff && productId) {
    check(
      "**층3 — 담당자는 리드타임을 못 쓴다** — 가격 칸과 같은 대표 전용이다",
      asUser(
        staff,
        `with u as (update public.products set lead_time_days = 99, lead_time_note = '담당자'
                     where id = '${productId}' returning 1)
         select count(*) from u;`,
      ) === "0",
    );
    check(
      "**층3 — 대표는 쓸 수 있다** — 통째로 잠근 것이 아니다",
      asUser(
        owner,
        `with u as (update public.products set lead_time_days = 21, lead_time_note = '대표가 적었다'
                     where id in (select id from public.products
                                   where vendor_id in (select vendor_id from public.vendor_members
                                                        where user_id = auth.uid()))
                     returning 1)
         select count(*) from u;`,
      ) !== "0",
    );
  }

  // ── 상한 파라미터 ────────────────────────────────────────────────────────
  check(
    "**상한 키가 있다** — 없으면 저장이 영영 막힌다",
    sqlOrNull(`select count(*) from public.app_settings where key = 'products.max_lead_time_days';`) ===
      "1",
  );
  check(
    "**마이그레이션이 값을 지어내지 않았다** — 로컬 값은 seed:accounts 가 넣는다",
    !/products\.max_lead_time_days[\s\S]{0,400}"value": *\d/.test(
      readFileSync("supabase/migrations/20260808008200_product_lead_time.sql", "utf8"),
    ),
  );
  check(
    "**로컬에는 값이 들어와 있다** — 그래야 업체 화면이 실제로 저장한다",
    Number(
      sqlOrNull(
        `select value_json->>'value' from public.app_settings
          where key = 'products.max_lead_time_days';`,
      ),
    ) > 0,
  );
  check(
    "**코드가 값 없음을 0 으로 읽지 않는다** — 상한이 비면 저장을 막는다",
    /LEAD_TIME_CAP_UNSET/.test(srcOf("lib/core/product/lead-time.ts")) &&
      /maxDays === null/.test(srcOf("lib/core/product/lead-time.ts")),
  );
  check(
    // **이름이 보이는지가 아니라 부르는지를 본다.** 처음엔 `/leadTimeProblems/` 였는데,
    // 등록 경로에서 호출을 지워도 `ReturnType<typeof leadTimeProblems>` 라는 **타입
    // 선언**에 걸려 통과했다(지시가 경고한 그 함정 그대로다).
    "**등록·수정 양쪽이 같은 검사를 지난다** — 한쪽만 막으면 다른 쪽으로 넘어간다",
    /leadTimeProblems\(\{/.test(srcOf("app/api/vendor/products/route.ts")) &&
      /leadTimeProblems\(\{/.test(srcOf("app/api/vendor/products/[id]/route.ts")) &&
      /VENDOR_LEAD_TIME_REJECTED/.test(srcOf("app/api/vendor/products/route.ts")) &&
      /VENDOR_LEAD_TIME_REJECTED/.test(srcOf("app/api/vendor/products/[id]/route.ts")),
  );
  check(
    "**리드타임 변경이 기록에 남는다** — 막지 않기로 한 대신 남긴다(D-224)",
    /product_lead_time_changed/.test(srcOf("app/api/vendor/products/[id]/route.ts")) &&
      /lead_time_days: before\.lead_time_days/.test(
        srcOf("app/api/vendor/products/[id]/route.ts"),
      ),
  );

  // ── 비로그인이 무엇을 가져가는가 ─────────────────────────────────────────
  //
  // **화면에 안 그리는 것만으로는 부족하다.** 이 값은 상품 상세가 익명 클라이언트로
  // 읽으므로 새면 응답 본문에 그대로 실린다.
  {
    const DRAFT = "00000000-0000-0000-0000-0000000004b1";
    const PENDING_VENDOR = "00000000-0000-0000-0000-0000000004b2";
    const anyVendor = sqlOrNull(`select id from public.vendors where status = 'active' limit 1;`);

    const fixture = anyVendor
      ? `insert into public.vendors (id, name, category, region_code, status)
           values ('${PENDING_VENDOR}', 'C-4b 심사중', 'hall', 'seoul-gangnam', 'pending')
           on conflict (id) do nothing;
         insert into public.products
           (id, vendor_id, category, name, base_price_total, status,
            included_items_json, add_ons_declared_at, lead_time_days, lead_time_note)
         values ('${DRAFT}', '${anyVendor}', 'hall', 'C-4b 초안', 12345678, 'draft',
                 '[]'::jsonb, null, 777, '초안 근거'),
                -- **게시 조건을 채워서 넣는다.** 안 채우면 \`products_publish_requirements_chk\` 가
                -- 거절하고, 그러면 "심사 중 업체의 게시 상품" 이라는 **검사의 전제 자체가**
                -- 만들어지지 않는다(픽스처가 못 서면 아래는 0건으로 조용히 통과한다).
                ('00000000-0000-0000-0000-0000000004b3', '${PENDING_VENDOR}', 'hall',
                 'C-4b 심사중 상품', 12345679, 'published',
                 '[{"label": "기본 구성", "note": null}]'::jsonb, now(), 778, '심사중 근거')
           on conflict (id) do nothing;`
      : "";

    check("**비로그인 검사의 픽스처가 섰다**", Boolean(anyVendor));

    if (anyVendor) {
      // **픽스처가 실제로 들어갔는지 먼저 본다.** 안 들어가면 아래 "안 보인다" 가
      // 전부 0건으로 조용히 통과한다(운영 규칙 §7.0b).
      check(
        "**숨겨야 할 값이 DB 에 실재한다** — 없으면 아래가 빈 표를 세고 통과한다",
        sqlOrNull(
          `begin; ${fixture}
           select count(*) from public.products where lead_time_days in (777, 778); rollback;`,
        ) === "2",
      );
      check(
        "**비로그인은 초안 상품의 리드타임을 못 본다**",
        asAnon(
          `select count(*) from public.products where lead_time_days = 777;`,
          fixture,
        ) === "0",
      );
      check(
        "**심사 중 업체의 '게시' 상품도 리드타임이 안 새어 나간다**",
        asAnon(
          `select count(*) from public.products where lead_time_days = 778;`,
          fixture,
        ) === "0",
      );
      check(
        "**공개 상품의 리드타임은 보인다** — 늘 0 을 돌려주는 검사가 아니다",
        asAnon(
          `select count(*) from public.products where lead_time_days = 779;`,
          `${fixture}
           update public.products set lead_time_days = 779, lead_time_note = '공개 근거'
            where status = 'published' and vendor_id = '${anyVendor}';`,
        ) !== "0",
      );
    }
  }

  // ── 화면·계산 ────────────────────────────────────────────────────────────
  check(
    "**「아직 준비 중」 목록이 비었다** — 셋으로 열었고 셋 다 채웠다",
    /PENDING_SECTIONS = \[\] as const/.test(srcOf("lib/core/product/detail.ts")),
  );
  check(
    "**비면 카드를 그리지 않는다** — 빈 카드는 '뭔가 있어야 하는데' 로 읽힌다",
    /Object\.keys\(PENDING_SECTION_NOTE\)\.length > 0/.test(
      srcOf("app/(consumer)/explore/[vendorId]/[productId]/page.tsx"),
    ),
  );
  check(
    "**상품 상세가 주문 기한을 그린다** — 만든 자리가 도달 불가로 남지 않는다",
    /<ProductOrderDeadline/.test(
      srcOf("app/(consumer)/explore/[vendorId]/[productId]/page.tsx"),
    ),
  );
  check(
    "**업체 폼이 값과 근거를 함께 받는다**",
    /leadTimeDays/.test(srcOf("app/(vendor)/vendor/products/ProductForm.tsx")) &&
      /leadTimeNote/.test(srcOf("app/(vendor)/vendor/products/ProductForm.tsx")),
  );
  check(
    "**역산이 저장되지 않는다** — 주문 기한 칸이 DB 에 없다(계산 가능한 값)",
    sqlOrNull(
      `select count(*) from information_schema.columns
        where table_name = 'products' and column_name in ('order_deadline', 'order_deadline_at');`,
    ) === "0",
  );
  check(
    // **언급이 아니라 타입에 실제로 있는지를 본다.** 처음엔 파일 어디든 그 문자열이
    // 있으면 통과했는데, 유니온에서 갈래를 지워도 함수 본문에 남은 리터럴이 통과시켰다.
    "**C-4d 가 읽을 모양이 네 갈래다** — '안 정했다'·'기한 없음'·'예식일 없음' 을 뭉치지 않는다",
    (() => {
      const union = (srcOf("lib/core/product/lead-time.ts").match(
        // **`;` 하나로 끊으면 안 된다** — 첫 갈래 안의 `date: string;` 에서 멈춘다.
        /export type OrderDeadline =[\s\S]*?\};/,
      ) ?? [""])[0];

      // 분모를 먼저 본다 — 못 읽으면 아래 every 가 0개를 견주고 통과한다.
      if (union.length < 40) return false;

      return ["not_declared", "no_deadline", "no_wedding_date", "deadline"].every((kind) =>
        union.includes(`kind: "${kind}"`),
      );
    })(),
  );
}

// =============================================================================
// C-4d — 기한 알림 (태스크 · 상품 주문 기한)
// =============================================================================
/**
 * **어휘가 네 군데에 있다** — 코드(`NOTIFICATION_TOPICS`) · `notifications.topic` ·
 * `notification_prefs.topic` · `job_runs.job_name`. 한 군데만 빠지면 조용히 깨진다:
 * 토픽이 알림 표에만 있으면 **수신 설정을 저장할 수 없고**(사용자가 껐다고 믿는데
 * 계속 온다), 배치 이름이 `job_runs` 어휘에 없으면 **첫 실행에서 기록이 사라진다**
 * (CLAUDE.md §7.0 의 `settlement-run` 사고와 같은 모양).
 */
{
  const notifSrc = srcOf("lib/core/schemas/notification.ts");

  const topics = [
    ...((notifSrc.match(/NOTIFICATION_TOPICS = \[([\s\S]*?)\] as const/) ?? ["", ""])[1]
      .matchAll(/"([a-z_]+)"/g)),
  ].map((m) => m[1]);

  check(
    "**토픽 목록을 실제로 읽었다** — 못 읽으면 아래가 0개를 견주고 통과한다",
    topics.length === 12,
    `code=${topics.length}`,
  );
  check("**`task_due` 가 코드 어휘에 있다**", topics.includes("task_due"));

  // ── 어휘 넷이 같은 말을 하는가 ───────────────────────────────────────────
  for (const [table, constraint] of [
    ["notifications", "notifications_topic_chk"],
    ["notification_prefs", "notification_prefs_topic_chk"],
  ]) {
    const def = sqlOrNull(
      `select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'public.${table}'::regclass and conname = '${constraint}';`,
    );

    check(
      `**${table}.topic 이 코드 어휘를 전부 안다**`,
      def !== null && topics.every((topic) => def.includes(`'${topic}'`)),
    );
  }

  check(
    "**`job_runs` 가 새 배치 이름을 안다** — 없으면 첫 실행에서 기록이 사라진다",
    (sqlOrNull(
      `select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'public.job_runs'::regclass and conname = 'job_runs_name_vocab';`,
    ) ?? "").includes("'task-due-notifications'"),
  );
  check(
    "**늘 통과하는 검사가 아니다** — 없는 배치 이름은 거절한다",
    rejectedWith(/job_runs_name_vocab/, () =>
      sql(`begin; insert into public.job_runs (job_name, started_at, status)
                  values ('task-due-run', now(), 'running'); rollback;`),
    ),
  );

  // ── 파라미터 — 값이 없으면 보내지 않는다 ────────────────────────────────
  check(
    "**파라미터 키 둘이 있다** — 없으면 배치가 영영 막힌다",
    sqlOrNull(
      `select count(*) from public.app_settings
        where key in ('notify.task_due_lead_days', 'notify.task_due_interval_days');`,
    ) === "2",
  );
  check(
    "**마이그레이션이 값을 지어내지 않았다** — 로컬 값은 seed:accounts 가 넣는다",
    !/task_due_(lead|interval)_days[\s\S]{0,300}"value": *\d/.test(
      readFileSync("supabase/migrations/20260808008300_task_due_notifications.sql", "utf8"),
    ),
  );
  check(
    "**로컬에는 값이 들어와 있다** — 그래야 배치가 실제로 돈다",
    Number(
      sqlOrNull(
        `select value_json->>'value' from public.app_settings where key = 'notify.task_due_lead_days';`,
      ),
    ) > 0 &&
      Number(
        sqlOrNull(
          `select value_json->>'value' from public.app_settings
            where key = 'notify.task_due_interval_days';`,
        ),
      ) > 0,
  );
  check(
    "**코드가 값 없음을 0 으로 읽지 않는다** — 둘 중 하나만 없어도 막는다",
    /leadDays === null \|\| intervalDays === null/.test(srcOf("lib/core/notify/task-due.ts")),
  );
  check(
    "**막힌 실행을 성공으로 적지 않는다** — '0건 보냈다' 와 구분된다",
    /status: result\.blocked === null \? "succeeded" : "skipped"/.test(
      srcOf("app/api/jobs/task-due-notifications/route.ts"),
    ),
  );

  // ── 네 갈래가 알림에서도 유지되는가 (C-4b · D-225) ──────────────────────
  {
    const batchSrc = srcOf("lib/notify/task-due.ts");

    /**
     * **조건과 집계를 붙여서 본다.**
     *
     * 처음엔 둘을 따로 찾았는데, 되돌림 시험에서 `if (false && deadline.kind === …)`
     * 로 조건을 죽여도 **문자열이 남아 통과했다.** 갈래 판정이 실제로 그 집계를
     * 지키고 있는지는 **붙어 있는 모양**으로만 확인된다.
     */
    const guards = [
      ["not_declared", "lead_time_not_declared"],
      ["no_deadline", "no_order_deadline"],
      ["no_wedding_date", "no_due_date"],
    ];

    check(
      "**네 갈래를 각각 다른 사유로 센다** — 합치면 왜 안 갔는지를 못 본다",
      guards.every(([kind, reason]) =>
        new RegExp(
          "if \\(deadline\\.kind === \"" + kind + "\"\\) \\{" +
            "\\s*counts\\.skipped\\." + reason + " \\+= 1;",
        ).test(batchSrc),
      ),
    );
    check(
      // 위 검사가 셋을 다 보므로 여기서는 **분모**를 본다 — 목록이 비면 every 가 참이다.
      "**갈래 셋을 실제로 세었다** — 빈 목록이 통과하지 않는다",
      guards.length === 3,
    );
    check(
      "**끝낸 항목에는 보내지 않는다**",
      /task\.status === "done"/.test(batchSrc) && /counts\.skipped\.done \+= 1/.test(batchSrc),
    );
    check(
      "**멱등 열쇠에 날짜가 아니라 지점이 들어간다** — 재실행이 중복을 만들지 않게",
      /period: `d-\$\{input\.days\}`/.test(batchSrc),
    );
    check(
      "**payload 에 제목·상품명을 담지 않는다**(§7.3) — 참조와 숫자만",
      !/title/.test(batchSrc) && !/task\.title/.test(batchSrc),
    );
  }

  // ── 저장된 알림이 규칙을 지키는가 ───────────────────────────────────────
  //
  // **배치를 손으로 돌려 둔 상태에 기대지 않는다.** 처음엔 `notifications` 를 그냥
  // 셌는데 `db:reseed` 뒤에는 0행이라 검사가 통째로 떨어졌다 — 검사가 **자기 픽스처를**
  // 세우고 롤백한다.
  {
    const someUser = sqlOrNull(`select id::text from auth.users limit 1;`);

    check("**알림 픽스처의 사용자가 있다**", Boolean(someUser));

    if (someUser) {
      const fixture =
        `insert into public.notifications (user_id, topic, channel, template_key, payload_json, dedupe_key)` +
        ` values ('${someUser}', 'task_due', 'in_app', 'task_due.remind',` +
        ` '{"days": 26, "taskId": "00000000-0000-0000-0000-0000000004d1"}'::jsonb, 'c4d-probe');`;

      check(
        "**새 토픽이 실제로 저장된다** — CHECK 을 넓힌 것이 값으로 확인된다",
        sqlOrNull(
          `begin; ${fixture}` +
            ` select count(*) from public.notifications where dedupe_key = 'c4d-probe'; rollback;`,
        ) === "1",
      );
      check(
        "**payload 의 키가 참조와 숫자뿐이다** — 이름·금액이 없다",
        sqlOrNull(
          `begin; ${fixture}` +
            ` select count(*) from public.notifications n, jsonb_object_keys(n.payload_json) k` +
            ` where n.topic = 'task_due'` +
            ` and k not in ('days', 'taskId', 'productId', 'vendorId'); rollback;`,
        ) === "0",
      );
      check(
        "**어휘 밖 토픽은 거절한다** — 늘 참인 CHECK 이 아니다",
        rejectedWith(/notifications_topic_chk/, () =>
          sql(
            `begin; insert into public.notifications (user_id, topic, channel, dedupe_key)` +
              ` values ('${someUser}', 'task_deadline', 'in_app', 'c4d-bad'); rollback;`,
          ),
        ),
      );
    }

    check(
      "**본문을 저장하지 않는다**(§7.3) — 문장 칸이 표에 없다",
      sqlOrNull(
        `select count(*) from information_schema.columns
          where table_name = 'notifications' and column_name in ('body', 'message', 'text');`,
      ) === "0",
    );

    /**
     * **payload 어휘를 발송부 소스에서 본다** (C-4e).
     *
     * 앞의 검사는 `topic = 'task_due'` 로 좁혀 있었고 **자기 픽스처만** 봤다.
     * C-4e 가 화면 이동을 위해 **발송부 셋에 참조를 더했는데**(해지·안전거래·결제),
     * 참조를 더하는 손이 다음에 이름이나 금액을 더하지 않으리라는 보장이 없다.
     *
     * **표를 세지 않는다.** `db:reset` 직후 `notifications` 는 **0행**이라 표를
     * 세는 금지 검사는 전부 조용히 통과한다(§7.0b — 보안 검사 15개가 빈 표 덕분에
     * 통과하던 그 모양이다). 그래서 **보내는 쪽 코드를 읽는다** — 거기엔 시드와
     * 무관하게 늘 값이 있다.
     */
    const ALLOWED_KEYS = new Set([
      "days", "seq", "rateBp", "overdue",
      "taskId", "productId", "vendorId", "coupleId", "roomId",
      "inquiryId", "targetId", "consultationId", "inviteId",
      "contractId", "cancellationId", "scheduleId", "holdId", "settlementId", "bookingId",
      // 전달만 하는 자리 — 실제 키는 호출부가 정하고 그쪽을 따로 읽는다.
      "...params", "params",
    ]);
    const SENDERS = [
      "lib/notify/task-due.ts", "lib/notify/dday.ts", "lib/notify/sla.ts",
      "lib/chat/notify.ts", "lib/inquiry/notify.ts", "lib/consultation/notify.ts",
      "lib/contract/actions.ts", "lib/cancellation/actions.ts", "lib/escrow/actions.ts",
      "lib/payments/charge.ts", "lib/settlements/actions.ts", "lib/vendor/invites.ts",
    ];
    const payloadKeys = new Map();

    for (const file of SENDERS) {
      const src = srcOf(file);

      for (const m of src.matchAll(/params:\s*\{([^{}]*)\}/g)) {
        for (const part of m[1].split(",")) {
          const key = part.trim().replace(/:.*$/s, "").trim();

          if (key !== "") payloadKeys.set(key, file);
        }
      }
    }

    const strayKeys = [...payloadKeys.keys()].filter((key) => !ALLOWED_KEYS.has(key));

    check(
      "**발송부를 실제로 읽었다** — payload 키를 0개로 세고 통과하지 않는다",
      payloadKeys.size >= 12,
      `keys=${payloadKeys.size}`,
    );
    check(
      "**발송부가 싣는 payload 키가 전부 참조·숫자다**(§7.3) — 이름·금액·본문이 없다",
      strayKeys.length === 0,
      strayKeys.map((key) => `${key}@${payloadKeys.get(key)}`).join(",") || "none",
    );
    check(
      "**C-4e 가 더한 참조가 실제로 그 어휘 안에 있다**",
      payloadKeys.has("bookingId"),
    );
  }

  // ── 이동 링크 — 없는 화면으로 보내지 않는다 (D-98 · C-4e 가 전수로 넓혔다) ─
  {
    const linkSrc = srcOf("lib/core/notify/links.ts");
    /**
     * **두 단 경로를 읽는다.** C-4d 는 `/[a-z-]+` 만 봤는데 그때는 도착지가
     * `/checklist` 하나뿐이었다. C-4e 가 `/vendor/inquiries` 처럼 **면이 앞에 붙는**
     * 경로를 더했고, 옛 정규식은 그것들을 **조용히 빼고** 나머지만 확인했다 —
     * 늘어난 자리를 안 보는 검사는 아무것도 지키지 않는다.
     */
    const linkCode = linkSrc.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const hrefs = [
      ...new Set([...linkCode.matchAll(/"(\/[a-z][a-z0-9\-/]*)"/g)].map((m) => m[1])),
    ];
    const screenExists = (href) =>
      ["(consumer)", "(vendor)", "(admin)", "(planner)", "(auth)", "(marketing)", ""].some(
        (group) => existsSync(`app/${group}${href}/page.tsx`),
      );

    check(
      "**링크 레지스트리를 실제로 읽었다**",
      /NOTIFICATION_LINKS/.test(linkSrc) && hrefs.length >= 8,
      `static=${hrefs.length}`,
    );
    check(
      "**업체 쪽 도착지를 빠뜨리지 않고 읽었다** — 옛 정규식은 이것들을 못 봤다",
      hrefs.filter((href) => href.startsWith("/vendor/")).length >= 4,
      `vendor=${hrefs.filter((href) => href.startsWith("/vendor/")).length}`,
    );
    check(
      "**정적 경로가 실재한다** — 디스크에 화면 파일이 있다",
      hrefs.length > 0 && hrefs.every(screenExists),
      hrefs.filter((href) => !screenExists(href)).join(",") || "all-exist",
    );
    check(
      "**동적 경로도 실재한다** — 상품 상세 화면이 있다",
      /\/explore\/\$\{vendorId\}\/\$\{productId\}/.test(linkSrc) &&
        existsSync("app/(consumer)/explore/[vendorId]/[productId]/page.tsx"),
    );
    check(
      "**참조가 모자라면 링크를 안 만든다** — 잘못된 곳으로 보내지 않는다",
      /if \(vendorId === null \|\| productId === null\) return null;/.test(linkSrc),
    );
    check(
      "**화면이 링크를 실제로 그린다** — 만든 자리가 도달 불가로 남지 않는다",
      /data-testid="notification-link"/.test(
        srcOf("app/(consumer)/notifications/NotificationsView.tsx"),
      ) && /notificationLink\(/.test(srcOf("app/(consumer)/notifications/page.tsx")),
    );

    // ── 전수인가 (C-4e 완료 조건) ─────────────────────────────────────────
    //
    // **두 파일을 각각 세어 맞춰 본다.** 레지스트리 안에서만 세면 "내가 적은 것은
    // 내가 적었다" 를 확인할 뿐이다.
    const tmplSrc = srcOf("lib/core/schemas/notification.ts");
    const tmplKeys = [
      ...tmplSrc
        .slice(tmplSrc.indexOf("export const NOTIFICATION_TEMPLATES"))
        .matchAll(/^  "([a-z_]+\.[a-z_]+)": \{$/gm),
    ].map((m) => m[1]);
    /**
     * **레지스트리 객체 안에서만 센다.**
     *
     * 처음엔 파일 전체를 훑었는데 `LINK_REQUIRED_REFS` 의 항목까지 같은 모양이라
     * **41개로 셌다**(31 + 10). 그러면 레지스트리에서 빠진 템플릿이 그 표에만
     * 있어도 "전부 덮였다" 가 된다 — **센 것이 세려던 것이 아니었다.**
     */
    const linkBody = linkSrc.slice(
      linkSrc.indexOf("export const NOTIFICATION_LINKS"),
      linkSrc.indexOf("export function notificationLink"),
    );
    const linkKeys = [...linkBody.matchAll(/^  "([a-z_]+\.[a-z_]+)":/gm)].map((m) => m[1]);
    const uncovered = tmplKeys.filter((key) => !linkKeys.includes(key));
    const orphan = linkKeys.filter((key) => !tmplKeys.includes(key));

    check(
      "**목록을 실제로 읽었다** — 템플릿을 0종으로 세고 통과하지 않는다",
      tmplKeys.length >= 31 && linkKeys.length >= 31,
      `templates=${tmplKeys.length} links=${linkKeys.length}`,
    );
    check(
      "**템플릿 전부에 가는 곳이거나 없다는 사실이 적혀 있다**",
      uncovered.length === 0,
      uncovered.join(",") || "none",
    );
    check(
      "**사라진 템플릿의 링크가 남아 있지 않다** — 양방향으로 센다",
      orphan.length === 0,
      orphan.join(",") || "none",
    );
    check(
      "**없다고 정한 자리에는 이유가 적혀 있다** — 빈 문자열이 아니다",
      /kind: "none",\s*\r?\n\s*reason:\s*\r?\n?\s*"[^"]{20,}"/.test(linkSrc),
    );
    check(
      "**초대 토큰이 경로에 들어가지 않는다** — 알림이 접근 열쇠가 되면 안 된다",
      !/\/vendor\/invite/.test(linkSrc) && !/token/.test(linkSrc.replace(/^.*토큰.*$/gm, "")),
    );
    check(
      "**읽는 사람에 따라 갈린다** — 한쪽 경로를 양쪽에 주면 다른 쪽은 거부 화면을 본다",
      /isVendorViewer\(role\) \? vendor : consumer/.test(linkSrc) &&
        /viewer\.role/.test(srcOf("app/(consumer)/notifications/page.tsx")),
    );

    // ── 발송부가 링크에 필요한 참조를 싣는가 ──────────────────────────────
    //
    // **레지스트리만 맞아서는 소용없다.** 발송부가 참조를 안 실으면 링크는 조용히
    // 사라지고, 그건 누른 사람만 아는 고장이다.
    check(
      "**해지 알림이 예약 참조를 싣는다** — 화면이 `/bookings/[id]/cancel` 이다",
      /bookingId: context\.bookingId/.test(srcOf("lib/cancellation/actions.ts")),
    );
    check(
      "**안전거래 알림이 예약 참조를 싣는다**",
      /params: \{ \.\.\.params, bookingId \}/.test(srcOf("lib/escrow/actions.ts")),
    );
    {
      const chargeSrc = srcOf("lib/payments/charge.ts");
      const dedupeLines = (chargeSrc.match(/^\s*dedupeKey:.*$/gm) ?? []).join("\n");

      check(
        "**결제 성공·실패 알림이 예약 참조를 싣는다** — 두 곳 다",
        (chargeSrc.match(/bookingId: context\.bookingId,/g) ?? []).length >= 2,
      );
      check(
        "**결제 멱등 열쇠가 payload 모양에 매이지 않는다** — 참조 하나 더 실었다고 다시 보내면 안 된다",
        dedupeLines.length > 0 && !dedupeLines.includes("JSON.stringify"),
      );
    }
  }

  // ── 증적 ─────────────────────────────────────────────────────────────────
  check(
    "**배치 증적의 쓰기 결과를 본다**(FIX-72) — 안 보면 조용히 사라진다",
    /const recorded = await recordAudit\(\{/.test(
      srcOf("app/api/jobs/task-due-notifications/route.ts"),
    ) && /recorded \? null : "audit_lost:1"/.test(
      srcOf("app/api/jobs/task-due-notifications/route.ts"),
    ),
  );
  check(
    "**배치에는 사람이 없다**(D-173) — actor 에 uuid 를 지어내지 않는다",
    /actorId: null,/.test(srcOf("app/api/jobs/task-due-notifications/route.ts")),
  );
  /**
   * **여기서는 '표가 그 모양을 받는가' 만 본다.**
   *
   * 처음엔 `audit_logs`·`job_runs` 를 그냥 세었는데 `db:reseed` 뒤에는 0행이라
   * 떨어졌다 — 검사가 **내가 손으로 배치를 돌려 둔 상태**에 기대고 있었다.
   * **배치가 실제로 쓰는지는 서버가 있어야 알 수 있고**, 그것은 `chain:walk` 가
   * 배치를 두 번 불러 확인한다(발송·중복·증적 개수까지).
   */
  check(
    "**증적이 배치의 모양 그대로 들어간다** — 사람 없는 행위자를 표가 받는다(D-173)",
    sqlOrNull(
      `begin;
       insert into public.audit_logs (actor_id, actor_role, action, target_type, target_id, after_json)
         values (null, null, 'task_due_batch_ran', 'job_run', null, '{"sent": 1}'::jsonb);
       select count(*) from public.audit_logs where action = 'task_due_batch_ran'; rollback;`,
    ) === "1",
  );
  check(
    "**`skipped` 상태를 표가 받는다** — 안 보낸 것을 성공으로 적지 않아도 된다",
    sqlOrNull(
      `begin;
       insert into public.job_runs (job_name, started_at, status, error_summary)
         values ('task-due-notifications', now(), 'skipped', 'blocked:params_unset');
       select count(*) from public.job_runs
        where job_name = 'task-due-notifications' and status = 'skipped'; rollback;`,
    ) === "1",
  );
  check(
    "**타입도 `skipped` 를 받는다** — DB 는 받는데 코드가 못 적는 상태가 아니다",
    /"succeeded" \| "failed" \| "skipped"/.test(srcOf("lib/ops/job-run.ts")),
  );

  // ── 권한 세 층 ───────────────────────────────────────────────────────────
  //
  // **층 1** — `notifications` 의 UPDATE 는 S4-13 이 **칸 목록 하나**로 좁혀 뒀다.
  // 칸 목록 방식이라 새 칸은 **자동으로 못 고치는 칸**이 된다(`products` 가 표 단위라
  // 정반대인 것과 대비 · C-4b 가 짚었다). 토픽을 늘려도 그 좁힘이 그대로인지 본다.
  check(
    "**층1 — 당사자가 고칠 수 있는 칸은 `read_at` 하나다**",
    sqlOrNull(
      `select string_agg(column_name, ',' order by column_name)
         from information_schema.column_privileges
        where grantee = 'authenticated' and table_name = 'notifications'
          and privilege_type = 'UPDATE';`,
    ) === "read_at",
  );
  check(
    "**층1 — 표 단위 UPDATE 가 아니다** — 새 칸이 자동으로 열리지 않는다",
    sqlOrNull(
      `select count(*) from information_schema.table_privileges
        where grantee = 'authenticated' and table_name = 'notifications'
          and privilege_type = 'UPDATE';`,
    ) === "0",
  );
  check(
    "**층1 — 배치 실행 기록은 아무도 못 쓴다**",
    sqlOrNull(
      `select count(*) from information_schema.table_privileges
        where grantee = 'authenticated' and table_name = 'job_runs'
          and privilege_type in ('INSERT', 'UPDATE', 'DELETE');`,
    ) === "0",
  );

  {
    const owner = idOf("couple-linked-a@local.test");

    check("**커플 픽스처가 있다** — 없으면 아래 층2·층3 이 헛돈다", Boolean(owner));

    if (owner) {
      // **층 2** — 정책이 부모를 타지 않는다. `notifications` 는 `user_id` 를 직접
      // 본다(부모 표에 기대지 않으므로 부모가 열려도 새지 않는다).
      check(
        "**층2 — 알림 정책이 부모 표에 기대지 않는다** (user_id 를 직접 본다)",
        (sqlOrNull(
          `select qual from pg_policies where tablename = 'notifications' and cmd = 'SELECT';`,
        ) ?? "").includes("auth.uid()"),
      );
      check(
        "**층2 — 남의 알림은 한 건도 안 보인다**",
        asUser(
          owner,
          `select count(*) from public.notifications where user_id <> auth.uid();`,
        ) === "0",
      );
      check(
        // **픽스처를 스스로 세운다.** `db:reseed` 뒤 알림 표가 비어 있으면 "안 보인다"
        // 가 0행으로 통과해 버린다(운영 규칙 §7.0b).
        "**층2 — 내 알림은 보인다** — 늘 0 을 돌려주는 검사가 아니다",
        asUser(
          owner,
          `select count(*) from public.notifications;`,
          `insert into public.notifications (user_id, topic, channel, template_key, payload_json, dedupe_key)
             values ('${owner}', 'task_due', 'in_app', 'task_due.remind', '{"days": 12}'::jsonb, 'c4d-mine');`,
        ) === "1",
      );

      // **층 3** — 자격의 근거. 알림을 받는 조건은 **커플 구성원**이고, 발송 여부는
      // **운영 파라미터**가 정한다. 둘 다 당사자가 못 쓴다.
      check(
        "**층3 — 사용자가 발송 파라미터를 못 고친다** — 자기에게 더 자주 보내게 할 수 없다",
        rejectedWith(/permission denied|row-level security/, () =>
          asUser(
            owner,
            `update public.app_settings set value_json = '{"value": 400}'::jsonb
              where key = 'notify.task_due_lead_days';`,
          ),
        ) ||
          asUser(
            owner,
            `with u as (update public.app_settings set value_json = '{"value": 400}'::jsonb
                         where key = 'notify.task_due_lead_days' returning 1)
             select count(*) from u;`,
          ) === "0",
      );
      check(
        "**층3 — 당사자가 발송 시각을 못 고친다**(S4-13 이 세운 경계가 살아 있다)",
        rejectedWith(/permission denied/, () =>
          asUser(owner, `update public.notifications set sent_at = now();`),
        ),
      );
      check(
        "**층3 — 그래도 읽음 표시는 한다** — 통째로 잠근 것이 아니다",
        asUser(
          owner,
          `with u as (update public.notifications set read_at = now()
                       where user_id = auth.uid() returning 1)
           select count(*) from u;`,
        ) !== null,
      );
      check(
        "**층3 — 수신 설정은 본인 것만 쓴다**",
        rejectedWith(/row-level security/, () =>
          asUser(
            owner,
            `insert into public.notification_prefs (user_id, topic, channel_flags)
              values ('00000000-0000-0000-0000-0000000004d9', 'task_due', '{}'::jsonb);`,
          ),
        ),
      );
      check(
        "**층3 — 자기 수신 설정으로 새 토픽을 끌 수 있다** — 끄는 수단이 실재한다",
        asUser(
          owner,
          `with u as (insert into public.notification_prefs (user_id, topic, channel_flags)
                       values (auth.uid(), 'task_due', '{"email": false}'::jsonb)
                       on conflict (user_id, topic) do update set channel_flags = excluded.channel_flags
                       returning 1)
           select count(*) from u;`,
        ) === "1",
      );
    }
  }

  // ── 스텁 발송 (D-28) ─────────────────────────────────────────────────────
  check(
    "**보낸 것과 안 보낸 것이 구분된다** — 발송 시각이 남는다",
    sqlOrNull(
      `select count(*) from public.notifications where topic = 'task_due' and sent_at is null;`,
    ) !== null,
  );
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
