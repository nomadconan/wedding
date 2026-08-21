"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  BUDGET_AUTO_CONTRACT_NOTE,
  BUDGET_CATEGORY_LABEL,
  BUDGET_NO_TOTAL_NOTE,
  BUDGET_SHARED_TOTAL_NOTE,
  BUDGET_WARNING_LABEL,
  NO_INDEX_RECOMMENDATION_NOTE,
  type BudgetCategory,
  type BudgetLine,
  type BudgetTotals,
  type BudgetWarning,
  type Recommendation,
  type RecommendationSummary,
} from "@/lib/core/budget/budget";
import { EXPENSE_MEMO_MAX_LENGTH } from "@/lib/core/schemas/budget";
import { cn } from "@/lib/utils";

/**
 * /budget — 예산 배분·추적 (F-C-05 · 명세서 §6.2)
 *
 * ── 이 화면이 지키는 것 ─────────────────────────────────────────────────────
 *  1. **총예산이 미정이면 기준선을 그리지 않는다.** 0을 기준으로 삼으면 담는 즉시
 *     '초과' 가 뜨는데 그건 사실이 아니라 설정이 비었다는 뜻이다(장바구니 `none` 과
 *     같은 판단 · D-77).
 *  2. **장바구니와 같은 총예산이라는 사실을 적는다.** 두 화면이 다른 숫자를 말하면
 *     사용자는 어느 쪽이 맞는지 묻게 된다.
 *  3. **기준이 없으면 권장하지 않는다.** 참가격 지수가 없는 카테고리는 **빈칸**이며
 *     0원을 권하지 않는다 — 0원은 '쓰지 마라' 로 읽힌다.
 *  4. **권장을 조용히 계획으로 만들지 않는다.** 버튼이다(D-73 과 같은 판단).
 *
 * 판정·문구는 전부 `lib/core/budget` 이 갖고 이 파일은 그리기만 한다(D-79 와 같은
 * 이유 — 규칙이 화면에만 있으면 화면이 늘 때 따라오지 않는다).
 */
