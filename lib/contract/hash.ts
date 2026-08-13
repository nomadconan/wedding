import { createHash } from "node:crypto";

import { canonicalContent, type ContractContent } from "@/lib/core/contract/contract";

/**
 * 계약 정본 해시 (S5-04 · D-23)
 *
 * **정규화는 `lib/core/contract` 가 하고 해시만 여기서 한다.** `node:crypto` 를
 * `lib/core` 에 넣으면 Expo 로 옮길 때 걸린다(CLAUDE.md §3.1 — 프레임워크·런타임
 * 무관 원칙). 그래서 "같은 입력이면 같은 문자열" 이라는 어려운 부분은 순수 모듈이
 * 갖고, 이 파일은 그 문자열을 sha256 으로 접는 두 줄이다.
 *
 * DB CHECK(`contracts_hash_shape`)가 `^[0-9a-f]{64}$` 를 요구한다.
 */
export function contentHash(content: ContractContent): string {
  return createHash("sha256").update(canonicalContent(content), "utf8").digest("hex");
}

/** 웹훅 원문 해시. 원문을 보관하지 않고 무엇을 받았는지 증명한다(§7.3 · 0028). */
export function payloadDigest(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * 요청 출처 해시.
 *
 * **원본 IP 를 저장하지 않는다**(§7.3). 남길 사실은 "같은 곳에서 왔는가" 이고
 * 주소 자체가 아니다. 소금 없이 해시하면 IPv4 는 전수 대입으로 되돌릴 수 있으므로
 * 앱 비밀을 소금으로 쓴다 — 없으면 해시를 만들지 않는다(있는 척하는 것보다 낫다).
 */
export function ipHash(ip: string | null): string | null {
  if (!ip) return null;

  const salt = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!salt) return null;

  return createHash("sha256").update(`${salt}:${ip}`, "utf8").digest("hex");
}
