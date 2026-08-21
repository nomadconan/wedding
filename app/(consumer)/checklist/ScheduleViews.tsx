"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { NextTaskList } from "@/components/domain/NextTaskList";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Progress } from "@/components/ui/progress";
import {
  WAITING_NOTE,
  nextTasks,
  type AnnotatedTask,
  type CategoryProgress,
  type TaskEdge,
  type TimelineBucket,
} from "@/lib/core/schedule/graph";
import { TASK_CATEGORY_LABEL, type TaskCategory } from "@/lib/core/schedule/templates";
import {
  SCHEDULE_VIEW_LABEL,
  SCHEDULE_VIEW_NOTE,
  dependencyCandidates,
  dependencyLevels,
  readinessBadge,
  resolveView,
  type ScheduleView,
} from "@/lib/core/schedule/view";
import { cn } from "@/lib/utils";

/**
 * /checklist 표현 넷 (S7-19 · F-C-37 · 명세서 §6.2 · IDEA-02)
 *
 * ── 이 화면이 캘린더보다 더 주는 것은 둘뿐이다 ──────────────────────────────
 * **순서**와 **"지금 할 수 있는가"**. S7-18 이 그렇게 정리했고 네 표현은 전부 그 둘을
 * 보이게 하는 방식이다 — A 는 시점 축, B 는 카테고리 축, C 는 하나만, D 는 관계 축.
 * 그 둘을 더 잘 보이게 하지 않는 장식은 넣지 않았다.
 *
 * ── 넷이 같은 응답을 쓴다 ───────────────────────────────────────────────────
 * §4.2 가 요구한 그대로다. 서버가 한 번 실은 데이터를 **클라이언트에서 나눠 그린다** —
 * 전환에 서버 왕복이 없다. 뷰마다 조회를 따로 두면 같은 질문에 다른 답이 나온다.
 *
 * ── 전환을 URL 에 쓰지 않는다 ───────────────────────────────────────────────
 * 넷이 같은 데이터를 쓰므로 전환은 서버를 부를 이유가 없는데, URL 을 바꾸면 Next 가
 * 서버 컴포넌트를 다시 부른다. 그래서 **클라이언트 상태**로 둔다 — 완료를 눌러
 * `router.refresh()` 가 돌아도 이 상태는 유지된다(클라이언트 컴포넌트의 상태는
 * 서버 재렌더로 사라지지 않는다). 뷰 전환을 **재는 일은 지표가 붙는 S8-01 이후**이며
 * 지금 기록을 남기지 않는다(O-16 · §7.3 — 새로 수집하는 값을 만들지 않는다).
 *
 * ── `waiting` 을 회색으로 칠하지 않는다 ─────────────────────────────────────
 * 네 표현 전부에서 지킨다. 칠하는 규칙은 화면이 아니라 `readinessBadge` 가 갖고
 * 테스트가 붙잡는다(§3.2 · D-71 — 순서 표시이지 잠금이 아니다).
 */
