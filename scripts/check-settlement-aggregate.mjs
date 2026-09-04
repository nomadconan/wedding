// =============================================================================
// 정산 기간 집계 배치 실동작 확인 (FIX-08 · §4.5 `settlement-aggregate`)
// -----------------------------------------------------------------------------
// **"돌긴 도는가" 만 보면 아무것도 못 세는 배치도 통과한다.** 그래서 이 점검은 세
// 갈래를 갈라 본다 —
//
//   ① 기준이 없을 때(O-15 · 지금 출하 상태)  → `blocked` 로 서고 **실행은 실패로 닫힌다**
//   ② 완납됐지만 **안전거래가 열려 있을 때**  → 정산에서 빠진다(`settlementEligible`)
//   ③ 그 홀드가 릴리즈된 뒤                   → 정산서가 서고 **실행은 성공으로 닫힌다**
//   ④ 확정된 정산서                           → 다시 계산하지 않는다(D-23 · `frozen`)
//   ⑤ 결제가 없던 기간                        → **조용하다**(후보 0 · 성공 · 0건)
//
// **②→③ 이 FIX-14 와 FIX-08 의 순서 의존이다.** 열린 홀드가 있는 예약은 정산에서
// 빠지므로, 자동 릴리즈가 없으면 이 배치는 **성실하게 그 돈을 매번 빼놓는다.**
// 그래서 여기서도 `escrow-release` 를 먼저 부르고 그 다음에 마감을 돌린다.
//
// ③은 `settlement.fee_basis` 를 잠깐 넣었다가 되돌린다. **값을 정하는 것이 아니라
// 두 갈래를 다 보려는 것**이며(O-15 는 여전히 미결) 끝에서 원래대로 돌린다.
//
// 실행 (서버가 떠 있어야 한다):
//   npm run build && npm start        (다른 창)
//   npm run check:settlement
//
// **DB 를 더럽힌다.** 정산서를 만들고 회차를 완납으로 옮긴다. 끝나면
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

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` :: ${detail}` : ""}`);
  ok ? (pass += 1) : (fail += 1);
};

const job = async (name, now, { auth = true } = {}) => {
  const res = await fetch(`${BASE}/api/jobs/${name}?now=${encodeURIComponent(now)}`, {
    method: "POST",
    headers: auth ? { authorization: `Bearer ${KEY}` } : {},
  });
  return { status: res.status, body: await res.json() };
};

const run = (now, opts) => job("settlement-aggregate", now, opts);

/** 마지막 실행 기록 한 줄. 표 전체가 아니라 **이 실행이 남긴 것**을 본다. */
const lastRun = (t0) =>
  psql(`select status || ':' || processed_count || ':' || coalesce(error_summary, '(없음)')
          from public.job_runs
         where job_name = 'settlement-aggregate' and started_at > timestamptz '${t0}'
         order by started_at desc limit 1;`);

async function main() {
  const T0 = psql("select now()::text;");

  // 시드의 결제일이 곧 마감 대상 기간이다. 날짜를 손으로 박지 않고 DB 에서 읽는다.
  const paidDay = psql(
    `select to_char(max(paid_at), 'YYYY-MM-DD') from public.payments where status = 'paid';`,
  );
  const asOf = `${paidDay}T12:00:00Z`;

  console.log("=== 인증 ===");
  {
    const res = await run(asOf, { auth: false });
    check("인증 없이 부르면 401", res.status === 401, `status=${res.status}`);
  }

  console.log("\n=== ① 기준이 없을 때 (O-15 · 지금 출하 상태) ===");
  check(
    "수수료 기준은 미결이다 — 코드도 시드도 정하지 않았다",
    psql(`select value_json ->> 'status' from public.app_settings
            where key = 'settlement.fee_basis';`) === "undecided",
  );
  {
    const res = await run(asOf);
    const d = res.body.data;
    check(
      "후보를 찾고 **하나도 서지 못한다** — blocked",
      res.status === 200 && d.scanned >= 1 && d.blocked >= 1 && d.drafted === 0,
      JSON.stringify(d),
    );
    check(
      "정산서는 `blocked` 로 서고 **사유가 붙는다** — 실패가 아니라 대기다",
      psql(`select status || ':' || coalesce(blocked_reason, '(없음)')
              from public.settlements order by created_at desc limit 1;`) ===
        "blocked:fee_basis_missing",
    );
    check(
      "**실행은 실패로 닫힌다** — 마감이 통째로 빈 것을 succeeded 로 적지 않는다",
      lastRun(T0) === `failed:0:settlement_blocked:${d.blocked}:fee_basis_missing`,
      lastRun(T0),
    );
  }

  console.log("\n=== ② 완납됐지만 안전거래가 열려 있을 때 ===");
  // **제품이 만드는 상태를 그대로 만든다** — S5-06 의 회차 결제가 회차를 `paid` 로
  // 옮기고 고지·동의를 남긴다. 여기서는 그 결과 상태를 세운다.
  psql(`
    update public.app_settings
       set value_json = '{"basis": "post_discount", "status": "decided", "openIssue": "O-15"}'::jsonb
     where key = 'settlement.fee_basis';
    update public.bookings set applied_fee_rate_bp = 500
     where id = '00000000-0000-0000-0000-00000000d004';
    -- **결제 전 고지·동의가 있어야 결제가 선다**(F-C-14 트리거). 제품에서는 결제
    -- 화면이 남기는 행이며, 여기서는 그 결과 상태를 세운다.
    insert into public.payment_consents
      (payment_schedule_id, user_id, kind, consent_version)
      select ps.id, c.owner_id, k.kind, 'v1'
        from public.payment_schedules ps
        join public.contracts ct on ct.id = ps.contract_id
        join public.bookings b on b.id = ct.booking_id
        join public.couples c on c.id = b.couple_id
        cross join (values ('installment_terms'), ('refund_policy')) as k(kind)
       where b.id = '00000000-0000-0000-0000-00000000d004'
    on conflict do nothing;
    -- 회차 1(계약금)은 시드에 결제가 없다. 제품이라면 S5-06 이 만들었을 행이다.
    insert into public.payments
      (booking_id, payment_schedule_id, amount, status, purpose, paid_at, provider)
      select p.booking_id, ps.id, ps.amount, 'paid', 'deposit', p.paid_at, p.provider
        from public.payments p
        join public.payment_schedules ps on ps.seq = 1
       where p.purpose = 'balance' and p.status = 'paid'
       limit 1;
    -- **회차를 완료로 옮기려면 그 회차의 결제가 있어야 한다**(트리거). 시드의 잔금
    -- 결제가 회차를 가리키지 않아 여기서 이어 준다 — 제품의 결제 경로가 하는 일이다.
    update public.payments p set payment_schedule_id = ps.id
      from public.payment_schedules ps
     where ps.seq = 2 and p.purpose = 'balance' and p.payment_schedule_id is null;
    update public.payment_schedules set status = 'paid', paid_at = now()
     where contract_id = (select id from public.contracts
                           where booking_id = '00000000-0000-0000-0000-00000000d004');
    -- 시드의 홀드는 조율 데모용 disputed 라 배치가 건드리지 않는다(D-24).
    -- 잔금이 맡겨진 **보통 상태**를 세운다 — 양측이 이행을 확인한 건이다.
    delete from public.escrow_holds where booking_id = '00000000-0000-0000-0000-00000000d004';
    insert into public.escrow_holds
      (payment_id, booking_id, payment_schedule_id, held_amount, status, held_at,
       confirm_due_at, provider, release_condition,
       couple_confirmed, couple_confirmed_at, vendor_confirmed, vendor_confirmed_at)
      select p.id, p.booking_id, p.payment_schedule_id, p.amount, 'held', now() - interval '3 day',
             now() + interval '4 day', 'none',
             '{"basis":"event_completed","confirmDueDays":7,"timeoutAction":"release","version":"v1"}'::jsonb,
             true, now(), true, now()
        from public.payments p where p.purpose = 'balance' and p.status = 'paid' limit 1;
  `);

  check(
    "잔금이 안전거래로 맡겨져 있다",
    psql(`select status from public.escrow_holds;`) === "held",
  );
  {
    const res = await run(asOf);
    const d = res.body.data;
    check(
      "**열린 홀드가 있는 예약은 정산에서 빠진다**(settlementEligible) — 돈이 사라지는 게 아니라 늦어진다",
      res.status === 200 && d.scanned === 1 && d.drafted === 0 && d.empty === 1,
      JSON.stringify(d),
    );
    check(
      "그래서 정산서에 금액이 없다 — **자동 릴리즈가 없으면 이 상태가 영원히 반복된다**(FIX-14 가 먼저인 이유)",
      psql(`select gross_amount || ':' || (select count(*) from public.settlement_items)
              from public.settlements order by created_at desc limit 1;`) === "0:0",
    );
  }

  console.log("\n=== ③ 홀드가 릴리즈된 뒤 ===");
  {
    const res = await job("escrow-release", asOf);
    check(
      "`escrow-release` 가 양측 확인된 홀드를 넘긴다 (FIX-14)",
      res.status === 200 && res.body.data.released === 1 &&
        psql(`select status from public.escrow_holds;`) === "released",
      JSON.stringify(res.body.data),
    );
  }
  {
    const res = await run(asOf);
    const d = res.body.data;
    check(
      "**같은 예약이 이번엔 정산에 든다** — 두 배치가 이어져야 돈이 업체까지 간다",
      res.status === 200 && d.drafted === 1 && d.blocked === 0 && d.empty === 0,
      JSON.stringify(d),
    );
    check(
      "**기준 스냅샷과 금액이 함께 박힌다** — 나중에 기준이 바뀌어도 이 건은 재현된다",
      psql(`select status || ':' || coalesce(fee_basis, '(없음)') || ':' || fee_rate_bp
              || ':' || (gross_amount > 0) || ':' || (fee_amount > 0)
              from public.settlements order by created_at desc limit 1;`) ===
        "draft:post_discount:500:true:true",
    );
    check(
      "건별 명세가 함께 만들어진다 — 금액의 근거다",
      psql(`select count(*) from public.settlement_items;`) === "1",
    );
    check(
      "**실행은 성공으로 닫히고 선 정산서만 센다**",
      lastRun(T0) === "succeeded:1:(없음)",
      lastRun(T0),
    );
    check(
      "**증적에 사람이 없다**(D-173) — 마감을 누른 운영자가 없다",
      psql(`select coalesce(actor_id::text, 'null') || ':' || source
              from public.entity_events
             where entity_type = 'settlement' and created_at > timestamptz '${T0}'
             order by created_at desc limit 1;`) === "null:system",
    );
  }

  console.log("\n=== ④ 확정된 정산서는 다시 계산하지 않는다 (D-23) ===");
  psql(`
    update public.settlements
       set status = 'confirmed', confirmed_at = now(),
           payout_amount = net_amount - coupon_deduction,
           payable_at = (now() + interval '7 day')::date
     where status = 'draft';
  `);
  {
    const res = await run(asOf);
    const d = res.body.data;
    check(
      "**frozen 으로 세고 실패로 세지 않는다** — 끝난 기간을 다시 돈 것뿐이다",
      res.status === 200 && d.frozen === 1 && d.failed === 0 && d.drafted === 0,
      JSON.stringify(d),
    );
    check(
      "확정된 금액이 그대로다 — 배치가 덮어쓰지 않았다",
      psql(`select status from public.settlements order by created_at desc limit 1;`) ===
        "confirmed",
    );
    check(
      "**후보가 있었지만 blocked 가 아니므로 실행은 성공이다**",
      lastRun(T0) === "succeeded:0:(없음)",
      lastRun(T0),
    );
  }

  console.log("\n=== ⑤ 결제가 없던 기간 — 조용하다 ===");
  {
    const res = await run("2020-03-15T00:00:00Z");
    const d = res.body.data;
    check(
      "후보가 0 이고 아무것도 만들지 않는다",
      res.status === 200 && d.scanned === 0 && d.drafted === 0 && d.blocked === 0,
      JSON.stringify(d),
    );
    check(
      "**그래도 실행 기록은 남는다** — 안 남으면 화면이 '한 번도 안 돌았다' 로 적는다",
      lastRun(T0) === "succeeded:0:(없음)",
      lastRun(T0),
    );
  }

  // ── 되돌린다 — O-15 는 여전히 미결이다 ──────────────────────────────────
  psql(`update public.app_settings
           set value_json = '{"basis": null, "status": "undecided", "openIssue": "O-15"}'::jsonb
         where key = 'settlement.fee_basis';`);
  check(
    "검사가 넣었던 기준을 되돌렸다 — **값은 운영 결정이다**(O-15)",
    psql(`select value_json ->> 'status' from public.app_settings
            where key = 'settlement.fee_basis';`) === "undecided",
  );

  console.log("\n=== 실행 기록 ===");
  check(
    "`job_runs` 에 이번 실행 다섯 번이 그대로 남는다 — 401 은 라우트를 지나지 못해 기록이 없다",
    psql(`select count(*) from public.job_runs
           where job_name = 'settlement-aggregate' and started_at > timestamptz '${T0}';`) === "5",
  );

  console.log(`\n${pass}/${pass + fail} passed`);
  console.log("DB 를 더럽혔다. `npm run db:reset && npm run seed:accounts` 로 되돌린다.");
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
