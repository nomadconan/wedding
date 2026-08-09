// ============================================================================
// LOCAL ONLY - creates demo accounts so the admin/vendor screens can be opened.
// ============================================================================
//   npm run seed:accounts
//   npm run seed:accounts -- --password=my-password
//   npm run seed:accounts -- --reset          (re-arm the approval demo)
//
// This script only creates ACCOUNT DATA. It does not touch auth/authorization
// code - roles are read by the app exactly as they are in production.
//
// Safety: refuses to run unless NEXT_PUBLIC_SUPABASE_URL points at
// 127.0.0.1/localhost. Never point it at staging or production.
//
// supabase-js is not used on purpose: Node 20 has no global WebSocket and the
// client constructor throws. Plain REST calls work everywhere.
// Console output is ASCII-only for Windows CMD (docs/06 section 3).

import { createHash } from "node:crypto";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const DEFAULT_PASSWORD = "local-dev-1234";

/** 로컬 데모용 사업자등록번호(체크섬 유효). 실재 사업자와 무관하다. */
const DEMO_BUSINESS_NUMBER = "1208147521";
const DEMO_BUSINESS_NUMBER_MASKED = "120-81-*****";

const ACCOUNTS = [
  { email: "admin@local.test", role: "admin", displayName: "운영 관리자", note: "operator (admin)" },
  { email: "ops@local.test", role: "ops", displayName: "운영 담당자", note: "operator (ops)" },
  {
    email: "vendor@local.test",
    role: "vendor_owner",
    displayName: "업체 대표",
    note: "vendor owner (vendor_members)",
  },
  {
    email: "staff@local.test",
    role: "vendor_staff",
    displayName: "업체 담당자",
    note: "vendor staff - cannot change price/settlement (S2-07)",
  },
];

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const passwordArg = args.find((a) => a.startsWith("--password="));
const password = passwordArg ? passwordArg.slice("--password=".length) : DEFAULT_PASSWORD;
const reset = args.includes("--reset");

// ── safety guard ────────────────────────────────────────────────────────────
function assertLocal() {
  if (!URL_ || !SERVICE) {
    console.error("FAIL  NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
    console.error("      Run: npm run env:sync");
    process.exit(1);
  }

  let host;
  try {
    host = new URL(URL_).hostname;
  } catch {
    console.error(`FAIL  NEXT_PUBLIC_SUPABASE_URL is not a URL: ${URL_}`);
    process.exit(1);
  }

  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error("");
    console.error("STOP  This script is for the LOCAL Supabase stack only.");
    console.error(`      NEXT_PUBLIC_SUPABASE_URL points at "${host}".`);
    console.error("      Creating demo accounts on a shared/remote project is not allowed.");
    console.error("");
    process.exit(1);
  }
}

// ── REST helpers ────────────────────────────────────────────────────────────
const svcHeaders = {
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  "Content-Type": "application/json",
};

