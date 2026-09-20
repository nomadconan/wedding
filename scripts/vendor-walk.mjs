// =============================================================================
// 업체 편의 실주행 — 상품 등록·복제·템플릿을 실제 Chrome 으로 민다 (C-3)
// -----------------------------------------------------------------------------
// **왜 또 하나인가.** `chain:walk`(C-1b · D-194)은 **한 거래**를 끝까지 민다 —
// 문의부터 결제까지. 그런데 C-3 이 손댄 것은 거래가 아니라 **업체가 반복해서 하는
// 일**이다: 비슷한 상품을 여러 개 올리고, 같은 견적 구성을 다시 쓰고, 같은 문장을
// 다시 보낸다. 사슬 주행은 그것을 한 번도 지나지 않는다.
//
// **B-1 이 센 것을 여기서도 센다.** 상품 하나를 게시까지 올리는 데 화면 몇 개와
// 입력 몇 개가 드는지 — 그 수가 줄었다는 주장을 **주장으로 두지 않는다.**
//
// **새 의존성을 넣지 않았다.** `audit-runtime.mjs`·`chain-walk.mjs` 와 같은 방식으로
// CDP 를 직접 문다.
//
// 실행 (개발 서버가 떠 있어야 한다):
//   npm run dev              (다른 창)
//   npm run vendor:walk
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
const OUT = opt("out", "tmp/vendor-walk.json");
const PASSWORD = process.env.SEED_PASSWORD || "local-dev-1234";

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE)) {
  console.error(`로컬 전용이다. NEXT_PUBLIC_APP_URL=${BASE}`);
  process.exit(1);
}

const sleep = (delayMs) => new Promise((r) => setTimeout(r, delayMs));

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
    // **stderr 를 삼킨다.** 일부러 막히는지 보는 질의가 있어서(CHECK 위반) 그대로 두면
    // 통과한 주행 로그에 빨간 ERROR 가 섞여 나온다 — 읽는 사람이 실패로 읽는다.
    // 실패는 던져서 알린다(`execFileSync` 가 0 아닌 종료 코드에 throw 한다).
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
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
  const port = 9833 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "wc-vendor-"));
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

async function openFace(cdp, key, email) {
  const { browserContextId } = await cdp.send("Target.createBrowserContext", {
    disposeOnDetach: false,
  });
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
    browserContextId,
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  const state = { loaded: false, consoleErrors: [] };
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Page.loadEventFired") state.loaded = true;
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
  face.loginNote = await login(face);
  return face;
}

async function evaluate(face, expression) {
  const r = await face.cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    face.sessionId,
  );
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.text ?? "evaluate 실패"));

  return r.result?.value;
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

async function goto(face, path) {
  face.state.loaded = false;
  face.state.consoleErrors.length = 0;
  await face.cdp.send("Page.navigate", { url: BASE + path }, face.sessionId);

  const deadline = Date.now() + ms(45000);
  while (!face.state.loaded && Date.now() < deadline) await sleep(50);
  await sleep(400);

  const settle = Date.now() + ms(10000);
  for (;;) {
    const info = await snapshot(face);
    if (!(info.textLength < 40 || info.loadingState) || Date.now() > settle) return info;
    await sleep(300);
  }
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

  const until = Date.now() + ms(25000);
  for (;;) {
    const value = await evaluate(face, fill);
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
      await sleep(800);
      return r;
    }
    if (Date.now() > until) {
      throw new Error(`누를 자리가 없다: ${selector}${text ? ` ("${text}")` : ""}`);
    }
    await sleep(400);
  }
}

// --- 결과 ---------------------------------------------------------------------
const steps = [];
let failed = 0;

