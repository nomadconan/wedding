// 사업자등록번호·통신판매업 신고번호·연락처 처리 (S2-01 · 명세서 §2.2 F-V-01, §7.2)
//
//  * **평문을 저장하지 않는다.** 원본은 서버에서 해시하고, 화면에는 마스킹 값을 쓴다.
//    이 파일은 프레임워크·런타임 무관이어야 하므로 **해시는 하지 않는다** —
//    해시는 `node:crypto` 를 쓸 수 있는 Route Handler 의 몫이다(CLAUDE.md §3.1).
//  * 검증은 형식·체크섬까지만 한다. 실제 사업자 상태 조회(국세청 API)는 범위 밖이며
//    운영자가 제출 서류로 수동 확인한다.

/** 숫자만 남긴다. 사용자는 '123-45-67890' 처럼 하이픈을 넣어 입력한다. */
export function normalizeBusinessNumber(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * 사업자등록번호 체크섬 검증.
 *
 * 국세청 규칙: 앞 9자리에 가중치 [1,3,7,1,3,7,1,3,5] 를 곱해 더하고,
 * 9번째 자리 × 5 의 십의 자리를 더한 뒤, (10 - 합 % 10) % 10 이 마지막 자리와 같아야 한다.
 *
 * 형식만 보고 통과시키면 오타가 심사 큐까지 흘러가고, 운영자가 서류와 대조하는 단계에서야
 * 발견된다. 입력 시점에 거른다.
 */
export function isValidBusinessNumber(value: string): boolean {
  const digits = normalizeBusinessNumber(value);
  if (digits.length !== 10) return false;

  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;

  for (let i = 0; i < 9; i += 1) {
    sum += Number(digits[i]) * weights[i];
  }

  sum += Math.floor((Number(digits[8]) * 5) / 10);

  return (10 - (sum % 10)) % 10 === Number(digits[9]);
}

/**
 * 표시용 마스킹. `123-45-67890` → `123-45-*****`.
 *
 * 앞 5자리만 남기는 이유: 앞 3자리는 세무서 코드, 다음 2자리는 개인·법인 구분이라
 * 개별 사업자를 특정하지 못한다. 뒤 5자리(일련번호+검증번호)가 식별력을 가진다.
 */
export function maskBusinessNumber(value: string): string {
  const digits = normalizeBusinessNumber(value);
  if (digits.length !== 10) return "*".repeat(Math.max(digits.length, 1));

  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-*****`;
}

/**
 * 통신판매업 신고번호. `2026-서울강남-01234` 형태가 표준이나 지자체마다 표기가 갈린다.
 * 형식을 강제하면 정상 신고번호가 반려되므로 **공백 정리까지만** 한다.
 */
export function normalizeMailOrderNumber(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * 연락처 마스킹. `01012345678` → `010-****-5678`.
 * 신청자 화면에서 자기 번호를 확인할 때 쓴다. 심사 화면은 원문을 보여준다 —
 * 운영자가 실제로 연락해야 심사가 진행되기 때문이다.
 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 9) return "*".repeat(Math.max(digits.length, 1));

  const head = digits.slice(0, 3);
  const tail = digits.slice(-4);

  return `${head}-****-${tail}`;
}
