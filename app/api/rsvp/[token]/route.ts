import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { RsvpAnswerSchema } from "@/lib/core/schemas/guest";

/**
 * GET/POST /api/rsvp/[token] — 하객 참석 응답 (F-C-22 · §4.2 신설)
 *
 * **비로그인이 들어오는 유일한 문**이다. 그래서 이 파일이 이 태스크에서 가장 조심할
 * 자리이며, 지키는 것이 셋이다 —
 *
 *  1. **이름을 쓸 수 없다.** 요청 스키마에 이름 필드가 없고, DB 함수
 *     `respond_to_invite()` 도 `rsvp_status`·`party_size`·`responded_at` 세 칸만 쓴다.
 *     링크를 받은 사람은 **답만** 한다.
 *  2. **같은 커플의 다른 하객이 보이지 않는다.** `invite_context()` 는 토큰이 가리키는
 *     **본인 한 줄**만 돌려주며 연락처·토큰은 나가지 않는다.
 *  3. **정적으로 굳지 않는다.** 쿠키를 읽지 않는 경로라 Next 가 캐시할 수 있고, 그러면
 *     **회수된 링크가 계속 열린다**(FIX-22 계열). `force-dynamic` + `no-store` 를 못 박는다.
 *
 * 익명 클라이언트로 부른다 — 함수 둘 다 `anon` 에게 실행 권한이 있고, `guests` 표
 * 자체에는 `anon` 권한이 없다(0051). **서비스롤을 쓰지 않는 이유**가 여기 있다:
 * 서비스롤로 열면 "어느 줄까지 보이는가" 의 책임이 전부 애플리케이션 코드로 넘어온다.
 */
export const dynamic = "force-dynamic";

/**
 * 자기 클라이언트를 만들고 `no-store` 를 못 박는다.
 *
 * `createPublicClient()` 를 쓰지 않는 이유는 그쪽을 건드리면 탐색·가격 화면의 캐시
 * 동작이 함께 바뀌기 때문이다 — **회수가 즉시 듣는 것이 여기서는 요구사항**이다
 * (`lib/flags.ts`·S7-12 가 같은 이유로 각자 클라이언트를 만들었다).
 */
function createRsvpClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) throw new Error("Supabase 공개 환경변수가 설정되지 않았습니다.");

  return createSupabaseClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: (input, init) => fetch(input as RequestInfo, { ...init, cache: "no-store" }),
    },
  });
}

type Context = {
  guest_name: string;
  wedding_date: string | null;
  rsvp_status: string;
  party_size: number;
  closed: boolean;
};

export async function GET(_request: NextRequest, { params }: { params: { token: string } }) {
  const { data } = await createRsvpClient()
    .rpc("invite_context", { p_token: params.token })
    .maybeSingle();

  const context = (data ?? null) as Context | null;

  // **없는 링크와 닫힌 링크를 가른다**(S7-12 가 세운 규칙) — 다음에 할 일이 다르다.
  if (context === null) {
    return fail(404, "RSVP_NOT_FOUND", "초대 링크를 찾을 수 없어요. 보내신 분께 확인해 주세요.");
  }

  return ok({
    guestName: context.guest_name,
    weddingDate: context.wedding_date,
    rsvpStatus: context.rsvp_status,
    partySize: context.party_size,
    closed: context.closed,
  });
}

const REASON_MESSAGE: Record<string, string> = {
  bad_answer: "참석 여부를 골라 주세요.",
  bad_party_size: "인원 수를 확인해 주세요.",
  not_found: "초대 링크를 찾을 수 없어요. 보내신 분께 확인해 주세요.",
  no_wedding_date: "예식일이 정해지지 않아 지금은 응답을 받을 수 없어요.",
  closed: "예식일이 지나 응답을 받지 않아요.",
};

export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "RSVP_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = RsvpAnswerSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const { data } = await createRsvpClient()
    .rpc("respond_to_invite", {
      p_token: params.token,
      p_answer: parsed.data.answer,
      p_party_size: parsed.data.partySize,
    })
    .maybeSingle();

  const result = (data ?? null) as { ok: boolean; reason: string } | null;

  if (result === null || !result.ok) {
    const reason = result?.reason ?? "not_found";

    return fail(
      reason === "not_found" ? 404 : 422,
      `RSVP_${reason.toUpperCase()}`,
      REASON_MESSAGE[reason] ?? "응답을 저장하지 못했어요.",
      { reason },
    );
  }

  return ok({ answered: true, answer: parsed.data.answer, partySize: parsed.data.partySize });
}
