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
  {
    email: "couple-a@local.test",
    role: "consumer",
    displayName: "예비부부 A",
    note: "consumer - onboarding owner (S3-01)",
  },
  {
    email: "couple-b@local.test",
    role: "consumer",
    displayName: "예비부부 B",
    note: "consumer - couple invite acceptor (S3-01)",
  },
  // ── linked couple fixture (S4-04) ─────────────────────────────────────────
  // Why two MORE accounts instead of pre-linking couple-a/couple-b:
  //   db:rls needs a couple that already exists. S0-02 needs couple-a/couple-b to
  //   have NO couple, so the onboarding first screen stays reachable. The same
  //   pair cannot serve both. A --flag would work but adds a mode to remember and
  //   leaves one purpose broken by default. Two extra accounts keep BOTH working
  //   with no flag: couple-a/b stay pristine, this pair is always linked.
  {
    email: "couple-linked-a@local.test",
    role: "consumer",
    displayName: "연동 커플 A",
    note: "consumer - onboarding DONE, linked (fixture for db:rls)",
  },
  {
    email: "couple-linked-b@local.test",
    role: "consumer",
    displayName: "연동 커플 B",
    note: "consumer - partner of couple-linked-a",
  },
  // ── planner fixture (S6-01) ───────────────────────────────────────────────
  // WHY a dedicated account: db:rls must prove that a planner sees ONLY what the
  // engagement grants. Reusing a consumer account would make "planner" and
  // "couple member" the same person, and every isolation check would pass for
  // the wrong reason.
  {
    email: "planner@local.test",
    role: "planner",
    displayName: "웨딩 플래너",
    note: "planner - delegation scope + category selection (S6-01)",
  },
];

/** Fixed id so re-runs are idempotent and rls-check can find it deterministically. */
const LINKED_COUPLE_ID = "00000000-0000-0000-0000-00000000c0a1";

/**
 * Onboarding answers (S3-01, 6 questions). Seeded so `stage='active'` is honest -
 * a couple marked complete with no answers would be a state the app never produces.
 */
