// 시각 표시 (fix/admin-client-error)
//
// ══════════════════════════════════════════════════════════════════════════
// **이 파일이 생긴 이유.** `/admin/privacy` 가 빈 화면으로 죽었다:
//
//   Error: Cannot read properties of null (reading 'replace')
//     at AdminPrivacyPage (app/(admin)/admin/privacy/page.tsx)
//
// 화면이 `run.startedAt.replace("T", " ")` 를 부르는데 `job_runs.started_at` 은
// **nullable** 이었다. 그런데 로더의 손으로 쓴 행 타입이 `startedAt: string` 이라고
// 적어 두어 **TypeScript 가 막아 주지 못했다** — `types/database.ts` 는 처음부터
// `started_at: string | null` 이라고 정확히 적고 있었는데도.
//
// 그래서 세 층으로 고친다.
//   1. 이 순수 함수 — null 을 받아도 죽지 않고 **"모름" 이라고 적는다**
//   2. 로더가 **생성된 타입에서 행 모양을 끌어다 쓴다**(손으로 안 적는다)
//   3. `job_runs.started_at` 을 NOT NULL 로 만든다(0057) — 시작 시각 없는 실행 기록은
//      뜻이 없다
//
// **빈칸으로 두지 않는다.** 시각을 모를 때 화면이 아무것도 안 그리면 "방금" 인지
// "기록이 없는지" 를 구분할 수 없다 — 증적 화면에서 그 차이는 크다.

/** 시각을 모를 때 화면에 적는 말. 빈 문자열이 아니다. */
export const UNKNOWN_TIMESTAMP = "시각 기록 없음";

/**
 * ISO 시각을 `YYYY-MM-DD HH:MM:SS` 로.
 *
 * **로컬 시간대로 바꾸지 않는다.** 증적 화면이 보는 값은 DB 에 적힌 그 값이어야 하고,
 * 브라우저 시간대에 따라 다르게 보이면 두 사람이 같은 기록을 다르게 읽는다.
 * (표시 시간대를 정하는 일은 별도 판단이며 지금 그 결정이 없다.)
 */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return UNKNOWN_TIMESTAMP;

  // `2026-08-27T12:34:56.789+00:00` → `2026-08-27 12:34:56`
  const text = value.replace("T", " ");

  return text.length >= 19 ? text.slice(0, 19) : text;
}

/** 날짜만. 수집일·기간처럼 시각이 필요 없는 자리에 쓴다. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return UNKNOWN_TIMESTAMP;

  return value.slice(0, 10);
}

/**
 * `<time dateTime={...}>` 에 넣을 값.
 *
 * **비어 있으면 속성을 아예 빼야 한다** — `dateTime=""` 는 유효하지 않은 마크업이고,
 * 접근성 도구가 빈 값을 읽으려다 엉뚱한 안내를 한다.
 */
export function dateTimeAttr(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}
