// =============================================================================
// 에스크로 자동 릴리즈 배치 실동작 확인 (FIX-14 · §4.5 `escrow-release`)
// -----------------------------------------------------------------------------
// **"없을 때 말하는가" 만 보면 늘 릴리즈하는 코드도 통과한다.** 그래서 이 점검은
// **"있을 때 조용한가" 를 먼저 본다** — 기한 전 · 예식 전 · **예식 당일**(경계)
// 셋에서 홀드가 그대로 남는지 확인하고, 그 다음에 예식 다음 날 릴리즈를 본다.
//
// 배치가 `?now=` 로 시각을 받으므로 **홀드 하나로 네 시점을 재현**할 수 있다.
// 시계를 기다리지 않고 실제 라우트를 실제로 두드린다.
//
// 실행 (서버가 떠 있어야 한다):
//   npm run build && npm start        (다른 창)
//   npm run check:escrow
//
// **DB 를 더럽힌다.** 홀드를 만들고 예식일을 옮긴다. 끝나면
// `npm run db:reset && npm run seed:accounts` 로 되돌린다(`audit:api` 와 같다).
//
// **이 실행이 만든 것만 센다**(D-178). 증적 표는 추가 전용이라(D-23) 앞선 실행의
// 기록이 남아 있고, 표 전체를 세면 두 번째 실행부터 값이 누적돼 검사가 거짓을 말한다.
// =============================================================================
import { execFileSync } from "node:child_process";

const BASE = "http://localhost:3000";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

