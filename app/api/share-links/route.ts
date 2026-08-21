import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { shareUrl } from "@/lib/core/share/share";
import { createShareLink, listShareLinks, revokeShareLink } from "@/lib/share/links";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST/GET/DELETE /api/share-links — 만료형 공유 링크 (F-C-20 · 명세서 §4.2)
 *
 * §4.2 는 `POST /api/share-links` 만 이름 붙였다. **거둠과 목록을 같은 경로에 뒀다** —
 * 링크를 만들 수 있으면 거둘 수도 있어야 하고(잘못 보낸 순간 할 수 있는 일이 기다리는
 * 것뿐이면 그것은 통제가 아니다), 목록이 없으면 **무엇이 밖에 나가 있는지** 알 수 없다.
 * 경로를 새로 만들지 않은 이유는 셋이 **같은 자원의 같은 권한**을 쓰기 때문이다.
 *
 * ── 권한은 자원으로 판정한다 ────────────────────────────────────────────────
 * "그 자원을 읽을 수 있으면 링크를 만들고 거둘 수 있다." 판정은 **세션 클라이언트가
 * 자원을 실제로 읽어 보는 것**으로 하며 경계는 언제나 RLS 다(`lib/share/links.ts`).
 *
 * **없는 것과 남의 것을 같은 답으로 돌려준다** — 다른 코드를 주면 토큰 없이
 * "그 리포트가 존재하는가" 를 물어볼 수 있게 된다.
 */
const CreateSchema = z
  .object({
    resourceType: z.string().min(1),
    resourceId: z.string().uuid(),
  })
  .strict();

const ListSchema = z.object({
  resourceType: z.string().min(1),
  resourceId: z.string().uuid(),
});

function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

async function context() {
  const user = await getSessionUser();
  if (!user) return { error: fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.") } as const;

  return { user, supabase: await createClient() } as const;
}

export async function POST(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "SHARE_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await createShareLink(ctx.supabase, {
    resourceType: parsed.data.resourceType,
    resourceId: parsed.data.resourceId,
    actorId: ctx.user.id,
  });

  if ("status" in result) return fail(result.status, result.code, result.message);

  return ok(
    {
      id: result.id,
      // **토큰은 만든 사람에게만 나간다.** 목록에서도 그렇다 — 링크를 넘기는 일은
      // 만든 사람이 한다.
      url: shareUrl(appBaseUrl(), result.token),
      expiresAt: result.expiresAt,
    },
    { status: 201 },
  );
}

export async function GET(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const parsed = ListSchema.safeParse({
    resourceType: request.nextUrl.searchParams.get("resourceType"),
    resourceId: request.nextUrl.searchParams.get("resourceId"),
  });
  if (!parsed.success) return failValidation(parsed.error.issues);

  const rows = await listShareLinks(ctx.supabase, parsed.data);

  return ok({
    links: rows.map((row) => ({ ...row, url: shareUrl(appBaseUrl(), row.token), token: undefined })),
  });
}

/**
 * 거둘 링크를 **쿼리로 받는다** — `?id=<uuid>`.
 *
 * DELETE 본문은 표준에 뜻이 정의돼 있지 않아 프록시·`fetch` 구현에 따라 사라질 수 있고,
 * 그러면 **거두는 요청이 조용히 아무것도 안 거둔 채 성공**으로 끝난다(D-80 과 같은 판단).
 */
export async function DELETE(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const id = request.nextUrl.searchParams.get("id");
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await revokeShareLink(ctx.supabase, { id: parsed.data, actorId: ctx.user.id });

  if ("status" in result) return fail(result.status, result.code, result.message);

  return ok(result);
}
