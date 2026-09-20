// 알림 → 화면 이동 (C-4d · 명세서 §2.1 F-C-21 확장 · D-98)
//
// 프레임워크를 모르는 순수 모듈이다(CLAUDE.md §3.1).
//
// ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
// **알림에서 나가는 링크가 하나도 없었다**(B-1 조사 4). "청첩장 주문할 때가 됐어요"
// 를 읽고 나서 **어디로 가야 하는지**는 사용자가 스스로 찾아야 했다 — 알림이 일을
// 알려 주기만 하고 **그 일을 할 수 있는 자리로 잇지 않으면** 알림이 아니라 잔소리다.
//
// ── 왜 레지스트리인가 (D-98) ────────────────────────────────────────────────
// 글의 CTA(`TOOL_CTAS`)가 이미 같은 판단을 했다 — **없는 화면으로 보내지 않는다.**
// 경로를 호출부에서 문자열로 조립하면 라우트가 바뀌었을 때 알림만 조용히 404 가 되고,
// 그것은 **누른 사람만 알게 되는 고장**이다. 여기 한 곳에 모아 두면 검사가 실재를 본다.
//
// ── 참조가 모자라면 링크를 만들지 않는다 ────────────────────────────────────
// `payload_json` 은 **참조 ID와 숫자만** 담는다(§7.3). 그 참조가 없으면 `null` 을
// 돌려주고 화면은 링크 없이 문장만 그린다 — **잘못된 곳으로 보내는 것보다 안 보내는
// 편이 낫다.** 던지지 않는 이유는 알림 하나의 참조 누락이 알림함 전체를 500 으로
// 만들면 안 되기 때문이다(`TOOL_CTAS` 가 모르는 키를 떨어뜨리는 것과 같은 판단).
//
// ── 여기 없는 템플릿은 아직 링크가 없다 ─────────────────────────────────────
// **C-4d 는 자기가 만든 템플릿 둘만 잇는다.** 나머지 템플릿 전부에 대해
// *"가는 곳이 있거나, 없다는 것이 적혀 있다"* 를 세우는 것은 **C-4e** 의 완료
// 조건이다. 경계를 앞당기면 "완료" 가 두 가지를 뜻하게 된다(S7-08 기준).

export type NotificationLink = { href: string; label: string };

type LinkResolver = (payload: Record<string, unknown>) => NotificationLink | null;

const asId = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * 템플릿 키 → 가는 곳.
 *
 * **실재하는 경로만 적는다.** `/checklist` 와 `/explore/[vendorId]/[productId]` 는
 * 둘 다 서 있는 화면이고, `db:rls` 가 파일 존재를 대조한다.
 */
export const NOTIFICATION_LINKS: Readonly<Record<string, LinkResolver>> = {
  /** 체크리스트 항목의 기한 — 목록으로 보낸다. 항목 단위 화면은 아직 없다. */
  "task_due.remind": () => ({ href: "/checklist", label: "체크리스트에서 보기" }),

  /** 상품 주문 기한 — 그 상품 상세로 보낸다(C-2c 가 만든 주소). */
  "task_due.order": (payload) => {
    const vendorId = asId(payload.vendorId);
    const productId = asId(payload.productId);

    if (vendorId === null || productId === null) return null;

    return { href: `/explore/${vendorId}/${productId}`, label: "상품에서 보기" };
  },
};

/**
 * 이 알림에서 어디로 가는가. 없으면 `null` 이고 화면은 문장만 그린다.
 *
 * **모르는 템플릿도 `null` 이다** — 링크가 아직 없는 것과 참조가 모자란 것을
 * 화면은 똑같이 다룬다(둘 다 "보낼 곳을 모른다").
 */
export function notificationLink(
  templateKey: string | null,
  payload: Record<string, unknown> | null,
): NotificationLink | null {
  if (templateKey === null) return null;

  return NOTIFICATION_LINKS[templateKey]?.(payload ?? {}) ?? null;
}

/** 링크가 붙은 템플릿 키. 검사가 실재 경로와 대조한다. */
export const LINKED_TEMPLATE_KEYS: readonly string[] = Object.keys(NOTIFICATION_LINKS);
