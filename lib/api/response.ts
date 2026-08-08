import { NextResponse } from "next/server";

/**
 * API 응답 포맷 (CLAUDE.md §6, 명세서 §4.1)
 *
 *   { ok: boolean, data?: T, error?: { code, message, details? } }
 *
 * 에러 코드는 도메인 접두어를 쓴다(`AUTH_`, `VENDOR_`, `ADMIN_`, `DOC_`, `PAY_`, `AI_`).
 * zod 검증 실패는 **422** 다.
 *
 * `details` 에 원문·Storage 경로를 담지 않는다(CLAUDE.md §5.3).
 */
export type ApiError = { code: string; message: string; details?: unknown };

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(status: number, code: string, message: string, details?: unknown) {
  const error: ApiError = { code, message };
  if (details !== undefined) error.details = details;

  return NextResponse.json({ ok: false, error }, { status });
}

/** zod 오류를 422 로 변환한다. 필드 경로와 메시지만 남긴다. */
export function failValidation(issues: { path: (string | number)[]; message: string }[]) {
  return fail(
    422,
    "VENDOR_INVALID_INPUT",
    "입력값을 확인해 주세요.",
    issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
  );
}
