import vercelConfig from "@/vercel.json";

/**
 * 배치 실행 인프라의 **진실 두 가지** (S8-13)
 *
 * 모니터링 화면은 "이 배치가 도는가" 를 묻는데, 그 답은 DB 가 아니라 **배포 설정과
 * 파일 트리**에 있다. 그래서 사본을 DB 에 두지 않고 여기서 읽는다 — DB 에 두면
 * 배포와 갈리고, 갈린 쪽이 화면에 뜬다.
 *
 * **`vercel.json` 을 직접 import 한다.** 목록을 손으로 옮겨 적으면 등록을 지웠는데
 * 화면은 "등록됨" 이라고 적는 상태가 만들어진다 — 모니터링이 거짓말하는 것이
 * 모니터링이 없는 것보다 나쁘다.
 */
const CRONS = (vercelConfig as { crons?: { path: string; schedule: string }[] }).crons ?? [];

/** `/api/jobs/<name>` → `<name>`. */
export const SCHEDULED_JOB_NAMES: string[] = CRONS.map((cron) => cron.path.split("/").pop() ?? "");

export const SCHEDULED_JOB_CRONS: Record<string, string> = Object.fromEntries(
  CRONS.map((cron) => [cron.path.split("/").pop() ?? "", cron.schedule]),
);

/**
 * 라우트가 실제로 있는 배치.
 *
 * **파일 시스템을 런타임에 읽지 않는다** — 번들된 배포에서 `app/` 트리가 그대로
 * 있으리라는 보장이 없고, 없으면 화면이 "코드 없음" 을 잘못 그린다. 대신 여기에
 * 선언하고 **테스트가 디스크와 대조한다**(`lib/ops/registry.test.ts`).
 */
export const JOB_ROUTE_NAMES = [
  "consultation-confirm-request",
  "consultation-resolve",
  "dday-notifications",
  "escrow-release",
  "planner-payout-due",
  "price-anomaly-scan",
  "price-index-refresh",
  "purge-documents",
  "sla-escalation",
] as const;