const LINKED_COUPLE_ANSWERS = [
  ["wedding_date", { value: "2027-05-15" }],
  ["region", { value: "서울 강남" }],
  ["budget", { value: 40000000 }],
  ["guest_count", { value: 150 }],
  ["style", { value: ["modern"] }],
  ["stage", { value: "venue" }],
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

/**
 * Local demo commission rates (S5-03).
 *
 * WHY THIS EXISTS: with zero rows in `commission_rates`, contract issuance fails
 * with CONTRACT_RATE_UNRESOLVED (S5-06) and the whole trade flow - contract,
 * payment, settlement, cancellation - cannot run end to end even locally.
 *
 * WHY NOT IN A MIGRATION: the rate VALUE is still undecided (O-02). Putting a
 * number in a migration would make it look like an operating decision
 * (0031 refused to seed penalty bands for the same reason). A seed script is
 * explicitly local demo data - `seed.sql` says so in its header.
 *
 * The real values go in through /admin/commission-rates (F-A-15).
 */
async function seedDemoRates() {
  const existing = await rest("commission_rates?select=id&limit=1");
  if (existing.length > 0) return "existing";

  await rest("commission_rates", {
    method: "POST",
    body: JSON.stringify({
      scope_type: "global",
      scope_key: null,
      // 500bp = 5%. LOCAL DEMO ONLY - not an operating decision (O-02).
      fee_rate_bp: 500,
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: null,
      memo: "local demo (O-02 undecided) - replace via /admin/commission-rates",
    }),
  });

  await rest("planner_fee_rates", {
    method: "POST",
    body: JSON.stringify({
      scope_type: "global",
      scope_key: null,
      fee_rate_bp: 300,
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: null,
      memo: "local demo (O-02 undecided) - replace via /admin/commission-rates",
    }),
  });

  return "created";
}

/**
 * Local demo AI conversation limits (S7-20).
 *
 * WHY THIS EXISTS: `conversationGate` refuses to open the planner when
 * `ai.free_daily_turns` / `ai.session_token_cap` are unset - an unset cap read
 * as "unlimited" would silently remove the cost ceiling, so the code blocks
 * instead. `seed.sql` therefore declares both keys with a null value, which
 * leaves the planner closed on a clean local database.
 *
 * WHY NOT IN seed.sql: the VALUES are an operating decision that has not been
 * made. Same split as seedDemoRates above - `seed.sql` owns the key, this
 * script owns the local demo number.
 *
 * The real values go in through the operator console (F-A-15 / S8-12).
 */
async function seedDemoAiLimits() {
  const rows = [
    // LOCAL DEMO ONLY - not an operating decision.
    ["ai.free_daily_turns", 20, "turns"],
    ["ai.session_token_cap", 120000, "tokens"],
  ];

  let touched = 0;

  for (const [key, value, unit] of rows) {
    const [existing] = await rest(`app_settings?key=eq.${key}&select=key,value_json`);
    if (!existing) continue;
    if (existing.value_json?.value !== null && existing.value_json?.value !== undefined) continue;

    await rest(`app_settings?key=eq.${key}`, {
      method: "PATCH",
      body: JSON.stringify({
        value_json: { value, unit, status: "local_demo" },
      }),
    });

    touched += 1;
  }

  return touched === 0 ? "existing" : "created";
}

/**
 * Linked couple fixture (S4-04).
 *
 * WHY this exists: `npm run db:rls` needs a couple to test against, but
 * `db:reset` leaves none, so the check used to depend on someone walking the
 * onboarding flow by hand first. That made the RLS suite unrunnable from a clean
 * database - which is exactly when you most want to run it.
 *
 * WHAT IS SEEDED, and why nothing more:
 *   couple + 2 members + 6 onboarding answers.  That is the minimum that makes
 *   `stage='active'` a state the app could actually have produced.
 *
 * WHAT IS DELIBERATELY NOT SEEDED - carts, wishlists, chat rooms:
 *   rls-check builds those inside a transaction and rolls them back. Permanent
 *   rows would collide with its fixtures (the chat fixture would hit
 *   uq_chat_rooms_couple_vendor, the cart fixture the active-cart partial
 *   unique). Permanent demo data would also make every empty-state screen
 *   impossible to review.
 */
async function seedLinkedCouple(ownerUser, partnerUser) {
  const existing = await rest(`couples?id=eq.${LINKED_COUPLE_ID}&select=id`);

  if (existing.length === 0) {
    await rest("couples", {
      method: "POST",
      body: JSON.stringify({
        id: LINKED_COUPLE_ID,
        owner_id: ownerUser.id,
        stage: "active",
        wedding_date: "2027-05-15",
        region_code: "서울 강남",
        guest_count: 150,
        total_budget: 40000000,
      }),
    });
  }

  for (const [user, role] of [
    [ownerUser, "owner"],
    [partnerUser, "partner"],
  ]) {
    const member = await rest(
      `couple_members?couple_id=eq.${LINKED_COUPLE_ID}&user_id=eq.${user.id}&select=id`,
    );

    if (member.length === 0) {
      await rest("couple_members", {
        method: "POST",
        body: JSON.stringify({
          couple_id: LINKED_COUPLE_ID,
          user_id: user.id,
          member_role: role,
        }),
      });
    }
  }

  await rest("onboarding_answers?on_conflict=couple_id,question_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(
      LINKED_COUPLE_ANSWERS.map(([key, value]) => ({
        couple_id: LINKED_COUPLE_ID,
        question_key: key,
        answer_json: value,
      })),
    ),
  });

  return LINKED_COUPLE_ID;
}

/** Fixed ids so re-runs are idempotent and rls-check can find them. */
const PLANNER_ID = "00000000-0000-0000-0000-00000000c0b1";
const ENGAGEMENT_ID = "00000000-0000-0000-0000-00000000c0b2";

/**
 * Planner fixture (S6-01).
 *
 * WHAT IS SEEDED: the planner record + an ACTIVE engagement over the linked
 * couple, scoped to the tables S3-04/S4-07 already opened (couples, carts,
 * consultations). Chat and payments are deliberately absent - S4-01/S5-06 closed
 * those and the fixture must not quietly widen them.
 *
 * WHAT IS NOT SEEDED: planner_scopes rows. Category selection is the customer's
 * act (F-C-31) and rls-check builds those inside a rolled-back transaction, the
 * same way it handles carts and chat rooms.
 */
