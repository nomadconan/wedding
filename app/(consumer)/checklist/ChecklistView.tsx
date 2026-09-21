"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  READINESS_LABEL,
  WAITING_NOTE,
  type AnnotatedTask,
  type CategoryProgress,
  type TaskEdge,
  type TimelineBucket,
} from "@/lib/core/schedule/graph";
import { TASK_CATEGORIES, TASK_CATEGORY_LABEL, type TaskCategory } from "@/lib/core/schedule/templates";
import type { ScheduleView } from "@/lib/core/schedule/view";
import { TASK_TITLE_MAX_LENGTH } from "@/lib/core/schemas/task";
import { TASK_LINK_BASIS_NOTE, type TaskLinks } from "@/lib/core/task/links";
import { cn } from "@/lib/utils";

import { ScheduleViews } from "./ScheduleViews";

/**
 * /checklist — 일정·체크리스트 (F-C-04 · 명세서 §6.2)
 *
 * ── 화면이 둘로 나뉜다 — 보는 곳과 고치는 곳 ────────────────────────────────
 * 위는 **표현 넷**(S7-19 · F-C-37 · `ScheduleViews`)이고 아래는 **목록**(S7-08)이다.
 * 표현은 순서를 보이는 일이고 목록은 고치는 일이라 섞지 않았다 — 네 표현마다 완료
 * 버튼과 날짜 입력을 다시 그리면 **같은 편집 수단이 다섯 벌**이 되고 그 중 하나만
 * 고치는 날이 온다(§6.2 가 컴포넌트 공유를 요구한 것과 같은 이유다).
 *
 * **카테고리 필터는 하나다.** 위아래가 같은 필터를 쓴다 — 두 곳이 다른 범위를
 * 보여주면 사용자는 어느 쪽이 맞는지 묻게 된다.
 *
 * ── 등록·기한 변경은 캘린더 형식이다 ────────────────────────────────────────
 * §6.2 가 정한 전제다. 날짜를 고르는 일은 달력이 가장 익숙하며, **바꾸는 것은
 * 표현이지 입력이 아니다** — 그래서 입력은 `<input type="date">` 하나이고 표현을
 * 다양하게 만드는 일은 위쪽 넷이 한다.
 *
 * ── `waiting` 을 회색으로 칠하지 않는다 ─────────────────────────────────────
 * 회색 비활성은 '못 한다' 로 읽히는데 **잠긴 것이 아니다**(§3.2 · S7-18 · D-71).
 * 순서를 알려 주는 배지로만 쓰고 완료 버튼은 그대로 살아 있다 — 화면이 잠그지 않기로
 * 한 결정을 시각적으로 뒤집으면 안 된다. 표현 넷도 같은 규칙을 쓴다(`readinessBadge`).
 */
