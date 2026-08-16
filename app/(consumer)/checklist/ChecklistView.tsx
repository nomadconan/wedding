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
} from "@/lib/core/schedule/graph";
import { TASK_CATEGORIES, TASK_CATEGORY_LABEL, type TaskCategory } from "@/lib/core/schedule/templates";
import { TASK_TITLE_MAX_LENGTH } from "@/lib/core/schemas/task";
import { cn } from "@/lib/utils";

/**
 * /checklist — 일정·체크리스트 (F-C-04 · 명세서 §6.2)
 *
 * ── 이 화면이 하는 일과 하지 않는 일 ────────────────────────────────────────
 * **한다** — 목록·추가·기한 변경·완료·담당자·카테고리 필터.
 * **하지 않는다** — 표현 넷(역산 타임라인 · 진행 게이지 · 다음 할 일 카드 · 의존 관계
 * 뷰)의 **토글**과 선행 관계 편집. 그것은 **S7-19**(F-C-37)다. 이 태스크가 표현을
 * 늘리면 "S7-08 완료" 가 두 가지를 뜻하게 된다.
 *
 * ── 등록·기한 변경은 캘린더 형식이다 ────────────────────────────────────────
 * §6.2 가 정한 전제다. 날짜를 고르는 일은 달력이 가장 익숙하며, **바꾸는 것은
 * 표현이지 입력이 아니다** — 그래서 입력은 `<input type="date">` 하나로 두고 표현을
 * 다양하게 만드는 일은 S7-19 에 남긴다.
 *
 * ── `waiting` 을 회색으로 칠하지 않는다 ─────────────────────────────────────
 * 회색 비활성은 '못 한다' 로 읽히는데 **잠긴 것이 아니다**(§3.2 · S7-18). 순서를
 * 알려 주는 배지로만 쓰고 완료 버튼은 그대로 살아 있다 — 화면이 잠그지 않기로 한
 * 결정을 시각적으로 뒤집으면 안 된다.
 */
export function ChecklistView({
  initialTasks,
  hasWeddingDate,
  generated,
}: {
  initialTasks: AnnotatedTask[];
  hasWeddingDate: boolean;
  /** 이미 자동 생성한 적이 있는가. 버튼 문구가 달라진다. */
  generated: boolean;
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
        <Button type="button" size="sm" disabled={busy} onClick={() => void generate()}>
          {busy ? "만드는 중…" : generated ? "빠진 것만 채우기" : "일정 만들기"}
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

      {tasks.length === 0 ? (
        <EmptyState
          title="할 일이 없어요"
          description="위에서 일정을 만들거나 직접 추가해 보세요."
        />
      ) : (
        <ul className="space-y-2" data-testid="checklist-tasks">
          {tasks.map((task) => (
            <li key={task.id}>
              <TaskRow task={task} busy={busy} onCall={call} />
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
}: {
  task: AnnotatedTask;
  busy: boolean;
  onCall: (body: unknown, method: "POST" | "PATCH") => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
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
