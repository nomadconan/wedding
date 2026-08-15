import { ArrowUpDown } from "lucide-react";

import type { ToolCard } from "@/lib/core/ai/conversation";
import { NO_PAID_RANKING_SHORT } from "@/lib/core/legal";
import { cn } from "@/lib/utils";

/**
 * 툴 결과 카드 (S7-06 · 명세서 §6.2 "툴 결과 카드")
 *
 * **카드 안의 글자는 전부 툴이 돌려준 값이거나 코드가 가진 문구다.** 모델이 쓴 문장은
 * 카드 밖 본문에만 있다 — 한 상자 안에 섞으면 "조회한 값" 과 "그 값에 대해 모델이 한
 * 말" 을 사용자가 구분할 수 없다.
 *
 * **순서를 정한 카드에는 기준 배지가 붙는다**(D-25 · §2.2). 광고·제휴 없는 구조를
 * 화면으로 증명하는 자리이고, 대화도 화면이다.
 */
export function ToolResultCard({ card }: { card: ToolCard }) {
  return (
    <section
      data-testid="planner-tool-card"
      data-tool={card.tool}
      data-status={card.status}
      className="rounded-lg border border-border bg-background p-3"
    >
      <h3 className="text-sm font-semibold text-foreground">{card.title}</h3>

      {/* 라벨을 그대로 그린다 — 코드로 사전을 찾으면 업체·플래너 두 어휘를 위해
          사전을 한 벌 더 만들게 된다(`/planners` 와 같은 방식). */}
      {card.rankingLabel ? (
        <div
          className="mt-1 flex flex-wrap items-center gap-1.5"
          data-testid="planner-card-ranking"
          data-code={card.rankingCode ?? undefined}
        >
          <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-caption font-medium text-secondary-foreground">
            <ArrowUpDown aria-hidden="true" className="h-3 w-3" />
            정렬 기준 · {card.rankingLabel}
          </span>
          <span className="inline-flex items-center rounded-md bg-brand-50 px-2 py-1 text-caption font-medium text-brand-700">
            {NO_PAID_RANKING_SHORT}
          </span>
        </div>
      ) : null}

      {card.rows.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {card.rows.map((row, index) => (
            <li
              key={`${row.label}-${index}`}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="min-w-0 truncate text-muted-foreground">{row.label}</span>
              <span className="shrink-0 font-medium text-foreground">{row.value}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {card.notice ? (
        <p
          className={cn(
            "mt-2 text-caption",
            card.status === "unavailable" ? "text-warning" : "text-muted-foreground",
          )}
        >
          {card.notice}
        </p>
      ) : null}

      {card.nextAction ? (
        <p className="mt-1 text-caption text-muted-foreground">다음: {card.nextAction}</p>
      ) : null}
    </section>
  );
}

export default ToolResultCard;
