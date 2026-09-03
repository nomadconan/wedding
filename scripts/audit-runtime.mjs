// =============================================================================
// 실동작 전수 점검 — 실제 Chrome + 세션 쿠키 (S0-04)
// -----------------------------------------------------------------------------
// **왜 브라우저인가.** 지금까지의 검증 다섯(lint·test·build·db:rls·흐름 스크립트)
// 어디에도 브라우저가 없다(운영 규칙 4 · D-75). FIX-24(로그인 불가)는 psql 검사와
// PostgREST 흐름 스크립트를 **전부 지나갔고** CDP 로 실제 Chrome 을 몰아서야 잡혔다.
// 그래서 화면 점검은 같은 방식으로 한다 — 진짜 Chrome 을 띄우고 로그인 폼을 지나
// 라우트를 하나씩 연다.
//
// **새 의존성을 넣지 않았다.** Playwright·Puppeteer 없이 CDP 를 직접 문다.
// Node 20 의 `--experimental-websocket` 플래그로 전역 WebSocket 을 켜서 쓴다.
//
// 실행 (dev 서버가 떠 있어야 한다):
//   npm run dev              (다른 창)
//   npm run audit:screens    화면 — 계정 10축 x page.tsx 전수
//   npm run audit:api        API  — route.ts 전수 (비로그인/무권한/정당)
//   npm run audit:runtime    둘 다
//
// 옵션:  --accounts=guest,admin   축을 좁힌다
//        --routes=/home,/cart     경로를 좁힌다 (부분 일치)
//        --headful                창을 띄운다 (눈으로 볼 때)
//        --out=tmp/x.json         결과 파일 경로
//
// **API 단계는 쓰기를 친다.** GET 이 없는 핸들러는 빈 본문으로 POST/PATCH/DELETE 를
// 보낸다 — 인가는 검증보다 앞에 있어야 하므로 401·403 이 먼저 나와야 하고, 그것이
// 이 점검이 보려는 것이다. 로컬 DB 를 더럽힐 수 있으니 **화면 점검 뒤에** 돌리고
// 끝나면 `npm run db:reset && npm run seed:accounts` 로 되돌린다.
// =============================================================================
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listRoutes } from "./lib/app-routes.mjs";

const ROOT = process.cwd();
const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
/**
 * **뒤에 온 값이 이긴다.** npm script 가 `--out=` 을 미리 박아 두므로 `--` 뒤에 사용자가
 * 준 값이 뒤에 온다. 앞의 것을 고르면 **사용자가 지정한 파일 대신 기본 파일을 덮어쓴다** —
 * 실제로 그렇게 해서 970행짜리 결과를 2행으로 날렸다.
 */
const opt = (name, fallback) => {
  const hits = ARGS.filter((a) => a.startsWith(`--${name}=`));
  return hits.length ? hits[hits.length - 1].slice(name.length + 3) : fallback;
};

const BASE = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
const DO_SCREENS = has("--screens") || !has("--api");
const DO_API = has("--api") || !has("--screens");
const OUT = opt("out", "tmp/audit-runtime.json");
const NAV_TIMEOUT = Number(opt("timeout", "45000"));

// 로컬 전용 안전장치 — 원격을 상대로 이 스크립트를 돌리면 남의 데이터를 친다.
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE)) {
  console.error(`로컬 전용이다. NEXT_PUBLIC_APP_URL=${BASE}`);
  process.exit(1);
}

// --- 계정 축 ------------------------------------------------------------------
// `seed:accounts` 가 만드는 전 계정 + 비로그인. 순서는 권한이 낮은 쪽부터다 —
// 앞의 계정이 실패해도 뒤가 서고, 로그가 위에서 아래로 읽힌다.
const PASSWORD = process.env.SEED_PASSWORD || "local-dev-1234";
const ACCOUNTS = [
  { key: "guest", email: null, label: "비로그인" },
  { key: "couple-a", email: "couple-a@local.test", label: "커플 A(미연동)" },
  { key: "couple-b", email: "couple-b@local.test", label: "커플 B(미연동)" },
  { key: "couple-linked-a", email: "couple-linked-a@local.test", label: "커플 연동 A(대표)" },
  { key: "couple-linked-b", email: "couple-linked-b@local.test", label: "커플 연동 B" },
  { key: "planner", email: "planner@local.test", label: "플래너" },
  { key: "vendor", email: "vendor@local.test", label: "업체 대표" },
  { key: "staff", email: "staff@local.test", label: "업체 스태프" },
  { key: "ops", email: "ops@local.test", label: "운영 담당자" },
  { key: "admin", email: "admin@local.test", label: "운영 관리자" },
];