async function step(name, face, fn) {
  try {
    const note = (await fn()) ?? "";
    const errors = face ? face.state.consoleErrors.slice(0, 3) : [];
    steps.push({ name, ok: true, note, consoleErrors: errors });
    console.log(`PASS  ${name}${note ? ` :: ${note}` : ""}${errors.length ? `  [console ${errors.length}]` : ""}`);
  } catch (error) {
    failed += 1;
    const message = String(error.message ?? error);
    steps.push({ name, ok: false, note: message, consoleErrors: face ? face.state.consoleErrors.slice(0, 3) : [] });
    console.log(`FAIL  ${name} :: ${message}`);
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

const walk = {};

try {
  const target = sql(`
    select v.id::text || '|' || v.status || '|' || u.email
      from public.vendors v
      join public.vendor_members m on m.vendor_id = v.id
      join auth.users u on u.id = m.user_id
     where m.vendor_role = 'owner'
     order by v.created_at, u.created_at limit 1;`);
  if (!target) throw new Error("대표가 있는 업체가 없다. seed:accounts 먼저.");
  const [vendorId, vendorStatus, ownerEmail] = target.split("|");
  walk.vendorId = vendorId;
  walk.ownerEmail = ownerEmail;

  const owner = await openFace(cdp, "대표", ownerEmail);
  const staff = await openFace(cdp, "담당자", "staff@local.test");
  const admin = await openFace(cdp, "운영자", "admin@local.test");
  /**
   * **소비자 면도 연다.** 견적 템플릿(F-V-07)은 **들어온 문의가 있어야** 열리는
   * 화면에 있다 — 인박스가 비면 견적 폼 자체가 안 뜨고, 그러면 이 점검은
   * "템플릿이 안 보인다" 가 아니라 **아무것도 안 보고 통과**한다.
   */
  const consumer = await openFace(cdp, "소비자", "couple-linked-a@local.test");
  console.log(
    `\n면 넷 로그인 — 대표(${ownerEmail}): ${owner.loginNote} / 담당자: ${staff.loginNote} / 운영자: ${admin.loginNote} / 소비자: ${consumer.loginNote}\n`,
  );

  // ── 0. 입점 승인 (게시 상품이 고객에게 보이려면 업체가 active 여야 한다) ───
  await step("운영자가 업체 신청을 승인한다", admin, async () => {
    if (vendorStatus === "active") return "이미 active — 건너뛴다";

    const info = await goto(admin, "/admin/vendors");
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);
    await click(admin, '[data-testid="review-panel"] button', { text: "승인" });

    const until = Date.now() + ms(20000);
    for (;;) {
      const status = sql(`select status from public.vendors where id = '${vendorId}';`);
      if (status === "active") return "vendors.status=active";
      if (Date.now() > until) throw new Error(`승인이 반영되지 않았다: status=${status}`);
      await sleep(700);
    }
  });

  // ── 1. 상품을 처음부터 등록한다 (B-1 이 센 단계를 실제로 밟는다) ───────────
  await step("상품 등록 화면이 뜬다", owner, async () => {
    const info = await goto(owner, "/vendor/products/new");
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    return info.path;
  });

  await step("**필수 입력 넷을 채우고 저장한다** — 화면 1", owner, async () => {
    await fill(owner, "#name", "C-3 주말 점심 패키지");
    await fill(owner, "#basePriceTotal", "12000000");
    await fill(owner, "#capacityMin", "100");
    await fill(owner, "#capacityMax", "250");
    await click(owner, "button", { text: "항목 추가" });
    await fill(owner, '[aria-label="포함 항목 1"]', "홀 대관 4시간");
    // 본문 두 칸도 같은 화면에서 채운다(C-2b). 선택 입력이지만 **등록 화면에 있어야** 쓴다.
    await fill(owner, "#summary", "평일 낮 예식을 위한 단독홀 패키지");
    await fill(owner, "#description", "## 구성\n\n- 홀 대관 4시간\n- 기본 데코\n\n**평일 낮**에는 더 여유롭습니다.");
    await click(owner, 'button[type="submit"]', { text: "상품 등록" });

    const until = Date.now() + ms(25000);
    for (;;) {
      const id = sql(`select id::text from public.products
                       where vendor_id = '${vendorId}' and name = 'C-3 주말 점심 패키지' limit 1;`);
      if (id) {
        walk.productId = id;

        return `product=${id.slice(0, 8)}`;
      }
      if (Date.now() > until) {
        const info = await snapshot(owner);
        throw new Error(`상품이 생기지 않았다: ${info.text.slice(0, 250)}`);
      }
      await sleep(700);
    }
  });

  // ── C-2b — 본문·사진 ────────────────────────────────────────────────────
  await step("**한 줄 소개와 본문이 함께 저장됐다**(C-2b) — 등록 화면에서 같이 받는다", null, async () => {
    const row = sql(`select coalesce(summary, '-') || '|' ||
                            coalesce(description_json ->> 'source', '-') || '|' ||
                            coalesce((description_json ->> 'v'), '-')
                       from public.products where id = '${walk.productId}';`);
    const [summary, source, version] = row.split("|");
    if (summary === "-") throw new Error("한 줄 소개가 저장되지 않았다");
    if (!source.includes("홀 대관 4시간")) throw new Error(`본문이 저장되지 않았다: ${source.slice(0, 80)}`);
    if (version !== "1") throw new Error(`봉투 판본이 이상하다: ${version}`);

    return `summary="${summary.slice(0, 16)}…" · source ${source.length}자 · v${version}`;
  });

  await step("**본문에 블록을 저장하지 않는다** — 원문만 담긴다(D-97)", null, async () => {
    const keys = sql(`select string_agg(k, ',' order by k)
                        from public.products, jsonb_object_keys(description_json) k
                       where id = '${walk.productId}';`);
    if (keys !== "source,v") throw new Error(`봉투에 다른 칸이 있다: ${keys}`);

    return `keys=${keys}`;
  });

  await step("**가격 회피 문구를 본문에 쓰면 저장이 잠긴다**(F-V-03) — 총액 강제가 본문으로 새지 않는다", owner, async () => {
    const info = await goto(owner, `/vendor/products/${walk.productId}`);
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    await fill(owner, "#summary", "자세한 가격은 별도 문의 주세요");

    const state = await evaluate(owner, `(() => {
      const box = document.querySelector('[data-testid="content-problems"]');
      const submit = [...document.querySelectorAll('button[type="submit"]')].pop();
      return JSON.stringify({ problem: box ? box.innerText.trim() : "", disabled: submit ? submit.disabled : null });
    })()`);
    const { problem, disabled } = JSON.parse(state);

    if (!problem) throw new Error("가격 회피 문구인데 화면이 아무 말도 하지 않는다");
    if (disabled !== true) throw new Error("문구가 걸렸는데 저장 버튼이 열려 있다");

    return problem.slice(0, 60);
  });

  await step("**연락처를 본문에 쓰면 막는다** — 밖에서 거래가 성사되면 증적이 남지 않는다", owner, async () => {
    await fill(owner, "#summary", "평일 낮 예식을 위한 단독홀 패키지");
    await fill(owner, "#description", "예약 문의는 010-1234-5678 로 주세요");

    const state = await evaluate(owner, `(() => {
      const box = document.querySelector('[data-testid="content-problems"]');
      const submit = [...document.querySelectorAll('button[type="submit"]')].pop();
      return JSON.stringify({ problem: box ? box.innerText.trim() : "", disabled: submit ? submit.disabled : null });
    })()`);
    const { problem, disabled } = JSON.parse(state);

    if (!/전화번호/.test(problem)) throw new Error(`연락처를 못 잡았다: ${problem.slice(0, 80)}`);
    if (disabled !== true) throw new Error("연락처가 걸렸는데 저장 버튼이 열려 있다");
    // **걸린 값 자체를 화면에 되풀이하지 않는다.**
    if (problem.includes("010-1234-5678")) throw new Error("걸린 번호를 화면이 그대로 되읊는다");

    return problem.slice(0, 60);
  });

  await step("**정상 문구는 통과한다** — 늘 잠그는 화면이 아니다", owner, async () => {
    await fill(owner, "#description", "## 구성\n\n- 홀 대관 4시간");

    const disabled = await evaluate(owner, `(() => {
      const submit = [...document.querySelectorAll('button[type="submit"]')].pop();
      return String(submit ? submit.disabled : "none");
    })()`);
    if (disabled !== "false") throw new Error(`정상 문구인데 저장이 잠겨 있다: ${disabled}`);

    return "저장 열림";
  });

  await step("**완성도 권유가 게시 조건과 다른 자리에 있다**(D-209) — 게시를 막지 않는다", owner, async () => {
    const view = await evaluate(owner, `(() => {
      const card = document.querySelector('[data-testid="content-suggestions"]');
      const photos = document.querySelector('[data-testid="product-photos"]');
      return JSON.stringify({
        suggestion: card ? card.innerText.replace(/\s+/g, " ").trim() : "",
        hasPhotoPanel: Boolean(photos),
      });
    })()`);
    const { suggestion, hasPhotoPanel } = JSON.parse(view);

    if (!hasPhotoPanel) throw new Error("사진 관리 자리가 없다");
    if (!suggestion) throw new Error("사진이 없는데 권유가 뜨지 않는다");
    if (!/게시를 막지 않습니다/.test(suggestion)) {
      throw new Error(`권유가 게시 조건처럼 읽힌다: ${suggestion.slice(0, 80)}`);
    }

    return suggestion.slice(0, 70);
  });

  await step("**기존 게시 상품이 내려가지 않았다**(C-2b 완료 조건) — 분모부터 센다", null, async () => {
    const bare = Number(sql(`select count(*) from public.products
                              where status = 'published' and summary is null and description_json is null
                                and not exists (select 1 from public.vendor_media m where m.product_id = products.id);`));
    if (bare === 0) throw new Error("본문·사진 없는 게시 상품이 없다 — 이 검사가 빈 표로 통과할 뻔했다");

    const demoted = sql(`select count(*) from public.products
                          where published_at is not null and status <> 'published';`);
    if (demoted !== "0") throw new Error(`게시였다가 내려간 상품이 있다: ${demoted}건`);

    return `본문·사진 없는 게시 ${bare}건 · 내려간 것 0건`;
  });

  await step("**등록 직후에는 게시할 수 없다**(D-06) — 추가금 확정이 남아 있다", null, async () => {
    const row = sql(`select status || '|' || coalesce(add_ons_declared_at::text, '-')
                       from public.products where id = '${walk.productId}';`);
    const [status, declared] = row.split("|");
    if (status !== "draft") throw new Error(`작성 중이 아니다: ${status}`);
    if (declared !== "-") throw new Error("등록만 했는데 추가금이 확정돼 있다");

    return "status=draft · 추가금 미확정";
  });

  await step("**추가금을 등록하고 확정한다** — 화면 2", owner, async () => {
    const info = await goto(owner, `/vendor/products/${walk.productId}`);
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    await fill(owner, "#option-name", "주말 할증");
    await fill(owner, "#option-price", "500000");
    await fill(owner, "#option-condition", "토요일·공휴일 예식 시");
    await click(owner, "button", { text: "추가금 등록" });

    /**
     * **고정 대기를 쓰지 않는다** (FIX-77).
     *
     * 여기는 `await sleep(1200)` 이었다. 등록이 반영되는 데 걸리는 시간은 기계마다
     * 다른데 **1.2초는 여유 있는 기계에서 맞춘 값**이라, 메모리가 빠듯한 PC 에서는
     * 항목이 아직 안 그려진 채로 "확정" 을 눌러 **아무 일도 일어나지 않았다.**
     * 그 결과가 `확정되지 않았다` 였고 **제품이 고장 난 것처럼 읽혔다.**
     *
     * `chain:walk` 이 같은 자리에서 먼저 배웠다("1.2초로 재다가 실제로 틀렸다") —
     * **기다리지 말고 물어본다.** 행이 실제로 생길 때까지 본다.
     */
    /**
     * **첫 POST 는 API 라우트까지 그 자리에서 컴파일한다.** 개발 서버라 그렇다.
     * 메모리가 빠듯한 기계에서는 그 한 번이 30초를 넘어간다(실측) — 그래서
     * 기본을 넉넉히 두고 `WALK_STEP_TIMEOUT_MS` 로 조절한다. **빠른 기계에서는
     * 비용이 없다** — 행이 생기는 순간 빠져나온다.
     */
    const STEP_MS = Number(process.env.WALK_STEP_TIMEOUT_MS) || ms(90000);
    const optionUntil = Date.now() + STEP_MS;
    for (;;) {
      const count = Number(
        sql(`select count(*) from public.product_options where product_id = '${walk.productId}';`),
      );
      if (count > 0) break;
      if (Date.now() > optionUntil) {
        // **무엇을 봤는지 적는다**(D-208) — 화면에 오류가 떴는지, 그냥 느린지 갈린다.
        const info = await snapshot(owner);
        throw new Error(
          `추가금 항목이 ${STEP_MS / 1000}초 안에 등록되지 않았다 — '확정' 을 누를 대상이 없다 :: ` +
            info.text.replace(/\s+/g, " ").slice(0, 160),
        );
      }
      await sleep(400);
    }

    await click(owner, "button", { text: "확정" });

    const until = Date.now() + ms(25000);
    for (;;) {
      const declared = sql(`select coalesce(add_ons_declared_at::text, '')
                              from public.products where id = '${walk.productId}';`);
      if (declared) {
        const count = sql(`select count(*) from public.product_options where product_id = '${walk.productId}';`);

        return `추가금 ${count}개 · 확정됨`;
      }
      if (Date.now() > until) {
        const info = await snapshot(owner);
        throw new Error(`확정되지 않았다: ${info.text.slice(0, 250)}`);
      }
      await sleep(700);
    }
  });

  await step("게시한다", owner, async () => {
    await goto(owner, `/vendor/products/${walk.productId}`);
    await click(owner, "button", { text: "게시" });

    const until = Date.now() + ms(20000);
    for (;;) {
      const status = sql(`select status from public.products where id = '${walk.productId}';`);
      if (status === "published") return "status=published";
      if (Date.now() > until) throw new Error(`게시되지 않았다: status=${status}`);
      await sleep(700);
    }
  });

  // ── 2. 복제 (C-3 이 만든 것) ──────────────────────────────────────────────
  await step("**상품 목록에 복제 버튼이 있다**(C-3 · F-V-03)", owner, async () => {
    const info = await goto(owner, "/vendor/products");
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    const count = await evaluate(owner, `document.querySelectorAll('[data-testid="duplicate-product"]').length`);
    if (count === 0) throw new Error("복제 버튼이 없다");

    return `${count}개 상품에 복제 버튼`;
  });

  await step("**복제하면 사본이 생긴다** — 값은 따라오고 확정은 안 따라온다", owner, async () => {
    const before = sql(`select count(*) from public.products where vendor_id = '${vendorId}';`);

    await click(owner, '[data-testid="duplicate-product"] button', { text: "복제" });

    const until = Date.now() + ms(25000);
    for (;;) {
      const row = sql(`select id::text || '|' || name || '|' || status || '|' ||
                              coalesce(add_ons_declared_at::text,'-') || '|' || base_price_total::text
                         from public.products
                        where vendor_id = '${vendorId}' and name like '%(사본)'
                        order by created_at desc limit 1;`);
      if (row) {
        const [id, name, status, declared, price] = row.split("|");
        walk.copyId = id;
        if (status !== "draft") throw new Error(`사본이 작성 중이 아니다: ${status}`);
        if (declared !== "-") throw new Error("**사본에 추가금 확정이 따라왔다**(D-06 위반)");

        const copied = sql(`select count(*) from public.product_options where product_id = '${id}';`);
        const after = sql(`select count(*) from public.products where vendor_id = '${vendorId}';`);
        if (Number(after) !== Number(before) + 1) throw new Error(`상품 수가 ${before}→${after}`);

        return `${name} · draft · 추가금 ${copied}개 옮김 · 금액 ${Number(price).toLocaleString("ko-KR")}원 그대로`;
      }
      if (Date.now() > until) {
        const info = await snapshot(owner);
        throw new Error(`사본이 생기지 않았다: ${info.text.slice(0, 250)}`);
      }
      await sleep(700);
    }
  });

  await step("**화면이 남은 일을 말한다** — 조용하면 이미 노출되는 줄 안다", owner, async () => {
    const note = await evaluate(
      owner,
      `(document.querySelector('[data-testid="duplicate-done"]')||{}).innerText || ""`,
    );
    if (!String(note).trim()) throw new Error("복제 뒤 아무 말도 없다");

    return String(note).replace(/\s+/g, " ").trim().slice(0, 90);
  });

  await step("**사본은 DB 가 게시를 막는다**(D-06) — 화면이 봐주더라도", null, async () => {
    const blocked = (() => {
      try {
        sql(`update public.products set status = 'published' where id = '${walk.copyId}';`);

        return false;
      } catch {
        return true;
      }
    })();
    if (!blocked) throw new Error("**확정 없이 게시됐다** — CHECK 이 막지 않았다");

    return "products_publish_requirements_chk 가 막았다";
  });

  await step("**담당자에게는 복제 버튼이 없다**(§3.9)", staff, async () => {
    const info = await goto(staff, "/vendor/products");
    if (info.notFound) throw new Error("담당자가 상품 목록을 못 본다 — 볼 수는 있어야 한다");

    const count = await evaluate(staff, `document.querySelectorAll('[data-testid="duplicate-product"]').length`);
    if (count !== 0) throw new Error(`담당자에게 복제 버튼이 ${count}개 뜬다 — 화면이 API 가 거부할 일을 시킨다`);

    return "0개";
  });

  await step("**담당자가 직접 불러도 403 이다** — 최종 경계는 RLS 다", staff, async () => {
    const result = await evaluate(
      staff,
      `fetch("/api/vendor/products/${walk.productId}/duplicate", { method: "POST" })
         .then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 160) }))`,
    );
    if (result.status !== 403) throw new Error(`403 이 아니라 ${result.status}: ${result.body}`);

    return `403 · ${JSON.parse(result.body).error?.code ?? "?"}`;
  });

  // ── FIX-78 — 지운 사진의 주소가 더 이상 열리지 않는다 (C-2c 가 닫았다) ────
  //
  // **행만 지우면 공개 버킷의 그 주소는 계속 열린다.** 업체는 내렸다고 생각하는데
  // 안 내려간 것이다. 소스 검사(`db:rls`)는 "지우는 코드가 있는가" 까지만 보므로
  // **주소를 실제로 눌러 본다** — C-2b 가 "되돌림 검사 자리가 함께 필요하다" 고
  // 적어 둔 자리가 여기다.
  await step("**FIX-78 — 지운 사진의 주소가 더 이상 열리지 않는다**", owner, async () => {
    const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
    if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL 이 없다");

    const raw = await evaluate(owner, `(async () => {
      const headers = { "Content-Type": "application/json" };
      const current = await fetch("/api/vendor/profile").then((r) => r.json());
      const v = current.data.vendor;
      const profile = {
        regionCode: v.region_code || "서울 강남",
        address: v.address, addressDetail: v.address_detail,
        capacityMin: v.capacity_min, capacityMax: v.capacity_max,
        facilities: v.facilities || [], styleTags: v.style_tags || [], intro: v.intro,
      };
      const empty = { add: [], remove: [], order: [], updateAlt: [] };

      const added = await fetch("/api/vendor/profile", {
        method: "PUT", headers,
        body: JSON.stringify({ profile, media: Object.assign({}, empty, {
          add: [{ type: "photo", fileName: "fix78.png", altText: "probe" }] }) }),
      }).then((r) => r.json());

      const upload = added && added.data && added.data.uploads && added.data.uploads[0];
      if (!upload) return JSON.stringify({ stage: "add", body: JSON.stringify(added).slice(0, 200) });

      // 서명 주소로 실제 바이트를 올린다(PNG 매직 8바이트).
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const put = await fetch(upload.signedUrl, {
        method: "PUT", headers: { "Content-Type": "image/png" }, body: bytes,
      });

      const publicUrl = "${supabaseUrl}/storage/v1/object/public/vendor-media/" + upload.path;
      const before = await fetch(publicUrl, { cache: "no-store" }).then((r) => r.status);

      await fetch("/api/vendor/profile", {
        method: "PUT", headers,
        body: JSON.stringify({ profile, media: Object.assign({}, empty, { remove: [upload.id] }) }),
      });

      const after = await fetch(publicUrl, { cache: "no-store" }).then((r) => r.status);

      return JSON.stringify({ stage: "done", putOk: put.ok, before, after });
    })()`);

    const outcome = JSON.parse(raw);
    if (outcome.stage !== "done") throw new Error(`미디어 추가 실패: ${outcome.body}`);
    if (!outcome.putOk) throw new Error("서명 주소 업로드가 실패했다");
    // **올린 직후에는 열려야 한다** — 안 열리면 아래 404 판정이 공짜로 통과한다.
    if (outcome.before !== 200) throw new Error(`올린 사진이 안 열린다(${outcome.before}) — 분모가 없다`);
    if (outcome.after === 200) throw new Error("지웠는데 주소가 그대로 열린다 — FIX-78 이 되살아났다");

    return `올린 뒤 ${outcome.before} · 지운 뒤 ${outcome.after}`;
  });

  // ── 3. 템플릿 — 저장하고 꺼내 쓴다 (C-3) ──────────────────────────────────
  await step("**빠른 답변을 저장한다** — 설정 화면", owner, async () => {
    const info = await goto(owner, "/vendor/settings");
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    await fill(owner, "#qr-title", "C-3 주차 안내");
    await fill(owner, "#qr-body", "주차는 건물 지하 2층에 100대까지 가능합니다.");
    await click(owner, '[data-testid="add-quick-reply"]');

    const until = Date.now() + ms(20000);
    for (;;) {
      const count = sql(`select count(*) from public.vendor_templates
                          where vendor_id = '${vendorId}' and kind = 'quick_reply' and title = 'C-3 주차 안내';`);
      if (count !== "0") return "vendor_templates 에 1건";
      if (Date.now() > until) {
        const state = await snapshot(owner);
        throw new Error(`저장되지 않았다: ${state.text.slice(0, 250)}`);
      }
      await sleep(700);
    }
  });

  await step("**저장한 빠른 답변이 채팅에 뜬다**(F-V-15) — 붙박이만 뜨던 자리다", owner, async () => {
    const info = await goto(owner, "/vendor/chat");
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    const seen = await evaluate(
      owner,
      `(() => {
        const saved = [...document.querySelectorAll('[data-testid="saved-quick-reply"]')];
        return { count: saved.length, titles: saved.map((b) => b.innerText.trim()) };
      })()`,
    );
    if (seen.count === 0) {
      throw new Error("저장한 빠른 답변이 채팅에 안 뜬다 — 저장만 되고 꺼낼 자리가 없다");
    }

    return `${seen.count}개 · ${seen.titles.join(", ").slice(0, 60)}`;
  });

  await step("**누르면 입력창에 들어간다** — 바로 보내지 않는다", owner, async () => {
    await click(owner, '[data-testid="saved-quick-reply"]');
    const draft = await evaluate(
      owner,
      `(() => {
        const el = document.querySelector("textarea");
        return el ? el.value : "";
      })()`,
    );
    if (!String(draft).includes("주차")) throw new Error(`입력창에 안 들어갔다: ${String(draft).slice(0, 60)}`);

    const sent = sql(`select count(*) from public.chat_messages where body like '%지하 2층%';`);
    if (sent !== "0") throw new Error("**바로 보내졌다** — 템플릿은 초안이어야 한다");

    return "입력창에 채워짐 · 보내지지 않음";
  });

  await step("**설정 화면이 꺼내는 자리를 이름으로 말한다**", owner, async () => {
    const info = await goto(owner, "/vendor/settings");
    if (!info.text.includes("채팅 응대")) throw new Error("어디서 꺼내는지 안 적는다");
    if (!info.text.includes("문의·견적")) throw new Error("견적 쪽 자리를 안 적는다");

    return "채팅 응대 · 문의·견적";
  });

  // ── 3b. 견적 템플릿 — 저장하고 꺼내 쓴다 (F-V-07) ─────────────────────────
  /**
   * **우회를 걷었다**(FIX-66 해소). 이 주행은 업체 쪽을 보는 것이지만, 견적 템플릿을
   * 시험하려면 **들어온 문의가 있어야** 한다. 예전에는 세션 fetch 로 만들었고
   * 그 칸은 아무도 지키지 못했다 — 이제 폼으로 보낸다.
   */
  await step("소비자가 **표준 폼으로** 문의를 보낸다(FIX-66)", consumer, async () => {
    const info = await goto(consumer, `/inquiries/new?vendor=${walk.vendorId}`);
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    const form = await evaluate(consumer, `!!document.querySelector('[data-testid="inquiry-form"]')`);
    if (!form) throw new Error(`폼이 안 열렸다: ${info.text.slice(0, 150)}`);

    const eventDate = new Date(Date.now() + ms(200) * 86400000).toISOString().slice(0, 10);
    await fill(consumer, "#inquiry-date", eventDate);
    await click(consumer, "#category-hall");
    await sleep(400);
    await click(consumer, '[data-testid="send-inquiry"]');

    const until = Date.now() + ms(25000);
    for (;;) {
      const count = sql(`select count(*) from public.inquiry_targets t
                           join public.inquiries i on i.id = t.inquiry_id
                          where t.vendor_id = '${walk.vendorId}';`);
      if (count !== "0") return `이 업체 앞으로 문의 ${count}건`;
      if (Date.now() > until) {
        const state = await snapshot(consumer);
        throw new Error(`문의가 생기지 않았다: ${state.text.slice(0, 250)}`);
      }
      await sleep(700);
    }
  });

  await step("**견적 폼에 저장 버튼이 있다**(F-V-07 — 명세가 '템플릿 저장' 을 요구한다)", owner, async () => {
    const info = await goto(owner, "/vendor/inquiries");
    if (info.notFound || info.errorState) throw new Error(`화면 상태 이상: ${info.text.slice(0, 150)}`);

    await click(owner, '[data-testid="vendor-inquiry-inbox"] li button');

    const seen = await evaluate(
      owner,
      `(() => ({
        form: !!document.querySelector('[data-testid="quote-form"]'),
        save: !!document.querySelector('[data-testid="save-quote-template"]'),
        applies: document.querySelectorAll('[data-testid="apply-quote-template"]').length,
      }))()`,
    );
    if (!seen.form) throw new Error("견적 폼이 안 열렸다 — 아래 검사가 아무것도 못 본다");
    if (!seen.save) throw new Error("**저장 버튼이 없다** — 설정 화면은 여기서 저장할 수 있다고 적는다");

    return `폼 열림 · 저장 버튼 있음 · 저장된 템플릿 ${seen.applies}개`;
  });

  await step("**구성을 템플릿으로 저장한다**", owner, async () => {
    // `window.prompt` 는 헤드리스에서 null 을 준다. 실제 사용자가 이름을 치는 것과
    // 같게 **미리 갈아 끼운다** — 이름을 못 받으면 저장하지 않는 것이 정상 동작이라
    // 그대로 두면 이 검사는 "저장 안 됨" 을 정상으로 읽는다.
    await evaluate(owner, `window.prompt = () => "C-3 주말 구성";`);
    await fill(owner, "#quote-base", "11000000");
    await click(owner, '[data-testid="save-quote-template"]');

    const until = Date.now() + ms(20000);
    for (;;) {
      const count = sql(`select count(*) from public.vendor_templates
                          where vendor_id = '${walk.vendorId}' and kind = 'quote' and title = 'C-3 주말 구성';`);
      if (count !== "0") return "vendor_templates(kind=quote) 에 1건";
      if (Date.now() > until) {
        const note = await evaluate(
          owner,
          `(document.querySelector('[data-testid="quote-template-note"]')||{}).innerText || ""`,
        );
        throw new Error(`저장되지 않았다: ${String(note).replace(/\s+/g, " ").slice(0, 200)}`);
      }
      await sleep(700);
    }
  });

  await step("**저장한 구성을 꺼내 쓴다** — 금액이 폼에 돌아온다", owner, async () => {
    await goto(owner, "/vendor/inquiries");
    await click(owner, '[data-testid="vendor-inquiry-inbox"] li button');

    const before = await evaluate(owner, `(document.querySelector("#quote-base")||{}).value ?? null`);
    if (before === null) throw new Error("견적 폼이 안 열렸다");
    if (before !== "") throw new Error(`꺼내기 전에 이미 값이 있다: ${before}`);

    await click(owner, '[data-testid="apply-quote-template"]');
    await sleep(600);

    const after = await evaluate(owner, `(document.querySelector("#quote-base")||{}).value ?? ""`);
    if (after !== "11000000") throw new Error(`금액이 안 돌아왔다: ${JSON.stringify(after)}`);

    // **보내지지 않았는지도 본다** — 템플릿은 초안이다.
    const quotes = sql(`select count(*) from public.quotes;`);
    if (quotes !== "0") throw new Error("**꺼내자마자 견적이 나갔다** — 템플릿은 초안이어야 한다");

    return "11,000,000원 복원 · 견적은 아직 안 나감";
  });

  // ── 4. 세 면 대조 · 콘솔 ──────────────────────────────────────────────────
  await step("**사본은 고객에게 안 보인다** — 초안이다", null, async () => {
    const visible = sql(`select count(*) from public.products
                          where id = '${walk.copyId}' and status = 'published';`);
    if (visible !== "0") throw new Error("사본이 게시 상태다");

    return "published 0건";
  });

  await step("업체 화면 어디에도 콘솔 오류가 없다", null, async () => {
    const noisy = steps.filter((s) => s.consoleErrors.length > 0);
    if (noisy.length > 0) {
      throw new Error(noisy.map((s) => `${s.name}: ${s.consoleErrors[0].slice(0, 120)}`).join(" / "));
    }

    return "0건";
  });
} catch (error) {
  failed += 1;
  console.log(`\n주행이 중단됐다: ${String(error.message ?? error)}`);
  steps.push({ name: "주행", ok: false, note: String(error.message ?? error), consoleErrors: [] });
} finally {
  cdp.close();
  killTree(proc);
  removeProfile(lastProfile);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ walk, steps }, null, 2), "utf8");

console.log(`\n${steps.filter((s) => s.ok).length}/${steps.length} passed — ${OUT}`);
process.exit(failed === 0 ? 0 : 1);