export function ScheduleViews({
  tasks,
  edges,
  timeline,
  progress,
  enabledViews,
  categoryFilter,
}: {
  tasks: AnnotatedTask[];
  edges: TaskEdge[];
  timeline: TimelineBucket[];
  progress: CategoryProgress[];
  enabledViews: ScheduleView[];
  /** 목록과 같은 카테고리 필터를 쓴다 — 두 곳이 다른 것을 보여주면 안 된다. */
  categoryFilter: TaskCategory | null;
}) {
  const [view, setView] = useState<ScheduleView>(() => resolveView(null, enabledViews));

  const visible = useMemo(
    () =>
      categoryFilter === null
        ? tasks
        : tasks.filter((task) => task.category === categoryFilter),
    [tasks, categoryFilter],
  );

  return (
    <section className="space-y-3" data-testid="schedule-views">
      {/* 표현이 하나뿐이면 토글을 그리지 않는다 — 고를 것이 없는 탭은 자리만 차지한다. */}
      {enabledViews.length > 1 ? (
        <nav aria-label="보기 방식" className="flex gap-2 overflow-x-auto pb-1" role="tablist">
          {enabledViews.map((code) => (
            <button
              key={code}
              type="button"
              role="tab"
              aria-selected={view === code}
              onClick={() => setView(code)}
              data-testid={`schedule-view-${code}`}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 text-caption",
                view === code
                  ? "border-brand-500 text-brand-600"
                  : "border-border text-muted-foreground",
              )}
            >
              {SCHEDULE_VIEW_LABEL[code]}
            </button>
          ))}
        </nav>
      ) : null}

      {/* **캘린더가 못 하는 무엇을 말하는지** 화면이 스스로 적는다(O-16 이 판정할 대상이다). */}
      <p className="text-caption text-muted-foreground" data-testid="schedule-view-note">
        {SCHEDULE_VIEW_NOTE[view]}
      </p>

      {visible.length === 0 ? (
        <EmptyState
          title="보여드릴 일정이 없어요"
          description="아래에서 일정을 만들거나 직접 추가해 보세요."
        />
      ) : (
        <div data-testid={`schedule-panel-${view}`}>
          {view === "timeline" ? <TimelineView buckets={timeline} filter={categoryFilter} /> : null}
          {view === "progress" ? <ProgressView progress={progress} filter={categoryFilter} /> : null}
          {view === "next" ? <NextView tasks={visible} /> : null}
          {view === "graph" ? <GraphView tasks={visible} allTasks={tasks} edges={edges} /> : null}
        </div>
      )}
    </section>
  );
}

// =============================================================================
// A. 역산 타임라인 — 기본 표현
// =============================================================================

/**
 * **D-day 구간으로 묶는다.** 구간과 그 경계는 `lib/core/schedule/graph` 가 정하고
 * (`TIMELINE_BUCKETS`) 여기서는 그리기만 한다 — 경계를 화면이 정하면 API 응답과
 * 화면이 다른 구간을 말하게 된다.
 *
 * **빈 구간은 오지 않는다**(`buildTimeline` 이 걸러 낸다). 12개월 전이 비어 있는데
 * 자리를 그리면 화면이 "여기서 뭔가 놓쳤다" 고 말하는 셈이다.
 */
