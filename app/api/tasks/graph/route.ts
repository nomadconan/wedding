import { fail, ok } from "@/lib/api/response";
import { WAITING_NOTE } from "@/lib/core/schedule/graph";
import {
  DEFAULT_SCHEDULE_VIEW,
  SCHEDULE_VIEWS,
  SCHEDULE_VIEW_LABEL,
  SCHEDULE_VIEW_NOTE,
  dependencyLevels,
  enabledViews,
} from "@/lib/core/schedule/view";
import { findMyCouple } from "@/lib/couple/membership";
import { SCHEDULE_VIEWS_FLAG, featureRollout } from "@/lib/flags";
import { loadChecklist } from "@/lib/tasks/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/tasks/graph — 준비 순서 조회 (S7-19 · F-C-37 · 명세서 §4.2)
 *
 * ── 왜 `/api/tasks` 와 따로 있는가 ──────────────────────────────────────────
 * §4.2 가 이 경로를 F-C-37 에 배정했고 AI 툴(`get_task_graph` · §5.6)이 이 이름을
 * 부른다. 그러나 **답은 같은 곳에서 온다** — `loadChecklist` 하나이며 이 라우트는
 * 그 결과를 그래프 모양으로 옮기기만 한다.
 *
 * **뷰마다 다른 API 를 두면 같은 질문에 다른 답이 나온다**(§4.2). 그래서 조회를 두 벌
 * 만들지 않았다. 두 라우트가 남는 이유는 **모양이 다르기 때문**이지 데이터가 달라서가
 * 아니다 — 목록은 태스크를 주고 그래프는 **간선·단계·순환**까지 준다.
 *
 * ── 무엇을 더 싣는가 ────────────────────────────────────────────────────────
 * `levels`(단계 배치)와 `enabledViews`(켜진 표현)를 더한다. 단계 계산을 화면에
 * 두면 뷰를 하나 더 만드는 날 그 계산이 따라오지 않고, 켜진 표현은 `feature_flags`
 * 를 서비스롤로 읽어야 알 수 있어 클라이언트가 스스로 답할 수 없다.
 *
 * **세션 클라이언트로 읽는다.** `tasks`·`task_dependencies` 는 커플 스코프 RLS 이고
 * 플래너 위임까지 그쪽이 판정한다(0005 [11] · 0042). 플래그만 서비스롤이며
 * (`lib/flags.ts`) 그쪽은 **캐시를 꺼 두었다**(FIX-22).
 */

const today = () => new Date().toISOString().slice(0, 10);

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const membership = await findMyCouple(user.id);
  if (!membership) {
    return fail(404, "TASK_COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.");
  }

  const supabase = await createClient();
  const view = await loadChecklist(supabase, {
    coupleId: membership.coupleId,
    today: today(),
  });

  const layout = dependencyLevels(view.tasks, view.edges);
  const enabled = enabledViews(await featureRollout(SCHEDULE_VIEWS_FLAG));

  return ok({
    tasks: view.tasks,
    edges: view.edges,
    order: view.order,
    // 위상 정렬이 잡은 순환과 단계 계산이 잡은 순환은 같은 사실의 두 표현이다.
    // **숨기지 않는다** — 조용히 임의 순서를 그리면 그것이 순서로 믿긴다.
    cycle: view.cycle,
    levels: layout.levels,
    cycleTasks: layout.cycle.map((task) => task.id),
    timeline: view.timeline,
    progress: view.progress,
    next: view.next,
    // **`waiting` 은 잠금이 아니다.** 문구를 응답에 실어 화면이 다시 쓰지 않게 한다.
    waitingNote: WAITING_NOTE,
    views: {
      all: SCHEDULE_VIEWS,
      enabled,
      default: DEFAULT_SCHEDULE_VIEW,
      label: SCHEDULE_VIEW_LABEL,
      note: SCHEDULE_VIEW_NOTE,
    },
  });
}