// --- 동적 세그먼트 값 ---------------------------------------------------------
// 시드에 실제로 있는 id 를 쓴다. 없는 것은 **형식이 맞는 가짜**를 넣는다 —
// 그러면 '못 찾음' 경로가 깨끗이 404 로 끝나는지를 대신 본다.
const MISSING_UUID = "00000000-0000-0000-0000-0000000000ff";
const MISSING_TOKEN = "missing-token-for-audit";

function fixtures() {
  const container = execFileSync("docker", [
    "ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}",
  ]).toString().trim().split(/\r?\n/)[0];
  if (!container) throw new Error("supabase_db_* 컨테이너가 없다. npm run db:start 먼저.");

  const sql = `
select 'booking='||coalesce((select id::text from bookings order by created_at limit 1),'')
union all select 'chatRoom='||coalesce((select id::text from chat_rooms order by created_at limit 1),'')
union all select 'post='||coalesce((select id::text from community_posts order by created_at limit 1),'')
union all select 'vendor='||coalesce((select id::text from vendors order by created_at limit 1),'')
union all select 'vendorPublic='||coalesce((select id::text from vendors where status = 'active' order by created_at limit 1),'')
union all select 'planner='||coalesce((select id::text from planners order by created_at limit 1),'')
union all select 'analysis='||coalesce((select id::text from document_analyses order by created_at limit 1),'')
union all select 'shareToken='||coalesce((select token from share_links order by created_at limit 1),'')
union all select 'rsvpToken='||coalesce((select invite_token from guests order by created_at limit 1),'')
union all select 'inviteToken='||coalesce((select token from vendor_invites order by created_at limit 1),'')
union all select 'product='||coalesce((select id::text from products order by created_at limit 1),'')
union all select 'slug='||coalesce((select slug from content_posts order by created_at limit 1),'')
union all select 'contract='||coalesce((select id::text from contracts order by created_at limit 1),'')
union all select 'priceRegion='||coalesce((select region_code from price_index order by created_at limit 1),'')
union all select 'priceCategory='||coalesce((select category from price_index order by created_at limit 1),'')
union all select 'flagKey='||coalesce((select key from feature_flags order by key limit 1),'')
union all select 'dispute='||coalesce((select id::text from disputes order by created_at limit 1),'')
union all select 'review='||coalesce((select id::text from reviews order by created_at limit 1),'')
union all select 'finding='||coalesce((select id::text from findings order by created_at limit 1),'')
union all select 'coupon='||coalesce((select id::text from coupons order by created_at limit 1),'')
union all select 'engagement='||coalesce((select id::text from planner_engagements order by created_at limit 1),'')
union all select 'consultation='||coalesce((select id::text from consultations order by created_at limit 1),'')
union all select 'cancellation='||coalesce((select id::text from contract_cancellations order by created_at limit 1),'')
union all select 'task='||coalesce((select id::text from tasks order by created_at limit 1),'')
union all select 'memberUser='||coalesce((select user_id::text from vendor_members order by created_at limit 1),'')
union all select 'priceRule='||coalesce((select id::text from price_rules order by created_at limit 1),'')
union all select 'option='||coalesce((select id::text from product_options order by created_at limit 1),'')
`;
  const out = execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
      "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  const map = {};
  const missing = [];
  for (const row of out.trim().split(/\r?\n/)) {
    const at = row.indexOf("=");
    const k = row.slice(0, at);
    const v = row.slice(at + 1).trim();
    if (v) map[k] = v;
    else missing.push(k);
  }
  return { map, missing };
}

const { map: FIX, missing: FIX_MISSING } = fixtures();

