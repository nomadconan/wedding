"use client";

import { useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  COMMISSION_SCOPES,
  NO_RATE_BODY,
  NO_RATE_TITLE,
  NO_RETROACTIVE_NOTICE,
  PLANNER_SCOPES,
  RATE_STATE_LABEL,
  VOID_NOT_RETROACTIVE_NOTICE,
  RATE_VALUE_UNDECIDED_NOTICE,
  SCOPE_LABEL,
  SCOPE_PRIORITY_NOTICE,
  formatRateBp,
  type RateType,
} from "@/lib/core/pricing/rate-admin";
import type { RateListRow } from "@/lib/rates/admin";
import { cn } from "@/lib/utils";

/**
 * 요율 관리 (S5-03 · F-A-15 · §6.4 · D-16 · O-02)
 *
 * ── 이 화면이 존재하는 이유를 화면이 말한다 ────────────────────────────────
 * 명세는 F-A-15 를 **"개발 블로커 해제 장치"** 라고 적었다 — 요율 **값**이 미확정이어도
 * (O-02) 넣는 자리가 있으면 거래·정산이 값에 묶이지 않는다. 그래서 목록이 비었을 때
 * "고장" 이 아니라 **"아직 안 넣은 값"** 으로 안내한다(S5-07 이 정산 '설정 대기' 에서
 * 세운 표현 규칙과 같다).
 *
 * ── 소급되지 않는다는 사실을 저장 옆에 둔다 (D-16) ─────────────────────────
 * 운영자가 "요율을 내렸으니 지난 정산도 줄겠지" 라고 기대하면, 어긋났을 때 장애로
 * 신고된다. 기대를 미리 맞춘다.
 *
 * ── 값의 범위를 강제하지 않는다 (O-02) ──────────────────────────────────────
 * 입력은 0~10000bp 만 막는다(그 밖은 입력 사고). "5~8%" 같은 업무 범위를 화면이
 * 강제하면 코드가 미결정을 앞질러 답한다.
 */
export type RatesData = { rates: RateListRow[] };