export function ChecklistView({
  initialTasks,
  edges,
  timeline,
  progress,
  enabledViews,
  hasWeddingDate,
  generated,
  missingTemplates,
  taskLinks,
  linkKeys,
}: {
  initialTasks: AnnotatedTask[];
  edges: TaskEdge[];
  timeline: TimelineBucket[];
  progress: CategoryProgress[];
  enabledViews: ScheduleView[];
  hasWeddingDate: boolean;
  /** 이미 자동 생성한 적이 있는가. 버튼 문구가 달라진다. */
  generated: boolean;
  /**
   * 아직 내 목록에 없는 준비 항목 (C-4a).
   *
   * **소급하지 않기로 했으므로 이 목록이 유일한 통로다.** 준비 항목이 늘어도
   * 이미 만든 사람에게 말없이 끼워 넣지 않는다(S7-08) — 대신 **무엇이 들어올지를
   * 이름으로 먼저 보이고** 넣을지는 사용자가 정한다.
   */
  missingTemplates: { code: string; title: string }[];
  /**
   * 어디서 할지 (C-4c · F-C-39).
   *
   * **카테고리 단위다.** 같은 카테고리의 태스크가 같은 다리를 쓰므로 태스크마다
   * 복사하지 않는다 — `linkKeys[taskId]` 로 찾는다.
   */
  taskLinks: Readonly<Record<string, TaskLinks>>;
  linkKeys: Readonly<Record<string, string>>;
}) {
  const router = useRouter();

  const [category, setCategory] = useState<TaskCategory | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const tasks =
    category === null
      ? initialTasks
      : initialTasks.filter((task) => task.category === category);

  async function call(body: unknown, method: "POST" | "PATCH") {
    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch("/api/tasks", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setNotice(payload.error?.message ?? "처리하지 못했어요.");

        return null;
      }

      router.refresh();

      return payload.data;
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    const data = await call({ action: "generate" }, "POST");

    if (data) {
      setNotice(
        data.created === 0
          ? "새로 만들 일정이 없어요. 이미 다 있습니다."
          : hasWeddingDate
            ? `${data.created}건을 만들었어요. 순서도 함께 이어 뒀습니다.`
            : `${data.created}건을 만들었어요. 예식일이 정해지면 기한을 채워 주세요.`,
      );
    }
  }

  return (
    <div className="space-y-4" data-testid="checklist">
      {/* 자동 생성 — **사용자가 누른다.** 온보딩에서 조용히 만들지 않는다. */}
      <section className="space-y-2 rounded-lg border border-border p-4">
        <p className="text-sm font-medium text-foreground">
          {generated ? "빠진 일정 채우기" : "예식일 기준으로 일정 만들기"}
        </p>
        <p className="text-caption text-muted-foreground">
          {hasWeddingDate
            ? "예식일에서 역산해 준비 순서까지 함께 만들어요. 이미 있는 항목은 건드리지 않습니다."
            : "예식일이 아직 없어요. 목록은 만들되 기한은 비워 둡니다 — 없는 날짜를 지어내지 않아요."}
        </p>

        {/*
          **무엇이 들어올지 먼저 보인다**(C-4a). 준비 항목이 늘어도 이미 만든 사람의
          목록에 말없이 끼우지 않기로 했고(S7-08), 그러면 버튼만으로는 무엇이 생길지
          모른 채 누르게 된다 — **지웠던 항목이 돌아오는 경우**도 여기서 드러난다.
        */}
        {generated ? (
          missingTemplates.length === 0 ? (
            <p className="text-caption text-muted-foreground" data-testid="missing-none">
              빠진 준비 항목이 없어요.
            </p>
          ) : (
            <div className="space-y-1" data-testid="missing-templates">
              <p className="text-caption text-foreground">
                내 목록에 없는 준비 항목 {missingTemplates.length}개
              </p>
              <p className="text-caption text-muted-foreground">
                {missingTemplates.map((template) => template.title).join(" · ")}
              </p>
            </div>
          )
        ) : null}

        <Button
          type="button"
          size="sm"
          // **넣을 것이 없으면 누르지 못한다.** 누르고 "0건을 만들었어요" 를 받으면
          // 사용자는 무엇이 잘못됐는지 되짚게 된다.
          disabled={busy || (generated && missingTemplates.length === 0)}
          onClick={() => void generate()}
        >
          {busy
            ? "만드는 중…"
            : generated
              ? `빠진 ${missingTemplates.length}개 넣기`
              : "일정 만들기"}
        </Button>
      </section>

      <nav aria-label="카테고리" className="flex gap-2 overflow-x-auto pb-1">
        <FilterTab label="전체" active={category === null} onClick={() => setCategory(null)} />
        {TASK_CATEGORIES.map((value) => (
          <FilterTab
            key={value}
            label={TASK_CATEGORY_LABEL[value]}
            active={category === value}
            onClick={() => setCategory(value)}
          />
        ))}
      </nav>

      {notice ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="checklist-notice">
          {notice}
        </p>
      ) : null}

      {/* ── 보는 곳 — 표현 넷 (S7-19 · F-C-37) ─────────────────────────────
          넷이 **같은 응답**을 쓴다(§4.2). 전환에 서버 왕복이 없다. */}
      {initialTasks.length > 0 ? (
        <ScheduleViews
          tasks={initialTasks}
          edges={edges}
          timeline={timeline}
          progress={progress}
          enabledViews={enabledViews}
          categoryFilter={category}
        />
      ) : null}

      {/* ── 고치는 곳 — 목록 (S7-08) ──────────────────────────────────────── */}
      {initialTasks.length > 0 ? (
        <h2 className="pt-2 text-sm font-semibold text-foreground">목록에서 고치기</h2>
      ) : null}

      {tasks.length === 0 ? (
        <EmptyState
          title="할 일이 없어요"
          description="위에서 일정을 만들거나 직접 추가해 보세요."
        />
      ) : (
        <ul className="space-y-2" data-testid="checklist-tasks">
          {tasks.map((task) => (
            <li key={task.id}>
              <TaskRow
                task={task}
                busy={busy}
                onCall={call}
                links={taskLinks[linkKeys[task.id] ?? task.category] ?? null}
              />
            </li>
          ))}
        </ul>
      )}

      <p className="text-caption text-neutral-500">{WAITING_NOTE}</p>

      {adding ? (
        <AddTask
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={async (input) => {
            const data = await call({ action: "create", ...input }, "POST");
            if (data) setAdding(false);
          }}
        />
      ) : (
        <Button type="button" variant="outline" className="w-full" onClick={() => setAdding(true)}>
          할 일 추가
        </Button>
      )}
    </div>
  );
}

function FilterTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 rounded-full border px-3 py-1 text-caption ${
        active ? "border-brand-500 text-brand-600" : "border-border text-muted-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function TaskRow({
  task,
  busy,
  onCall,
  links,
}: {
  task: AnnotatedTask;
  busy: boolean;
  onCall: (body: unknown, method: "POST" | "PATCH") => Promise<unknown>;
  /** 없으면(=서버가 못 만들었으면) 자리를 아예 그리지 않는다. 빈 카드를 남기지 않는다. */
  links: TaskLinks | null;
}) {
  const [editing, setEditing] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const done = task.status === "done";

  return (
    <div
      className="space-y-2 rounded-lg border border-border p-4"
      data-testid="checklist-task"
      data-readiness={task.readiness}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{TASK_CATEGORY_LABEL[task.category as TaskCategory] ?? task.category}</Badge>

        {/* **회색 비활성이 아니다.** 순서를 알려 주는 배지일 뿐이다(§3.2 · S7-18). */}
        {task.readiness === "waiting" ? (
          <Badge variant="outline" data-testid="checklist-waiting">
            {READINESS_LABEL.waiting}
          </Badge>
        ) : null}

        {task.completedOutOfOrder ? (
          <Badge variant="outline" data-testid="checklist-out-of-order">
            순서를 앞당겨 완료
          </Badge>
        ) : null}
      </div>

      <p className={cn("text-sm font-medium", done ? "text-muted-foreground line-through" : "text-foreground")}>
        {task.title}
      </p>

      {editing ? (
        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">기한</span>
          {/* **캘린더 형식**이다(§6.2). 날짜를 고르는 일은 달력이 가장 익숙하다. */}
          <input
            type="date"
            defaultValue={task.dueDate ?? ""}
            onChange={(event) =>
              void onCall(
                { taskId: task.id, dueDate: event.target.value === "" ? null : event.target.value },
                "PATCH",
              )
            }
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="checklist-due-date"
          />
        </label>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-caption text-muted-foreground underline-offset-2 hover:underline"
        >
          {task.dueDate === null ? "기한 미정 — 정하기" : `기한 ${task.dueDate} — 바꾸기`}
        </button>
      )}

      <div className="flex gap-2">
        {/* **완료 버튼은 waiting 에서도 살아 있다.** 잠그지 않기로 했다(§3.2). */}
        <Button
          type="button"
          size="sm"
          variant={done ? "outline" : "default"}
          disabled={busy}
          onClick={() =>
            void onCall({ taskId: task.id, status: done ? "todo" : "done" }, "PATCH")
          }
          data-testid="checklist-toggle"
        >
          {done ? "되돌리기" : "완료"}
        </Button>
      </div>

      {task.readiness === "waiting" ? (
        <p className="text-caption text-neutral-500">
          먼저 할 일 {task.blockedBy.length}건이 남아 있어요.
        </p>
      ) : null}

      {/*
        **어디서 할지** (C-4c · F-C-39 · B-1 조사 4-3).

        접어 둔 이유는 카드가 스물다섯 장이기 때문이다 — 전부 펴면 목록이 아니라
        벽이 된다. **접힘이 기본이되 있다는 사실은 늘 보인다**(버튼 문구가 그것을
        말한다). AI 고지처럼 숨기면 안 되는 것이 아니라 **탐색을 돕는 자리**다.
      */}
      {links === null ? null : (
        <div className="border-t border-border pt-2">
          <button
            type="button"
            onClick={() => setShowLinks((prev) => !prev)}
            className="text-caption font-medium text-brand-600 underline-offset-2 hover:underline"
            data-testid="task-links-toggle"
            aria-expanded={showLinks}
          >
            {showLinks ? "어디서 할지 접기" : "어디서 할지 보기"}
          </button>

          {showLinks ? <TaskLinksPanel links={links} /> : null}
        </div>
      )}
    </div>
  );
}

/**
 * 준비 항목 하나에서 나가는 세 다리 (C-4c).
 *
 * **추천이 아니라 대응이다**(D-03). 업체·상품을 고르지 않고 **카테고리 목록**으로
 * 보내며, 그 사실을 `TASK_LINK_BASIS_NOTE` 가 화면에 상시 적는다 — §2.2 가
 * 정렬 기준을 화면에 노출하라고 한 것과 같은 규칙이다.
 *
 * **없으면 빈 목록이 아니라 이유다.** 다섯 상태를 서로 다른 문장으로 말한다:
 * 파는 카테고리가 있고 상품도 있다 / 카테고리는 있는데 상품이 아직 없다 /
 * 아직 그 카테고리를 열지 않았다 / 애초에 살 것이 아니다 / 분류를 못 했다(우리 결함).
 */