/** 세그먼트 이름 -> 값. 시드에 없으면 형식만 맞는 가짜를 준다. */
function segmentValue(name, routeHint) {
  const byName = {
    roomId: FIX.chatRoom ?? MISSING_UUID,
    postId: FIX.post ?? MISSING_UUID,
    // 소비자가 여는 업체 화면은 **공개된(active) 업체**여야 한다. 시드의 첫 업체는
    // 입점 심사 데모용 `pending` 이라 `/explore/[vendorId]` 가 정상적으로 404 를 낸다 —
    // 그 404 를 결함으로 세면 표가 거짓말을 한다.
    vendorId: FIX.vendorPublic ?? FIX.vendor ?? MISSING_UUID,
    bookingId: FIX.booking ?? MISSING_UUID,
    slug: FIX.slug ?? "missing-slug",
    region: FIX.priceRegion ?? "서울 강남",
    category: FIX.priceCategory ?? "hall",
    token: routeHint.startsWith("/share")
      ? (FIX.shareToken ?? MISSING_TOKEN)
      : routeHint.startsWith("/rsvp")
        ? (FIX.rsvpToken ?? MISSING_TOKEN)
        : (FIX.inviteToken ?? MISSING_TOKEN),
    key: FIX.flagKey ?? "missing.flag",
    userId: FIX.memberUser ?? MISSING_UUID,
    optionId: FIX.option ?? MISSING_UUID,
  };
  if (byName[name] !== undefined) return byName[name];

  // `[id]` 는 라우트마다 가리키는 것이 다르다. 접두어로 고른다.
  const byPrefix = [
    ["/bookings/", FIX.booking],
    ["/reports/", FIX.analysis],
    ["/planners/", FIX.planner],
    ["/vendor/products/", FIX.product],
    ["/api/admin/coupons/", FIX.coupon],
    ["/api/vendor/coupons/", FIX.coupon],
    ["/api/admin/disputes/", FIX.dispute],
    ["/api/admin/vendors/", FIX.vendor],
    ["/api/vendors/", FIX.vendorPublic],
    ["/api/bookings/", FIX.booking],
    ["/api/cancellations/", FIX.cancellation],
    ["/api/community/posts/", FIX.post],
    ["/api/consultations/", FIX.consultation],
    ["/api/contracts/", FIX.contract],
    ["/api/findings/", FIX.finding],
    ["/api/planner-engagements/", FIX.engagement],
    ["/api/reports/", FIX.analysis],
    ["/api/reviews/", FIX.review],
    ["/api/tasks/", FIX.task],
    ["/api/vendor/bookings/", FIX.booking],
    ["/api/vendor/price-rules/", FIX.priceRule],
    ["/api/vendor/products/", FIX.product],
  ];
  for (const [prefix, value] of byPrefix) {
    if (routeHint.startsWith(prefix) && value) return value;
  }
  return MISSING_UUID;
}

/** `/bookings/[id]/cancel` -> `/bookings/<uuid>/cancel` */
function materialize(route) {
  let usedFallback = false;
  const url = route.replace(/\[([^\]]+)\]/g, (_, name) => {
    const clean = name.replace(/^\.\.\./, "");
    const v = segmentValue(clean, route);
    if (v === MISSING_UUID || v === MISSING_TOKEN || v === "missing-slug" || v === "missing.flag") {
      usedFallback = true;
    }
    return encodeURIComponent(v);
  });
  return { url, usedFallback };
}

// --- CDP ----------------------------------------------------------------------

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : null,
  "/usr/bin/google-chrome",
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error("Chrome 을 찾지 못했다. CHROME_PATH 환경변수로 지정한다.");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchChrome() {
  const port = 9333 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "wc-audit-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1280,900",
  ];
  if (!has("--headful")) args.push("--headless=new");

  const proc = spawn(findChrome(), args, { stdio: "ignore", detached: false });

  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return { proc, ws: (await res.json()).webSocketDebuggerUrl, port };
    } catch {
      /* 아직 안 떴다 */
    }
    await sleep(200);
  }
  proc.kill();
  throw new Error("Chrome DevTools 엔드포인트가 열리지 않았다.");
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();

  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`));
      else resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  return {
    ready,
    close: () => socket.close(),
    on: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    send(method, params = {}, sessionId) {
      const id = nextId;
      nextId += 1;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      socket.send(JSON.stringify(payload));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP 응답 없음: ${method}`));
          }
        }, 60000);
      });
    },
  };
}

