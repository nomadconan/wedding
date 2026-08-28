import { type NextRequest, NextResponse } from "next/server";

import { LOGIN_ERROR_CODES } from "@/lib/core/auth/login-error";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/observability/client-event — 클라이언트 실패 신고 (S8-13 · **FIX-32**)
 *
 * **왜 이 경로가 필요한가.** 로그인 POST 는 브라우저에서 Supabase 로 직접 나간다.
 * Next 서버를 지나지 않으므로 **서버에 흔적이 구조적으로 없다** — FIX-24(로그인이
 * 몇 주 막혀 있었다)가 안 잡힌 직접적인 이유이며, 그때 찾던 "서버 로그" 는 원래
 * 존재할 수 없었다. 그래서 **클라이언트가 실패했다는 사실만 서버에 알린다.**
 *
 * ── 무엇을 받지 않는가 ─────────────────────────────────────────────────────
 *
 * **이메일·비밀번호·IP·User-Agent·자유 문장을 받지 않는다.** 어휘가 정해진 코드
 * 하나뿐이다. 비인증 경로라 들어오는 값을 신뢰할 수 없고, 개인정보가 이 경로로
 * 들어오면 **지울 근거도 주체도 없다**(§5.2·§5.3). 표에도 그 칸을 두지 않았다.
 *
 * **`occurred_at` 도 받지 않는다.** DB 기본값이 채운다 — 클라이언트가 시각을 정하면
 * 과거·미래로 기록을 흩뿌릴 수 있다.
 *
 * ── 이 관측의 한계 ─────────────────────────────────────────────────────────
 *
 * 브라우저가 안 보내면(네트워크 실패·JS 차단·탭 종료) **아무것도 안 남는다.** 그래서
 * 이 값은 "이만큼은 있었다" 이지 **"이게 전부다" 가 아니며**, `/admin/ops` 가 그 문장을
 * 그대로 적는다. 완전한 관측은 로그인을 서버 경유로 바꿔야 얻어지고, 그것은 관측을
 * 위해 인증 경로 전체를 바꾸는 일이라 **고치려는 것보다 위험이 크다**(D-148).
 */
export const dynamic = "force-dynamic";

const KINDS = ["login_failed"] as const;

export async function POST(request: NextRequest) {
  // **응답을 항상 204 로 고정한다.** 성공·실패·어휘 위반이 구분되면 이 경로가
  // 표의 존재와 어휘를 알려주는 탐지 도구가 된다. 로그인 화면은 이 결과를 보지도
  // 않는다 — 신고가 실패해도 로그인이 영향을 받으면 안 된다.
  const done = new NextResponse(null, { status: 204 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return done;
  }

  const payload = body as { kind?: unknown; code?: unknown } | null;
  const kind = typeof payload?.kind === "string" ? payload.kind : "";
  const code = typeof payload?.code === "string" ? payload.code : "";

  // **서버에서도 어휘를 확인한다.** DB CHECK 이 최종 경계지만, 여기서 걸러야
  // 낙서 요청이 DB 까지 가지 않는다.
  if (!(KINDS as readonly string[]).includes(kind)) return done;
  if (!(LOGIN_ERROR_CODES as readonly string[]).includes(code)) return done;

  // **세션(anon) 클라이언트로 넣는다.** 서비스롤을 쓰면 RLS 를 우회하게 되고,
  // 비인증 입력에 그 권한을 붙일 이유가 없다. 표는 `anon` 에게 `kind`·`code`
  // 두 칸의 INSERT 만 주며(0064), 그것이 이 경로가 할 수 있는 전부다.
  const supabase = await createClient();
  await supabase.from("client_events").insert({ kind, code });

  return done;
}
