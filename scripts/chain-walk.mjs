// =============================================================================
// 사슬 실주행 — 문의부터 정산까지 한 거래를 실제 Chrome 으로 끝까지 민다 (C-1b)
// -----------------------------------------------------------------------------
// **왜 또 브라우저인가.** `audit:screens` 는 화면을 **하나씩** 연다 — 97개가 다 떠도
// "문의에서 정산까지 한 거래가 실제로 흘러가는가" 는 아무도 묻지 않는다. C-1 이 만든
// 다리(`bookings.quote_id` · 견적 수락 → 예약)는 **그 질문에만 걸린다.**
//
// 그리고 실제로 걸렸다. 이 스크립트를 처음 돌렸을 때 사슬은 **계약 발행에서 끊겼다** —
// `POST /api/contracts` 를 부르는 클라이언트가 리포에 하나도 없었고, 업체 목록은
// "계약서를 발행할 수 있습니다" 라고 적어 놓고 버튼을 주지 않았다(FIX-65 로 고쳤다).
//
// **세 면을 동시에 연다.** 소비자·업체·운영자 컨텍스트를 따로 띄워 두고 단계마다
// 세 면이 같은 거래를 어떻게 보는지 비교한다 — 한 면만 보면 "내 쪽에서는 됐다" 로
// 끝나고, 상태가 다른 면에 반영되지 않는 결함은 거기서 새어 나간다.
//
// **새 의존성을 넣지 않았다.** `audit-runtime.mjs` 와 같은 방식으로 CDP 를 직접 문다.
//
// 실행 (**반드시 개발 서버**여야 한다):
//   npm run dev            (다른 창)
//   npm run chain:walk
//
// **프로덕션 빌드로는 결제 단계가 안 끝난다.** `resolveChargeAdapterName()` 이
// NODE_ENV=production 에서 **noop** 을 고르고, noop 은 일부러 실패를 돌려준다 —
// "받지 않은 돈이 들어왔다고 기록되는 사고" 를 막는 장치다(어댑터 머리말).
// 사슬을 끝까지 밀려면 개발 서버(PAYMENT_ADAPTER=stub 기본)에서 돌려야 한다.
//
// 반대로 audit:screens · check:settlement 는 **프로덕션 빌드**에서 돌린다(FIX-58) —
// 개발 서버는 라우트를 열 때마다 컴파일해서 970 건을 물어보는 데 몇 시간이 걸린다.
//
// 옵션:  --headful      창을 띄운다
//        --out=경로     결과 JSON
//
// **DB 에 쓴다.** 돌린 뒤에는 `npm run db:reset && npm run seed:accounts` 로 되돌린다.
// =============================================================================
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { killTree, removeProfile, sweepOrphans, memoryNote, ms, walkScale } from "./lib/chrome-teardown.mjs";

/** 이번 주행이 쓴 임시 프로필. 끝날 때 지운다(FIX-77). */
let lastProfile = "";

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const opt = (name, fallback) => {
  const hits = ARGS.filter((a) => a.startsWith(`--${name}=`));
  return hits.length ? hits[hits.length - 1].slice(name.length + 3) : fallback;
};

const BASE = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
const OUT = opt("out", "tmp/chain-walk.json");
const PASSWORD = process.env.SEED_PASSWORD || "local-dev-1234";

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE)) {
  console.error(`로컬 전용이다. NEXT_PUBLIC_APP_URL=${BASE}`);
  process.exit(1);
}

const sleep = (delayMs) => new Promise((r) => setTimeout(r, delayMs));

// --- DB 직접 조회 (픽스처 찾기·상태 확인) -------------------------------------
const CONTAINER = execFileSync("docker", [
  "ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}",
]).toString().trim().split(/\r?\n/)[0];
if (!CONTAINER) {
  console.error("supabase_db_* 컨테이너가 없다. npm run db:start 먼저.");
  process.exit(1);
}

function sql(query) {
  return execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", query],
    { encoding: "utf8" },
  ).trim();
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

async function launchChrome() {
  const port = 9733 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "wc-chain-"));
  lastProfile = profile;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1440,960",
  ];
  if (!has("--headful")) args.push("--headless=new");
  /**
   * **CI 에서는 샌드박스를 끈다.** 러너는 컨테이너 안에서 돌고 user namespace 가
   * 막혀 있는 경우가 있어 Chrome 이 아예 안 뜬다 — 그러면 검사가 "화면이 없다" 가
   * 아니라 **"크롬이 없다"** 로 죽고, 둘은 다른 사실이다. 로컬에서는 켠 채로 둔다.
   */
  if (process.env.CI) args.push("--no-sandbox", "--disable-dev-shm-usage");

  const proc = spawn(findChrome(), args, { stdio: "ignore", detached: false });
  for (let i = 0; i < 300; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return { proc, ws: (await res.json()).webSocketDebuggerUrl };
    } catch {
      /* 아직 */
    }
    await sleep(200);
  }
  killTree(proc);
  removeProfile(lastProfile);
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
      if (msg.error) reject(new Error(msg.error.message));
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
    on: (fn) => listeners.add(fn),
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
        }, 90000);
      });
    },
  };
}

// --- 면(face) 하나 --------------------------------------------------------------
/**
 * 면마다 **독립 브라우저 컨텍스트**를 쓴다. 쿠키가 섞이면 "업체로 눌렀는데 소비자
 * 세션이었다" 같은 일이 조용히 일어나고, 그러면 이 점검이 거짓말을 한다.
 */
async function openFace(cdp, key, email) {
  const { browserContextId } = await cdp.send("Target.createBrowserContext", {
    disposeOnDetach: false,
  });
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
    browserContextId,
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  const state = { loaded: false, consoleErrors: [], docResponses: [] };
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Page.loadEventFired") state.loaded = true;
    if (msg.method === "Network.responseReceived" && msg.params.type === "Document") {
      state.docResponses.push({ status: msg.params.response.status, url: msg.params.response.url });
    }
    if (msg.method === "Runtime.exceptionThrown") {
      state.consoleErrors.push(
        String(msg.params.exceptionDetails?.exception?.description ?? "exception").slice(0, 300),
      );
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      state.consoleErrors.push(
        msg.params.args.map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 300),
      );
    }
  });

  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);

  const face = { key, email, sessionId, state, cdp };
  const note = await login(face);
  face.loginNote = note;
  return face;
}

async function evaluate(face, expression) {
  const r = await face.cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    face.sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(String(r.exceptionDetails.text ?? "evaluate 실패"));
  }
  return r.result?.value;
}

async function goto(face, path) {
  face.state.loaded = false;
  face.state.consoleErrors.length = 0;
  face.state.docResponses.length = 0;

  await face.cdp.send("Page.navigate", { url: BASE + path }, face.sessionId);

  const deadline = Date.now() + ms(45000);
  while (!face.state.loaded && Date.now() < deadline) await sleep(50);
  await sleep(400);

  // 화면이 자리를 잡을 때까지 기다린다 — `loading.tsx` 가 있는 라우트는 본문이
  // 비어 있는 순간이 있고, 그때 읽으면 정상 화면이 '빈 화면' 으로 기록된다.
  const settle = Date.now() + ms(8000);
  for (;;) {
    const info = await snapshot(face);
    const still = info.textLength < 40 || info.loadingState;
    if (!still || Date.now() > settle) return info;
    await sleep(300);
  }
}

async function snapshot(face) {
  return evaluate(
    face,
    `(() => {
      const q = (s) => !!document.querySelector(s);
      const flat = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim();
      return {
        path: location.pathname + location.search,
        loadingState: q('[data-testid="loading-state"]'),
        errorState: q('[data-testid="error-state"]'),
        notFound: /This page could not be found/.test(flat),
        textLength: flat.length,
        text: flat,
      };
    })()`,
  );
}