const HOLD = "00000000-0000-0000-0000-0000000fb001";
const BOOKING = "00000000-0000-0000-0000-00000000d004";
const SCHED = "00000000-0000-0000-0000-0000000005e3"; // seq 2 = 잔금 (제품이 실제로 예치하는 회차)
const WEDDING = "2027-05-15";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` :: ${detail}` : ""}`);
  ok ? (pass += 1) : (fail += 1);
};

const run = async (now, { auth = true } = {}) => {
  const res = await fetch(`${BASE}/api/jobs/escrow-release?now=${encodeURIComponent(now)}`, {
    method: "POST",
    headers: auth ? { authorization: `Bearer ${KEY}` } : {},
  });
  return { status: res.status, body: await res.json() };
};

const statusOf = () => psql(`select status from public.escrow_holds where id = '${HOLD}';`);

const makeHold = (cols = [], vals = []) => {
  psql(`
    delete from public.notifications where dedupe_key like '%${HOLD}%';
    delete from public.escrow_holds where id = '${HOLD}';
    update public.couples set wedding_date = '${WEDDING}'
      where id = (select couple_id from public.bookings where id = '${BOOKING}');
    insert into public.escrow_holds
      (id, payment_id, booking_id, payment_schedule_id, held_amount, status,
       held_at, confirm_due_at, provider, release_condition${cols.map((c) => `, ${c}`).join("")})
      select '${HOLD}',
             (select id from public.payments where booking_id = '${BOOKING}' and status = 'paid' limit 1),
             '${BOOKING}', '${SCHED}', 9600000, 'held',
             timestamptz '2026-08-20 00:00:00+09', timestamptz '2026-09-01 00:00:00+09',
             'none',
             '{"basis":"event_completed","confirmDueDays":7,"timeoutAction":"release","version":"v1"}'::jsonb${vals.map((v) => `, ${v}`).join("")};
  `);
};

async function main() {
  // **이 실행이 만든 것만 센다**(D-178). 증적 표는 추가 전용이라(D-23) 지울 수도 없고,
  // 표 전체를 세면 두 번째 실행부터 값이 누적돼 검사가 사실을 말하지 못한다.
  const T0 = psql("select now()::text;");

  console.log("=== 인증 ===");
  {
    const res = await run("2027-05-16T00:00:00Z", { auth: false });
    check("인증 없이 부르면 401", res.status === 401, `status=${res.status}`);
  }

  console.log("\n=== 무응답 릴리즈 — 시점을 옮겨 가며 네 번 ===");
  makeHold();
  check("보관 중인 홀드를 만들었다", statusOf() === "held");
  console.log(`  예식일 ${WEDDING} · 확인 기한 2026-09-01 · 양측 무응답`);

  {
    const res = await run("2026-08-01T00:00:00Z");
    check(
      "① 기한 전 — **조용하다**(대기)",
      res.status === 200 && statusOf() === "held" && res.body.data.held === 1 &&
        res.body.data.released === 0,
      JSON.stringify(res.body.data),
    );
  }
  {
    const res = await run("2026-09-10T00:00:00Z");
    check(
      "② 기한은 지났지만 예식 전 — **조용하다**(이행 개연성이 없다)",
      res.status === 200 && statusOf() === "held" && res.body.data.held === 1 &&
        res.body.data.released === 0,
      JSON.stringify(res.body.data),
    );
  }
  {
    const res = await run(`${WEDDING}T12:00:00Z`);
    check(
      "③ **예식 당일** — 아직 지나지 않은 것으로 본다(경계)",
      res.status === 200 && statusOf() === "held" && res.body.data.held === 1,
      JSON.stringify(res.body.data),
    );
  }
  {
    const res = await run("2027-05-16T00:00:00Z");
    check(
      "④ 예식 다음 날 — **릴리즈한다**",
      res.status === 200 && statusOf() === "released" && res.body.data.released === 1 &&
        res.body.data.held === 0,
      JSON.stringify(res.body.data),
    );
  }

  check(
    "릴리즈에는 시각과 사유가 함께 간다",
    psql(`select (released_at is not null) || ':' || coalesce(release_reason, '(없음)')
            from public.escrow_holds where id = '${HOLD}';`) === "true:확인 기한 경과",
  );
  check(
    "**증적에 사람이 없다**(D-173) — actor_id null · source system",
    psql(`select coalesce(actor_id::text, 'null') || ':' || source || ':' || before_state || '>' || after_state
            from public.entity_events
           where entity_id = '${HOLD}' and event_type = 'escrow_released'
             and created_at > timestamptz '${T0}';`) ===
      "null:system:held>released",
  );
  check(
    "**같은 사건을 두 줄로 남기지 않는다** — 배치가 증적을 덧쓰지 않는다",
    psql(`select count(*) from public.entity_events
           where entity_id = '${HOLD}' and event_type = 'escrow_released'
             and created_at > timestamptz '${T0}';`) === "1",
  );
  check(
    "업체에게 정산 알림이 나갔다 — 릴리즈는 정산으로 가는 사건이다",
    Number(psql(`select count(*) from public.notifications
                  where dedupe_key like 'escrow.released_vendor:${HOLD}%';`)) > 0,
  );

  {
    const res = await run("2027-05-17T00:00:00Z");
    check(
      "⑤ 다시 불러도 **종결된 것을 되돌리지 않는다**(D-23) — 후보에서 빠진다",
      res.status === 200 && res.body.data.scanned === 0 && res.body.data.released === 0,
      JSON.stringify(res.body.data),
    );
  }

  console.log("\n=== 한쪽이 '이행되지 않았어요' 로 답해 둔 건 ===");
  makeHold(["couple_confirmed", "couple_confirmed_at"], ["false", "now()"]);
  check("보관 중이고 커플이 부정 확인을 남겼다", statusOf() === "held");
  {
    const res = await run("2027-05-16T00:00:00Z");
    check(
      "⑥ **릴리즈하지 않고 조율로 보낸다** — 자동 릴리즈가 이의를 덮지 않는다",
      res.status === 200 && statusOf() === "disputed" && res.body.data.disputed === 1 &&
        res.body.data.released === 0,
      JSON.stringify(res.body.data),
    );
  }
  {
    const res = await run("2027-06-01T00:00:00Z");
    check(
      "⑦ 조율 중인 건은 **후보가 아니다**(D-24) — 사람이 사유를 붙여 끝낸다",
      res.status === 200 && res.body.data.scanned === 0,
      JSON.stringify(res.body.data),
    );
  }

  console.log("\n=== 실행 기록 ===");
  check(
    "`job_runs` 에 이번 실행 일곱 번이 그대로 남는다 — 없으면 화면이 '한 번도 안 돌았다' 로 적는다",
    Number(psql(`select count(*) from public.job_runs where job_name = 'escrow-release'
                    and started_at > timestamptz '${T0}';`)) === 7,
  );
  check(
    "전부 succeeded 로 닫혔다",
    psql(`select count(*) from public.job_runs
           where job_name = 'escrow-release' and status <> 'succeeded'
             and started_at > timestamptz '${T0}';`) === "0",
  );
  check(
    "**움직인 수를 센다** — 살펴본 수를 적으면 아무것도 안 한 날과 구분이 안 된다",
    psql(`select coalesce(sum(processed_count), -1) from public.job_runs
           where job_name = 'escrow-release'
             and started_at > timestamptz '${T0}';`) === "2",
  );

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
