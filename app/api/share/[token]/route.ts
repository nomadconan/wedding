import { fail, ok } from "@/lib/api/response";
import { SHARE_STATE_LABEL, SHARE_STATE_NOTE, SHARE_VIEW_NOTICE } from "@/lib/core/share/share";
import { openShareLink } from "@/lib/share/links";

/**
 * GET /api/share/[token] — 공유 링크 열기 (F-C-20 · 명세서 §4.2)
 *
 * **로그인을 요구하지 않는다.** 링크는 **토큰을 가진 것이 곧 권한**이며 받는 사람은
 * 우리 사용자가 아니다. 판정은 `share_link_open()`(SECURITY DEFINER · 0046)이 하고
 * — 만료·거둠을 확인하고 살아 있을 때만 자원을 가리킨다 — 자원은 그 뒤에 읽는다.
 *
 * ── 왜 404 하나로 답하지 않는가 ────────────────────────────────────────────
 * "없는 링크" 로 뭉뚱그리면 **만료된 링크를 받은 사람이 자기가 주소를 잘못 옮겼다고
 * 생각한다.** 셋은 다음에 할 일이 다르다 — 만료·거둠은 **보낸 사람에게 다시 받기**,
 * 없음은 **주소 확인**. 그래서 상태를 사유와 함께 돌려주고 화면이 그대로 적는다.
 *
 * 닫힌 링크도 **410 이 아니라 404** 로 답한다: 상태 코드로 "그 토큰이 존재하긴 한다" 를
 * 알려 주면 토큰을 하나씩 넣어 보는 쪽에 정보가 된다. 사유는 **본문에만** 싣는다.
 */
/**
 * **정적 캐시를 끈다.** 이 라우트는 쿠키를 하나도 읽지 않아 Next 가 GET 핸들러를
 * 정적으로 취급한다 — 그러면 **거둔 링크가 계속 열린다**(흐름 점검이 잡았다 ·
 * FIX-22 계열). `lib/share/links.ts` 의 `no-store` 와 짝이다.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { token: string } }) {
  const opened = await openShareLink(params.token);

  if (opened.state !== "live") {
    return fail(404, "SHARE_LINK_CLOSED", SHARE_STATE_LABEL[opened.state], {
      state: opened.state,
      note: SHARE_STATE_NOTE[opened.state],
    });
  }

  return ok({
    state: opened.state,
    resource: opened.resource,
    expiresAt: opened.expiresAt,
    // **뷰 전용·마스킹 상태라는 사실**을 응답이 갖는다 — 화면이 문구를 다시 쓰지 않는다.
    notice: SHARE_VIEW_NOTICE,
  });
}
