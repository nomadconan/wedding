import { z } from "zod";

import { TERMS_MAX_LENGTH } from "../compliance/compliance";

/**
 * 컴플라이언스 진단 입출력 (S7-13 · 명세서 §4.2 · CLAUDE.md §6)
 *
 * **길이 상한만 스키마가 갖고 하한은 순수 함수가 본다.** zod 로 둘 다 막으면 짧은
 * 입력이 422 로 나가되 **왜 짧으면 안 되는지**를 못 적는다 — `termsIssue()` 는 사유
 * 코드와 문장을 함께 준다(화면과 API 가 같은 문장을 쓴다).
 *
 * 상한을 여기에 두는 이유는 다르다. **본문을 파싱하기 전에 막아야** 100MB 짜리 요청이
 * 서버 메모리로 들어오지 않는다.
 */
export const ComplianceScanSchema = z.object({
  terms: z.string().max(TERMS_MAX_LENGTH),
});

export type ComplianceScanInput = z.infer<typeof ComplianceScanSchema>;