async function seedPlanner(plannerUser, coupleId) {
  if (!plannerUser) return "skipped";

  const existing = await rest(`planners?id=eq.${PLANNER_ID}&select=id`);

  if (existing.length === 0) {
    await rest("planners", {
      method: "POST",
      body: JSON.stringify({
        id: PLANNER_ID,
        user_id: plannerUser.id,
        // active so the market screen has something to show. In production this
        // is a review outcome, not a self-declaration (0037 trigger blocks
        // self-activation) - the seed writes it with the service role.
        status: "active",
        regions: ["서울 강남", "서울 서초"],
        // Fees live in planner_fee_rates (S5-01) - never in the profile.
        // A CHECK keeps fee_json empty (0037).
        profile_json: {
          headline: "10년차 스드메 전문 플래너",
          bio: "스튜디오·드레스·메이크업 위주로 함께 준비합니다.",
          careerYears: 10,
          categories: ["studio", "dress", "makeup"],
        },
      }),
    });
  }

  const engagement = await rest(`planner_engagements?id=eq.${ENGAGEMENT_ID}&select=id`);

  if (engagement.length === 0) {
    await rest("planner_engagements", {
      method: "POST",
      body: JSON.stringify({
        id: ENGAGEMENT_ID,
        planner_id: PLANNER_ID,
        couple_id: coupleId,
        // Only the tables S3-04/S4-07 opened. Chat/payments stay closed.
        scope_json: { tables: ["couples", "carts", "consultations"] },
        status: "active",
        valid_from: "2026-01-01T00:00:00Z",
        valid_to: null,
      }),
    });
  }

  return "created";
}

// ── metrics fixture (S8-01) ─────────────────────────────────────────────────
// Fixed ids so re-runs are idempotent and rls-check can find them.
const METRIC_PRODUCT_ID = "00000000-0000-0000-0000-00000000d001";
const METRIC_CART_ID = "00000000-0000-0000-0000-00000000d002";
const METRIC_INQUIRY_ID = "00000000-0000-0000-0000-00000000d003";
const METRIC_BOOKING_ID = "00000000-0000-0000-0000-00000000d004";
const METRIC_DOCUMENT_ID = "00000000-0000-0000-0000-00000000d005";
const METRIC_ANALYSIS_ID = "00000000-0000-0000-0000-00000000d006";

/**
 * Operator dashboard fixture (S8-01, F-A-07).
 *
 * WHY THIS EXISTS: /admin aggregates couple- and vendor-side rows. With an empty
 * database every tile reads a measured zero, which is indistinguishable at a
 * glance from "the aggregate is broken". Nobody can tell the dashboard works.
 * db:rls has the same problem - a count that is 0 for everyone passes an
 * isolation check for the wrong reason.
 *
 * ONE ROW PER FUNNEL STEP, all dated NOW so the default 30-day window sees them.
 * Amounts are round demo numbers; they are not derived from any real vendor.
 *
 * NOT SEEDED: settlements. Fee amounts depend on settlement.fee_basis, which is
 * O-15 undecided - seeding one would make the dashboard show a fee figure that
 * silently picks a basis. The dashboard is supposed to say "기준 미확정" there.
 */