/** 페이지 하나를 열고 문서 응답 코드 + 화면 상태를 돌려준다. */
async function visit(cdp, sessionId, url, state) {
  const startPath = new URL(url).pathname + new URL(url).search;
  state.docResponses.length = 0;
  state.consoleErrors.length = 0;
  state.loaded = false;

  let navError = null;
  try {
    const res = await cdp.send("Page.navigate", { url }, sessionId);
    if (res.errorText) navError = res.errorText;
  } catch (err) {
    navError = String(err.message ?? err);
  }

  const deadline = Date.now() + NAV_TIMEOUT;
  while (!state.loaded && Date.now() < deadline) await sleep(50);
  const timedOut = !state.loaded;
  await sleep(350); // 클라이언트 렌더가 상태를 그릴 틈

  const expr = `(() => {
    const q = (s) => !!document.querySelector(s);
    const text = document.body ? document.body.innerText : "";
    const flat = text.replace(/\\s+/g, " ").trim();
    return {
      path: location.pathname + location.search,
      title: document.title,
      empty: q('[data-testid="empty-state"]'),
      errorState: q('[data-testid="error-state"]'),
      errorCode: (() => {
        const el = document.querySelector('[data-testid="error-state"]');
        if (!el) return null;
        const m = el.innerText.match(/\\uc624\\ub958 \\ucf54\\ub4dc\\s+([A-Z0-9_]+)/);
        return m ? m[1] : el.innerText.replace(/\\s+/g, " ").trim().slice(0, 60);
      })(),
      loadingState: q('[data-testid="loading-state"]'),
      shell: q('[data-testid="admin-shell"]') ? "admin"
           : q('[data-testid="bottom-tab-nav"]') ? "consumer" : "none",
      crash: /Application error|Unhandled Runtime Error|Internal Server Error|500 -/i.test(flat),
      // 404 라는 글자만 보고 판정하지 않는다. 피처 플래그 콘솔은 설명 문장에
      // "꺼면 그 경로가 404 가 됩니다" 를 담고 있어서, 느슨한 판정이 **정상으로 뜬
      // 운영자 화면을 404 로 기록**했다. Next 의 not-found 화면 문구만 본다.
      notFound: /This page could not be found/.test(flat),
      textLength: flat.length,
      head: flat.slice(0, 200)
    };
  })()`;

  const readDom = async () => {
    try {
      const r = await cdp.send(
        "Runtime.evaluate",
        { expression: expr, returnByValue: true, awaitPromise: false },
        sessionId,
      );
      return r.result?.value ?? { error: String(r.exceptionDetails?.text ?? "unknown") };
    } catch (err) {
      return { error: String(err.message ?? err) };
    }
  };

  /**
   * **한 번만 읽으면 안 된다.** `loading.tsx` 가 있는 라우트는 응답이 스트리밍으로
   * 먼저 나가므로 서버 컴포넌트의 `redirect()` 가 **load 이벤트 뒤에** 클라이언트에서
   * 일어난다(미들웨어 주석 S3-01). 그 순간에 읽으면 본문이 비어 있고 경로는 아직
   * 원래 자리라 **정상적인 권한 거부가 '빈 화면 오류' 로 기록된다.**
   * 화면이 자리를 잡을 때까지(본문이 차거나 경로가 바뀔 때까지) 다시 읽는다.
   */
  let dom = await readDom();
  const settleUntil = Date.now() + 6000;
  while (
    Date.now() < settleUntil &&
    !dom.error &&
    ((dom.textLength ?? 0) < 40 || dom.loadingState) &&
    dom.path === startPath
  ) {
    await sleep(300);
    dom = await readDom();
  }

  /**
   * **마지막 문서 응답을 상태로 쓰면 안 된다.** 화면이 뜬 뒤 Next 가 링크를 미리
   * 당겨오고, 그중 보호 경로는 미들웨어가 307 로 되돌린다 — 그 307 이 마지막
   * 문서 응답이 되어 **정상적으로 200 으로 뜬 화면이 307 로 기록됐다.**
   * 우리가 물은 것은 **우리가 친 URL 의 응답**이므로 그것을 골라 쓴다.
   */
  const docs = state.docResponses.slice();
  const want = startPath.split("?")[0];
  const mine = docs.find((d) => d.url.replace(BASE, "").split("?")[0] === want);
  const status = mine ? mine.status : (docs.length ? docs[docs.length - 1].status : null);

  return {
    status,
    chain: docs.map((d) => `${d.status} ${d.url.replace(BASE, "")}`),
    navError,
    timedOut,
    consoleErrors: state.consoleErrors.slice(0, 3),
    ...dom,
  };
}

