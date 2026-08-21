"use client";

import { useEffect, useState } from "react";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  COMPARE_INTRO,
  COMPARE_MAX,
  COMPARE_MIN,
  ESTIMATE_FLAG_LABEL,
  LOWEST_REASON_NOTE,
  NO_UPLOAD_NOTE,
  type EstimateComparison,
  type EstimateFlag,
  type NormalizedEstimate,
} from "@/lib/core/estimate/normalize";
import { cn } from "@/lib/utils";

/**
 * /estimates — 견적 비교 (F-C-06 · 명세서 §6.2 · §5.4)
 *
 * ── 업로드 슬롯이 없다 ─────────────────────────────────────────────────────
 * §6.2 는 "업로드 슬롯" 을 적었지만 이 제품에 **자유 양식 견적이 존재하지 않는다** —
 * 업체는 표준 폼으로만 응답한다(F-V-07). 업로드는 §5.4 1단계의 LLM 파싱을 전제하는데
 * **PDF 파서·OCR 은 새 의존성**이라 열려 있지 않다(D-56). **빈 슬롯을 그려 두지
 * 않고** 그 사실을 문장으로 적는다 — 누를 수 있는데 아무 일도 안 일어나는 자리가
 * 가장 나쁘다.
 *
 * ── 사과와 오렌지를 나란히 두지 않는다 ──────────────────────────────────────
 * 카테고리가 섞이면 **총액 우열을 정하지 않고 사유를 적는다**(D-77 과 같은 규칙).
 * 판정은 순수 함수가 하고 화면은 그린다.
 *
 * ── 빈 칸은 0이 아니다 ──────────────────────────────────────────────────────
 * 그 견적에 그 항목이 없으면 **'없음'** 이라고 적는다. 0원으로 그리면 "0원에 해 준다"
 * 로 읽힌다.
 */
type Candidate = {
  quoteId: string;
  vendorName: string;
  productName: string | null;
  declaredTotal: number;
  validUntil: string | null;
  sentAt: string | null;
};

type CompareResponse = {
  candidates: Candidate[];
  estimates: NormalizedEstimate[];
  comparison: EstimateComparison | null;
  noUploadNote: string;
};

