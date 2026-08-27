import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { METRIC_STATUS_LABEL, isMeasured, type MetricValue } from "@/lib/core/stats/metric";
import { cn } from "@/lib/utils";

/**
 * 지표 타일 (S2-08 · F-V-12)
 *
 * **측정된 값과 아직 못 세는 값을 다르게 그린다.**
 * 아직 못 세는 지표를 0으로 적으면 업체는 "0건 왔다"로 읽는다. 실제로는 셀 수단이
 * 없는 것이고, 그 둘은 업체가 내릴 판단이 완전히 다르다
 * (S2-04 의 '추가금 없음' vs '미등록' 과 같은 원칙).
 *
 * 그래서 미측정은 **숫자 자리에 숫자를 넣지 않고** 왜 없는지와 언제 채워지는지를 적는다.
 *
 * 차트 라이브러리를 쓰지 않는다. `docs/DESIGN.md` §5 가 차트 색을 범위 밖으로 두었고,
 * 지금 필요한 것은 **숫자와 한 줄 막대**뿐이라 기존 토큰으로 충분하다.
 */
export type MetricTileProps = {
  label: string;
  metric: MetricValue<number>;
  /** 값 뒤에 붙는 단위. '건', '%' 등. */
  unit?: string;
  /** 값 아래 보조 설명. */
  hint?: string;
  /** 0~10000 bp 를 막대로 그린다. 값이 비율일 때만 넘긴다. */
  asBar?: boolean;
  action?: ReactNode;
  className?: string;
};

export function MetricTile({
  label,
  metric,
  unit,
  hint,
  asBar = false,
  action,
  className,
}: MetricTileProps) {
  return (
    <div
      className={cn("rounded-lg border border-border p-4", className)}
      data-testid="metric-tile"
      data-status={metric.status}
    >
      <p className="text-unit text-muted-foreground">{label}</p>

      {isMeasured(metric) ? (
        <>
          <p className="mt-1 flex items-baseline gap-1">
            <span data-amount="" className="text-amount-sm text-foreground">
              {asBar ? Math.round(metric.value / 100) : metric.value.toLocaleString("en-US")}
            </span>
            {unit ? <span className="text-unit text-muted-foreground">{unit}</span> : null}
          </p>

          {asBar ? (
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${label} ${Math.round(metric.value / 100)}퍼센트`}
            >
              <div
                className="h-full rounded-full bg-brand-500"
                style={{ width: `${Math.min(100, Math.max(0, metric.value / 100))}%` }}
              />
            </div>
          ) : null}

          {hint ? <p className="mt-1 text-caption text-muted-foreground">{hint}</p> : null}
        </>
      ) : (
        <div className="mt-1 space-y-1">
          {/*
            숫자 자리에 숫자를 넣지 않는다. 네 가지 '숫자 아님' 은 **서로 다른 사실**이라
            배지 문구도 다르다 — 하나로 뭉치면 "권한이 없다" 와 "기준이 미결이다" 가
            같은 얼굴이 되고, 운영자는 고칠 수 있는 것과 없는 것을 구분하지 못한다.
          */}
          <Badge
            variant={
              // 손댈 수 없는 것(권한·미결 이슈)과 아직 안 온 것(기능·모수)을 가른다.
              metric.status === "restricted" || metric.status === "undecided"
                ? "outline"
                : "secondary"
            }
          >
            {METRIC_STATUS_LABEL[metric.status]}
          </Badge>
          <p className="text-caption text-muted-foreground">{metric.reason}</p>
          {metric.status === "not_yet" ? (
            <p className="text-caption text-muted-foreground">
              연결 예정 · <span className="font-medium">{metric.filledBy}</span>
            </p>
          ) : null}
          {metric.status === "undecided" ? (
            <p className="text-caption text-muted-foreground">
              미결 이슈 · <span className="font-medium">{metric.openIssue}</span> — 값이 정해지면
              그대로 계산됩니다.
            </p>
          ) : null}
          {metric.status === "no_basis" ? (
            <p className="text-caption text-muted-foreground">
              분모 · <span className="font-medium">{metric.basisLabel}</span>
            </p>
          ) : null}
        </div>
      )}

      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export default MetricTile;
