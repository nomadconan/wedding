import { formatKrw } from "@/components/domain/PriceDisplay";
import type { PriceIndexRow } from "@/lib/pricing/price-index-query";

/**
 * 가격 분포 막대 (F-C-09, §6.1 `/prices/[region]/[category]`)
 *
 * **차트 라이브러리를 쓰지 않는다.** p25~p75 구간과 중앙값 하나를 그리는 데 의존성을
 * 더할 이유가 없다 — S2-08 에서 CSS 막대로 처리한 방식과 같다.
 *
 * 막대는 **p25 를 왼쪽 끝, p75 를 오른쪽 끝**으로 두고 그 사이에서 중앙값 위치를
 * 표시한다. 축이 0원에서 시작하지 않으므로 "막대 길이 = 금액" 으로 읽히지 않게
 * 세 금액을 모두 숫자로 함께 적는다. 그래프가 말을 대신하지 않는다.
 */
export function PriceDistribution({ index }: { index: PriceIndexRow }) {
  const { p25, p50, p75 } = index;

  if (p25 === null || p50 === null || p75 === null) return null;

  const span = p75 - p25;
  // 세 값이 모두 같으면(모두 같은 금액) 중앙값을 한가운데 둔다.
  const medianPercent = span === 0 ? 50 : Math.round(((p50 - p25) * 100) / span);

  return (
    <div className="space-y-3" data-testid="price-distribution">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-unit text-muted-foreground">중앙값</span>
        <span className="flex items-baseline gap-1">
          <span data-amount="" className="text-amount text-foreground">
            {formatKrw(p50)}
          </span>
          <span className="text-base text-muted-foreground">원</span>
        </span>
      </div>

      {/* 구간 막대. 0원이 아니라 p25 에서 시작한다는 사실을 아래 숫자가 밝힌다. */}
      <div className="space-y-1">
        <div className="relative h-2 rounded-full bg-secondary" aria-hidden="true">
          <div
            className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded bg-brand-600"
            style={{ left: `${medianPercent}%` }}
          />
        </div>

        <div className="flex justify-between text-caption text-muted-foreground">
          <span data-amount="">하위 25% · {formatKrw(p25)}원</span>
          <span data-amount="">상위 25% · {formatKrw(p75)}원</span>
        </div>
      </div>

      <p className="text-caption text-muted-foreground">
        표본의 절반은 {formatKrw(p25)}원 ~ {formatKrw(p75)}원 사이에 있어요.
      </p>
    </div>
  );
}

export default PriceDistribution;