async function login(face) {
  await goto(face, "/login");

  const fill = `(() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const put = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return false;
      set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    if (!put("login-email", ${JSON.stringify(face.email)}) || !put("login-password", ${JSON.stringify(PASSWORD)})) {
      return "입력칸 없음";
    }
    const form = document.querySelector('[data-testid="login-form"]');
    if (!form) return "폼 없음";
    form.requestSubmit();
    return "제출";
  })()`;

  let value = null;
  const until = Date.now() + ms(25000);
  for (;;) {
    value = await evaluate(face, fill);
    if (value === "제출") break;
    if (Date.now() > until) throw new Error(`로그인 폼을 못 찾았다(${face.key}): ${value}`);
    await sleep(400);
  }

  /**
   * **왜 이렇게 오래 기다리나 (FIX-77).**
   *
   * 40초로 잡혀 있었다. 그것은 **여유 있는 기계에서 맞춘 값**이고, 물리 메모리가
   * 7.8GB 인 이 개발 PC 에서는 스택·개발 서버·Chrome 넷이 함께 올라가면
   * 스왑으로 밀려 **로그인 왕복 하나가 40초를 넘는다.** 그러면 주행이
   * `로그인이 이동하지 않았다` 로 죽고, 그 문구는 **제품이 고장 난 것처럼 읽힌다.**
   *
   * 기다림을 늘려도 **빠른 기계에서는 비용이 없다** — 경로가 바뀌는 순간 빠져나온다.
   * `WALK_LOGIN_TIMEOUT_MS` 로 조절한다(CI 는 기본값으로 충분하다).
   */
  const LOGIN_NAV_MS = Number(process.env.WALK_LOGIN_TIMEOUT_MS) || ms(120000);
  const deadline = Date.now() + LOGIN_NAV_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    const path = await evaluate(face, "location.pathname");
    if (!String(path).startsWith("/login")) return `성공 → ${path}`;
  }

  /**
   * **못 갔으면 무엇을 봤는지 적는다.**
   *
   * FIX-24 가 값을 치르고 배운 것이다 — 로그인 실패에 화면 문구가 없으면
   * 아무도 원인을 못 찾는다. 여기서도 `이동하지 않았다` 한 줄만 남기면
   * **느린 기계**와 **진짜 로그인 실패**가 구분되지 않는다.
   */
  let why = "";
  try {
    why = await evaluate(
      face,
      `(() => {
        const alert = document.querySelector('[role="alert"]')?.textContent?.trim() ?? "";
        const busy = document.querySelector('[data-testid="login-form"] button[disabled]') ? "제출 중" : "";
        return JSON.stringify({ path: location.pathname, alert: alert.slice(0, 160), busy });
      })()`,
    );
  } catch {
    why = '{"path":"?","alert":"CDP 응답 없음 — 브라우저가 죽었을 수 있다"}';
  }
  throw new Error(
    `로그인이 ${LOGIN_NAV_MS / 1000}초 안에 이동하지 않았다(${face.key}) :: ${why}` +
      " — 화면 문구가 비어 있으면 **자격 증명이 아니라 속도** 문제일 수 있다(FIX-77).",
  );
}

/** 값을 넣는다. React 가 보게 네이티브 setter 로 넣고 input 이벤트를 쏜다. */
async function fill(face, selector, value) {
  const done = await evaluate(
    face,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
  );
  if (!done) throw new Error(`입력칸이 없다: ${selector}`);
  await sleep(150);
}

/**
 * 화면 안의 무언가를 누른다. **없으면 없다고 말한다** — 못 찾은 것을 조용히 넘기면
 * 이 점검은 "다 됐다" 고 거짓말하게 된다.
 */
async function click(face, selector, { text = null } = {}) {
  const expr = `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const want = ${JSON.stringify(text)};
    const hit = want === null
      ? nodes[0]
      : nodes.find((n) => (n.innerText || n.value || "").includes(want));
    if (!hit) return { ok: false, found: nodes.length };
    hit.scrollIntoView();
    hit.click();
    return { ok: true, found: nodes.length };
  })()`;

  const until = Date.now() + ms(12000);
  for (;;) {
    const r = await evaluate(face, expr);
    if (r.ok) {
      await sleep(900);
      return r;
    }
    if (Date.now() > until) {
      throw new Error(`누를 자리가 없다: ${selector}${text ? ` ("${text}")` : ""}`);
    }
    await sleep(400);
  }
}

// --- 결과 기록 ------------------------------------------------------------------
const steps = [];
let failed = 0;

async function step(name, face, fn) {
  const started = Date.now();
  try {
    const note = (await fn()) ?? "";
    const errors = face ? face.state.consoleErrors.slice(0, 3) : [];
    steps.push({ name, face: face?.key ?? "-", ok: true, note, consoleErrors: errors });
    console.log(
      `PASS  ${name}${note ? ` :: ${note}` : ""}${errors.length ? `  [console ${errors.length}]` : ""}`,
    );
  } catch (error) {
    failed += 1;
    const message = String(error.message ?? error);
    steps.push({
      name,
      face: face?.key ?? "-",
      ok: false,
      note: message,
      consoleErrors: face ? face.state.consoleErrors.slice(0, 3) : [],
    });
    console.log(`FAIL  ${name} :: ${message}`);
  } finally {
    void started;
  }
}

// =============================================================================
// 주행
// =============================================================================
// ── 주행 전 정리 (FIX-77) ───────────────────────────────────────────────────
// 지난 주행이 중간에 끊기면 Chrome 자식들이 **고아로 살아남는다**(Windows 에서
// `proc.kill()` 은 부모만 죽인다). 이 PC 는 물리 메모리가 7.8GB 라 그것이 쌓이면
// **다음 주행이 남의 쓰레기 때문에 실패한다** — 그리고 그 실패는 제품 결함처럼 보인다.
sweepOrphans();
console.log(memoryNote());
if (walkScale() > 1) console.log(`[대기] WALK_TIMEOUT_SCALE=${walkScale()} — 모든 기다림 상한에 배율을 걸었다(FIX-77).`);

const { proc, ws } = await launchChrome();
const cdp = connect(ws);
await cdp.ready;

const chain = {};

