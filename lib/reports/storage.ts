import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 계약서 원문 저장소 (S7-03 · 명세서 §3.10 · CLAUDE.md §5.5)
 *
 * **`contracts-raw` 는 비공개 버킷이고 `storage.objects` 에 정책이 없다**(0021).
 * 정책이 없다는 것은 anon·authenticated 어느 쪽도 직접 접근할 수 없다는 뜻이며,
 * **서명 URL 이 유일한 문**이다. 그 문을 여는 조건은 "이 커플의 문서인가" 이고,
 * 그 판정은 라우트가 RLS 에게 묻는다(`documents` 정책).
 *
 * **파일은 이 서버를 지나가지 않는다.** 20MB 파일이 서버리스 함수 본문을 통과할
 * 이유가 없고, 통과시키면 원문이 로그·트레이스에 실릴 위험만 생긴다(§5.3 ·
 * S4-01 채팅 첨부와 같은 판단).
 *
 * **경로를 로그에 남기지 않는다**(0004 주석 · §5.3). 이 파일의 함수들은 경로를
 * 인자·반환값으로만 다루고 어디에도 찍지 않는다.
 */

export const DOCUMENT_BUCKET = "contracts-raw";

/**
 * 객체 경로.
 *
 * **커플 id 를 앞에 둔다.** 나중에 경로 접두어로 정책을 걸 수 있게 하기 위해서다
 * (지금은 정책 없이 서명 URL 전용이지만, 경로가 평평하면 그때 가서 못 건다).
 * 파일명은 쓰지 않는다 — 사용자가 붙인 이름이 계약 상대를 특정할 수 있다.
 */
export function documentPath(coupleId: string, documentId: string): string {
  return `${coupleId}/${documentId}`;
}

export type UploadTicket = { path: string; token: string; signedUrl: string };

export async function createDocumentUploadUrl(
  path: string,
): Promise<UploadTicket | null> {
  const { data, error } = await createAdminClient()
    .storage.from(DOCUMENT_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data) return null;

  return { path, token: data.token, signedUrl: data.signedUrl };
}