async function seedMetricsFixture(vendorId, coupleId, ownerUser, partnerUser) {
  if (!vendorId || !coupleId || !ownerUser) return "skipped";

  const upsert = (table, row) =>
    rest(`${table}?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(row),
    });

  await upsert("products", {
    id: METRIC_PRODUCT_ID,
    vendor_id: vendorId,
    category: "hall",
    name: "로컬 데모 홀 패키지",
    base_price_total: 12000000,
    // products_publish_requirements_chk: a published product must have a price,
    // at least one included item, and a declared add-on state (S2-04 - "추가금
    // 없음" has to be an explicit declaration, never an empty column).
    included_items_json: [{ label: "예식장 대관", included: true }],
    add_ons_declared_at: new Date().toISOString(),
    status: "published",
    published_at: new Date().toISOString(),
  });

  await upsert("carts", { id: METRIC_CART_ID, couple_id: coupleId, status: "active" });

  // cart_items has no id conflict target we control on re-run, so check first.
  const items = await rest(`cart_items?cart_id=eq.${METRIC_CART_ID}&select=id`);
  if (items.length === 0) {
    await rest("cart_items", {
      method: "POST",
      body: JSON.stringify({
        cart_id: METRIC_CART_ID,
        vendor_id: vendorId,
        product_id: METRIC_PRODUCT_ID,
        added_by: ownerUser.id,
        price_at_add: 12000000,
      }),
    });
  }

  await upsert("inquiries", {
    id: METRIC_INQUIRY_ID,
    couple_id: coupleId,
    status: "open",
    request_json: { note: "local demo inquiry" },
    region_code: "서울 강남",
    guest_count: 150,
  });

  await upsert("bookings", {
    id: METRIC_BOOKING_ID,
    couple_id: coupleId,
    vendor_id: vendorId,
    product_id: METRIC_PRODUCT_ID,
    status: "confirmed",
    total_amount: 12000000,
    deposit_amount: 2400000,
  });

  // purge_scheduled_at is REQUIRED (CLAUDE.md 5.1) - a documents row without it
  // is exactly the state the rule forbids, seed or not.
  await upsert("documents", {
    id: METRIC_DOCUMENT_ID,
    couple_id: coupleId,
    doc_type: "contract",
    storage_path: "local-demo/never-uploaded.pdf",
    purge_scheduled_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  });

  await upsert("document_analyses", {
    id: METRIC_ANALYSIS_ID,
    document_id: METRIC_DOCUMENT_ID,
    // 'done', not 'succeeded' - ANALYSIS_STATUSES in lib/core/report/pipeline.ts.
    status: "done",
    risk_score: 42,
  });

  // Membership: one active (conversion) + one canceled (churn). Both are needed
  // or the churn-rate denominator has nothing in it and reads as "모수 없음".
  const memberships = [
    { user: ownerUser, status: "active" },
    { user: partnerUser, status: "canceled" },
  ].filter((row) => row.user);

  for (const row of memberships) {
    const existing = await rest(`memberships?user_id=eq.${row.user.id}&select=id`);
    const body = {
      user_id: row.user.id,
      plan: "premium",
      status: row.status,
      started_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      source: "local_demo",
    };

    if (existing.length === 0) {
      await rest("memberships", { method: "POST", body: JSON.stringify(body) });
    } else {
      await rest(`memberships?id=eq.${existing[0].id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    }
  }

  // MAU counts distinct actors in entity_events. The fixture actions above really
  // did happen, so recording them is not an invention - it is the same row the
  // app would have written. Without them MAU is 0 while everything else is not,
  // which looks like a bug in the MAU query rather than an empty event log.
  const actors = [ownerUser, partnerUser].filter(Boolean);
  for (const actor of actors) {
    const seen = await rest(
      `entity_events?actor_id=eq.${actor.id}&event_type=eq.seed_fixture_created&select=id`,
    );

    if (seen.length === 0) {
      await rest("entity_events", {
        method: "POST",
        body: JSON.stringify({
          entity_type: "couple",
          entity_id: coupleId,
          event_type: "seed_fixture_created",
          actor_id: actor.id,
          actor_role: "consumer",
          source: "system",
          memo: "local demo fixture (S8-01)",
        }),
      });
    }
  }

  return "created";
}


// ── audit console fixture (S8-02) ───────────────────────────────────────────
/**
 * Operator audit console fixture (F-A-09).
 *
 * WHY THIS EXISTS: audit_logs is empty on a fresh database - nothing writes to it
 * until an operator actually approves a vendor or edits a rate. So /admin/audit
 * would render an empty state and nobody could tell "the console works and there
 * is nothing yet" from "the console is broken". db:rls has the same problem: a
 * query that returns 0 rows for everyone passes an isolation check for the wrong
 * reason.
 *
 * WHAT IS SEEDED: three audit_logs rows written the way real routes write them
 * (actor + action + target + before/after json). One of them carries
 * resolution_basis so the "근거 이벤트" path is exercised.
 *
 * ONE ROW CARRIES A DELIBERATE TRAP: a before/after pair containing `phone` and a
 * value starting with `=`. The console must redact the first and the CSV export
 * must neutralise the second (formula injection). A fixture that only contains
 * well-behaved data proves nothing about the code that handles bad data.
 */
