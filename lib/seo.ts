/**
 * 색인 정책 (S3-10 · §7.1)
 *
 * **공개 전에는 검색엔진 색인을 막는다.** 지금 색인되면 '표본이 아직 모이지 않았어요'·
 * '준비 중' 화면이 검색 결과로 남고, 색인은 넣기보다 빼기가 훨씬 오래 걸린다.
 *
 * 코드가 아니라 **환경 변수 하나**로 연다 — CLAUDE.md §2.1 의 "만들어 두고 켜지
 * 않는다" 와 같은 방식이다. `robots.txt` 와 각 페이지의 `robots` 메타가 같은 값을
 * 보므로 둘이 어긋날 수 없다.
 *
 * 서버 전용이다. `NEXT_PUBLIC_` 을 붙이지 않는 이유는 클라이언트가 알 필요가 없어서다.
 */
export const INDEXING_ALLOWED = process.env.ALLOW_INDEXING === "true";

/** 절대 URL 기준. OG·canonical·사이트맵이 같은 값을 쓴다. */
export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/**
 * 페이지 메타의 `robots` 값.
 *
 * 색인을 막을 때 `nocache`·`noimageindex` 까지 함께 끄는 이유: 미리보기 캐시나
 * 이미지 색인만 남아도 준비되지 않은 화면이 검색에 노출된다.
 */
export const ROBOTS_META = INDEXING_ALLOWED
  ? { index: true, follow: true }
  : { index: false, follow: false, nocache: true, noimageindex: true };