function TaskLinksPanel({ links }: { links: TaskLinks }) {
  return (
    <div className="mt-2 space-y-3" data-testid="task-links">
      <p className="text-caption text-muted-foreground" data-testid="task-links-basis">
        {TASK_LINK_BASIS_NOTE}
      </p>

      {/* ── 상품·탐색 ──────────────────────────────────────────────────── */}
      <section className="space-y-1">
        <h4 className="text-caption font-medium text-foreground">상품 찾아보기</h4>

        {links.explore.kind === "categories" ? (
          <ul className="space-y-1" data-testid="task-links-explore">
            {links.explore.categories.map((item) => (
              <li key={item.code} className="flex flex-wrap items-center gap-2">
                <a
                  href={item.href}
                  className="text-caption text-brand-600 underline-offset-2 hover:underline"
                  data-testid="task-link-explore"
                >
                  {item.label} 보기
                </a>
                {/*
                  **0 을 건수로 적지 않는다.** "0개" 는 *찾아봤는데 없다* 로 읽히지만
                  실제로는 *카테고리는 열려 있는데 아직 아무도 안 올렸다* 다 —
                  카테고리 자체가 없는 것과 다른 상태이고 고객이 할 일이 다르다.
                */}
                <span className="text-caption text-muted-foreground">
                  {item.productCount === 0
                    ? "아직 등록된 상품이 없어요"
                    : `${item.productCount}개`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div data-testid="task-links-explore-none">
            <p className="text-caption font-medium text-foreground">{links.explore.title}</p>
            <p className="text-caption text-muted-foreground">{links.explore.note}</p>
          </div>
        )}
      </section>

      {/* ── 가이드 ─────────────────────────────────────────────────────── */}
      <section className="space-y-1">
        <h4 className="text-caption font-medium text-foreground">읽어 볼 것</h4>

        {links.guides.kind === "guides" ? (
          <ul className="space-y-1" data-testid="task-links-guides">
            {links.guides.guides.map((guide) => (
              <li key={guide.slug}>
                <a
                  href={guide.href}
                  className="text-caption text-brand-600 underline-offset-2 hover:underline"
                  data-testid="task-link-guide"
                >
                  {guide.title}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div data-testid="task-links-guides-none">
            <p className="text-caption font-medium text-foreground">{links.guides.title}</p>
            <p className="text-caption text-muted-foreground">{links.guides.note}</p>
          </div>
        )}
      </section>

      {/* ── 커뮤니티 ───────────────────────────────────────────────────── */}
      <section className="space-y-1">
        <h4 className="text-caption font-medium text-foreground">다른 사람은 어떻게 했을까</h4>

        {/*
          **주의 문구를 링크보다 먼저 그린다**(D-26). 커뮤니티 글은 미검증
          경험담이고, 체크리스트에서 곧장 들어가면 그 사실을 못 보고 읽는다 —
          목적지 화면에도 라벨이 있지만 **누르기 전에** 읽어야 의미가 있다.
        */}
        <p className="text-caption text-muted-foreground" data-testid="task-links-community-caution">
          {links.community.caution}
        </p>

        <a
          href={links.community.href}
          className="text-caption text-brand-600 underline-offset-2 hover:underline"
          data-testid="task-link-community"
        >
          {links.community.label}
        </a>

        <p className="text-caption text-muted-foreground">
          {links.community.postCount === 0
            ? "아직 올라온 글이 없어요"
            : `글 ${links.community.postCount}건`}
        </p>
      </section>
    </div>
  );
}

function AddTask({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (input: { category: TaskCategory; title: string; dueDate: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [category, setCategory] = useState<TaskCategory>("hall");
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");

  return (
    <section className="space-y-2 rounded-lg border border-border p-4" data-testid="checklist-add">
      <label className="block space-y-1">
        <span className="text-caption text-muted-foreground">카테고리</span>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as TaskCategory)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        >
          {TASK_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {TASK_CATEGORY_LABEL[value]}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1">
        <span className="text-caption text-muted-foreground">할 일</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={TASK_TITLE_MAX_LENGTH}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          data-testid="checklist-new-title"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-caption text-muted-foreground">기한 (비워 둘 수 있어요)</span>
        <input
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      </label>

      <div className="flex gap-2">
        <Button
          type="button"
          disabled={busy || title.trim() === ""}
          onClick={() =>
            void onSubmit({ category, title: title.trim(), dueDate: dueDate === "" ? null : dueDate })
          }
        >
          추가
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          취소
        </Button>
      </div>
    </section>
  );
}

export default ChecklistView;
