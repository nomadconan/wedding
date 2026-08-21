"use client";

import { useState } from "react";

import { AiDisclaimer } from "@/components/domain/AiDisclaimer";
import { formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CONTRACT_TERM_HINT,
  CONTRACT_TERM_KINDS,
  CONTRACT_TERM_LABEL,
  SAVED_SIMULATION_NOTE,
  SIMULATOR_INTRO,
  comparisonOf,
  contractTermOf,
  excessSentence,
  standardZeroReason,
  type ContractTermKind,
  type PenaltyComparison,
  type RuleState,
  type SavedSimulation,
} from "@/lib/core/pricing/penalty-view";
import {
  PENALTY_CATEGORIES,
  bpToPercent,
  type PenaltyCategory,
  type PenaltyResult,
} from "@/lib/core/schemas/penalty";
import { VENDOR_CATEGORY_LABEL } from "@/lib/core/schemas/vendor";
import { cn } from "@/lib/utils";

/**
 * /tools/penalty — 위약금 시뮬레이터 (F-C-08 · 명세서 §6.2 · §5.3 · §7.7)
 *
 * ── 이 화면이 지키는 것 ─────────────────────────────────────────────────────
 *  1. **고지를 상시 노출한다.** 접거나 툴팁으로 만들지 않는다(§7.7 · CLAUDE.md §2.3).
 *     문구는 `AiDisclaimer` 가 `AI_DISCLAIMER` 단일 진실을 그대로 렌더한다.
 *  2. **기준 미설정을 '0원' 으로 말하지 않는다.** `penalty_rules` 는 일부러 시드하지
 *     않았고(0031 · S5-08) 지금 계산은 가정치다 — 그 사실을 **결과보다 먼저** 적는다.
 *  3. **평가어를 쓰지 않는다.** "과도한 조항" 은 판단이다. 우리가 말할 수 있는 것은
 *     **금액과 기준 대비 편차**뿐이며(CLAUDE.md §2.3) 문장은 `excessSentence` 가 만든다.
 *  4. **계산을 화면이 하지 않는다.** 서버가 `lib/core/pricing/penalty.ts` 를 부르고
 *     화면은 그린다 — 해지 견적(S5-08)·AI 툴(S7-20)과 **같은 엔진**이라야 같은 계약이
 *     세 자리에서 같은 금액으로 나온다.
 *
 * ── 로그인 없이도 쓴다 ──────────────────────────────────────────────────────
 * 입력이 전부 사용자에게서 오고 커플 데이터를 읽지 않는다. **저장만 로그인**이 필요하며
 * 그 사실을 버튼 자리에서 말한다 — 눌러 보고 나서야 알게 하지 않는다.
 */
type SimulateResponse = {
  result: PenaltyResult;
  ruleState: RuleState;
  comparison: PenaltyComparison;
  saved: { id: string; createdAt: string } | null;
};

const TODAY = () => new Date().toISOString().slice(0, 10);

