import type { DonutSegment } from "@/lib/core/budget/budget";

/**
 * 예산 배분 도넛 (S7-07 · 명세서 §6.2 `/budget`)
 *
 * ── 색을 만들지 않았다 ──────────────────────────────────────────────────────
 * DESIGN.md 의 팔레트는 **브랜드 한 색 + 무채색 스케일 + 시맨틱 3종**이다. 예산
 * 카테고리는 14종이라 색으로 가르려면 색을 새로 만들어야 하고, 만들어도 **375px 에서
 * 14조각은 범례 없이 못 읽는다.**
 *
 * 그래서 조각을 **상위 5개 + '기타' + '미배정'** 으로 접고(`donutSegments`) 브랜드
 * 명도 세 단계와 무채색 두 단계만 쓴다 — 전부 이미 있는 토큰이다. 접힌 것은
 * 사라지지 않는다: 아래 카테고리 목록이 전부를 금액과 함께 보인다. **도넛은 큰
 * 그림이고 목록이 사실이다.**
 *
 * ── 원이 닫힌다 ────────────────────────────────────────────────────────────
 * 조각 비율은 **basis point 정수이고 합이 정확히 10000** 이다(`sharesBp` · 최대잉여법).
 * 반올림을 그냥 두면 합이 99.9% 가 되어 원 끝에 틈이 남는다.
 *
 * 서버 컴포넌트다. 인라인 SVG 하나이며 새 의존성이 없다.
 */

/** 조각 색. **전부 기존 토큰**이며 순서가 곧 명도 단계다. */
const SEGMENT_TONE = [
  "hsl(var(--brand-600))",
  "hsl(var(--brand-500))",
  "hsl(var(--brand-200))",
  "hsl(var(--brand-100))",
  "hsl(var(--brand-50))",
] as const;

const MUTED_TONE = ["hsl(var(--neutral-400))", "hsl(var(--neutral-200))"] as const;

const RADIUS = 60;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function BudgetDonut({
  segments,
  emptyLabel = "아직 배분한 금액이 없어요",
}: {
  segments: readonly DonutSegment[];
  emptyLabel?: string;
}) {
  if (segments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="budget-donut-empty">
        {emptyLabel}
      </p>
    );
  }

  let offsetBp = 0;
  let colored = 0;
  let muted = 0;

  const drawn = segments.map((segment) => {
    const tone = segment.muted
      ? MUTED_TONE[Math.min(muted++, MUTED_TONE.length - 1)]
      : SEGMENT_TONE[Math.min(colored++, SEGMENT_TONE.length - 1)];

    const start = offsetBp;
    offsetBp += segment.shareBp;

    return { ...segment, tone, start };
  });

  return (
    <div className="flex flex-col items-center gap-3" data-testid="budget-donut">
      <svg
        viewBox="0 0 160 160"
        className="h-40 w-40 -rotate-90"
        role="img"
        aria-label="카테고리별 예산 배분"
      >
        {/* 바닥 원. 조각이 없는 구간이 빈칸으로 보이지 않게 한다. */}
        <circle cx="80" cy="80" r={RADIUS} fill="none" strokeWidth="20" stroke="hsl(var(--neutral-100))" />

        {drawn.map((segment) => (
          <circle
            key={segment.key}
            cx="80"
            cy="80"
            r={RADIUS}
            fill="none"
            strokeWidth="20"
            stroke={segment.tone}
            strokeDasharray={`${(CIRCUMFERENCE * segment.shareBp) / 10_000} ${CIRCUMFERENCE}`}
            strokeDashoffset={-((CIRCUMFERENCE * segment.start) / 10_000)}
            data-testid="budget-donut-segment"
            data-key={segment.key}
          />
        ))}
      </svg>

      <ul className="w-full space-y-1" data-testid="budget-donut-legend">
        {drawn.map((segment) => (
          <li key={segment.key} className="flex items-center gap-2 text-caption">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: segment.tone }}
            />
            <span className="flex-1 text-foreground">{segment.label}</span>
            {/* bp 정수를 그대로 나눠 적는다 — 화면이 비율을 다시 계산하지 않는다. */}
            <span className="text-muted-foreground">{(segment.shareBp / 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default BudgetDonut;
