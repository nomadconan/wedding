import type { NextRequest } from "next/server";

import { openRoom } from "@/lib/chat/actions";
import { loadRooms, loadSlaThreshold } from "@/lib/chat/loader";
import { OpenRoomSchema } from "@/lib/core/schemas/chat";
import { findMyCouple } from "@/lib/couple/membership";
import { fail, failValidation, ok } from "@/lib/api/response";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST /api/chat/rooms — 소비자 대화방 목록·개설 (F-C-27, §4.2)
 *
 * **커플 id 를 입력으로 받지 않는다.** 세션에서 찾는다 — 받으면 남의 커플 id 를
 * 적어 보내는 경로가 열리고, RLS 가 막더라도 그런 모양의 API 자체가 잘못이다.
 *
 * 방 개설은 **고객만** 한다(S4-01). 업체에는 `chat_rooms` INSERT 정책이 없으므로
 * 이 라우트를 업체 계정으로 불러도 DB 가 거절한다 — 여기서 역할을 다시 판정하지
 * 않는 이유다. 경계는 하나여야 한다(CLAUDE.md §5.5).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();

  try {
    // RLS 가 자기 커플의 방만 보여준다. side 는 서버가 고정한다 — 소비자 라우트다.
    const rooms = await loadRooms(supabase, {
      viewerId: user.id,
      side: "couple",
      threshold: await loadSlaThreshold(),
      now: new Date(),
    });

    return ok({
      rooms,
      totalUnread: rooms.reduce((sum, room) => sum + room.unread, 0),
    });
  } catch {
    return fail(500, "CHAT_ROOMS_LOAD_FAILED", "대화 목록을 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CHAT_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = OpenRoomSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const membership = await findMyCouple(user.id);
  if (!membership) {
    return fail(
      403,
      "CHAT_COUPLE_REQUIRED",
      "온보딩을 먼저 마쳐야 업체와 대화를 시작할 수 있어요.",
    );
  }

  const supabase = await createClient();

  const result = await openRoom(supabase, {
    coupleId: membership.coupleId,
    vendorId: parsed.data.vendorId,
    actorId: user.id,
  });

  if ("status" in result) return fail(result.status, result.code, result.message);

  return ok(result, { status: result.created ? 201 : 200 });
}