async function seedAuditFixture(adminUser, vendorId, coupleId) {
  if (!adminUser || !vendorId) return "skipped";

  const existing = await rest(`audit_logs?action=eq.seed_fixture_recorded&select=id&limit=1`);
  if (existing.length > 0) return "existing";

  const rows = [
    {
      actor_id: adminUser.id,
      actor_role: "admin",
      action: "vendor_review_approve",
      target_type: "vendor",
      target_id: vendorId,
      before_json: { status: "pending" },
      after_json: { status: "active" },
      // PostgREST bulk insert requires every object to carry the same keys
      // ("All object keys must match"), so nulls are spelled out rather than omitted.
      resolution_basis: null,
    },
    {
      actor_id: adminUser.id,
      actor_role: "admin",
      action: "seed_fixture_recorded",
      target_type: "vendor",
      target_id: vendorId,
      // The trap. `phone` must be redacted; the `=` value must not become an
      // Excel formula in the CSV export.
      before_json: { phone: "010-1234-5678", label: "before" },
      after_json: { phone: "010-0000-0000", label: "=HYPERLINK(\"http://evil.example\",\"click\")" },
      resolution_basis: null,
    },
    {
      actor_id: adminUser.id,
      actor_role: "admin",
      action: "moderation_applied",
      target_type: "community_post",
      target_id: coupleId ?? vendorId,
      before_json: { status: "visible" },
      after_json: { status: "hidden" },
      // NOT [] - audit_logs_resolution_basis_not_empty_chk rejects an empty array.
      // The schema already says what this file would otherwise have to remember:
      // a basis is either real or absent. There is no "decided on nothing".
      resolution_basis: null,
    },
  ];

  await rest("audit_logs", { method: "POST", body: JSON.stringify(rows) });

  // Point the last row's resolution_basis at real event ids so the console shows
  // a decision whose grounds can actually be followed. Written as a second step
  // because we need ids that already exist.
  const events = await rest(`entity_events?select=id&limit=2`);
  if (events.length > 0) {
    // audit_logs is append-only (0053) - we cannot UPDATE the row we just wrote.
    // So insert one more row that carries the basis, which is also how the real
    // flow works: a decision is a new record, not an edit of an old one.
    await rest("audit_logs", {
      method: "POST",
      body: JSON.stringify({
        actor_id: adminUser.id,
        actor_role: "admin",
        action: "dispute_resolved",
        target_type: "dispute",
        target_id: vendorId,
        before_json: { status: "open" },
        after_json: { status: "resolved" },
        resolution_basis: events.map((row) => row.id),
      }),
    });
  }

  return "created";
}


// ── privacy audit fixture (S8-04) ───────────────────────────────────────────
const PRIVACY_OVERDUE_DOC_ID = "00000000-0000-0000-0000-00000000e001";
const PRIVACY_PURGED_DOC_ID = "00000000-0000-0000-0000-00000000e002";
const PRIVACY_REQUEST_PENDING = "00000000-0000-0000-0000-00000000e003";
const PRIVACY_REQUEST_DONE = "00000000-0000-0000-0000-00000000e004";

/**
 * Operator privacy console fixture (F-A-08).
 *
 * WHY THIS EXISTS: on a fresh database /admin/privacy shows "0 overdue, 0 requests,
 * no runs" - which is indistinguishable from "the aggregate is broken". The alert
 * rules in particular cannot be seen at all: an operator would have to wait for a
 * real purge failure to find out whether the console warns.
 *
 * WHAT IS SEEDED:
 *   - one document whose purge_scheduled_at is 8 hours in the PAST and not purged
 *     -> exercises the 잔존 alert AND crosses PURGE_CRITICAL_HOURS (6), so the
 *        console must render it as critical rather than a warning.
 *   - one already-purged document, so "파기 완료" is not 0 either.
 *   - two deletion requests: one pending (SLA row, unknown because O-18) and one
 *     already completed WITH a reason (the resolution path is visible).
 *   - one failed job_run, so the 실행 이력 and the PURGE_RUN_FAILED alert both have
 *     something to show.
 *
 * The failed run's error_summary deliberately carries ONLY reason:count - if a
 * future change starts writing paths in there, this fixture is what a reviewer
 * looks at first.
 */
