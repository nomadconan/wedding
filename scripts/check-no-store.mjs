// =============================================================================
// 서버 조회가 굳지 않는가 — 실동작 확인 (FIX-22)
// -----------------------------------------------------------------------------
// **소스에 `no-store` 가 적혀 있는지는 단위 테스트가 본다**(`lib/supabase/no-store.test.ts`).
// 여기서는 **정말로 안 굳는지**를 실제 서버로 본다 — 값을 바꾸고 화면이 따라오는지,
// 그리고 Next 의 디스크 캐시(`.next/cache/fetch-cache`)에 서비스롤·익명 응답이
// 쌓이는지를 직접 센다.
//
// **"안 굳는가" 만 보면 안 된다.** 굳어야 하는 자리(SEO 화면 `/guides`)가 여전히
// 굳는지도 함께 본다 — 앞만 보면 캐시를 통째로 꺼 버린 코드도 통과한다.
//
// 실행 (서버가 떠 있어야 한다):
//   node -e "require('fs').rmSync('.next/cache/fetch-cache',{recursive:true,force:true})"
//   npm run build && npm start        (다른 창)
//   npm run check:no-store
//
// **DB 를 잠깐 더럽혔다가 되돌린다.** 값을 바꿔 보는 것이 이 점검의 방법이라 그렇다.
// =============================================================================
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";

const BASE = "http://localhost:3000";
const DIR = ".next/cache/fetch-cache";
const PRODUCT = "00000000-0000-0000-0000-000000000951";

const container = execFileSync("docker", [
  "ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}",
]).toString().trim().split(/\r?\n/)[0];

const psql = (text) =>
  execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
      "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
    { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();

/** 디스크 캐시에 쌓인 PostgREST 응답. **표 이름 단위로 센다.** */
const cachedTables = () => {
  if (!existsSync(DIR)) return [];
  const out = [];
  for (const f of readdirSync(DIR)) {
    let d;
    try {
      d = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
    } catch {
      continue;
    }
    const rel = decodeURIComponent(d.data?.url ?? "").replace(/^https?:\/\/[^/]+\/rest\/v1\//, "");
    if (rel) out.push(rel.split("?")[0]);
  }
  return out;
};

const html = async (path) => {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  return { status: res.status, body: await res.text() };
};

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` :: ${detail}` : ""}`);
  ok ? (pass += 1) : (fail += 1);
};

const won = (n) => Number(n).toLocaleString("en-US");

async function main() {
  const before = psql(`select base_price_total from public.products where id = '${PRODUCT}';`);
  const next = String(Number(before) + 1_234_000);

  console.log("=== ① 값을 바꾸면 화면이 따라오는가 ===");
  const first = await html("/explore");
  check(
    "먼저 원래 가격이 그려진다 — 이 전제가 깨지면 아래가 헛돈다",
    first.status === 200 && first.body.includes(won(before)),
    `${won(before)}원`,
  );

  psql(`update public.products set base_price_total = ${next} where id = '${PRODUCT}';`);
  const second = await html("/explore");
  check(
    "**바꾼 가격이 곧바로 그려진다** — 굳지 않는다(FIX-22)",
    second.body.includes(won(next)) && !second.body.includes(won(before)),
    `${won(next)}원`,
  );
  psql(`update public.products set base_price_total = ${before} where id = '${PRODUCT}';`);

  const third = await html("/explore");
  check("되돌린 값도 곧바로 따라온다", third.body.includes(won(before)));

  console.log("");
  console.log("=== ② 디스크 캐시에 무엇이 쌓였나 ===");
  const tables = cachedTables();
  console.log(`  ${tables.length ? [...new Set(tables)].join(" · ") : "(없음)"}`);

  const money = tables.filter((t) => ["products", "product_options", "price_index"].includes(t));
  check(
    "**금액이 걸린 조회가 캐시에 없다** — 고치기 전에는 셋 다 1년 캐시에 있었다",
    money.length === 0,
    money.join(","),
  );
  check(
    "**권한이 걸린 조회도 캐시에 없다** — 회수한 초대가 캐시에 남으면 회수가 안 먹는다",
    !tables.includes("vendor_invites"),
  );

  console.log("");
  console.log("=== ③ 굳어야 하는 자리는 여전히 굳는가 ===");
  // **앞만 보면 캐시를 통째로 꺼 버린 코드도 통과한다.** SEO 화면(/guides)은 굳는 것이
  // 목적이므로(§2.1) 여기서는 **반대 방향**을 확인한다 — 값을 바꿔도 안 따라와야 한다.
  const guides = await html("/guides");
  check("`/guides` 가 200 으로 열린다", guides.status === 200);
  check(
    "**빌드가 미리 그려 뒀다** — 요청마다 렌더하면 SEO 화면으로서 의미가 없다",
    existsSync(".next/server/app/guides.html"),
  );

  const slug = psql(
    `select slug from public.content_posts
      where published_at is not null and published_at <= now() order by slug limit 1;`,
  );
  const title = psql(`select title from public.content_posts where slug = '${slug}';`);
  const mark = `캐시확인-${Date.now()}`;

  check("바꿔 볼 발행 글이 있다 — 없으면 아래 검사가 헛돈다", slug !== "" && title !== "");

  psql(`update public.content_posts set title = '${mark}' where slug = '${slug}';`);
  const after = await html("/guides");
  check(
    "**콘텐츠는 바꿔도 곧바로 안 따라온다** — 이 화면은 굳는 것이 목적이고 신선도는 revalidate 300 이 잡는다",
    !after.body.includes(mark),
  );
  psql(`update public.content_posts set title = '${title.replace(/'/g, "''")}' where slug = '${slug}';`);

  console.log("");
  console.log(`${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