export function EstimatesView({ initial }: { initial: CompareResponse }) {
  const [data, setData] = useState<CompareResponse>(initial);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const enough = picked.length >= COMPARE_MIN;

  useEffect(() => {
    if (!enough) {
      setData((current) => ({ ...current, comparison: null, estimates: [] }));
      setSavedId(null);

      return;
    }

    let alive = true;
    setBusy(true);

    void (async () => {
      try {
        const response = await fetch(`/api/estimates/compare?quoteIds=${picked.join(",")}`);
        const payload = await response.json();

        if (!alive) return;

        if (!response.ok || !payload.ok) {
          setNotice(payload.error?.message ?? "비교표를 만들지 못했어요.");

          return;
        }

        setNotice(null);
        setSavedId(null);
        setData(payload.data);
      } finally {
        if (alive) setBusy(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [picked, enough]);

  function toggle(quoteId: string) {
    setPicked((current) => {
      if (current.includes(quoteId)) return current.filter((id) => id !== quoteId);
      if (current.length >= COMPARE_MAX) {
        setNotice(`한 번에 ${COMPARE_MAX}개까지 견줄 수 있어요.`);

        return current;
      }

      return [...current, quoteId];
    });
  }

  async function save() {
    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch("/api/estimates/normalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteIds: picked }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setNotice(payload.error?.message ?? "비교표를 저장하지 못했어요.");

        return;
      }

      setSavedId(payload.data.id);
      setNotice("비교표를 남겼어요. 이제 공유 링크를 만들 수 있어요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="estimates">
      <p className="text-caption text-muted-foreground">{COMPARE_INTRO}</p>

      {/* **업로드 슬롯 대신 그 자리가 없는 이유를 적는다.** */}
      <p className="rounded-lg border border-border p-3 text-caption text-neutral-500" data-testid="estimates-no-upload">
        {data.noUploadNote ?? NO_UPLOAD_NOTE}
      </p>

      {notice ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="estimates-notice">
          {notice}
        </p>
      ) : null}

      {/* ── 받은 견적 고르기 ─────────────────────────────────────────────── */}
      <section className="space-y-2" data-testid="estimate-candidates">
        <h2 className="text-sm font-semibold text-foreground">
          받은 견적 ({picked.length}/{COMPARE_MAX} 선택)
        </h2>

        {data.candidates.length === 0 ? (
          <EmptyState
            title="아직 받은 견적이 없어요"
            description="문의를 보내면 업체가 표준 양식으로 견적을 보내 줘요. 그 견적들을 여기서 견줍니다."
          />
        ) : (
          <ul className="space-y-2">
            {data.candidates.map((candidate) => {
              const on = picked.includes(candidate.quoteId);

              return (
                <li key={candidate.quoteId}>
                  <button
                    type="button"
                    onClick={() => toggle(candidate.quoteId)}
                    aria-pressed={on}
                    data-testid="estimate-candidate"
                    data-picked={on ? "true" : "false"}
                    className={cn(
                      "block w-full rounded-lg border p-4 text-left",
                      on ? "border-brand-500" : "border-border",
                    )}
                  >
                    <p className="text-sm font-medium text-foreground">{candidate.vendorName}</p>
                    <p className="text-caption text-muted-foreground">
                      {candidate.productName ?? "상품 미정"} · {formatKrw(candidate.declaredTotal)}원
                      {candidate.validUntil === null
                        ? ""
                        : ` · ${candidate.validUntil.slice(0, 10)}까지`}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── 비교표 ───────────────────────────────────────────────────────── */}
      {!enough ? (
        <p className="text-caption text-neutral-500" data-testid="estimates-need-more">
          {LOWEST_REASON_NOTE.not_enough}
        </p>
      ) : data.comparison === null ? (
        <p className="text-caption text-muted-foreground">{busy ? "비교표를 만드는 중…" : ""}</p>
      ) : (
        <>
          <ComparisonTable comparison={data.comparison} estimates={data.estimates} />

          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={busy || savedId !== null}
            onClick={() => void save()}
            data-testid="estimates-save"
          >
            {savedId === null ? "이 비교표 남기기 (공유하려면 필요해요)" : "남겼어요"}
          </Button>
        </>
      )}
    </div>
  );
}

function ComparisonTable({
  comparison,
  estimates,
}: {
  comparison: EstimateComparison;
  estimates: NormalizedEstimate[];
}) {
  return (
    <section className="space-y-3" data-testid="estimate-comparison">
      {/* **우열을 정할 수 없으면 사유를 적는다.** */}
      {comparison.lowest.kind === "lowest" ? (
        <p className="text-sm text-success" data-testid="estimate-lowest">
          실총액이 가장 낮은 것은{" "}
          <strong>
            {comparison.columns.find((column) => column.quoteId === lowestId(comparison))?.vendorName ??
              "고른 견적"}
          </strong>
          {" — "}
          {formatKrw(comparison.lowest.amount)}원이에요.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="estimate-not-comparable">
          {LOWEST_REASON_NOTE[comparison.lowest.reason]}
        </p>
      )}

      <p className="text-caption text-neutral-500">{comparison.plannerNote}</p>

      {/* 좁은 화면에서 표가 넘치면 가로로 민다. 줄바꿈으로 뭉개지 않는다. */}
      <div className="-mx-gutter overflow-x-auto px-gutter">
        <table className="w-full min-w-[520px] border-collapse text-caption">
          <thead>
            <tr>
              <th className="border-b border-border p-2 text-left text-muted-foreground">항목</th>
              {comparison.columns.map((column) => (
                <th key={column.quoteId} className="border-b border-border p-2 text-left">
                  <span className="block text-sm font-medium text-foreground">
                    {column.vendorName}
                  </span>
                  <span className="block text-muted-foreground">
                    {column.productName ?? "상품 미정"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {comparison.rows.map((row) => (
              <tr key={row.category} data-testid="estimate-row" data-category={row.category}>
                <th className="border-b border-border p-2 text-left font-normal text-muted-foreground">
                  {row.label}
                  {/* 하나만 가진 줄 = '과다 항목'(§5.4). 판단하지 않고 짚기만 한다. */}
                  {row.onlyOne ? (
                    <Badge variant="outline" className="ml-1">
                      한 곳만
                    </Badge>
                  ) : null}
                </th>

                {row.amounts.map((amount, index) => (
                  <td
                    key={comparison.columns[index].quoteId}
                    className="border-b border-border p-2 text-foreground"
                    data-testid="estimate-cell"
                    data-missing={amount === null ? "true" : "false"}
                  >
                    {/* **빈 칸은 0이 아니다.** '0원에 해 준다' 로 읽히면 안 된다. */}
                    {amount === null ? (
                      <span className="text-neutral-500">없음</span>
                    ) : (
                      `${formatKrw(amount)}원`
                    )}
                  </td>
                ))}
              </tr>
            ))}

            <tr>
              <th className="p-2 text-left text-foreground">실총액</th>
              {comparison.columns.map((column) => (
                <td
                  key={column.quoteId}
                  className="p-2 text-sm font-semibold text-foreground"
                  data-testid="estimate-total"
                >
                  {formatKrw(column.realTotal)}원
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── 확인 필요 ─────────────────────────────────────────────────────── */}
      <ul className="space-y-2" data-testid="estimate-flags">
        {comparison.columns.map((column) => {
          const estimate = estimates.find((item) => item.quoteId === column.quoteId);

          if (column.flags.length === 0 && column.missing.length === 0) return null;

          return (
            <li
              key={column.quoteId}
              className="space-y-1 rounded-lg border border-warning/40 p-3"
              data-testid="estimate-flag-group"
            >
              <p className="text-sm font-medium text-foreground">{column.vendorName}</p>

              {column.flags.map((flag) => (
                <p key={flag.kind} className="text-caption text-warning" data-flag={flag.kind}>
                  {ESTIMATE_FLAG_LABEL[flag.kind]}
                  {flagDetail(flag)}
                </p>
              ))}

              {column.missing.length > 0 ? (
                <p className="text-caption text-warning" data-flag="missing">
                  다른 견적에 있는 항목이 여기엔 없어요 — {column.missing.length}개
                </p>
              ) : null}

              {estimate !== undefined && estimate.optionalOptionAmount > 0 ? (
                <p className="text-caption text-neutral-500">
                  고르면 최대 {formatKrw(estimate.optionalOptionAmount)}원이 더해져요.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 가장 낮은 견적의 id. 판정 자체는 순수 함수가 이미 했다. */
function lowestId(comparison: EstimateComparison): string | null {
  return comparison.lowest.kind === "lowest" ? comparison.lowest.quoteId : null;
}

function flagDetail(flag: EstimateFlag): string {
  if (flag.kind === "total_mismatch") {
    return ` — 적힌 총액 ${formatKrw(flag.declared)}원 / 항목 합 ${formatKrw(flag.computed)}원`;
  }

  if (flag.kind === "unmapped_items") return ` — ${flag.count}줄`;
  if (flag.kind === "expired") return ` — ${flag.validUntil.slice(0, 10)}`;

  return ` — ${flag.count}개 · 최대 ${formatKrw(flag.amount)}원`;
}

export default EstimatesView;