async function seedPrivacyFixture(adminUser, coupleId, consumerUser) {
  if (!coupleId || !consumerUser) return "skipped";

  const existing = await rest(`documents?id=eq.${PRIVACY_OVERDUE_DOC_ID}&select=id`);
  if (existing.length > 0) return "existing";

  const hoursAgo = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString();

  const upsert = (table, row) =>
    rest(`${table}?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(row),
    });

  // Overdue: scheduled 8h ago, never purged. Past PURGE_CRITICAL_HOURS on purpose.
  await upsert("documents", {
    id: PRIVACY_OVERDUE_DOC_ID,
    couple_id: coupleId,
    doc_type: "contract",
    storage_path: "contracts-raw/local-demo-overdue.pdf",
    purge_scheduled_at: hoursAgo(8),
    purged_at: null,
  });

  await upsert("documents", {
    id: PRIVACY_PURGED_DOC_ID,
    couple_id: coupleId,
    doc_type: "estimate",
    storage_path: "contracts-raw/local-demo-purged.pdf",
    purge_scheduled_at: hoursAgo(30),
    purged_at: hoursAgo(29),
  });

  // Deletion requests. The service role can set status/resolved_by - the requester
  // cannot (0054 column privileges), which is the whole point of that migration.
  await upsert("data_deletion_requests", {
    id: PRIVACY_REQUEST_PENDING,
    user_id: consumerUser.id,
    scope: "service_data",
    status: "pending",
    requested_at: hoursAgo(20),
    completed_at: null,
    resolved_by: null,
    resolution_reason: null,
  });

  if (adminUser) {
    await upsert("data_deletion_requests", {
      id: PRIVACY_REQUEST_DONE,
      user_id: consumerUser.id,
      scope: "account",
      status: "completed",
      requested_at: hoursAgo(72),
      completed_at: hoursAgo(70),
      resolved_by: adminUser.id,
      // completed/rejected require a non-blank reason (0054 CHECK).
      resolution_reason: "\ubcf8\uc778 \ud655\uc778 \ud6c4 \uacc4\uc815\uacfc \uc11c\ube44\uc2a4 \ub370\uc774\ud130\ub97c \ubaa8\ub450 \uc0ad\uc81c\ud588\uc2b5\ub2c8\ub2e4.",
    });
  }

  // A failed run so the history and the PURGE_RUN_FAILED alert have something.
  // error_summary carries reason:count ONLY - never a path, never an id.
  await rest("job_runs", {
    method: "POST",
    body: JSON.stringify({
      job_name: "purge-documents",
      started_at: hoursAgo(1),
      finished_at: hoursAgo(1),
      status: "failed",
      processed_count: 1,
      error_summary: "storage_error:1",
    }),
  });

  return "created";
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

  const rateSeed = await seedDemoRates();
  const aiLimitSeed = await seedDemoAiLimits();

  const linkedCouple = await seedLinkedCouple(
    results.find((row) => row.email === "couple-linked-a@local.test"),
    results.find((row) => row.email === "couple-linked-b@local.test"),
  );

  const plannerSeed = await seedPlanner(
    results.find((row) => row.email === "planner@local.test"),
    linkedCouple,
  );

  const metricsSeed = await seedMetricsFixture(
    vendor.id,
    linkedCouple,
    results.find((row) => row.email === "couple-linked-a@local.test"),
    results.find((row) => row.email === "couple-linked-b@local.test"),
  );

  // AFTER the metrics fixture on purpose: the dispute row needs real
  // entity_events ids for its resolution_basis, and those events are written
  // by seedMetricsFixture. Run it first and the basis silently comes out empty.
  const privacySeed = await seedPrivacyFixture(
    results.find((row) => row.email === "admin@local.test"),
    linkedCouple,
    results.find((row) => row.email === "couple-linked-a@local.test"),
  );

  const auditSeed = await seedAuditFixture(
    results.find((row) => row.email === "admin@local.test"),
    vendor.id,
    linkedCouple,
  );

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
  console.log(`    rates       : commission/planner global rate ${rateSeed} (LOCAL DEMO - O-02 undecided)`);
  console.log("                  without a rate, contract issuance fails (CONTRACT_RATE_UNRESOLVED)");
  console.log(`    ai limits   : ai.free_daily_turns / ai.session_token_cap ${aiLimitSeed} (LOCAL DEMO)`);
  console.log("                  without them the planner refuses to open (unconfigured cap)");
  console.log("");
  console.log("  consumer accounts (S3-01)");
  console.log("    couple-a@local.test -> /onboarding 6 steps, then issue an invite code");
  console.log("    couple-b@local.test -> accept that code to share one couple");
  console.log("    (both start with no couple - onboarding creates it)");
  console.log("");
  console.log("  planner fixture (S6-01)");
  console.log(`    planner     : planner@local.test (${plannerSeed})`);
  console.log("    engagement  : active over the linked couple");
  console.log("    scope       : couples, carts, consultations (chat/payments stay closed)");
  console.log("    -> category selection (planner_scopes) is the customer's act - not seeded");
  console.log("");
  console.log("  linked couple fixture (S4-04)");
  console.log(`    couple id   : ${linkedCouple}`);
  console.log("    members     : couple-linked-a (owner) + couple-linked-b (partner)");
  console.log("    onboarding  : complete (6 answers, stage=active)");
  console.log("    -> npm run db:rls now runs straight after db:reset + this script.");
  console.log("    -> couple-a / couple-b stay untouched so /onboarding is still demoable.");
  console.log("");
  console.log("  metrics fixture (S8-01)");
  console.log(`    status      : ${metricsSeed}`);
  console.log("    rows        : product, cart+item, inquiry, booking(confirmed),");
  console.log("                  document+analysis(done), membership active/canceled, 2 events");
  console.log("    -> /admin shows real numbers instead of a wall of zeros.");
  console.log("    -> settlements are NOT seeded: fee basis is O-15 undecided and the");
  console.log("       dashboard must keep saying 기준 미확정 there.");
  console.log("");
  console.log("  audit console fixture (S8-02)");
  console.log(`    status      : ${auditSeed}`);
  console.log("    rows        : 4 audit_logs (approve / trap / moderation / dispute+basis)");
  console.log("    -> /admin/audit shows real records instead of an empty state.");
  console.log("    -> one row carries a phone field and an =FORMULA value on purpose:");
  console.log("       the console must redact the first, the CSV export must defuse the second.");
  console.log("");
  console.log("  privacy audit fixture (S8-04)");
  console.log(`    status      : ${privacySeed}`);
  console.log("    rows        : 1 overdue doc (8h past due -> CRITICAL), 1 purged doc,");
  console.log("                  2 deletion requests (pending / completed+reason), 1 failed run");
  console.log("    -> /admin/privacy shows real alerts instead of a silent 'all zero' screen.");
  console.log("    -> the overdue doc is past PURGE_CRITICAL_HOURS on purpose: the console");
  console.log("       must render it as critical, not as a warning.");
  console.log("");
  console.log("  try it");
  console.log(`    1. ${APP_URL}/login          -> admin@local.test`);
  console.log(`    2. ${APP_URL}/admin/vendors  -> approve the seeded application`);
  console.log(`    3. ${APP_URL}/login          -> vendor@local.test`);
  console.log(`    4. ${APP_URL}/vendor/apply , /vendor/profile , /vendor/products`);
  console.log(`    5. ${APP_URL}/vendor/members -> staff@local.test 로 로그인하면`);
  console.log("       판매가/추가금 저장이 막히는 것을 확인할 수 있다");
  console.log(`    6. ${APP_URL}/login -> couple-a@local.test -> ${APP_URL}/onboarding`);
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
