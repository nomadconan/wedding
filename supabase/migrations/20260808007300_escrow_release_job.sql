-- 에스크로 자동 릴리즈 배치를 어휘에 넣는다 (FIX-14 · S5-09 · §4.5)
--
-- ══════════════════════════════════════════════════════════════════════════
-- **무엇이 막혀 있었나.** 무응답 폴백(확인 기한 경과 **그리고** 예식일 경과 → 릴리즈)의
-- 판정은 순수 함수(`decideRelease`)가 이미 갖고 있는데, **그 함수를 부르는 자동 경로가
-- 없었다.** 부르는 곳은 둘뿐이다 —
--
--   1. `confirmFulfillment` : 양측 중 **누군가 확인 버튼을 눌렀을 때**
--   2. `lib/escrow/loader`  : 화면이 **보여주려고** 계산할 때 (쓰지 않는다)
--
-- 즉 **아무도 화면을 열지 않으면 아무 일도 일어나지 않는다.** 로컬에서 재현했다:
-- 예식일과 확인 기한이 모두 지난 `held` 홀드를 두고 **지금 있는 배치 여덟 개를 전부
-- 실행**해도 상태가 `held` 그대로였다.
--
-- 그리고 그 손해는 두 겹이다. `settlementEligible`(S5-09)은 **열린 홀드가 있는 예약을
-- 정산에서 뺀다** — 홀드가 안 풀리면 그 돈은 업체에게 가지도 않고 **정산에도 영원히
-- 들어오지 않는다.**
--
-- ── 이 마이그레이션이 하는 일 ──────────────────────────────────────────────
-- `job_runs.job_name` 의 어휘에 `escrow-release` 를 더한다. **어휘에 없으면 배치가
-- 이름을 남기지 못하고**(CHECK 위반) 실행 기록이 통째로 사라져, `/admin/ops` 는
-- "그런 배치는 없다" 고 말한다. 라우트를 먼저 만들어도 첫 실행에서 죽는다.
--
-- **`lib/core/ops/monitor.ts` 의 `BATCH_SPECS` 와 같은 목록이어야 한다**(0064 가 세운
-- 규칙 · `db:rls` 가 대조한다). 그래서 코드와 이 어휘를 같은 커밋에서 함께 고친다.
-- ══════════════════════════════════════════════════════════════════════════

alter table public.job_runs drop constraint job_runs_name_vocab;

alter table public.job_runs
  add constraint job_runs_name_vocab check (
    job_name = any (array[
      'purge-documents',
      'dday-notifications',
      'price-index-refresh',
      'settlement-aggregate',
      'price-anomaly-scan',
      'sla-escalation',
      'consultation-confirm-request',
      'consultation-resolve',
      'planner-payout-due',
      'escrow-release',
      'wishlist-price-watch'
    ])
  );

comment on constraint job_runs_name_vocab on public.job_runs is
  '§4.5 의 배치 이름. lib/core/ops/monitor.ts 의 BATCH_SPECS 와 같은 목록이어야 하며 db:rls 가 대조한다(0064 · FIX-14).';