export function RatesPanel({ rates }: RatesData) {
  const [type, setType] = useState<RateType>("commission");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [simulation, setSimulation] = useState<string | null>(null);

  const rows = rates.filter((row) => row.type === type);

  async function post(path: string, body: unknown, method = "POST") {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (payload.ok) {
        window.location.reload();

        return;
      }

      setError(payload.error?.message ?? "처리하지 못했어요.");
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  /** 지금 실제로 적용될 수 있는 요율. 무효화된 행은 해석에서 빠진다(FIX-12). */
  const liveRows = rows.filter((row) => row.state !== "voided");

  return (
    <div className="space-y-5">
      <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-brand-700">
        {RATE_VALUE_UNDECIDED_NOTICE}
      </p>

      <div className="flex gap-2">
        {(["commission", "planner"] as RateType[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setType(value)}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-sm",
              type === value
                ? "border-brand-500 bg-brand-50 text-brand-700"
                : "border-border text-neutral-700",
            )}
          >
            {value === "commission" ? "업체 수수료" : "플래너 수수료"}
          </button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="rounded-lg border border-danger bg-danger-surface px-3 py-2 text-sm text-danger-foreground">
          {error}
        </p>
      ) : null}

      <CreateForm type={type} busy={busy} onSubmit={(draft) => post("/api/admin/commission-rates", draft)} />

      <Simulator type={type} onResult={setSimulation} result={simulation} />

      {/* **'행이 없다' 가 아니라 '살아 있는 요율이 없다' 를 본다**(FIX-11).
          무효화된 행만 남아 있으면 목록은 비어 있지 않은데 계약은 계속 막힌다 —
          FIX-12 가 무효화를 열면서 생긴 자리다. 화면이 그 상태를 말하지 않으면
          운영자는 표에 줄이 보이니 요율이 있다고 읽는다. */}
      {liveRows.length === 0 ? (
        <EmptyState
          title={NO_RATE_TITLE}
          description={
            rows.length === 0
              ? NO_RATE_BODY
              : `${NO_RATE_BODY} 지금 목록에 보이는 ${rows.length}건은 모두 무효화된 이력이라 적용되지 않습니다.`
          }
        />
      ) : null}

      {rows.length === 0 ? null : (
        <section className="rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground">요율 이력</h2>
          <p className="mt-1 text-xs text-neutral-600">{SCOPE_PRIORITY_NOTICE}</p>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-xs">
              <thead>
                <tr className="border-b border-border text-left text-neutral-500">
                  <th className="py-1.5 pr-2 font-medium">범위</th>
                  <th className="py-1.5 pr-2 font-medium">대상</th>
                  <th className="py-1.5 pr-2 text-right font-medium">요율</th>
                  <th className="py-1.5 pr-2 font-medium">기간</th>
                  <th className="py-1.5 pr-2 font-medium">상태</th>
                  <th className="py-1.5 font-medium"> </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="py-1.5 pr-2">{SCOPE_LABEL[row.scopeType]}</td>
                    <td className="py-1.5 pr-2 text-neutral-600">
                      {row.scopeLabel ?? row.scopeKey ?? "—"}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums font-medium">
                      {formatRateBp(row.feeRateBp)}
                    </td>
                    <td className="py-1.5 pr-2 text-neutral-600">
                      {row.effectiveFrom.slice(0, 10)} ~ {row.effectiveTo?.slice(0, 10) ?? "무기한"}
                    </td>
                    <td className="py-1.5 pr-2">
                      {/* **무효는 종료와 다른 색이다**(FIX-12). 둘을 같은 회색으로 그리면
                          "여기까지 적용했다" 와 "없던 것으로 친다" 가 한 낱말로 읽힌다. */}
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5",
                          row.state === "active"
                            ? "bg-success-surface text-success-foreground"
                            : row.state === "voided"
                              ? "bg-danger-surface text-danger"
                              : "bg-neutral-100 text-neutral-600",
                        )}
                      >
                        {RATE_STATE_LABEL[row.state]}
                      </span>
                      {row.voidReason ? (
                        <span className="ml-1 text-neutral-500">{row.voidReason}</span>
                      ) : null}
                    </td>
                    <td className="space-x-1 py-1.5 text-right">
                      {row.state === "voided" ? null : (
                        <>
                          {row.effectiveTo === null ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                post(
                                  "/api/admin/commission-rates",
                                  { type: row.type, rateId: row.id, endAt: new Date().toISOString() },
                                  "PATCH",
                                )
                              }
                            >
                              종료
                            </Button>
                          ) : null}
                          {/* **무효화는 사유를 받고서야 보낸다**(FIX-12). 사유 없는 무효화는
                              DB 도 거부하지만(`*_void_pair`) 여기서 먼저 물어야 운영자가
                              422 를 보고 되돌아오지 않는다. */}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => {
                              const reason = window.prompt(
                                `이 요율을 무효화합니다.\n\n${VOID_NOT_RETROACTIVE_NOTICE}\n\n무효화 사유를 적어 주세요.`,
                                "",
                              );

                              // 취소(null)와 빈 사유를 나눠 다룬다 — 취소는 아무 일도
                              // 일어나지 않아야 하고, 빈 사유는 서버가 거절할 요청이다.
                              if (reason === null) return;

                              void post("/api/admin/commission-rates/void", {
                                type: row.type,
                                rateId: row.id,
                                reason,
                              });
                            }}
                          >
                            무효화
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 요율 행은 지우지 않는다 — 지우면 "그때 어떤 요율표였나" 를 재현할 수 없다. */}
          <p className="mt-3 text-xs text-neutral-500">
            요율은 삭제하지 않고 <strong>종료</strong>하거나 <strong>무효화</strong>합니다. 지난 정산의
            근거가 남아야 하기 때문이에요. 종료는 “여기까지 적용했다”이고, 무효화는 “이 줄은 없던
            것으로 친다”입니다 — 잘못 넣은 값은 종료로는 되돌릴 수 없어요(그 구간에는 그대로
            적용됐기 때문입니다).
          </p>
          {/* **무효화가 못 하는 일을 같은 자리에 적는다**(FIX-12). 이 문장이 없으면
              "무효화했는데 왜 지난 정산이 그대로냐" 가 장애로 신고된다. */}
          <p className="mt-1 text-xs text-neutral-500">{VOID_NOT_RETROACTIVE_NOTICE}</p>
        </section>
      )}
    </div>
  );
}

