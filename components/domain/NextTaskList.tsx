import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type { AnnotatedTask } from "@/lib/core/schedule/graph";
import { readinessBadge } from "@/lib/core/schedule/view";
import { TASK_CATEGORY_LABEL, type TaskCategory } from "@/lib/core/schedule/templates";
import { cn } from "@/lib/utils";

/**
 * 다음 할 일 카드 (S7-19 · 명세서 §6.2 · F-C-37 표현 C)
 *
 * ── 왜 컴포넌트로 꺼냈는가 ─────────────────────────────────────────────────
 * §6.2 는 **"C 다음 할 일 카드는 홈과 같은 컴포넌트를 쓴다"** 고 적었다. S7-08 은
 * 고르는 **함수**를 하나로 만들었고(`nextTasks`) 그리는 **마크업**은 홈에만 있었다 —
 * `/checklist` 에 표현 C 를 만들면서 그것을 베끼면 **두 벌이 되고 한쪽만 고치는 날이
 * 온다.** 그래서 이번에 마크업까지 한 벌로 옮겼다.
 *
 * ── `waiting` 이 여기 오지 않는 이유 ───────────────────────────────────────
 * `nextTasks` 가 `ready` 만 고른다 — 먼저 할 일이 있는 태스크를 '다음 할 일' 로
 * 올리면 **그 카드가 순서를 뒤집는다.** 그래도 배지는 `readinessBadge` 를 쓴다:
 * 고르는 규칙이 바뀌어 `waiting` 이 들어오는 날에도 **회색으로 칠하지 않기 위해서**다
 * (§3.2 · D-71 — 순서 표시이지 잠금이 아니다).
 *
 * 서버 컴포넌트다. 상태가 없고 링크만 갖는다.
 */
export function NextTaskList({
  tasks,
  href = "/checklist",
  emptyHint,
  testId = "next-task-list",
}: {
  tasks: readonly AnnotatedTask[];
  /** 카드를 눌렀을 때 갈 곳. 홈은 `/checklist`, 체크리스트는 자기 자신이라 링크가 없다. */
  href?: string | null;
  emptyHint?: React.ReactNode;
  testId?: string;
}) {
  if (tasks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid={`${testId}-empty`}>
        {emptyHint ?? "지금 할 수 있는 일이 없어요."}
      </p>
    );
  }

  return (
    <ul className="space-y-2" data-testid={testId}>
      {tasks.map((task) => (
        <li key={task.id}>
          <NextTaskCard task={task} href={href} />
        </li>
      ))}
    </ul>
  );
}

function NextTaskCard({ task, href }: { task: AnnotatedTask; href: string | null }) {
  const badge = readinessBadge(task.readiness);

  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">
          {TASK_CATEGORY_LABEL[task.category as TaskCategory] ?? task.category}
        </Badge>
        {/* **흐리게 칠할지를 화면이 정하지 않는다**(`readinessBadge`). 규칙이 한 곳에 있다. */}
        <Badge variant={badge.variant} className={cn(badge.dimmed && "opacity-70")}>
          {badge.label}
        </Badge>
      </div>

      <p className="text-sm font-medium text-foreground">{task.title}</p>
      <p className="text-caption text-muted-foreground">
        {task.dueDate === null ? "기한 미정" : `기한 ${task.dueDate}`}
      </p>
    </>
  );

  const className = "block space-y-1 rounded-lg border border-border p-4";

  if (href === null) {
    return (
      <div className={className} data-testid="next-task">
        {body}
      </div>
    );
  }

  return (
    <Link href={href} className={className} data-testid="next-task">
      {body}
    </Link>
  );
}

export default NextTaskList;
