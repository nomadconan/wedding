import { fail, ok } from "@/lib/api/response";
import { TASK_LINK_BASIS_NOTE } from "@/lib/core/task/links";
import { findMyCouple } from "@/lib/couple/membership";
import { linkKeyFor, loadTaskLinks } from "@/lib/tasks/links";
import { loadChecklist } from "@/lib/tasks/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/tasks/links — 준비 항목에서 어디로 갈 수 있는가 (C-4c · F-C-39 · §4.2)
 *
 * ── 왜 이 라우트가 따로 있는가 ──────────────────────────────────────────────
 * 원장이 이 경로를 F-C-39 에 배정했고, 화면 말고도 읽는 쪽이 있다 — AI 플래너가
 * *"청첩장은 어디서 봐요?"* 에 답하려면 같은 판정이 필요하고, 앱(Capacitor·Expo)이
 * 같은 다리를 그려야 한다. **판정은 한 벌이다** — 화면도 이 라우트도
 * `lib/tasks/links.ts` 하나를 부른다(`/api/tasks/graph` 가 `loadChecklist` 를
 * 공유하는 것과 같은 모양).
 *
 * ── 무엇을 돌려주는가 ───────────────────────────────────────────────────────
 * 태스크 하나하나가 아니라 **카테고리 단위**다. 같은 카테고리의 태스크 스물다섯
 * 개가 같은 답을 받으므로, 태스크마다 실으면 같은 것을 스물다섯 번 보낸다.
 * `linkKeys[taskId]` 로 어느 다리를 쓸지 찾는다.
 *
 * ── 추천이 아니다 ───────────────────────────────────────────────────────────
 * 응답에 **판정 기준(`basis`)을 함께 싣는다**(§2.2 와 같은 규칙). 업체·상품을
 * 고르지 않고 카테고리 목록으로만 보내며, 그 사실이 응답에 적혀 있어야 부르는
 * 쪽(특히 AI)이 이것을 추천으로 옮기지 않는다.
 *
 * **세션 클라이언트로 읽는다.** `tasks` 는 커플 스코프 RLS 이고 플래너 위임까지
 * 그쪽이 판정한다(0005 [11] · 0042).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const membership = await findMyCouple(user.id);
  if (!membership) return fail(404, "COUPLE_NOT_FOUND", "커플 정보를 먼저 만들어 주세요.");

  const supabase = await createClient();
  const checklist = await loadChecklist(supabase, {
    coupleId: membership.coupleId,
    today: new Date().toISOString().slice(0, 10),
  });

  const keys = checklist.tasks.map((task) => ({
    category: task.category,
    vendorCategory: task.vendorCategory ?? null,
  }));

  const links = await loadTaskLinks(keys);

  return ok({
    basis: TASK_LINK_BASIS_NOTE,
    links,
    /** 태스크 → 어느 다리를 쓰는가. 다리 본문을 태스크마다 복사하지 않는다. */
    linkKeys: Object.fromEntries(
      checklist.tasks.map((task) => [
        task.id,
        linkKeyFor({ category: task.category, vendorCategory: task.vendorCategory ?? null }),
      ]),
    ),
  });
}