/** 화면 상태를 한 낱말로 분류한다. 표에 들어가는 값이다. */
function classify(requestedPath, r) {
  if (r.navError) return "오류(내비 실패)";
  if (r.timedOut) return "오류(응답 없음)";
  if (r.crash) return "오류(렌더 실패)";
  if (r.status !== null && r.status >= 500) return "오류(5xx)";
  const path = (r.path ?? "").split("?")[0];
  const search = (r.path ?? "").includes("?") ? r.path.slice(r.path.indexOf("?")) : "";
  if (path === "/login" && requestedPath !== "/login") {
    return search.includes("denied=1") ? "권한 거부" : "로그인 요구";
  }
  if (r.status === 404 || r.notFound) return "404";
  // 컴포넌트 카탈로그는 **세 상태를 일부러 다 그린다**. 상태 마커로 판정하면
  // 정상 화면이 늘 '오류 상태' 로 잡힌다 — 표가 거짓말하는 쪽이 더 나쁘다.
  if (requestedPath === "/design-system") {
    return (r.textLength ?? 0) > 200 ? "정상(카탈로그)" : "오류(빈 화면)";
  }
  if (path !== requestedPath) return `리다이렉트(→${path})`;
  // **ErrorState 는 두 가지를 그린다.** 하나는 진짜 실패(질의 오류)이고 다른 하나는
  // **전제 미충족**이다 — 온보딩 전 계정의 `/cart` 는 `COUPLE_NOT_FOUND` 를 그리는데
  // 그것은 결함이 아니라 화면이 제 일을 한 것이다(docs/06 '전제 조건' 표).
  // 둘을 한 낱말로 적으면 표가 정상을 오류로 세므로 **코드를 함께 남긴다.**
  if (r.errorState) return `오류 상태(${r.errorCode ?? "코드 없음"})`;
  if (r.empty) return "빈 상태";
  if (r.loadingState) return "로딩 고착";
  if ((r.textLength ?? 0) < 40) return "오류(빈 화면)";
  return "정상";
}

// --- 화면 점검 ----------------------------------------------------------------

async function auditScreens(cdp, routes) {
  const results = [];
  for (const account of ACCOUNTS) {
    if (accountFilter && !accountFilter.includes(account.key)) continue;

    const { browserContextId } = await cdp.send("Target.createBrowserContext", {
      disposeOnDetach: false,
    });
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    const state = { docResponses: [], consoleErrors: [], loaded: false };
    const off = cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === "Page.loadEventFired") state.loaded = true;
      if (msg.method === "Network.responseReceived" && msg.params.type === "Document") {
        state.docResponses.push({ status: msg.params.response.status, url: msg.params.response.url });
      }
      if (msg.method === "Network.requestWillBeSent" && msg.params.redirectResponse) {
        state.docResponses.push({
          status: msg.params.redirectResponse.status,
          url: msg.params.redirectResponse.url,
        });
      }
      if (msg.method === "Runtime.exceptionThrown") {
        state.consoleErrors.push(
          String(msg.params.exceptionDetails?.exception?.description ?? "exception").slice(0, 200),
        );
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        state.consoleErrors.push(
          msg.params.args.map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 200),
        );
      }
    });

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);

    let loginNote = "비로그인";
    if (account.email) {
      loginNote = await login(cdp, sessionId, state, account);
    }
    console.log(`\n[${account.key}] ${account.label} — 로그인: ${loginNote}`);

    for (const route of routes) {
      const { url, usedFallback } = materialize(route.route);
      const r = await visit(cdp, sessionId, BASE + url, state);
      const verdict = classify(url.split("?")[0], r);
      results.push({
        account: account.key,
        route: route.route,
        url,
        fixtureMissing: usedFallback,
        status: r.status,
        verdict,
        finalPath: r.path ?? null,
        shell: r.shell ?? null,
        chain: r.chain,
        head: r.head ?? null,
        consoleErrors: r.consoleErrors ?? [],
      });
      const mark = verdict.startsWith("오류") ? "  <<<" : "";
      console.log(`  ${String(r.status ?? "--").padEnd(4)} ${verdict.padEnd(16)} ${url}${mark}`);
    }

    // API 단계에서 쓸 쿠키를 여기서 걷는다.
    const { cookies } = await cdp.send("Network.getCookies", { urls: [BASE] }, sessionId);
    cookieJar[account.key] = cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    off();
    await cdp.send("Target.closeTarget", { targetId });
    await cdp.send("Target.disposeBrowserContext", { browserContextId });
  }
  return results;
}