function TimelineView({
  buckets,
  filter,
}: {
  buckets: TimelineBucket[];
  filter: TaskCategory | null;
}) {
  const shown = buckets
    .map((bucket) => ({
      ...bucket,
      tasks: filter === null ? bucket.tasks : bucket.tasks.filter((t) => t.category === filter),
    }))
    .filter((bucket) => bucket.tasks.length > 0);

  return (
    <ol className="space-y-4" data-testid="schedule-timeline">
      {shown.map((bucket) => (
        <li key={bucket.code} className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{bucket.label}</h3>
            <span className="text-caption text-muted-foreground">{bucket.tasks.length}건</span>
          </div>

          <ul className="space-y-2 border-l border-border pl-3">
            {bucket.tasks.map((task) => (
              <li key={task.id}>
                <TaskLine task={task} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

// =============================================================================
// B. 카테고리별 진행 게이지
// =============================================================================

/**
 * **비율은 basis point 정수**로 온다(`categoryProgress`). 화면은 그것을 100으로 나눠
 * 보여줄 뿐 계산하지 않는다 — 부동소수점을 쓰지 않기로 한 규칙이 화면에서 깨지면
 * 같은 값이 두 자리에서 다르게 반올림된다.
 *
 * **'0%' 와 '아직 없음' 을 가르지 않는다** — 카테고리에 태스크가 하나도 없으면
 * `categoryProgress` 가 그 카테고리를 아예 내지 않는다. 빈 게이지를 그리면 "해야 할
 * 일이 있는데 안 했다" 로 읽히는데 그것은 사실이 아니다.
 */
function ProgressView({
  progress,
  filter,
}: {
  progress: CategoryProgress[];
  filter: TaskCategory | null;
}) {
  const shown = filter === null ? progress : progress.filter((row) => row.category === filter);

  return (
    <ul className="space-y-3" data-testid="schedule-progress">
      {shown.map((row) => (
        <li key={row.category} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-foreground">
              {TASK_CATEGORY_LABEL[row.category as TaskCategory] ?? row.category}
            </span>
            <span className="text-caption text-muted-foreground">
              {row.done}/{row.total}
            </span>
          </div>

          <Progress value={row.rateBp / 100} aria-label={`${row.category} 진행률`} />
        </li>
      ))}
    </ul>
  );
}

// =============================================================================
// C. 다음 할 일 — 홈과 같은 컴포넌트
// =============================================================================

/**
 * **홈(S3-11)과 같은 컴포넌트·같은 규칙이다**(§6.2). 고르는 것은 `nextTasks` 이고
 * 그리는 것은 `NextTaskList` 다 — 둘 다 한 벌이라 두 화면이 같은 3건을 말한다.
 *
 * 여기서 링크를 주지 않는 이유는 **이미 그 화면에 있기** 때문이다.
 */
function NextView({ tasks }: { tasks: AnnotatedTask[] }) {
  return (
    <div className="space-y-2" data-testid="schedule-next">
      <NextTaskList
        tasks={nextTasks(tasks)}
        href={null}
        testId="schedule-next-list"
        emptyHint="지금 할 수 있는 일이 없어요. 먼저 할 일부터 끝내면 여기에 올라옵니다."
      />
    </div>
  );
}

// =============================================================================
// D. 의존 관계 뷰 — 단계로 쌓고 선행을 편집한다
// =============================================================================

/**
 * **그래프를 그리지 않는다.** 배치가 아니라 문장이 목적이다 — "이걸 먼저 해야 저게
 * 됩니다"(§2.1 F-C-37). 단계 계산은 `dependencyLevels` 가 하고 여기서는 쌓기만 한다.
 *
 * **선행 편집은 이 뷰에만 있다.** 타임라인·게이지·다음 할 일은 보는 화면이고 순서를
 * 고치는 일은 순서를 보는 화면에서 한다 — 세 곳에 같은 입력칸을 두면 어디서 고쳤는지
 * 가 흐려진다.
 *
 * **후보는 전체 태스크에서 고른다**(`allTasks`). 카테고리 필터는 보는 범위이지
 * 이을 수 있는 범위가 아니다 — 홀과 스드메 사이를 잇는 일이 가장 잦다.
 */
function GraphView({
  tasks,
  allTasks,
  edges,
}: {
  tasks: AnnotatedTask[];
  allTasks: AnnotatedTask[];
  edges: TaskEdge[];
}) {
  const layout = useMemo(() => dependencyLevels(tasks, edges), [tasks, edges]);
  const titleById = useMemo(
    () => new Map(allTasks.map((task) => [task.id, task.title])),
    [allTasks],
  );

  return (
    <div className="space-y-4" data-testid="schedule-graph">
      {layout.cycle.length > 0 ? (
        <p className="rounded-lg border border-warning/40 p-3 text-caption text-warning">
          순서가 돌고 도는 항목이 {layout.cycle.length}건 있어 단계를 정하지 못했어요.
          아래에서 먼저 할 일 하나를 지우면 풀립니다.
        </p>
      ) : null}

      <ol className="space-y-4">
        {layout.levels.map((level) => (
          <li key={level.depth} className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">
              {level.depth === 0 ? "먼저 할 수 있는 일" : `${level.depth}단계`}
            </h3>

            <ul className="space-y-2">
              {level.tasks.map((task) => (
                <li key={task.id}>
                  <DependencyRow
                    task={task}
                    edges={edges}
                    allTasks={allTasks}
                    titleById={titleById}
                  />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>

      {layout.cycle.length > 0 ? (
        <ul className="space-y-2" data-testid="schedule-graph-cycle">
          {layout.cycle.map((task) => (
            <li key={task.id}>
              <DependencyRow task={task} edges={edges} allTasks={allTasks} titleById={titleById} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DependencyRow({
  task,
  edges,
  allTasks,
  titleById,
}: {
  task: AnnotatedTask;
  edges: TaskEdge[];
  allTasks: AnnotatedTask[];
  titleById: Map<string, string>;
}) {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const mine = edges.filter((edge) => edge.taskId === task.id);
  const candidates = useMemo(
    () => dependencyCandidates({ taskId: task.id, tasks: allTasks, edges }),
    [task.id, allTasks, edges],
  );

  async function call(url: string, method: "POST" | "DELETE", body?: unknown) {
    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        // 서버가 보낸 문장을 그대로 쓴다 — 순환·깊이 사유는 §4.2 가 코드로 정했고
        // 화면이 다시 쓰면 두 곳이 다른 말을 하게 된다.
        setNotice(payload.error?.message ?? "처리하지 못했어요.");

        return;
      }

      setPicking(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const badge = readinessBadge(task.readiness);

  return (
    <div
      className="space-y-2 rounded-lg border border-border p-4"
      data-testid="schedule-graph-task"
      data-readiness={task.readiness}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">
          {TASK_CATEGORY_LABEL[task.category as TaskCategory] ?? task.category}
        </Badge>
        {/* **회색 비활성이 아니다.** 흐림 여부는 `readinessBadge` 가 정한다. */}
        <Badge variant={badge.variant} className={cn(badge.dimmed && "opacity-70")}>
          {badge.label}
        </Badge>
      </div>

      <p className="text-sm font-medium text-foreground">{task.title}</p>

      {mine.length === 0 ? (
        <p className="text-caption text-muted-foreground">먼저 할 일이 없어요.</p>
      ) : (
        <ul className="space-y-1" data-testid="schedule-graph-prereqs">
          {mine.map((edge) => (
            <li key={edge.dependsOn} className="flex items-center justify-between gap-2">
              <span className="text-caption text-muted-foreground">
                먼저 · {titleById.get(edge.dependsOn) ?? "이 목록에 없는 일"}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                data-testid="schedule-graph-remove"
                onClick={() =>
                  void call(
                    `/api/tasks/${task.id}/dependencies?dependsOn=${edge.dependsOn}`,
                    "DELETE",
                  )
                }
              >
                순서 지우기
              </Button>
            </li>
          ))}
        </ul>
      )}

      {picking ? (
        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">먼저 할 일 고르기</span>
          <select
            defaultValue=""
            disabled={busy}
            data-testid="schedule-graph-pick"
            onChange={(event) => {
              if (event.target.value === "") return;

              void call(`/api/tasks/${task.id}/dependencies`, "POST", {
                dependsOn: event.target.value,
              });
            }}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">고르지 않음</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </select>
          {/* 후보를 줄이는 것은 **편의이지 방어가 아니다** — 최종 판정은 DB 트리거다. */}
          {candidates.length === 0 ? (
            <span className="text-caption text-muted-foreground">
              고를 수 있는 일이 없어요. 이 일에 매달린 순서를 먼저 풀어 주세요.
            </span>
          ) : null}
        </label>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          data-testid="schedule-graph-add"
          onClick={() => setPicking(true)}
        >
          먼저 할 일 잇기
        </Button>
      )}

      {notice ? (
        <p role="status" className="text-caption text-warning" data-testid="schedule-graph-notice">
          {notice}
        </p>
      ) : null}

      {task.readiness === "waiting" ? (
        <p className="text-caption text-neutral-500">{WAITING_NOTE}</p>
      ) : null}
    </div>
  );
}

// =============================================================================
// 공통 — 한 줄 표기
// =============================================================================

function TaskLine({ task }: { task: AnnotatedTask }) {
  const badge = readinessBadge(task.readiness);

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="schedule-task-line"
      data-readiness={task.readiness}
    >
      <span
        className={cn(
          "text-sm",
          task.status === "done" ? "text-muted-foreground line-through" : "text-foreground",
        )}
      >
        {task.title}
      </span>
      <Badge variant={badge.variant} className={cn(badge.dimmed && "opacity-70")}>
        {badge.label}
      </Badge>
      <span className="text-caption text-muted-foreground">
        {task.dueDate === null ? "기한 미정" : task.dueDate}
      </span>
    </div>
  );
}

export default ScheduleViews;