export function PenaltyToolView({
  canSave,
  initialSaved,
}: {
  /** 로그인 + 커플이 있는가. 없으면 저장 버튼 대신 이유를 적는다. */
  canSave: boolean;
  initialSaved: SavedSimulation[];
}) {
  const [category, setCategory] = useState<PenaltyCategory>("hall");
  const [totalAmount, setTotalAmount] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [cancelDate, setCancelDate] = useState(TODAY());
  const [termKind, setTermKind] = useState<ContractTermKind>("none");
  const [ratePercent, setRatePercent] = useState("");

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [response, setResponse] = useState<SimulateResponse | null>(null);
  const [savedList, setSavedList] = useState<SavedSimulation[]>(initialSaved);
  const [copied, setCopied] = useState(false);

  const ready = totalAmount.trim() !== "" && eventDate !== "" && cancelDate !== "";

  async function simulate(save: boolean) {
    setBusy(true);
    setNotice(null);
    setCopied(false);

    try {
      const httpResponse = await fetch("/api/penalty/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          totalAmount: Math.trunc(Number(totalAmount || 0)),
          depositAmount: Math.trunc(Number(depositAmount || 0)),
          eventDate,
          cancelDate,
          contractTerm: contractTermOf({
            kind: termKind,
            ratePercent: ratePercent.trim() === "" ? null : Number(ratePercent),
          }),
          save,
        }),
      });
      const payload = await httpResponse.json();

      if (!httpResponse.ok || !payload.ok) {
        setNotice(payload.error?.message ?? "계산하지 못했어요.");

        return;
      }

      setResponse(payload.data);

      if (payload.data.saved) {
        setSavedList((current) => [
          {
            id: payload.data.saved.id,
            category,
            standardAmount: payload.data.result.standard.penalty,
            contractAmount: payload.data.result.contract.penalty,
            excessAmount: payload.data.result.excessPenalty,
            ruleVersion: payload.data.result.ruleVersion,
            createdAt: payload.data.saved.createdAt,
          },
          ...current,
        ]);
        setNotice("계산을 저장했어요.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="penalty-tool">
      <p className="text-caption text-muted-foreground">{SIMULATOR_INTRO}</p>

      {/* ── 입력 ─────────────────────────────────────────────────────────── */}
      <section className="space-y-3 rounded-lg border border-border p-4" data-testid="penalty-form">
        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">카테고리</span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as PenaltyCategory)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="penalty-category"
          >
            {PENALTY_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {VENDOR_CATEGORY_LABEL[value] ?? value}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">계약 총액 (원)</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={10000}
            value={totalAmount}
            onChange={(event) => setTotalAmount(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="penalty-total"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">계약금 (원)</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={10000}
            value={depositAmount}
            onChange={(event) => setDepositAmount(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="penalty-deposit"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">예식일</span>
          <input
            type="date"
            value={eventDate}
            onChange={(event) => setEventDate(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="penalty-event-date"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">취소 시점</span>
          <input
            type="date"
            value={cancelDate}
            onChange={(event) => setCancelDate(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="penalty-cancel-date"
          />
        </label>

        <fieldset className="space-y-1">
          <legend className="text-caption text-muted-foreground">계약서의 위약 규정</legend>
          <select
            value={termKind}
            onChange={(event) => setTermKind(event.target.value as ContractTermKind)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="penalty-term-kind"
          >
            {CONTRACT_TERM_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {CONTRACT_TERM_LABEL[kind]}
              </option>
            ))}
          </select>
          <p className="text-caption text-neutral-500">{CONTRACT_TERM_HINT[termKind]}</p>

          {termKind === "rate" ? (
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step={0.1}
              placeholder="예: 20 (총액의 20%)"
              value={ratePercent}
              onChange={(event) => setRatePercent(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              data-testid="penalty-term-rate"
            />
          ) : null}
        </fieldset>

        <Button
          type="button"
          className="w-full"
          disabled={busy || !ready}
          onClick={() => void simulate(false)}
          data-testid="penalty-submit"
        >
          {busy ? "계산 중…" : "계산하기"}
        </Button>
      </section>

      {notice ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="penalty-notice">
          {notice}
        </p>
      ) : null}

      {/* ── 결과 ─────────────────────────────────────────────────────────── */}
      {response ? (
        <ResultSection
          response={response}
          busy={busy}
          canSave={canSave}
          copied={copied}
          onCopy={async () => {
            await navigator.clipboard.writeText(response.result.objectionScript);
            setCopied(true);
          }}
          onSave={() => void simulate(true)}
        />
      ) : null}

      {/* ── 저장한 계산 ──────────────────────────────────────────────────── */}
      {savedList.length > 0 ? (
        <section className="space-y-2" data-testid="penalty-saved">
          <h2 className="text-sm font-semibold text-foreground">저장한 계산</h2>
          <p className="text-caption text-neutral-500">{SAVED_SIMULATION_NOTE}</p>

          <ul className="space-y-2">
            {savedList.map((item) => (
              <li
                key={item.id}
                className="rounded-lg border border-border p-3"
                data-testid="penalty-saved-item"
              >
                <p className="text-sm text-foreground">
                  {VENDOR_CATEGORY_LABEL[item.category as PenaltyCategory] ?? item.category} · 기준{" "}
                  {formatKrw(item.standardAmount)}원 / 계약서 {formatKrw(item.contractAmount)}원
                </p>
                <p className="text-caption text-muted-foreground">
                  {item.createdAt.slice(0, 10)}
                  {item.ruleVersion === null ? "" : ` · 기준 판본 ${item.ruleVersion}`}
                  {item.excessAmount > 0 ? ` · 차이 ${formatKrw(item.excessAmount)}원` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ResultSection({
  response,
  busy,
  canSave,
  copied,
  onCopy,
  onSave,
}: {
  response: SimulateResponse;
  busy: boolean;
  canSave: boolean;
  copied: boolean;
  onCopy: () => Promise<void>;
  onSave: () => void;
}) {
  const { result, ruleState, comparison } = response;

  return (
    <div className="space-y-4" data-testid="penalty-result">
      {/* **기준의 출처를 결과보다 먼저 적는다.** 어느 수치로 계산했는지 모르는 금액을
          보여주지 않는다(§7.7). */}
      <section
        className={cn(
          "space-y-1 rounded-lg border p-3",
          ruleState.settled ? "border-border" : "border-warning/40",
        )}
        data-testid="penalty-rule-state"
        data-settled={ruleState.settled ? "true" : "false"}
      >
        <p
          className={cn(
            "text-sm font-medium",
            ruleState.settled ? "text-foreground" : "text-warning",
          )}
        >
          {ruleState.headline}
        </p>
        <p className="text-caption text-muted-foreground">{ruleState.detail}</p>
      </section>

      {/* 고지는 **상시 고정**이다. 접거나 툴팁으로 만들지 않는다. */}
      <AiDisclaimer basisRef={result.basisRef} />

      <section className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{result.bandLabel}</Badge>
          <span className="text-caption text-muted-foreground">
            {result.daysBeforeEvent >= 0
              ? `예식일 ${result.daysBeforeEvent}일 전`
              : `예식일 ${Math.abs(result.daysBeforeEvent)}일 경과`}
          </span>
        </div>

        <Bar
          label="기준 위약금"
          amount={result.standard.penalty}
          bp={comparison.standardBp}
          tone="standard"
        />

        {/* **계산된 0과 모르는 0을 가른다.** 위쪽의 '기준이 등록되지 않았다' 와 겹쳐
            읽히면 "기준이 없어서 0" 으로 이해된다 — 완전히 다른 사실이다. */}
        {standardZeroReason(result) === null ? null : (
          <p className="text-caption text-neutral-500" data-testid="penalty-zero-reason">
            {standardZeroReason(result)}
          </p>
        )}
        <Bar
          label="계약서 기준 위약금"
          amount={result.contract.penalty}
          bp={comparison.contractBp}
          tone={comparison.excess > 0 ? "over" : "standard"}
        />

        {/* **평가어가 아니라 금액과 편차다**(CLAUDE.md §2.3). */}
        <p
          className={cn("text-sm", comparison.excess > 0 ? "text-warning" : "text-success")}
          data-testid="penalty-excess"
          data-excess={comparison.excess}
        >
          {excessSentence(comparison)}
        </p>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-caption">
          <dt className="text-muted-foreground">돌려받는 계약금(기준)</dt>
          <dd className="text-right text-foreground">
            {formatKrw(result.standard.depositRefund)}원
          </dd>
          <dt className="text-muted-foreground">돌려받는 계약금(계약서)</dt>
          <dd className="text-right text-foreground">
            {formatKrw(result.contract.depositRefund)}원
          </dd>
          {result.contract.balanceDue > 0 ? (
            <>
              <dt className="text-muted-foreground">추가로 내야 하는 금액</dt>
              <dd className="text-right text-foreground">
                {formatKrw(result.contract.balanceDue)}원
              </dd>
            </>
          ) : null}
        </dl>

        <p className="text-caption text-neutral-500" data-testid="penalty-basis">
          근거 {result.basisRef} · 판본 {result.ruleVersion}
          {comparison.excessOverTotalBp === null
            ? ""
            : ` · 총액 대비 ${bpToPercent(comparison.excessOverTotalBp).toFixed(1)}%`}
        </p>
      </section>

      {result.notes.length > 0 ? (
        <ul className="space-y-1" data-testid="penalty-notes">
          {result.notes.map((note) => (
            <li key={note} className="text-caption text-warning">
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      {/* 이의 제기 문구 — **비교값만 담는다.** 문구는 엔진이 만들고 화면은 옮긴다. */}
      <section className="space-y-2 rounded-lg border border-border p-4" data-testid="penalty-script">
        <h2 className="text-sm font-semibold text-foreground">업체에 보낼 문구</h2>
        <pre className="whitespace-pre-wrap break-words text-caption text-foreground">
          {result.objectionScript}
        </pre>
        <Button type="button" size="sm" variant="outline" onClick={() => void onCopy()}>
          {copied ? "복사했어요" : "문구 복사"}
        </Button>
      </section>

      {canSave ? (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={busy}
          onClick={onSave}
          data-testid="penalty-save"
        >
          이 계산 저장하기
        </Button>
      ) : (
        // **눌러 보고 나서야 알게 하지 않는다.** 왜 안 되는지 그 자리에서 적는다.
        <p className="text-caption text-muted-foreground" data-testid="penalty-save-locked">
          로그인하고 온보딩을 마치면 이 계산을 저장해 둘 수 있어요.
        </p>
      )}
    </div>
  );
}

function Bar({
  label,
  amount,
  bp,
  tone,
}: {
  label: string;
  amount: number;
  bp: number;
  tone: "standard" | "over";
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-muted-foreground">{label}</span>
        <span className="text-sm font-medium text-foreground">{formatKrw(amount)}원</span>
      </div>
      {/* 눈금은 **bp 정수를 100 으로 나눈 값**이다. 화면이 비율을 다시 계산하지 않는다. */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className={cn("h-full rounded-full", tone === "over" ? "bg-warning" : "bg-brand-500")}
          style={{ width: `${bp / 100}%` }}
          data-testid="penalty-bar"
          data-bp={bp}
        />
      </div>
    </div>
  );
}

export default PenaltyToolView;