/** 로그인 폼을 실제로 채워 넘긴다. React 제어 입력이라 네이티브 setter 를 쓴다. */
async function login(cdp, sessionId, state, account) {
  await visit(cdp, sessionId, `${BASE}/login`, state);

  const fill = `(() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const put = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return false;
      set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    const ok = put("login-email", ${JSON.stringify(account.email)})
            && put("login-password", ${JSON.stringify(PASSWORD)});
    if (!ok) return "입력칸 없음";
    const form = document.querySelector('[data-testid="login-form"]');
    if (!form) return "폼 없음";
    form.requestSubmit();
    return "제출";
  })()`;

  /**
   * **한 번만 시도하면 안 된다.** 폼은 클라이언트 컴포넌트라 하이드레이션 뒤에야
   * 입력칸이 선다. 첫 시도에서 못 찾고 포기하면 그 계정의 화면 97개가 통째로
   * '로그인 요구' 로 기록되고 — 표는 조용히 거짓말을 한다.
   */
  let r = null;
  const tryUntil = Date.now() + 20000;
  for (;;) {
    r = await cdp.send("Runtime.evaluate", { expression: fill, returnByValue: true }, sessionId);
    if (r.result?.value === "제출") break;
    if (Date.now() > tryUntil) break;
    await sleep(400);
  }
  if (r.result?.value !== "제출") return `실패(${r.result?.value ?? "evaluate 오류"})`;

  // 로그인 성공은 **경로가 /login 을 벗어나는 것**으로 본다.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(200);
    const now = await cdp.send(
      "Runtime.evaluate",
      { expression: "location.pathname + location.search", returnByValue: true },
      sessionId,
    );
    const path = String(now.result?.value ?? "");
    if (!path.startsWith("/login")) return `성공 → ${path}`;
  }
  const why = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `(document.querySelector('[data-testid="error-state"]')?.innerText ?? "").replace(/\\s+/g," ").slice(0,120)`,
      returnByValue: true,
    },
    sessionId,
  );
  return `실패(${why.result?.value || "이동하지 않음"})`;
}

// --- API 점검 -----------------------------------------------------------------

const cookieJar = {};

/** route.ts 가 내보내는 HTTP 메서드를 읽는다. */
function exportedMethods(file) {
  const text = readFileSync(join(ROOT, file), "utf8");
  const found = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PATCH|PUT|DELETE)\b/g)) {
    found.add(m[1]);
  }
  for (const m of text.matchAll(/export\s+const\s+(GET|POST|PATCH|PUT|DELETE)\b/g)) found.add(m[1]);
  return [...found];
}

async function auditApis(apis) {
  const results = [];
  for (const api of apis) {
    const methods = exportedMethods(api.file);
    // GET 이 있으면 GET 만 친다. 없으면 첫 쓰기 메서드를 빈 본문으로 친다 —
    // 인가는 본문 검증보다 앞이어야 하므로 401·403 이 먼저 나와야 한다.
    const method = methods.includes("GET") ? "GET" : (methods[0] ?? "GET");
    const { url, usedFallback } = materialize(api.route);

    for (const account of ACCOUNTS) {
      if (accountFilter && !accountFilter.includes(account.key)) continue;
      const cookie = account.email ? cookieJar[account.key] : "";
      if (account.email && !cookie) {
        results.push({ account: account.key, route: api.route, url, method, status: null,
          verdict: "미확인(쿠키 없음)", fixtureMissing: usedFallback });
        continue;
      }

      const headers = { accept: "application/json" };
      if (cookie) headers.cookie = cookie;
      let body;
      if (method !== "GET" && method !== "DELETE") {
        headers["content-type"] = "application/json";
        body = "{}";
      }

      let status = null;
      let snippet = "";
      try {
        const res = await fetch(BASE + url, { method, headers, body, redirect: "manual" });
        status = res.status;
        snippet = (await res.text()).replace(/\s+/g, " ").slice(0, 160);
      } catch (err) {
        snippet = String(err.message ?? err);
      }
      results.push({
        account: account.key,
        route: api.route,
        url,
        method,
        methods,
        status,
        verdict: apiVerdict(status),
        snippet,
        fixtureMissing: usedFallback,
      });
    }
    const row = results.filter((r) => r.route === api.route);
    console.log(
      `  ${method.padEnd(6)} ${api.route.padEnd(52)} ` +
        row.map((r) => `${r.account}:${r.status ?? "--"}`).join(" "),
    );
  }
  return results;
}