function CreateForm({
  type,
  busy,
  onSubmit,
}: {
  type: RateType;
  busy: boolean;
  onSubmit: (draft: Record<string, unknown>) => void;
}) {
  const scopes = type === "commission" ? COMMISSION_SCOPES : PLANNER_SCOPES;
  const [scopeType, setScopeType] = useState<string>("global");
  const [scopeKey, setScopeKey] = useState("");
  const [percent, setPercent] = useState("");
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));

  // 화면은 퍼센트로 받고 **저장은 bp 정수**다. 부동소수점을 넘기지 않는다(§6).
  const feeRateBp = Math.round(Number(percent) * 100);
  const valid = percent !== "" && Number.isInteger(feeRateBp) && feeRateBp >= 0 && feeRateBp <= 10_000;

  return (
    <section className="rounded-xl border border-border p-4">
      <h2 className="text-sm font-semibold text-foreground">새 요율</h2>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-neutral-700">
          범위
          <select
            value={scopeType}
            onChange={(event) => setScopeType(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            {scopes.map((scope) => (
              <option key={scope} value={scope}>
                {SCOPE_LABEL[scope]}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs text-neutral-700">
          대상 {scopeType === "global" ? "(전역은 비움)" : ""}
          <Input
            value={scopeKey}
            disabled={scopeType === "global"}
            onChange={(event) => setScopeKey(event.target.value)}
            placeholder={scopeType === "category" ? "hall" : "업체·플래너 식별자"}
            className="mt-1"
          />
        </label>

        <label className="text-xs text-neutral-700">
          요율 (%)
          <Input
            value={percent}
            inputMode="decimal"
            onChange={(event) => setPercent(event.target.value)}
            placeholder="예: 5.5"
            className="mt-1"
          />
          <span className="mt-1 block text-neutral-500">
            {valid ? `${feeRateBp}bp 로 저장돼요.` : "0~100 사이 값을 적어 주세요."}
          </span>
        </label>

        <label className="text-xs text-neutral-700">
          시작일
          <Input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="mt-1"
          />
        </label>
      </div>

      {/* D-16 — 소급되지 않는다는 사실을 저장 버튼 옆에 둔다. */}
      <p className="mt-3 text-xs text-neutral-600">{NO_RETROACTIVE_NOTICE}</p>

      <Button
        size="sm"
        className="mt-3"
        disabled={busy || !valid || (scopeType !== "global" && scopeKey.trim() === "")}
        onClick={() =>
          onSubmit({
            type,
            scopeType,
            scopeKey: scopeType === "global" ? null : scopeKey.trim(),
            feeRateBp,
            effectiveFrom: new Date(`${from}T00:00:00.000Z`).toISOString(),
            effectiveTo: null,
          })
        }
      >
        {busy ? "저장 중…" : "요율 추가"}
      </Button>
    </section>
  );
}

/** "이 시점 이 업체에 무엇이 적용되나" — 목록만 보고 사람이 계산하면 틀린다. */
function Simulator({
  type,
  onResult,
  result,
}: {
  type: RateType;
  onResult: (value: string | null) => void;
  result: string | null;
}) {
  const [target, setTarget] = useState("");
  const [category, setCategory] = useState("");
  const [at, setAt] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    onResult(null);

    const params = new URLSearchParams({ type, at: new Date(`${at}T00:00:00.000Z`).toISOString() });
    if (target.trim()) params.set(type === "commission" ? "vendor" : "planner", target.trim());
    if (category.trim()) params.set("category", category.trim());

    try {
      const response = await fetch(`/api/admin/commission-rates/resolve?${params.toString()}`);
      const payload = (await response.json()) as {
        ok: boolean;
        data?: {
          resolved: { feeRateBp: number; scopeType: string; reason: string } | null;
          detail?: string;
          notice?: string | null;
        };
      };

      const data = payload.data;

      onResult(
        data?.resolved
          ? `${formatRateBp(data.resolved.feeRateBp)} · ${data.resolved.reason}`
          : (data?.notice ?? data?.detail ?? "적용되는 요율이 없어요."),
      );
    } catch {
      onResult("조회하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border p-4">
      <h2 className="text-sm font-semibold text-foreground">적용 요율 확인</h2>
      <p className="mt-1 text-xs text-neutral-600">
        특정 시점·대상에 실제로 적용되는 요율을 계약 발행과 <strong>같은 규칙</strong>으로 조회합니다.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder={type === "commission" ? "업체 식별자" : "플래너 식별자"}
        />
        <Input
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          placeholder="카테고리 (hall 등)"
        />
        <Input type="date" value={at} onChange={(event) => setAt(event.target.value)} />
      </div>

      <Button size="sm" variant="outline" className="mt-3" disabled={busy} onClick={run}>
        {busy ? "조회 중…" : "조회"}
      </Button>

      {result ? (
        <p className="mt-3 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-700">{result}</p>
      ) : null}
    </section>
  );
}