try {
  /**
   * 상대할 업체는 **상품도 있고 사람도 있는** 업체여야 한다.
   *
   * 시드의 `active` 표본 업체 다섯에는 **`vendor_members` 가 없다** — 문의는 들어가지만
   * 인박스를 열 사람이 없어 견적이 영원히 안 나온다(이 점검이 첫 주행에서 그렇게 막혔다).
   * 사람이 붙은 업체는 `로컬 데모 웨딩홀` 하나이고 그것은 심사 데모용 `pending` 이다.
   * 그래서 **입점 승인부터 사슬에 넣는다** — 우회가 아니라 실제 순서가 그렇다.
   */
  const target = sql(`
    select v.id::text || '|' || v.status || '|' || u.email
      from public.vendors v
      join public.products p on p.vendor_id = v.id
      join public.vendor_members m on m.vendor_id = v.id
      join auth.users u on u.id = m.user_id
     order by v.created_at, u.created_at limit 1;`);
  if (!target) throw new Error("상품과 멤버가 다 있는 업체가 없다. seed:accounts 먼저.");
  const [vendorId, vendorStatus, vendorEmail] = target.split("|");
  chain.vendorId = vendorId;
  chain.vendorEmail = vendorEmail;
  chain.vendorStatusBefore = vendorStatus;

  const consumer = await openFace(cdp, "소비자", "couple-linked-a@local.test");
  const vendor = await openFace(cdp, "업체", chain.vendorEmail);
  const admin = await openFace(cdp, "운영자", "admin@local.test");
  /**
   * **배우자 면을 따로 연다**(C-1 이 잡은 버그 계열).
   *
   * 배우자는 같은 커플이라 RLS 가 계약을 **보여 준다.** 그런데 서명은
   * 소유자만 한다 — 예전엔 역할을 `member_role='owner'` 로만 물어 **배우자에게도
   * 서명 버튼이 떴다.** 화면이 **API 가 거부할 일을 시키는** 모양이다.
   * 소스 검사(`db:rls`)는 `.eq("user_id", actorId)` 가 있는지만 보므로,
   * **실제로 버튼이 안 뜨는지**는 여기서 눈으로 확인한다.
   */
  const spouse = await openFace(cdp, "배우자", "couple-linked-b@local.test");
  console.log(
    `\n면 넷 로그인 — 소비자: ${consumer.loginNote} / 배우자: ${spouse.loginNote} / 업체(${chain.vendorEmail}): ${vendor.loginNote} / 운영자: ${admin.loginNote}\n`,
  );

  // ── 0. 입점 승인 ───────────────────────────────────────
  await step("운영자가 업체 신청을 승인한다", admin, async () => {
    if (chain.vendorStatusBefore === "active") return "이미 active — 건너뛴다";

    const info = await goto(admin, "/admin/vendors");
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);
    await click(admin, '[data-testid="review-panel"] button', { text: "승인" });

    const until = Date.now() + ms(20000);
    for (;;) {
      const status = sql(`select status from public.vendors where id = '${chain.vendorId}';`);
      if (status === "active") return "vendors.status=active";
      if (Date.now() > until) throw new Error(`승인이 반영되지 않았다: status=${status}`);
      await sleep(700);
    }
  });

  // ── 1. 문의 ────────────────────────────────────────────────────────────────
  await step("문의 화면이 뜬다", consumer, async () => {
    const info = await goto(consumer, "/inquiries");
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 120)}`);
    return info.path;
  });

  /**
   * **우회를 걷었다**(FIX-66 해소). C-1b·C-3 때는 이 칸에 화면이 없어 세션 fetch 로
   * 넘어갔고, **실주행이 우회하는 단계는 실주행이 지키지 못했다.** 이제 업체 상세에서
   * 폼까지 걸어가 실제로 보낸다 — 사슬의 첫 칸도 클릭으로 지난다.
   */
  await step("업체 상세가 **견적 요청으로 잇는다**(FIX-66)", consumer, async () => {
    const info = await goto(consumer, `/explore/${chain.vendorId}`);
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    const href = await evaluate(
      consumer,
      `(document.querySelector('[data-testid="vendor-inquiry-link"]') || {}).getAttribute
         ? document.querySelector('[data-testid="vendor-inquiry-link"]').getAttribute("href")
         : null`,
    );
    if (!href) throw new Error("업체 상세에 견적 요청으로 가는 자리가 없다");
    if (!String(href).includes(chain.vendorId)) {
      throw new Error(`이 업체가 안 딸려 간다: ${href}`);
    }

    await click(consumer, '[data-testid="vendor-inquiry-link"]');

    // **고정 대기를 쓰지 않는다.** 개발 서버는 처음 여는 라우트를 그 자리에서
    // 컴파일하므로 클라이언트 내비가 몇 초 걸린다 — 1.2초로 재다가 실제로 틀렸다.
    const until = Date.now() + ms(30000);
    for (;;) {
      const after = await snapshot(consumer);
      if (after.path.startsWith("/inquiries/new")) return after.path;
      if (Date.now() > until) throw new Error(`폼으로 가지 않았다: ${after.path}`);
      await sleep(500);
    }
  });

  await step("**표준 폼을 채우고 보낸다** — 사슬의 첫 칸(F-C-13)", consumer, async () => {
    // 업체 상세에서 왔으므로 그 업체가 미리 골라져 있어야 한다.
    const preselected = await evaluate(
      consumer,
      `(() => {
        const box = document.querySelector('#vendor-${chain.vendorId}');
        if (!box) return "후보에 없음";
        return box.getAttribute("data-state") === "checked" || box.getAttribute("aria-checked") === "true"
          ? "미리 골라짐" : "안 골라짐";
      })()`,
    );
    if (preselected !== "미리 골라짐") {
      /**
       * **못 찾았으면 화면이 무엇을 그리고 있었는지 함께 적는다** (FIX-77 이 여기서 시작됐다).
       *
       * 예전에는 `업체가 후보에 없음` 한 줄만 남겼다. 그 문구는 **후보 계산이 틀렸다**
       * 로 읽히는데 실제 원인은 **메모리가 모자라 화면이 덜 그려진 것**이었다 —
       * 그 탓에 회차 하나를 제품 결함 추적에 썼다.
       *
       * 무엇을 봤는지 남기면 둘이 구분된다: 후보 상자가 **0개면** 화면이 안 그려진
       * 쪽이고, **다른 업체만 있으면** 후보 계산이 틀린 쪽이다.
       */
      const seen = await evaluate(
        consumer,
        `(() => {
          const ids = [...document.querySelectorAll('[id^="vendor-"]')].map((n) => n.id);
          return JSON.stringify({
            path: location.pathname + location.search,
            boxes: ids.length,
            heading: document.querySelector("h1,h2")?.textContent?.trim()?.slice(0, 60) ?? "",
          });
        })()`,
      );
      throw new Error(`업체가 ${preselected} :: 화면 ${seen}`);
    }

    const eventDate = new Date(Date.now() + ms(200) * 86400000).toISOString().slice(0, 10);
    await fill(consumer, "#inquiry-date", eventDate);
    await click(consumer, "#category-hall");
    await sleep(400);

    // **보내기 전에 막는 이유가 사라졌는지 본다** — 잠긴 버튼을 누르면 아무 일도
    // 안 일어나고, 그러면 "안 보내졌다" 가 "못 눌렀다" 와 구분되지 않는다.
    const blocked = await evaluate(
      consumer,
      `(document.querySelector('[data-testid="inquiry-blocked"]') || {}).innerText || null`,
    );
    if (blocked) throw new Error(`아직 막혀 있다: ${String(blocked).slice(0, 80)}`);

    await click(consumer, '[data-testid="send-inquiry"]');

    const until = Date.now() + ms(25000);
    for (;;) {
      const id = sql(`select id::text from public.inquiries order by created_at desc limit 1;`);
      const targets = id
        ? sql(`select count(*) from public.inquiry_targets
                 where inquiry_id = '${id}' and vendor_id = '${chain.vendorId}';`)
        : "0";
      if (id && targets !== "0") {
        chain.inquiryId = id;

        return `inquiry=${id.slice(0, 8)} · 이 업체에 대상 행 생성`;
      }
      if (Date.now() > until) {
        const info = await snapshot(consumer);
        throw new Error(`문의가 생기지 않았다: ${info.text.slice(0, 250)}`);
      }
      await sleep(700);
    }
  });

  await step("**보낸 뒤 화면이 몇 곳에 갔는지 말한다** — 간 적 없는 곳에 갔다고 적지 않는다", consumer, async () => {
    const sent = await evaluate(
      consumer,
      `(document.querySelector('[data-testid="inquiry-sent"]') || {}).innerText || ""`,
    );
    if (!String(sent).trim()) throw new Error("보낸 뒤 아무 말도 없다");

    return String(sent).replace(/\s+/g, " ").trim().slice(0, 80);
  });

  // ── 2. 견적 ────────────────────────────────────────────────────────────────
  await step("업체 인박스에 문의가 뜬다", vendor, async () => {
    const info = await goto(vendor, "/vendor/inquiries");
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 120)}`);
    const count = await evaluate(
      vendor,
      `document.querySelectorAll('[data-testid="vendor-inquiry-inbox"] li').length`,
    );
    if (count === 0) throw new Error("인박스가 비었다 — 소비자가 만든 문의가 업체 면에 반영되지 않았다");
    return `인박스 ${count}건`;
  });

  await step("견적을 보낸다", vendor, async () => {
    await click(vendor, '[data-testid="vendor-inquiry-inbox"] li button');
    await click(vendor, '[data-testid="send-quote"]');
    const until = Date.now() + ms(15000);
    for (;;) {
      const id = sql(`select id::text from public.quotes order by created_at desc limit 1;`);
      if (id) {
        chain.quoteId = id;
        return `quote=${id.slice(0, 8)}`;
      }
      if (Date.now() > until) {
        const info = await snapshot(vendor);
        throw new Error(`견적이 생기지 않았다: ${info.text.slice(0, 200)}`);
      }
      await sleep(600);
    }
  });

  // ── 3. 수락 → 예약(hold) ──────────────────────────────────────────────────
  await step("소비자 문의함에 견적이 보인다", consumer, async () => {
    const info = await goto(consumer, "/inquiries");
    const count = await evaluate(consumer, `document.querySelectorAll('[data-testid="quote"]').length`);
    if (count === 0) throw new Error(`견적이 소비자 면에 안 보인다: ${info.text.slice(0, 150)}`);
    return `견적 ${count}건`;
  });

  await step("견적을 수락하면 예약이 함께 생긴다 (C-1 의 다리)", consumer, async () => {
    await click(consumer, '[data-testid="accept-quote"]');
    const until = Date.now() + ms(20000);
    for (;;) {
      const row = sql(
        `select id::text || '|' || status || '|' || coalesce(quote_id::text,'-')
           from public.bookings where quote_id = '${chain.quoteId}' limit 1;`,
      );
      if (row) {
        const [id, status, quoteId] = row.split("|");
        chain.bookingId = id;
        if (status !== "hold") throw new Error(`예약이 hold 가 아니다: ${status}`);
        if (quoteId !== chain.quoteId) throw new Error("예약이 견적을 가리키지 않는다");
        return `booking=${id.slice(0, 8)} status=${status} quote_id 연결됨`;
      }
      if (Date.now() > until) throw new Error("수락했는데 예약이 생기지 않았다");
      await sleep(700);
    }
  });

  await step("수락한 견적이 예약 화면으로 잇는다", consumer, async () => {
    await goto(consumer, "/inquiries");
    await click(consumer, '[data-testid="quote-booking-link"]');

    /**
     * **고정 대기를 쓰지 않는다.** 여기가 C-3 이 한 번 보고 재현하지 못한 25/26 이었다 —
     * 개발 서버는 처음 여는 라우트를 그 자리에서 컴파일하므로 `/bookings/[id]` 로 가는
     * 내비가 1.2초를 넘길 때가 있다. 그러면 검사가 **화면이 아니라 컴파일 속도를** 잰다.
     */
    const until = Date.now() + ms(30000);
    for (;;) {
      const info = await snapshot(consumer);
      if (info.path.startsWith("/bookings/")) return info.path;
      if (Date.now() > until) throw new Error(`예약 화면으로 가지 않았다: ${info.path}`);
      await sleep(500);
    }
  });

  // ── 4. 업체 승인 ──────────────────────────────────────────────────────────
  await step("업체가 예약을 승인한다", vendor, async () => {
    const info = await goto(vendor, "/vendor/bookings");
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 120)}`);
    await click(vendor, '[data-testid="decide-panel"] button', { text: "승인" });
    await click(vendor, '[data-testid="decide-accept"] button', { text: "승인하기" });

    const until = Date.now() + ms(20000);
    for (;;) {
      const acceptedAt = sql(
        `select coalesce(accepted_at::text,'') from public.bookings where id = '${chain.bookingId}';`,
      );
      if (acceptedAt) return `accepted_at=${acceptedAt.slice(0, 19)}`;
      if (Date.now() > until) throw new Error("승인이 반영되지 않았다");
      await sleep(700);
    }
  });

  // ── 5. 계약 발행 ──────────────────────────────────────────────────────────
  await step("업체가 계약서를 발행한다 (FIX-65 로 생긴 버튼)", vendor, async () => {
    await goto(vendor, "/vendor/bookings");
    await click(vendor, '[data-testid="issue-panel"] button', { text: "계약서 발행" });
    await click(vendor, '[data-testid="issue-confirm"] button', { text: "발행하기" });

    const until = Date.now() + ms(25000);
    for (;;) {
      const row = sql(
        `select id::text || '|' || status || '|' || coalesce(quote_id::text,'-')
           from public.contracts where booking_id = '${chain.bookingId}' limit 1;`,
      );
      if (row) {
        const [id, status, quoteId] = row.split("|");
        chain.contractId = id;
        if (quoteId !== chain.quoteId) {
          throw new Error(`계약이 견적을 안 가리킨다(quote_id=${quoteId}) — 사슬이 계약에서 끊긴다`);
        }
        return `contract=${id.slice(0, 8)} status=${status} quote_id 연결됨`;
      }
      if (Date.now() > until) {
        const info = await snapshot(vendor);
        throw new Error(`계약이 생기지 않았다: ${info.text.slice(0, 200)}`);
      }
      await sleep(700);
    }
  });

  /**
   * **회차는 `payment_schedules` 다.** `payments` 는 실제 결제 시도가 남는 표라
   * 발행 시점에는 비어 있다 — 처음에 `payments` 를 셌 때는 멀제한 앱을 두고
   * 점검이 FAIL 을 냈다. 검사가 틀렸다.
   */
  await step("발행과 동시에 결제 회차가 만들어진다", null, async () => {
    const count = sql(
      `select count(*) from public.payment_schedules s
         join public.contracts c on c.id = s.contract_id
        where c.booking_id = '${chain.bookingId}';`,
    );
    if (count === "0") throw new Error("결제 회차가 없다 — 결제 화면이 부를 것이 없다");
    return `payment_schedules ${count}건`;
  });

  // ── 6. 서명 ───────────────────────────────────────────────────────────────
  await step("계약서 화면이 소비자에게 뜬다", consumer, async () => {
    const info = await goto(consumer, `/contracts/${chain.contractId}`);
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);
    const has = await evaluate(consumer, `!!document.querySelector('[data-testid="contract-clauses"]')`);
    if (!has) throw new Error("조항 영역이 없다");
    return info.path;
  });

  await step("소비자(대표)가 서명한다", consumer, async () => {
    await click(consumer, '[data-testid="contract-sign"]');
    const until = Date.now() + ms(20000);
    for (;;) {
      const n = sql(
        `select count(*) from public.contract_signatures
          where contract_id = '${chain.contractId}' and signer_role = 'couple' and signed_at is not null;`,
      );
      if (n !== "0") return "couple 서명됨";
      if (Date.now() > until) {
        const info = await snapshot(consumer);
        throw new Error(`서명이 기록되지 않았다: ${info.text.slice(0, 200)}`);
      }
      await sleep(700);
    }
  });

  await step("배우자는 계약을 보지만 서명 버튼은 없다 (C-1 이 잡은 버그)", spouse, async () => {
    const info = await goto(spouse, `/contracts/${chain.contractId}`);
    if (info.notFound) throw new Error("배우자가 계약을 못 본다 — 볼 수는 있어야 한다");
    if (info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    const seen = await evaluate(
      spouse,
      `(() => ({
        sign: !!document.querySelector('[data-testid="contract-sign"]'),
        blocked: (document.querySelector('[data-testid="contract-sign-blocked"]')||{}).innerText || null,
        clauses: !!document.querySelector('[data-testid="contract-clauses"]'),
      }))()`,
    );

    if (!seen.clauses) throw new Error("조항을 못 본다 — 배우자는 내용을 볼 수 있어야 한다");
    if (seen.sign) throw new Error("**배우자에게 서명 버튼이 떴다** — API 가 거부할 일을 화면이 시킨다");
    if (!seen.blocked) throw new Error("못 하는 이유를 적지 않는다 — 감추면 '그런 기능이 없다' 로 읽힌다");

    return String(seen.blocked).replace(/\s+/g, " ").trim().slice(0, 70);
  });

  await step("업체가 서명하면 계약이 확정된다", vendor, async () => {
    await goto(vendor, `/contracts/${chain.contractId}`);
    await click(vendor, '[data-testid="contract-sign"]');
    const until = Date.now() + ms(25000);
    for (;;) {
      const status = sql(`select status from public.contracts where id = '${chain.contractId}';`);
      if (status === "active") return "contracts.status=active";
      if (Date.now() > until) throw new Error(`계약이 확정되지 않았다: status=${status}`);
      await sleep(700);
    }
  });

  await step("확정이 예약 상태에도 반영된다", null, async () => {
    const status = sql(`select status from public.bookings where id = '${chain.bookingId}';`);
    if (status !== "confirmed") throw new Error(`예약이 confirmed 가 아니다: ${status}`);
    const rate = sql(
      `select coalesce(applied_fee_rate_bp::text,'') from public.bookings where id = '${chain.bookingId}';`,
    );
    if (!rate) throw new Error("확정인데 요율 스냅샷이 없다");
    return `bookings.status=confirmed · 요율 ${rate}bp 박힘`;
  });

  // ── 7. 결제 ───────────────────────────────────────────────────────────────
  await step("소비자 예약 상세가 결제로 잇는다", consumer, async () => {
    const info = await goto(consumer, `/bookings/${chain.bookingId}`);
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);
    const entry = await evaluate(
      consumer,
      `(() => {
        const el = document.querySelector('[data-testid="booking-entry-checkout"]');
        if (!el) return null;
        return { tag: el.tagName, href: el.getAttribute("href"), text: (el.innerText||"").trim().slice(0,60) };
      })()`,
    );
    if (!entry) throw new Error("결제 진입점이 없다");
    if (entry.tag !== "A") throw new Error(`결제 진입점이 막혀 있다: ${entry.text}`);
    chain.checkoutHref = entry.href;
    return `${entry.tag} → ${entry.href}`;
  });

  await step("결제 화면이 뜬다", consumer, async () => {
    const info = await goto(consumer, chain.checkoutHref);
    if (info.notFound) throw new Error("결제 화면이 404 다");
    if (info.errorState) throw new Error(`결제 화면 오류: ${info.text.slice(0, 200)}`);
    return info.path;
  });

  /**
   * **실제로 결제한다.** 로컬은 `PAYMENT_ADAPTER=stub` 이 기본이라(`charge-adapter.ts`)
   * PSP 없이도 회차가 실제로 닫힌다. 화면이 뜨는 것까지만 보고 멈추면
   * **결제를 확인했다고 말할 수 없다** — 누르는 데까지 간다.
   */
  await step("동의 둘을 채우기 전에는 결제 버튼이 잠긴다", consumer, async () => {
    const locked = await evaluate(
      consumer,
      `(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => (b.innerText||"").includes("\uacb0\uc81c\ud558\uae30"));
        return btn ? btn.disabled : null;
      })()`,
    );
    if (locked === null) throw new Error("결제 버튼이 없다");
    if (locked !== true) throw new Error("동의 없이도 누를 수 있다 — 화면이 API 가 거부할 일을 시킨다");
    return "disabled";
  });

  await step("동의를 채우고 결제한다 (PAYMENT_ADAPTER=stub)", consumer, async () => {
    /**
     * **Radix 체크박스는 `<button role="checkbox">` 다.** `id` 가 붙는 것도 그
     * 버튼이므로 `.click()` 이 먹는다. 다만 **한 번에 안 바뀜 때가 있어**
     * 상태를 다시 읽어 확인하고, 안 바뀜 것만 다시 누른다.
     */
    const settle = async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const state = await evaluate(
          consumer,
          `(() => {
            const boxes = [...document.querySelectorAll('[id^="consent-"]')];
            const off = boxes.filter((b) =>
              b.getAttribute("data-state") !== "checked" && b.getAttribute("aria-checked") !== "true");
            off.forEach((b) => b.click());
            return { total: boxes.length, remaining: off.length };
          })()`,
        );
        await sleep(600);
        const left = await evaluate(
          consumer,
          `[...document.querySelectorAll('[id^="consent-"]')].filter((b) =>
             b.getAttribute("data-state") !== "checked" && b.getAttribute("aria-checked") !== "true").length`,
        );
        if (state.total > 0 && left === 0) return state.total;
        if (state.total === 0) throw new Error("동의 체크박스가 화면에 없다");
      }
      throw new Error("동의를 다 체우지 못했다");
    };

    const total = await settle();

    // **버튼이 정말 풀렸는지 먼저 본다.** 잠긴 버튼을 누르면 아무 일도 안
    // 일어나고, 그러면 "결제가 안 됐다" 가 아니라 "눌르지도 않았다" 가 된다.
    const btn = await evaluate(
      consumer,
      `(() => {
        const b = [...document.querySelectorAll("button")].find((x) => (x.innerText||"").includes("\uacb0\uc81c\ud558\uae30"));
        return b ? { text: b.innerText.replace(/\s+/g," ").trim().slice(0,40), disabled: b.disabled } : null;
      })()`,
    );
    if (btn === null) throw new Error("결제 버튼이 없다");
    if (btn.disabled) throw new Error(`동의 ${total}건을 다 채웠는데도 버튼이 잠겨 있다: ${btn.text}`);

    await click(consumer, "button", { text: "결제하기" });

    const until = Date.now() + ms(40000);
    for (;;) {
      const row = sql(
        `select status from public.payments where booking_id = '${chain.bookingId}' order by created_at desc limit 1;`,
      );
      if (row === "paid") return `payments.status=paid (동의 ${total}건)`;
      if (row !== "") throw new Error(`결제가 ${row} 로 끝났다`);
      if (Date.now() > until) {
        const info = await snapshot(consumer);
        throw new Error(`결제 행이 생기지 않았다: ${info.text.slice(0, 250)}`);
      }
      await sleep(900);
    }
  });

  await step("결제가 회차에 반영된다", null, async () => {
    const paid = sql(
      `select count(*) from public.payment_schedules s
         join public.contracts c on c.id = s.contract_id
        where c.booking_id = '${chain.bookingId}' and s.status = 'paid';`,
    );
    if (paid === "0") throw new Error("결제는 닫혔는데 회차가 그대로다 — 정산이 이것을 본다");
    return `paid 회차 ${paid}건`;
  });

  await step("업체 면이 결제를 본다 — 상태가 다른 면에 반영된다", vendor, async () => {
    const info = await goto(vendor, `/vendor/bookings/${chain.bookingId}`);
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);
    const text = await evaluate(
      vendor,
      `(document.querySelector('[data-testid="vendor-booking-schedules"]')||{}).innerText || ""`,
    );
    if (!/paid/i.test(String(text))) throw new Error(`업체 면의 회차에 결제가 안 보인다: ${String(text).slice(0, 150)}`);
    return String(text).replace(/\s+/g, " ").trim().slice(0, 80);
  });
  // ── 8. 세 면 대조 ─────────────────────────────────────────────────────────
  await step("운영자 거래 조회에 이 거래가 보인다", admin, async () => {
    const info = await goto(admin, "/admin/transactions");
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);
    const hit = await evaluate(
      admin,
      `(() => {
        const rows = [...document.querySelectorAll('[data-testid="admin-transaction-open"]')];
        const want = ${JSON.stringify(chain.bookingId)};
        return rows.some((r) => (r.getAttribute("href")||"").includes(want)) ? rows.length : -rows.length;
      })()`,
    );
    if (hit < 0) throw new Error(`거래 ${hit * -1}건이 보이는데 이 거래는 없다`);
    return `거래 ${hit}건 · 이 거래 포함`;
  });

  await step("업체 거래 상세가 같은 사실을 말한다", vendor, async () => {
    const info = await goto(vendor, `/vendor/bookings/${chain.bookingId}`);
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);
    const status = await evaluate(
      vendor,
      `(document.querySelector('[data-testid="vendor-booking-status"]')||{}).innerText || ""`,
    );
    if (!String(status).trim()) throw new Error("상태 배지가 비었다");
    return String(status).replace(/\s+/g, " ").trim().slice(0, 80);
  });

  await step("세 면이 같은 금액을 말한다", null, async () => {
    const row = sql(
      `select b.total_amount::text || '|' || c.total_amount::text || '|' || q.total_amount::text
         from public.bookings b
         join public.contracts c on c.booking_id = b.id
         join public.quotes q on q.id = b.quote_id
        where b.id = '${chain.bookingId}';`,
    );
    const [booking, contract, quote] = row.split("|");
    if (!(booking === contract && contract === quote)) {
      throw new Error(`금액이 갈린다 — 예약 ${booking} / 계약 ${contract} / 견적 ${quote}`);
    }
    return `견적=예약=계약 ${Number(quote).toLocaleString("ko-KR")}원`;
  });

  // ── 8b. 후기 — 거래가 끝나면 상품에 후기가 붙는다 (C-2e) ─────────────────
  //
  // 사슬은 결제에서 끝났는데, **후기는 그 사슬이 만든 자격 위에 선다.**
  // 확정된 예약이 있어야 쓸 수 있고(정책), 그 예약이 가리키는 상품에 붙는다(트리거).
  // 여기서 밟지 않으면 "검증 후기" 라는 말이 **화면으로 확인된 적 없는 말**이 된다.
  await step("**소비자가 후기를 쓴다** — 확정된 예약이 자격이다(F-C-17)", consumer, async () => {
    const info = await goto(consumer, `/reviews/new/${chain.bookingId}`);
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 200)}`);

    const form = await evaluate(consumer, `!!document.querySelector('[data-testid="review-form"]')`);
    if (!form) throw new Error(`후기 폼이 안 열렸다: ${info.text.slice(0, 200)}`);

    // 축 셋에 각각 점수를 준다. 점수 버튼에는 testid 가 없어 fieldset 안에서 고른다.
    await evaluate(consumer, `(() => {
      for (const set of document.querySelectorAll("fieldset")) {
        const five = [...set.querySelectorAll("button")].find((b) => b.textContent.trim() === "5");
        if (five) five.click();
      }
      return true;
    })()`);

    await fill(consumer, '[data-testid="review-body"]', "C-2e 실주행 후기 — 견적대로 진행됐어요.");
    await click(consumer, "button", { text: "후기 올리기" });

    const until = Date.now() + ms(25000);
    for (;;) {
      const row = sql(`select coalesce(product_id::text, 'NULL')
                         from public.reviews where booking_id = '${chain.bookingId}';`);
      if (row && row !== "NULL") {
        chain.reviewProductId = row;

        return `product_id=${row.slice(0, 8)}`;
      }
      if (Date.now() > until) {
        const info2 = await snapshot(consumer);
        throw new Error(`후기가 저장되지 않았다(product=${row || "없음"}): ${info2.text.slice(0, 250)}`);
      }
      await sleep(700);
    }
  });

  await step("**상품은 작성자가 고른 것이 아니라 예약이 정했다**", null, async () => {
    const same = sql(`select count(*) from public.reviews r
                        join public.bookings b on b.id = r.booking_id
                       where r.booking_id = '${chain.bookingId}'
                         and r.product_id = b.product_id;`);
    if (same !== "1") throw new Error(`후기의 상품이 예약의 상품과 다르다(${same})`);

    return "reviews.product_id = bookings.product_id";
  });

  await step("**그 후기가 상품 상세에 뜬다** — 업체 상세가 아니라 상품 한 장에", consumer, async () => {
    const vendorId = sql(`select vendor_id::text from public.bookings where id = '${chain.bookingId}';`);
    const info = await goto(consumer, `/explore/${vendorId}/${chain.reviewProductId}`);
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 200)}`);

    const view = await evaluate(consumer, `(() => {
      const box = document.querySelector('[data-testid="product-reviews"]');
      const caption = document.querySelector('[data-testid="product-rating-caption"]');
      return JSON.stringify({
        hasBox: Boolean(box),
        body: box ? box.innerText.includes("C-2e 실주행 후기") : false,
        caption: caption ? caption.innerText.trim() : "",
      });
    })()`);
    const { hasBox, body, caption } = JSON.parse(view);

    if (!hasBox) throw new Error("상품 상세에 후기 자리가 없다");
    if (!body) throw new Error(`후기 본문이 상품 상세에 없다: ${info.text.slice(0, 200)}`);

    return `본문 보임 · ${caption.slice(0, 40)}`;
  });

  await step("**평균이 건수 없이 나가지 않는다**(S8-11 규칙) — 분모를 함께 적는다", consumer, async () => {
    const view = await evaluate(consumer, `(() => {
      const caption = document.querySelector('[data-testid="product-rating-caption"]');
      const overall = document.querySelector('[data-testid="product-rating-overall"]');
      return JSON.stringify({
        caption: caption ? caption.innerText.trim() : "",
        overall: overall ? overall.innerText.trim() : "",
      });
    })()`);
    const { caption, overall } = JSON.parse(view);

    // 평균이 보이는데 건수가 없으면 그것이 이 검사가 막는 상태다.
    if (overall === "") throw new Error("평균이 안 보인다 — 분모가 없다");
    if (!/\d+건/.test(caption)) throw new Error(`건수가 없다: "${caption}"`);
    if (!caption.includes("이 상품")) {
      throw new Error(`업체 후기와 구분되지 않는다: "${caption}"`);
    }

    return `${overall} · ${caption.slice(0, 40)}`;
  });

  await step("**막힌 정렬은 여는 조건을 적는다**(C-2e 완료 조건 ③)", consumer, async () => {
    const info = await goto(consumer, "/explore");
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    // 필터 패널은 조건이 없으면 **접혀 있다**(`useState(activeCount > 0)`).
    // 접힌 동안에는 DOM 에 없으므로 먼저 펼친다 — 사용자가 여는 조건에 실제로
    // 닿을 수 있는지까지 확인하는 셈이다.
    await evaluate(consumer, `(() => {
      const toggle = [...document.querySelectorAll("button")]
        .find((b) => /펼치기|접기/.test(b.textContent || ""));
      if (toggle && /펼치기/.test(toggle.textContent || "")) toggle.click();
      return true;
    })()`);
    await sleep(300);

    const view = await evaluate(consumer, `(() => {
      const box = document.querySelector('[data-testid="sort-pending"]');
      const unlocks = document.querySelectorAll('[data-testid="sort-unlock"]');
      return JSON.stringify({
        items: box ? box.querySelectorAll("li").length : 0,
        unlocks: unlocks.length,
        text: box ? box.innerText.replace(/\s+/g, " ").slice(0, 200) : "",
      });
    })()`);
    const { items, unlocks, text } = JSON.parse(view);

    if (items === 0) throw new Error("막힌 정렬 목록이 비었다 — 분모가 없다");
    if (unlocks !== items) throw new Error(`여는 조건이 빠진 항목이 있다(${unlocks}/${items})`);
    if (/후기 데이터가 아직 없습니다/.test(text)) {
      throw new Error("후기가 생겼는데 화면은 아직 '후기 데이터가 없다' 고 적는다");
    }

    return `막힌 정렬 ${items}가지 · 전부 여는 조건 있음`;
  });

  // ── 8b. 지역 필터 (C-2f) ─────────────────────────────────────────────────
  //
  // **어휘를 세운 일이 화면에서 실제로 되는지 본다.** 스키마와 DB 검사는 값이 옳은지
  // 말해 주지만, 사용자가 지역을 골라 결과를 받는 데까지는 아무 말도 하지 않는다.
  await step("**지역을 골라서 찾는다** — 코드로 정확히 거른다(C-2f)", consumer, async () => {
    const before = await goto(consumer, "/explore");
    if (before.notFound || before.errorState) {
      throw new Error(`화면 상태 이상: ${before.text.slice(0, 150)}`);
    }

    await evaluate(consumer, `(() => {
      const toggle = [...document.querySelectorAll("button")]
        .find((b) => /펼치기|접기/.test(b.textContent || ""));
      if (toggle && /펼치기/.test(toggle.textContent || "")) toggle.click();
      return true;
    })()`);
    await sleep(300);

    // **자유 입력이 아니라 고르는 자리인지 먼저 본다.** `<input>` 이 남아 있으면
    // 아래에서 값을 넣어도 통과하므로, 무엇을 조작했는지가 검사의 일부다.
    const shape = await evaluate(consumer, `(() => {
      const el = document.querySelector('#region');
      if (!el) return JSON.stringify({ tag: "none" });
      return JSON.stringify({
        tag: el.tagName.toLowerCase(),
        options: el.tagName.toLowerCase() === "select" ? el.options.length : 0,
        groups: el.tagName.toLowerCase() === "select" ? el.querySelectorAll("optgroup").length : 0,
      });
    })()`);
    const { tag, options, groups } = JSON.parse(shape);

    if (tag !== "select") throw new Error(`지역이 아직 자유 입력이다: <${tag}>`);
    // 73 + '전체'
    if (options !== 74) throw new Error(`어휘가 다 실리지 않았다: ${options}개`);
    if (groups !== 17) throw new Error(`시도 묶음이 17이 아니다: ${groups}`);

    await evaluate(consumer, `(() => {
      const el = document.querySelector('#region');
      el.value = 'seoul-gangnam';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const form = el.closest('form');
      form.requestSubmit();
      return true;
    })()`);
    await sleep(1200);

    const after = await evaluate(consumer, `(() => JSON.stringify({
      url: location.search,
      cards: document.querySelectorAll('[data-testid="vendor-card"]').length,
      body: document.body.innerText.replace(/\\s+/g, " ").slice(0, 400),
    }))()`);
    const result = JSON.parse(after);

    if (!result.url.includes("region=seoul-gangnam")) {
      throw new Error(`주소에 코드가 안 실렸다: ${result.url}`);
    }
    if (result.cards === 0) throw new Error("지역으로 걸렀더니 0건 — 필터가 아무도 못 찾는다");
    // **코드가 화면에 노출되면 안 된다.** 라벨이 사람이 읽는 것이다.
    if (/seoul-gangnam/.test(result.body)) throw new Error("화면에 코드가 그대로 적혔다");
    if (!/서울 강남/.test(result.body)) throw new Error("라벨이 화면에 없다");

    return `${result.cards}곳 · 선택지 ${options}(시도 ${groups}묶음) · 화면은 라벨`;
  });

  await step("**시도를 고르면 그 안이 함께 나온다** — 서울 = 서울 어디든", consumer, async () => {
    const wide = await goto(consumer, "/explore?region=seoul");
    if (wide.notFound || wide.errorState) {
      throw new Error(`화면 상태 이상: ${wide.text.slice(0, 150)}`);
    }

    const counts = await evaluate(consumer, `(() => JSON.stringify({
      cards: document.querySelectorAll('[data-testid="vendor-card"]').length,
    }))()`);
    const wideCount = JSON.parse(counts).cards;

    const narrowInfo = await goto(consumer, "/explore?region=gyeonggi");
    if (narrowInfo.errorState) throw new Error("경기로 거르니 화면이 깨졌다");
    const other = JSON.parse(
      await evaluate(consumer, `(() => JSON.stringify({
        cards: document.querySelectorAll('[data-testid="vendor-card"]').length,
      }))()`),
    ).cards;

    if (wideCount === 0) throw new Error("서울로 걸렀는데 0건 — 시도가 시군구를 못 품는다");
    // **늘 다 나오는 필터가 아니다.** 다른 시도를 고르면 줄어야 한다.
    if (other >= wideCount) {
      throw new Error(`시도가 구분되지 않는다: 서울 ${wideCount} · 경기 ${other}`);
    }

    return `서울 ${wideCount}곳 · 경기 ${other}곳`;
  });

  await step("**옛 링크가 살아 있다** — 공유된 주소를 깨지 않는다(C-2f 이행)", consumer, async () => {
    const info = await goto(consumer, "/explore?region=%EA%B0%95%EB%82%A8");
    if (info.errorState) throw new Error(`옛 표기로 들어오니 오류다: ${info.text.slice(0, 150)}`);

    const body = await evaluate(consumer, `(() => document.body.innerText.replace(/\\s+/g, " ").slice(0, 300))()`);
    if (!/서울 강남/.test(body)) throw new Error(`옛 표기가 코드로 안 옮겨졌다: ${body.slice(0, 120)}`);

    return "‘강남’ → 서울 강남";
  });

  await step("**없는 지역은 조용히 넘기지 않는다** — 0건과 오탈자를 구분한다", consumer, async () => {
    const info = await goto(consumer, "/explore?region=zzz-nowhere");
    if (info.notFound) return "404";

    // **본문 앞자락을 보지 않는다.** 처음엔 `innerText.slice(0, 400)` 이었는데 그
    // 400자가 통째로 **지역 선택지 73개**여서 안내 문구에 닿지 못했다 — 검사가 떨어진
    // 이유가 코드가 아니라 자기 자신이었다. 오류 상태를 자리로 집어서 본다.
    const seen = JSON.parse(await evaluate(consumer, `(() => {
      const box = document.querySelector('[data-testid="error-state"]');
      return JSON.stringify({
        shown: Boolean(box),
        text: box ? box.innerText.replace(/\\s+/g, " ").slice(0, 160) : "",
        cards: document.querySelectorAll('[data-testid="vendor-card"]').length,
      });
    })()`));

    // 전체 목록을 그냥 보여 주면 사용자는 자기 조건이 안 걸린 줄 모른다.
    if (!seen.shown) throw new Error("어휘 밖 지역인데 오류 상태가 없다");
    if (seen.cards > 0) throw new Error(`오류를 띄우면서 결과도 냈다: ${seen.cards}건`);
    if (!/지역/.test(seen.text)) throw new Error(`무엇이 문제인지 안 적었다: ${seen.text}`);

    return seen.text.replace(/\s+/g, " ").slice(0, 60);
  });

  await step("**참가격 페이지가 어휘를 지킨다** — 없는 지역은 404 다", consumer, async () => {
    const good = await goto(consumer, "/prices/seoul-gangnam/hall");
    if (good.notFound) throw new Error("있는 지역인데 404 다 — 늘 404 를 내는 판정이 아니다");

    const bad = await goto(consumer, "/prices/zzz-nowhere/hall");
    if (!bad.notFound) throw new Error("없는 지역이 200 이다 — 빈 페이지가 검색엔진에 쌓인다");

    return "seoul-gangnam 200 · zzz-nowhere 404";
  });

  // ── 8c. 준비 항목 확장 · 예식 후 태스크 (C-4a) ───────────────────────────
  //
  // **완료 조건이 "역산·선행·표현 넷에서 전부 제자리에 뜬다" 라서** DB 검사만으로는
  // 끝나지 않는다. 양수 오프셋은 **만들어지기는 하는데 어디에도 안 뜨는** 방식으로
  // 실패할 수 있다 — 그 실패는 화면을 열어야 보인다.
  await step("**체크리스트가 25종을 만든다** — 준비 항목이 늘었다(C-4a)", consumer, async () => {
    const info = await goto(consumer, "/checklist");
    if (info.notFound || info.errorState) {
      throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);
    }

    // 아직 만들기 전이면 **무엇이 들어올지 화면이 먼저 말해야 한다**(소급하지 않는다).
    const before = JSON.parse(await evaluate(consumer, `(() => {
      const box = document.querySelector('[data-testid="missing-templates"]');
      return JSON.stringify({ listed: box ? box.innerText.replace(/\\s+/g, " ") : null });
    })()`));

    await click(consumer, "button", { text: "일정 만들기" });
    await sleep(2500);

    const made = Number(
      sql(`select count(*) from public.tasks t
             join public.couples c on c.id = t.couple_id
            where t.template_code is not null;`),
    );

    if (made !== 25) throw new Error(`템플릿 태스크가 25가 아니다: ${made}`);

    return `${made}건 · 만들기 전 안내 ${before.listed === null ? "없음(첫 생성)" : "있음"}`;
  });

  await step("**예식 뒤 항목이 예식 뒤 날짜를 갖는다** — 역산이 양수를 넘긴다", consumer, async () => {
    const bad = sql(`select count(*) from public.tasks t
                      join public.couples c on c.id = t.couple_id
                      join public.task_templates tp on tp.code = t.template_code
                     where tp.offset_days > 0 and (t.due_date is null or t.due_date <= c.wedding_date);`);

    const post = sql(`select count(*) from public.tasks t
                       join public.task_templates tp on tp.code = t.template_code
                      where tp.offset_days > 0;`);

    // **분모를 먼저 본다** — 0건이면 위 검사가 조용히 통과한다.
    if (post !== "3") throw new Error(`예식 후 태스크가 셋이 아니다: ${post}`);
    if (bad !== "0") throw new Error(`예식 뒤인데 기한이 예식 전이거나 빈 것이 ${bad}건`);

    return `예식 후 ${post}건 · 전부 예식 뒤 날짜`;
  });

  await step("**타임라인에 '예식 후' 구간이 뜬다**(표현 A)", consumer, async () => {
    const info = await goto(consumer, "/checklist");
    if (info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    const seen = JSON.parse(await evaluate(consumer, `(() => {
      const box = document.querySelector('[data-testid="schedule-views"]');
      const text = box ? box.innerText.replace(/\\s+/g, " ") : "";
      return JSON.stringify({
        hasBox: Boolean(box),
        after: /예식 후/.test(text),
        settlement: /축의금 정산/.test(text),
        // 예식 전 구간도 함께 서 있어야 한다 — 축을 통째로 갈아엎은 것이 아니다.
        before: /개월 전|주 전/.test(text),
        stale: /예식 당일·이후/.test(text),
      });
    })()`));

    if (!seen.hasBox) throw new Error("표현 영역이 없다");
    if (!seen.after) throw new Error("'예식 후' 구간이 화면에 없다 — 양수 항목이 예식 전 칸에 섞였다");
    if (!seen.settlement) throw new Error("축의금 정산이 타임라인에 없다");
    if (!seen.before) throw new Error("예식 전 구간이 사라졌다 — 기존 표현이 깨졌다");
    if (seen.stale) throw new Error("'예식 당일·이후' 가 남아 있다 — 두 자리가 같은 것을 주장한다");

    return "예식 후 구간 · 축의금 정산 · 예식 전 구간 동시에";
  });

  await step("**새 카테고리가 한글 라벨로 뜬다**(표현 B) — 코드가 새지 않는다", consumer, async () => {
    await evaluate(consumer, `(() => {
      const tab = document.querySelector('[data-testid="schedule-view-progress"]');
      if (tab) tab.click();
      return true;
    })()`);
    await sleep(600);

    const seen = JSON.parse(await evaluate(consumer, `(() => {
      const box = document.querySelector('[data-testid="schedule-views"]');
      const text = box ? box.innerText.replace(/\\s+/g, " ") : "";
      return JSON.stringify({
        labels: ["양가", "예복·한복", "답례"].filter((l) => text.includes(l)),
        rawCodes: ["family", "attire", "gift"].filter((c) => text.includes(c)),
      });
    })()`));

    if (seen.labels.length !== 3) {
      throw new Error(`새 카테고리 라벨이 ${seen.labels.length}/3 만 보인다`);
    }
    if (seen.rawCodes.length > 0) {
      throw new Error(`코드가 그대로 화면에 적혔다: ${seen.rawCodes.join(",")}`);
    }

    return `라벨 셋 · 코드 노출 0`;
  });

  await step("**나머지 표현 둘도 선다**(표현 C·D) — 넷 중 둘만 고치지 않았다", consumer, async () => {
    const shown = [];

    for (const view of ["next", "graph", "timeline"]) {
      await evaluate(consumer, `(() => {
        const tab = document.querySelector('[data-testid="schedule-view-${view}"]');
        if (tab) tab.click();
        return true;
      })()`);
      await sleep(500);

      const ok = await evaluate(consumer, `(() => {
        const box = document.querySelector('[data-testid="schedule-views"]');
        return Boolean(box) && (box.innerText || "").trim().length > 0;
      })()`);

      if (ok !== "true" && ok !== true) throw new Error(`${view} 표현이 비었다`);
      shown.push(view);
    }

    return shown.join(" · ");
  });

  await step("**다 넣고 나면 '빠진 것이 없다' 고 말한다** — 0건을 만들게 두지 않는다", consumer, async () => {
    const info = await goto(consumer, "/checklist");
    if (info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    const seen = JSON.parse(await evaluate(consumer, `(() => {
      const none = document.querySelector('[data-testid="missing-none"]');
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /넣기|일정 만들기/.test(b.textContent || ""),
      );
      return JSON.stringify({
        none: Boolean(none),
        disabled: btn ? btn.disabled : null,
        label: btn ? (btn.textContent || "").trim() : null,
      });
    })()`));

    if (!seen.none) throw new Error("'빠진 준비 항목이 없어요' 가 없다");
    if (seen.disabled !== true) throw new Error(`버튼이 여전히 눌린다: ${seen.label}`);

    return `안내 있음 · 버튼 잠김("${seen.label}")`;
  });

  await step("**하나 지우면 이름으로 되돌아온다** — 소급하지 않고 알린다", consumer, async () => {
    // **소급 생성을 하지 않기로 했으므로**(S7-08) 늘어난 항목이 기존 커플에게 닿는
    // 길은 이 안내 하나다. 그 길이 실제로 열리는지 지워서 만들어 본다.
    sql(`delete from public.tasks where template_code = 'T-family-settlement';`);

    const info = await goto(consumer, "/checklist");
    if (info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    const seen = JSON.parse(await evaluate(consumer, `(() => {
      const box = document.querySelector('[data-testid="missing-templates"]');
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /넣기/.test(b.textContent || ""),
      );
      return JSON.stringify({
        text: box ? box.innerText.replace(/\\s+/g, " ") : null,
        disabled: btn ? btn.disabled : null,
      });
    })()`));

    if (seen.text === null) throw new Error("빠진 항목 안내가 없다");
    if (!seen.text.includes("축의금 정산")) {
      throw new Error(`무엇이 빠졌는지 이름으로 안 적었다: ${seen.text}`);
    }
    if (seen.disabled === true) throw new Error("넣을 것이 있는데 버튼이 잠겼다");

    return seen.text.slice(0, 60);
  });

  // ── 9. 하이드레이션·콘솔 ──────────────────────────────────────────────────
  await step("사슬 화면 어디에도 콘솔 오류가 없다", null, async () => {
    const noisy = steps.filter((s) => s.consoleErrors.length > 0);
    if (noisy.length > 0) {
      throw new Error(
        noisy.map((s) => `${s.name}: ${s.consoleErrors[0].slice(0, 120)}`).join(" / "),
      );
    }
    return "0건";
  });
} catch (error) {
  failed += 1;
  console.log(`\n주행이 중단됐다: ${String(error.message ?? error)}`);
  steps.push({ name: "주행", face: "-", ok: false, note: String(error.message ?? error) });
} finally {
  cdp.close();
  killTree(proc);
  removeProfile(lastProfile);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ chain, steps }, null, 2), "utf8");

console.log(`\n${steps.filter((s) => s.ok).length}/${steps.length} passed — ${OUT}`);
process.exit(failed === 0 ? 0 : 1);