function apiVerdict(status) {
  if (status === null) return "오류(연결 실패)";
  if (status >= 500) return "오류(5xx)";
  if (status === 401) return "401 미인증";
  if (status === 403) return "403 권한 없음";
  if (status === 404) return "404";
  if (status === 405) return "405 메서드 불일치";
  if (status === 422 || status === 400) return "검증 거절";
  if (status >= 300 && status < 400) return `리다이렉트(${status})`;
  if (status >= 200 && status < 300) return "200 통과";
  return String(status);
}

// --- 실행 ---------------------------------------------------------------------

const accountFilter = opt("accounts", null)?.split(",").map((s) => s.trim());
const routeFilter = opt("routes", null)?.split(",").map((s) => s.trim());

const { pages, apis } = listRoutes(ROOT);
const pageTargets = routeFilter
  ? pages.filter((p) => routeFilter.some((f) => p.route.includes(f)))
  : pages;
const apiTargets = routeFilter
  ? apis.filter((p) => routeFilter.some((f) => p.route.includes(f)))
  : apis;

async function main() {
  const up = await fetch(BASE, { redirect: "manual" }).then(() => true).catch(() => false);
  if (!up) {
    console.error(`${BASE} 에 붙지 못했다. 다른 창에서 npm run dev 를 먼저 띄운다.`);
    process.exit(1);
  }

  console.log(`대상 ${BASE} · 화면 ${pageTargets.length} · API ${apiTargets.length} · 계정 ${
    accountFilter ? accountFilter.length : ACCOUNTS.length
  }`);
  if (FIX_MISSING.length) {
    console.log(`시드에 없는 픽스처: ${FIX_MISSING.join(", ")}`);
  }

  const { proc, ws } = await launchChrome();
  const cdp = connect(ws);
  await cdp.ready;

  let screens = [];
  let apiRows = [];
  try {
    if (DO_SCREENS) {
      console.log("\n=== 화면 ===");
      screens = await auditScreens(cdp, pageTargets);
    }
    if (DO_API) {
      if (!DO_SCREENS) {
        // API 만 돌릴 때도 쿠키가 필요하다 — 로그인만 하고 화면은 열지 않는다.
        console.log("\n=== 로그인(쿠키 확보) ===");
        await auditScreens(cdp, []);
      }
      console.log("\n=== API ===");
      apiRows = await auditApis(apiTargets);
    }
  } finally {
    cdp.close();
    proc.kill();
  }

  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  writeFileSync(
    join(ROOT, OUT),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), base: BASE, fixtures: FIX,
        fixturesMissing: FIX_MISSING, screens, apis: apiRows },
      null, 2,
    ),
  );
  console.log(`\n${OUT} 에 저장했다.`);

  // **하드 실패와 '오류 상태' 를 갈라 센다.** 후자는 화면이 제 일을 한 경우가 섞여
  // 있다(전제 미충족). 한 수로 합치면 정상을 결함으로 세게 된다.
  const hard = screens.filter((s) => s.verdict.startsWith("오류("));
  const errState = screens.filter((s) => s.verdict.startsWith("오류 상태"));
  console.log(`화면 하드 실패 ${hard.length} / ${screens.length}`);
  console.log(`화면 오류 상태(코드별 판단 필요) ${errState.length}`);
  const apiBad = apiRows.filter((a) => a.verdict.startsWith("오류"));
  console.log(`API 오류 ${apiBad.length} / ${apiRows.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