async function auth(path, init = {}) {
  const response = await fetch(`${URL_}/auth/v1${path}`, {
    ...init,
    headers: { ...svcHeaders, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`auth ${path} -> ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

async function rest(path, init = {}) {
  const response = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { ...svcHeaders, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`rest ${path} -> ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

/** auth.users 전체에서 이메일로 찾는다. 로컬 계정 수가 적어 페이지네이션은 불필요하다. */
async function findUserByEmail(email) {
  const page = await auth("/admin/users?per_page=200");

  return (page.users ?? []).find((user) => user.email === email) ?? null;
}

/**
 * 계정을 만들거나 맞춘다.
 *
 * 이미 있으면 **새로 만들지 않는다.** 대신 비밀번호·이메일 확인·역할을 지정값으로 맞춘다 —
 * 스크립트가 출력한 자격증명이 실제로 로그인되지 않으면 시드의 의미가 없기 때문이다.
 */
async function upsertAccount(account) {
  const existing = await findUserByEmail(account.email);
  let user = existing;
  let created = false;

  if (!existing) {
    user = await auth("/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email: account.email,
        password,
        // 로컬에서 메일 인증 단계를 건너뛴다.
        email_confirm: true,
      }),
    });
    created = true;
  } else {
    await auth(`/admin/users/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify({ password, email_confirm: true }),
    });
  }

  // profiles.role 이 운영자 판정(lib/supabase/auth.ts 의 isOperator)의 유일한 근거다.
  await rest("profiles?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      user_id: user.id,
      display_name: account.displayName,
      role: account.role,
    }),
  });

  return { ...account, id: user.id, created };
}

/**
 * 업체 확인용 데이터.
 *
 * `status = 'pending'` + 신청서 `submitted` 로 둔다. 그래야 admin 계정으로
 * `/admin/vendors` 에서 **실제 승인 플로우를 처음부터 밟아 볼 수 있다.**
 */
async function seedVendor(vendorUser, staffUser) {
  const members = await rest(
    `vendor_members?user_id=eq.${vendorUser.id}&select=vendor_id&limit=1`,
  );

  let vendorId = members[0]?.vendor_id ?? null;
  let created = false;

  if (!vendorId) {
    const [vendor] = await rest("vendors", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        name: "로컬 데모 웨딩홀",
        category: "hall",
        region_code: "서울 강남",
        // 평문 저장 금지(§7.2). 앱과 같은 방식으로 SHA-256 해시만 남긴다.
        biz_no_enc: createHash("sha256").update(DEMO_BUSINESS_NUMBER).digest("hex"),
        status: "pending",
      }),
    });

    vendorId = vendor.id;
    created = true;

    await rest("vendor_members", {
      method: "POST",
      body: JSON.stringify({
        vendor_id: vendorId,
        user_id: vendorUser.id,
        vendor_role: "owner",
      }),
    });
  }

  // staff 계정을 같은 업체에 붙인다. 권한 제한(가격·정산 불가)을 화면에서 확인하려면
  // 담당자 계정이 실제로 있어야 한다(S2-07).
  const staffMembers = await rest(
    `vendor_members?vendor_id=eq.${vendorId}&user_id=eq.${staffUser.id}&select=id&limit=1`,
  );

  if (staffMembers.length === 0) {
    await rest("vendor_members", {
      method: "POST",
      body: JSON.stringify({
        vendor_id: vendorId,
        user_id: staffUser.id,
        vendor_role: "staff",
      }),
    });
  }

  await rest("vendor_applications?on_conflict=vendor_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      vendor_id: vendorId,
      applicant_id: vendorUser.id,
      representative_name: "홍길동",
      contact_phone: "010-1234-5678",
      mail_order_no: "2026-서울강남-01234",
      biz_no_masked: DEMO_BUSINESS_NUMBER_MASKED,
      ...(created || reset
        ? { status: "submitted", review_note: null, reviewed_by: null, reviewed_at: null }
        : {}),
    }),
  });

  if (reset && !created) {
    await rest(`vendors?id=eq.${vendorId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "pending" }),
    });
  }

  const [vendorRow] = await rest(`vendors?id=eq.${vendorId}&select=id,name,status`);
  const [application] = await rest(
    `vendor_applications?vendor_id=eq.${vendorId}&select=status`,
  );

  return { ...vendorRow, applicationStatus: application?.status ?? "-", created };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  assertLocal();

  console.log("");
  console.log(`  target : ${URL_}  (local only)`);
  console.log(`  mode   : ${reset ? "reset (vendor back to pending)" : "idempotent"}`);
  console.log("");

  const results = [];
  for (const account of ACCOUNTS) {
    results.push(await upsertAccount(account));
  }

  const vendorUser = results.find((row) => row.email === "vendor@local.test");
  const staffUser = results.find((row) => row.email === "staff@local.test");
  const vendor = await seedVendor(vendorUser, staffUser);

  console.log("  accounts");
  for (const row of results) {
    console.log(
      `    ${row.email.padEnd(20)} role=${row.role.padEnd(12)} ${row.created ? "created" : "existing (updated)"}`,
    );
  }

  console.log("");
  console.log(`  password : ${password}`);
  console.log("             (local demo credentials - do not commit, do not reuse)");
  console.log("");
  console.log("  vendor data");
  console.log(`    vendor      : ${vendor.name} (${vendor.status})`);
  console.log(`    application : ${vendor.applicationStatus}`);
  console.log("    members     : vendor@local.test (owner) + staff@local.test (staff)");
  console.log("");
  console.log("  try it");
  console.log(`    1. ${APP_URL}/login          -> admin@local.test`);
  console.log(`    2. ${APP_URL}/admin/vendors  -> approve the seeded application`);
  console.log(`    3. ${APP_URL}/login          -> vendor@local.test`);
  console.log(`    4. ${APP_URL}/vendor/apply , /vendor/profile , /vendor/products`);
  console.log(`    5. ${APP_URL}/vendor/members -> staff@local.test 로 로그인하면`);
  console.log("       판매가/추가금 저장이 막히는 것을 확인할 수 있다");
  console.log("");
  console.log("  re-arm the approval demo: npm run seed:accounts -- --reset");
  console.log("");
}

main().catch((error) => {
  console.error("");
  console.error(`FAIL  ${error.message}`);
  console.error("");
  process.exit(1);
});
