// =============================================================================
// 원문 파기 배치 실동작 확인 (FIX-87 · §5.1 · §4.3 배치 `purge-documents`)
// -----------------------------------------------------------------------------
// **왜 이 점검이 생겼나.** 배치가 `documents.storage_path` 의 앞 조각을 버킷으로
// 읽고 있었다. 값을 적는 쪽(`documentPath()`)은 `<커플id>/<문서id>` 를 적으므로 그
// 앞 조각은 커플 id 이고, 배치는 **없는 버킷**에서 지웠다. `storage.remove()` 는
// 없는 버킷에도 오류를 안 내므로 배치는 이렇게 답했다:
//
//     {"processed":2,"purged":2,"failed":0,"status":"succeeded"}   ← 원문은 그대로
//
// 그리고 `purged_at` 이 찍히는 순간 배치의 `is('purged_at', null)` 에서 **영영
// 빠진다.** 24시간 파기가 영구 보존이 되고 감사 화면은 "파기됨" 이라고 말한다.
//
// **왜 단위 테스트로 안 되나.** 깨진 것은 판정이 아니라 **Storage 와 DB 사이의
// 약속**이었다. 가짜 저장소를 세우면 그 약속도 함께 가짜가 된다 — 실제로 시드
// 픽스처가 `contracts-raw/...` 로 적혀 **배치와 짝이 맞는 바람에** 모든 검사가
// 통과했다. 진짜 버킷에 진짜 파일을 올리고 진짜 배치를 부른다.
//
// **"지우는가" 만 보지 않는다**(§7.0b). 앞만 보면 **전부 지우는 코드도 통과한다.**
// 그래서 아직 때가 안 된 문서가 **그대로 남는지**를 먼저 보고, 지우지 못한 건에
// `purged_at` 이 **안 찍히는지**도 본다.
//
// 실행 (서버가 떠 있어야 한다):
//   npm run dev                       (다른 창)
//   npm run check:purge
//
// **DB 와 Storage 를 더럽힌다.** 끝나면 `npm run db:reset && npm run seed:accounts`
// 로 되돌린다(`check:escrow` 와 같다).
//
// **이 실행이 만든 것만 센다**(D-178). `job_runs` 도 `documents` 도 앞선 실행의
// 행이 남아 있어 표 전체를 세면 두 번째 실행부터 값이 누적된다.
// =============================================================================
import { execFileSync } from "node:child_process";

const BASE = "http://localhost:3000";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

if (!KEY || !URL) {
  console.error("SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL 이 없다 (.env.local).");
  process.exit(1);
}

const BUCKET = "contracts-raw";

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

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` :: ${detail}` : ""}`);
  ok ? (pass += 1) : (fail += 1);
};

// ── Storage — 서비스롤로 직접 두드린다 ──────────────────────────────────────

// **`apikey` 헤더가 필요하다.** 로컬 스택의 서비스롤 키는 `sb_secret_...` 모양이라
// `Authorization: Bearer` 만 보내면 storage-api 가 `Invalid Compact JWS` 로 거절한다.
const storage = async (method, path, body, headers = {}) => {
  const res = await fetch(`${URL}/storage/v1/${path}`, {
    method,
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, ...headers },
    body,
  });
  return { status: res.status, text: await res.text() };
};

const putObject = (key, content) =>
  storage("POST", `object/${BUCKET}/${key}`, content, {
    "content-type": "application/pdf",
    // 앞선 실행이 남긴 것이 있어도 덮어쓴다.
    "x-upsert": "true",
  });

const objectExists = async (key) => (await storage("GET", `object/${BUCKET}/${key}`)).status === 200;

// ── 픽스처 ──────────────────────────────────────────────────────────────────

const COUPLE = psql("select id from public.couples order by created_at limit 1;");

if (!COUPLE) {
  console.error("커플 시드가 없다 — `npm run seed:accounts` 를 먼저 돌린다.");
  process.exit(1);
}

/** 이 점검이 만드는 문서 넷. **id 를 고정해 이 실행이 만든 것만 센다**(D-178). */
const DUE = "00000000-0000-0000-0000-0000000f7a01"; // 때가 됐고 원문이 있다
const FUTURE = "00000000-0000-0000-0000-0000000f7a02"; // 아직 때가 안 됐다
const GONE = "00000000-0000-0000-0000-0000000f7a03"; // 때가 됐는데 원문이 이미 없다
const BADPATH = "00000000-0000-0000-0000-0000000f7a04"; // 버킷 접두어가 붙은 경로

const MINE = [DUE, FUTURE, GONE, BADPATH];

/** **앱이 실제로 적는 모양**이다 — `documentPath()` 와 같다. 버킷 접두어가 없다. */
const keyOf = (documentId) => `${COUPLE}/${documentId}`;

const insertDoc = (id, storagePath, scheduledAt) =>
  psql(`
    delete from public.documents where id = '${id}';
    insert into public.documents (id, couple_id, doc_type, storage_path, mime, purge_scheduled_at)
    values ('${id}', '${COUPLE}', 'contract', '${storagePath}', 'application/pdf', ${scheduledAt});
  `);

const purgedAt = (id) =>
  psql(`select coalesce(purged_at::text, '') from public.documents where id = '${id}';`);

// ── 준비 ────────────────────────────────────────────────────────────────────

console.log(`커플 ${COUPLE}\n`);

for (const id of MINE) await storage("DELETE", `object/${BUCKET}/${keyOf(id)}`);
await storage("DELETE", `object/${BUCKET}/${BUCKET}/${BADPATH}`);

insertDoc(DUE, keyOf(DUE), "now() - interval '2 hours'");
insertDoc(FUTURE, keyOf(FUTURE), "now() + interval '20 hours'");
insertDoc(GONE, keyOf(GONE), "now() - interval '2 hours'");
// 낡은 모양. 이 값이 무엇을 가리키는지 **알 수 없으므로** 배치는 추측하면 안 된다.
insertDoc(BADPATH, `${BUCKET}/${BADPATH}`, "now() - interval '2 hours'");

const uploaded = await Promise.all([
  putObject(keyOf(DUE), "원문 A"),
  putObject(keyOf(FUTURE), "원문 B"),
  // BADPATH 는 **경로가 가리키는 두 해석 모두**에 파일을 둔다. 배치가 어느 쪽이든
  // 추측해서 지우면 아래 검사가 잡는다.
  putObject(`${BUCKET}/${BADPATH}`, "원문 D"),
]);

check(
  "준비: 원문 셋이 실제로 올라갔다",
  uploaded.every((r) => r.status === 200),
  uploaded.map((r) => r.status).join(","),
);

// **목록을 실제로 읽었는지 먼저 본다**(§7.0b) — 아무것도 안 올라갔는데 "다 지워졌다"
// 로 통과하면 이 점검은 아무것도 지키지 않는다.
check("준비: 지워야 할 원문이 배치 전에 실재한다", await objectExists(keyOf(DUE)));
check("준비: `GONE` 은 원문이 없다 (이미 사라진 상태)", !(await objectExists(keyOf(GONE))));

// ── 배치를 돌린다 ───────────────────────────────────────────────────────────

const before = Number(psql(`select count(*) from public.job_runs where job_name = 'purge-documents';`));

const res = await fetch(`${BASE}/api/jobs/purge-documents`, {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}` },
});
const body = await res.json();

