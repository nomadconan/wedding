import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * 서비스롤 클라이언트 (S2-01)
 *
 * **서버 전용이다.** `SUPABASE_SERVICE_ROLE_KEY` 는 RLS 를 우회하므로
 * 클라이언트 번들에 들어가면 전 데이터가 열린다(CLAUDE.md §5.4).
 * 이 모듈은 **Route Handler 에서만** import 한다. 클라이언트 컴포넌트(`"use client"`)에서
 * 절대 참조하지 않는다 — `server-only` 패키지로 강제하고 싶지만 새 의존성이라 추가하지 않았다
 * (S8-05 CI 의 번들 유입 검사가 최종 방어선이다).
 *
 * 쓰는 곳은 §3.9 가 "서비스롤 경유" 로 규정한 경로뿐이다.
 *  - 입점 신청 생성(`vendors` 는 INSERT 정책이 없다 — 심사 도메인이라 서버가 만든다)
 *  - 심사 승인·반려(운영자)
 *  - `entity_events`·`audit_logs` 기록(INSERT 정책을 두지 않는 증적 테이블)
 *
 * **호출자는 반드시 세션에서 확인한 사용자 id 로 대상을 좁혀야 한다.**
 * 클라이언트가 보낸 id 를 그대로 쓰면 RLS 우회가 그대로 취약점이 된다.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase 서버 환경변수가 설정되지 않았습니다.");
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
