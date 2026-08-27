import type { FunnelStep } from "@/lib/core/metrics/admin";
import { METRIC_STATUS_LABEL, isMeasured } from "@/lib/core/stats/metric";

/**
 * 단계별 전환 퍼널 (S8-01 · F-A-07 · §6.4 "단계별 전환 퍼널")
 *
 * **차트 라이브러리를 넣지 않는다.** `docs/DESIGN.md` §5 가 차트 색을 범위 밖으로 두었고,
 * S2-08(F-V-12 업체 퍼널)이 이미 CSS 막대로 같은 일을 하고 있다. 여기서 라이브러리를
 * 들이면 같은 그림이 두 가지 방식으로 그려지고, 색 팔레트도 두 벌이 된다.
 *
 * **막대 길이는 첫 단계 대비**다. 직전 단계 대비로 그리면 모든 막대가 비슷해져
 * 어디서 사람이 빠지는지가 보이지 않는다 — 퍼널을 그리는 이유가 사라진다.
 * 잔존율(직전 대비)은 숫자로 따로 적는다.
 */
export type FunnelBarsProps = {
  steps: FunnelStep[];
};

export function FunnelBars({ steps }: FunnelBarsProps) {
  const head = steps[0];
  const headValue = head && isMeasured(head.count) ? head.count.value : 0;

  return (
    <ol className="space-y-3" data-testid="admin-funnel">
      {steps.map((step) => {
        const value = isMeasured(step.count) ? step.count.value : 0;
        // 첫 단계가 0이면 비율을 만들 수 없다. 막대를 0으로 그리는 대신 그리지 않는다.
        const widthPercent = headValue > 0 ? Math.min(100, (value * 100) / headValue) : 0;

        return (
          <li key={step.key} data-testid="funnel-step" data-step={step.key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-foreground">{step.label}</span>
              <span className="flex items-baseline gap-1">
                <span data-amount="" className="text-amount-sm text-foreground">
                  {value.toLocaleString("en-US")}
                </span>
                <span className="text-unit text-muted-foreground">건</span>
              </span>
            </div>

            <div
              className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${step.label} ${value}건`}
            >
              {headValue > 0 ? (
                <div className="h-full rounded-full bg-brand-500" style={{ width: `${widthPercent}%` }} />
              ) : null}
            </div>

            <p className="mt-1 text-caption text-muted-foreground">
              {step.basis}
              {step.vsPreviousBp
                ? isMeasured(step.vsPreviousBp)
                  ? ` · 직전 단계 대비 ${Math.round(step.vsPreviousBp.value / 100)}%`
                  : ` · 직전 단계 대비 ${METRIC_STATUS_LABEL[step.vsPreviousBp.status]}`
                : null}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

export default FunnelBars;