export function BudgetView({
  totalBudget,
  lines,
  totals,
  warnings,
  recommendations,
  recommendation,
  expenses,
  regionCode,
}: {
  totalBudget: number | null;
  lines: BudgetLine[];
  totals: BudgetTotals;
  warnings: BudgetWarning[];
  recommendations: Recommendation[];
  recommendation: RecommendationSummary;
  expenses: { id: string; category: BudgetCategory; amount: number; paidAt: string | null; memo: string | null }[];
  regionCode: string | null;
}) {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingTotal, setEditingTotal] = useState(totalBudget === null);
  const [totalInput, setTotalInput] = useState(totalBudget === null ? "" : String(totalBudget));

  async function call(body: unknown) {
    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch("/api/budget", {
        method: "PUT",
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

  const recommendationByCategory = new Map(
    recommendations.map((item) => [item.category, item]),
  );

  return (
    <div className="space-y-5" data-testid="budget">
      {/* ── 총예산 ────────────────────────────────────────────────────────── */}
      <section className="space-y-2 rounded-lg border border-border p-4" data-testid="budget-total">
        <h2 className="text-sm font-semibold text-foreground">총예산</h2>

        {editingTotal ? (
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-caption text-muted-foreground">금액 (원)</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={10000}
                value={totalInput}
                onChange={(event) => setTotalInput(event.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                data-testid="budget-total-input"
              />
            </label>

            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy || totalInput.trim() === ""}
                onClick={async () => {
                  const data = await call({
                    action: "set_total",
                    totalBudget: Math.trunc(Number(totalInput)),
                  });
                  if (data) setEditingTotal(false);
                }}
              >
                저장
              </Button>
              {totalBudget !== null ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setEditingTotal(false)}>
                  취소
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-lg font-semibold text-foreground" data-testid="budget-total-amount">
              {formatKrw(totalBudget as number)}원
            </p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setEditingTotal(true)}>
                바꾸기
              </Button>
              {/* **지우는 것은 0으로 만드는 것이 아니다.** 미정으로 되돌린다. */}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                data-testid="budget-total-clear"
                onClick={() => void call({ action: "set_total", totalBudget: null })}
              >
                미정으로
              </Button>
            </div>
          </div>
        )}

        <p className="text-caption text-muted-foreground">
          {totalBudget === null ? BUDGET_NO_TOTAL_NOTE : BUDGET_SHARED_TOTAL_NOTE}
        </p>
      </section>

      {/* ── 초과 경고 ─────────────────────────────────────────────────────── */}
      {warnings.length > 0 ? (
        <ul className="space-y-2" data-testid="budget-warnings">
          {warnings.map((warning) => (
            <li
              key={`${warning.kind}-${"category" in warning ? warning.category : "total"}`}
              className="rounded-lg border border-warning/40 p-3 text-caption text-warning"
              data-testid="budget-warning"
              data-kind={warning.kind}
            >
              {"category" in warning
                ? `${BUDGET_CATEGORY_LABEL[warning.category]} — ${BUDGET_WARNING_LABEL[warning.kind]} (${formatKrw(warning.amount)}원)`
                : `${BUDGET_WARNING_LABEL[warning.kind]} — ${formatKrw(warning.amount)}원`}
            </li>
          ))}
        </ul>
      ) : null}

      {notice ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="budget-notice">
          {notice}
        </p>
      ) : null}

      {/* ── 합계 ──────────────────────────────────────────────────────────── */}
      <section className="space-y-2 rounded-lg border border-border p-4" data-testid="budget-totals">
        <Row label="계획" amount={totals.planned} />
        <Row label="확정된 계약" amount={totals.contracted} />
        <Row label="그중 결제 완료" amount={totals.paid} muted />
        <Row label="직접 적은 지출" amount={totals.manualSpent} />
        <Row label="빠져나갈 총액" amount={totals.committed} strong />
        {totals.remaining === null ? null : <Row label="남은 예산" amount={totals.remaining} strong />}
        <p className="pt-1 text-caption text-muted-foreground">{BUDGET_AUTO_CONTRACT_NOTE}</p>
      </section>

      {/* ── 권장 배분 ─────────────────────────────────────────────────────── */}
      <section className="space-y-2 rounded-lg border border-border p-4" data-testid="budget-recommendation">
        <h2 className="text-sm font-semibold text-foreground">참가격 기준 권장</h2>

        {regionCode === null ? (
          <p className="text-caption text-muted-foreground">
            지역이 정해지지 않아 참가격 기준을 고를 수 없어요. 온보딩에서 지역을 정해 주세요.
          </p>
        ) : recommendation.total === null ? (
          <p className="text-caption text-muted-foreground" data-testid="budget-recommendation-empty">
            아직 이 지역의 참가격 기준이 없어요. 기준이 모이면 카테고리별 권장액을 보여드려요.
          </p>
        ) : (
          <>
            <p className="text-sm text-foreground">
              기준이 있는 {recommendation.indexedCount}개 카테고리의 중앙값 합은{" "}
              <strong>{formatKrw(recommendation.total)}원</strong>이에요.
            </p>
            <p className="text-caption text-muted-foreground">
              나머지 {recommendation.missingCount}개는 {NO_INDEX_RECOMMENDATION_NOTE}
            </p>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              data-testid="budget-apply-recommendation"
              onClick={() => void call({ action: "apply_recommendation", overwrite: false })}
            >
              계획에 채우기 (이미 정한 것은 그대로 둬요)
            </Button>
          </>
        )}
      </section>

      {/* ── 카테고리 ──────────────────────────────────────────────────────── */}
      <section className="space-y-3" data-testid="budget-categories">
        <h2 className="text-sm font-semibold text-foreground">카테고리</h2>

        <ul className="space-y-2">
          {lines.map((line) => (
            <li key={line.category}>
              <CategoryRow
                line={line}
                recommendation={recommendationByCategory.get(line.category)}
                busy={busy}
                onPlan={(amount) =>
                  call({
                    action: "set_plan",
                    allocations: [{ category: line.category, plannedAmount: amount }],
                  })
                }
              />
            </li>
          ))}
        </ul>
      </section>

      {/* ── 실지출 ────────────────────────────────────────────────────────── */}
      <ExpenseSection
        expenses={expenses}
        busy={busy}
        onAdd={(input) => call({ action: "add_expense", ...input })}
        onRemove={(expenseId) => call({ action: "remove_expense", expenseId })}
      />
    </div>
  );
}

function Row({
  label,
  amount,
  strong,
  muted,
}: {
  label: string;
  amount: number;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={cn("text-caption", muted ? "text-neutral-500" : "text-muted-foreground")}>
        {label}
      </span>
      <span className={cn("text-sm", strong ? "font-semibold text-foreground" : "text-foreground")}>
        {formatKrw(amount)}원
      </span>
    </div>
  );
}

function CategoryRow({
  line,
  recommendation,
  busy,
  onPlan,
}: {
  line: BudgetLine;
  recommendation: Recommendation | undefined;
  busy: boolean;
  onPlan: (amount: number | null) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(line.planned === null ? "" : String(line.planned));

  const over = (line.overBy ?? 0) > 0;
  // 계획이 없으면 게이지를 그리지 않는다 — 0 기준 100% 는 사실이 아니다.
  const usedPercent =
    line.planned === null || line.planned <= 0
      ? null
      : Math.min(100, Math.round((line.committed * 10_000) / line.planned) / 100);

  return (
    <div
      className="space-y-2 rounded-lg border border-border p-4"
      data-testid="budget-category"
      data-category={line.category}
      data-over={over ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          {BUDGET_CATEGORY_LABEL[line.category]}
        </span>
        {over ? (
          <Badge variant="outline" data-testid="budget-category-over">
            계획 초과 {formatKrw(line.overBy as number)}원
          </Badge>
        ) : null}
      </div>

      {usedPercent === null ? null : (
        <Progress value={usedPercent} aria-label={`${BUDGET_CATEGORY_LABEL[line.category]} 소진율`} />
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-muted-foreground">
        <span>계획 {line.planned === null ? "미정" : `${formatKrw(line.planned)}원`}</span>
        <span>계약 {formatKrw(line.contracted)}원</span>
        <span>지출 {formatKrw(line.manualSpent)}원</span>
        {line.remaining === null ? null : <span>남음 {formatKrw(line.remaining)}원</span>}
      </div>

      {/* **기준이 없으면 권장액을 만들지 않는다.** 빈칸이지 0원이 아니다. */}
      {recommendation?.kind === "indexed" ? (
        <p className="text-caption text-neutral-500" data-testid="budget-category-recommendation">
          참가격 중앙값 {formatKrw(recommendation.amount)}원 · 표본 {recommendation.sampleSize}곳
          {recommendation.sourceLabel === null ? "" : ` · ${recommendation.sourceLabel}`}
        </p>
      ) : (
        <p className="text-caption text-neutral-500" data-testid="budget-category-no-index">
          {NO_INDEX_RECOMMENDATION_NOTE}
        </p>
      )}

      {editing ? (
        <div className="flex gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={10000}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="budget-plan-input"
          />
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={async () => {
              // 빈칸은 **계획을 지우는 것**이다 — 0원 계획과 다르다.
              await onPlan(value.trim() === "" ? null : Math.trunc(Number(value)));
              setEditing(false);
            }}
          >
            저장
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          data-testid="budget-plan-edit"
          onClick={() => setEditing(true)}
        >
          {line.planned === null ? "계획 정하기" : "계획 바꾸기"}
        </Button>
      )}
    </div>
  );
}

function ExpenseSection({
  expenses,
  busy,
  onAdd,
  onRemove,
}: {
  expenses: { id: string; category: BudgetCategory; amount: number; paidAt: string | null; memo: string | null }[];
  busy: boolean;
  onAdd: (input: { category: BudgetCategory; amount: number; paidAt: string | null; memo: string | null }) => Promise<unknown>;
  onRemove: (expenseId: string) => Promise<unknown>;
}) {
  const [adding, setAdding] = useState(false);
  const [category, setCategory] = useState<BudgetCategory>("hall");
  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [memo, setMemo] = useState("");

  return (
    <section className="space-y-2" data-testid="budget-expenses">
      <h2 className="text-sm font-semibold text-foreground">직접 적은 지출</h2>

      {expenses.length === 0 ? (
        <p className="text-caption text-muted-foreground">
          아직 없어요. 플랫폼 밖에서 낸 돈만 적으면 됩니다.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="budget-expense-list">
          {expenses.map((expense) => (
            <li
              key={expense.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border p-3"
              data-testid="budget-expense"
            >
              <div className="min-w-0">
                <p className="text-sm text-foreground">
                  {BUDGET_CATEGORY_LABEL[expense.category]} · {formatKrw(expense.amount)}원
                </p>
                <p className="truncate text-caption text-muted-foreground">
                  {expense.paidAt ?? "날짜 미정"}
                  {expense.memo === null || expense.memo === "" ? "" : ` · ${expense.memo}`}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                data-testid="budget-expense-remove"
                onClick={() => void onRemove(expense.id)}
              >
                지우기
              </Button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="space-y-2 rounded-lg border border-border p-4" data-testid="budget-expense-add">
          <label className="block space-y-1">
            <span className="text-caption text-muted-foreground">카테고리</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as BudgetCategory)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {Object.entries(BUDGET_CATEGORY_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-caption text-muted-foreground">금액 (원)</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              data-testid="budget-expense-amount"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-caption text-muted-foreground">낸 날 (비워 둘 수 있어요)</span>
            <input
              type="date"
              value={paidAt}
              onChange={(event) => setPaidAt(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-caption text-muted-foreground">메모 (선택)</span>
            <input
              value={memo}
              maxLength={EXPENSE_MEMO_MAX_LENGTH}
              onChange={(event) => setMemo(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </label>

          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || amount.trim() === ""}
              onClick={async () => {
                await onAdd({
                  category,
                  amount: Math.trunc(Number(amount)),
                  paidAt: paidAt === "" ? null : paidAt,
                  memo: memo.trim() === "" ? null : memo.trim(),
                });
                setAdding(false);
                setAmount("");
                setMemo("");
              }}
            >
              추가
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)}>
              취소
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => setAdding(true)}
          data-testid="budget-expense-open"
        >
          지출 적기
        </Button>
      )}
    </section>
  );
}

export default BudgetView;