console.log(`\n배치 응답: ${JSON.stringify(body)}\n`);

check("배치가 200 으로 끝났다", res.status === 200, `status=${res.status}`);

const after = Number(psql(`select count(*) from public.job_runs where job_name = 'purge-documents';`));
check("이 실행이 `job_runs` 를 한 줄 남겼다", after === before + 1, `${before} → ${after}`);

// ── 지웠는가 ────────────────────────────────────────────────────────────────

check(
  "**때가 된 원문이 Storage 에서 실제로 사라졌다** (§5.1)",
  !(await objectExists(keyOf(DUE))),
  "남아 있으면 배치가 엉뚱한 버킷을 지운 것이다 — FIX-87",
);
check("때가 된 문서에 `purged_at` 이 찍혔다", purgedAt(DUE) !== "");

// ── 안 지워야 할 것은 그대로인가 ("있을 때 조용한가") ───────────────────────

check(
  "아직 때가 안 된 원문은 **그대로 있다**",
  await objectExists(keyOf(FUTURE)),
  "없으면 배치가 예약 시각을 안 보고 전부 지운 것이다",
);
check("아직 때가 안 된 문서는 `purged_at` 이 비어 있다", purgedAt(FUTURE) === "");

// ── 이미 없는 것은 닫는다 ───────────────────────────────────────────────────

check(
  "원문이 이미 없던 건은 `purged_at` 을 찍어 닫는다 (`already_gone`)",
  purgedAt(GONE) !== "",
  "안 찍으면 매시간 같은 건을 다시 집는다",
);
check(
  "요약이 `already_gone` 을 세었다",
  Number(body?.data?.alreadyGone ?? 0) >= 1,
  JSON.stringify({ alreadyGone: body?.data?.alreadyGone }),
);

// ── 못 지운 것에 '파기됨' 을 찍지 않는다 (D-58) ─────────────────────────────

check(
  "**뜻을 알 수 없는 경로는 지우지 않는다** — 원문이 그대로 있다",
  await objectExists(`${BUCKET}/${BADPATH}`),
  "지웠다면 배치가 경로의 뜻을 추측한 것이다",
);
check(
  "**못 지운 건에는 `purged_at` 을 안 찍는다** (D-58)",
  purgedAt(BADPATH) === "",
  "찍으면 다음 실행에서 영영 빠져 원문이 영구 보존된다",
);
check(
  "요약이 실패를 세었고 실행 상태가 `failed` 다",
  Number(body?.data?.failed ?? 0) >= 1 && body?.data?.status === "failed",
  JSON.stringify({ failed: body?.data?.failed, status: body?.data?.status }),
);
check(
  "`error_summary` 에 **경로도 id 도 안 실렸다** (§5.3)",
  typeof body?.data?.errorSummary === "string" &&
    !body.data.errorSummary.includes("/") &&
    !MINE.some((id) => body.data.errorSummary.includes(id)),
  String(body?.data?.errorSummary),
);

// ── 두 번 돌려도 같은 답인가 ────────────────────────────────────────────────

const second = await (
  await fetch(`${BASE}/api/jobs/purge-documents`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}` },
  })
).json();

check(
  "두 번째 실행은 이미 지운 건을 **다시 집지 않는다**",
  !JSON.stringify(second?.data ?? {}).includes('"purged":0,"alreadyGone":0') ||
    Number(second?.data?.purged ?? 0) === 0,
  JSON.stringify(second?.data),
);
check(
  "두 번째 실행에서도 **못 지운 건은 계속 실패로 남는다**",
  Number(second?.data?.failed ?? 0) >= 1,
  "실패가 사라지면 감사가 그 건을 놓친다",
);

// ── 정리 ────────────────────────────────────────────────────────────────────

for (const id of MINE) await storage("DELETE", `object/${BUCKET}/${keyOf(id)}`);
await storage("DELETE", `object/${BUCKET}/${BUCKET}/${BADPATH}`);
psql(`delete from public.documents where id in (${MINE.map((id) => `'${id}'`).join(",")});`);

console.log(`\n${pass + fail} 중 ${pass} 통과 · ${fail} 실패`);
process.exit(fail > 0 ? 1 : 0);
