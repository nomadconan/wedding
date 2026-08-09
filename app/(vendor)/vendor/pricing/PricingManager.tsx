"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { bpToPercentText, type PriceEvaluation } from "@/lib/core/pricing/dynamic";
import { WEEKDAY_LABEL } from "@/lib/core/schemas/inventory";
import {
  ADJUST_TYPES,
  ADJUST_TYPE_LABEL,
  PRICE_RULE_TYPES,
  PRICE_RULE_TYPE_DESCRIPTION,
  PRICE_RULE_TYPE_LABEL,
  type AdjustType,
  type PriceRuleType,
} from "@/lib/core/schemas/price-rule";

/**
 * 다이내믹 프라이싱 관리 (F-V-06, §6.3 `/vendor/pricing`)
 *
 * 시뮬레이션은 **결과만 보여주지 않는다.** 어느 룰이 왜 걸렸는지·왜 안 걸렸는지,
 * 가드에 잘렸는지까지 단계로 보여준다. 결과만 보면 업체가 룰을 고칠 수 없다.
 *
 * 가격 룰은 owner 전용이다(§3.9). staff 에게는 편집 UI 를 감추되 최종 경계는 RLS 다.
 * 시뮬레이션은 조회라 staff 도 볼 수 있다.
 */
export type PriceRuleView = {
  id: string;
  ruleType: PriceRuleType;
  condition: Record<string, unknown>;
  adjustType: AdjustType;
  adjustValue: number;
  floorPrice: number | null;
  capPrice: number | null;
  priority: number;
  isActive: boolean;
};

export type PricingManagerProps = {
  rules: PriceRuleView[];
  canEdit: boolean;
  /** 시뮬레이션 기본 금액. 등록된 상품이 있으면 그 총액을 쓴다. */
  defaultBasePrice: number;
};

function conditionText(rule: PriceRuleView): string {
  const c = rule.condition;

  switch (rule.ruleType) {
    case "season":
      return `${c.from} ~ ${c.to}`;
    case "weekday":
      return ((c.weekdays as number[]) ?? []).map((day) => WEEKDAY_LABEL[day]).join(", ");
    case "leadtime":
      return `${c.minDays ?? "-"}일 ~ ${c.maxDays ?? "-"}일 전`;
    case "occupancy":
      return `잔여 ${c.minRatioBp === null || c.minRatioBp === undefined ? "-" : bpToPercentText(Number(c.minRatioBp))} ~ ${
        c.maxRatioBp === null || c.maxRatioBp === undefined ? "-" : bpToPercentText(Number(c.maxRatioBp))
      }`;
  }
}

function adjustText(rule: PriceRuleView): string {
  if (rule.adjustType === "percent_bp") {
    return `${rule.adjustValue > 0 ? "+" : ""}${bpToPercentText(rule.adjustValue)}`;
  }

  return `${rule.adjustValue > 0 ? "+" : "-"}${formatKrw(Math.abs(rule.adjustValue))}원`;
}

const EMPTY_DRAFT = {
  ruleType: "weekday" as PriceRuleType,
  adjustType: "percent_bp" as AdjustType,
  adjustValue: "-1000",
  priority: "100",
  floorPrice: "",
  capPrice: "",
  seasonFrom: "",
  seasonTo: "",
  weekdays: [6] as number[],
  minDays: "",
  maxDays: "",
  minRatioBp: "",
  maxRatioBp: "",
};

export function PricingManager({ rules, canEdit, defaultBasePrice }: PricingManagerProps) {
  const router = useRouter();

  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 시뮬레이션
  const [basePrice, setBasePrice] = useState(String(defaultBasePrice));
  const [eventDate, setEventDate] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("30");
  const [occupancy, setOccupancy] = useState("50");
  const [evaluation, setEvaluation] = useState<PriceEvaluation | null>(null);

  async function call(path: string, init: RequestInit, message?: string) {
    setPending(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const body = await response.json();

      if (!response.ok || !body.ok) {
        const detail = Array.isArray(body.error?.details) ? body.error.details[0]?.message : null;
        setError(detail ?? body.error?.message ?? "처리하지 못했어요.");

        return null;
      }

      if (message) setNotice(message);
      router.refresh();

      return body.data;
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");

      return null;
    } finally {
      setPending(false);
    }
  }

  function buildCondition() {
    switch (draft.ruleType) {
      case "season":
        return { ruleType: "season", from: draft.seasonFrom, to: draft.seasonTo };
      case "weekday":
        return { ruleType: "weekday", weekdays: draft.weekdays };
      case "leadtime":
        return {
          ruleType: "leadtime",
          minDays: draft.minDays === "" ? null : Number(draft.minDays),
          maxDays: draft.maxDays === "" ? null : Number(draft.maxDays),
        };
      case "occupancy":
        return {
          ruleType: "occupancy",
          minRatioBp: draft.minRatioBp === "" ? null : Number(draft.minRatioBp) * 100,
          maxRatioBp: draft.maxRatioBp === "" ? null : Number(draft.maxRatioBp) * 100,
        };
    }
  }

  async function createRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const done = await call(
      "/api/vendor/price-rules",
      {
        method: "POST",
        body: JSON.stringify({
          ruleType: draft.ruleType,
          condition: buildCondition(),
          adjustType: draft.adjustType,
          adjustValue: Number(draft.adjustValue),
          floorPrice: draft.floorPrice === "" ? null : Number(draft.floorPrice),
          capPrice: draft.capPrice === "" ? null : Number(draft.capPrice),
          priority: Number(draft.priority),
          isActive: true,
          productId: null,
        }),
      },
      "룰을 등록했습니다.",
    );

    if (done) setDraft(EMPTY_DRAFT);
  }

  async function simulate() {
    const data = await call("/api/vendor/price-rules/simulate", {
      method: "POST",
      body: JSON.stringify({
        basePrice: Number(basePrice),
        eventDate,
        leadTimeDays: Number(leadTimeDays),
        occupancyRatioBp: occupancy === "" ? null : Number(occupancy) * 100,
        productId: null,
      }),
    });

    if (data) setEvaluation(data.evaluation as PriceEvaluation);
  }

  return (
    <div className="space-y-6" data-testid="pricing-manager">
      {/* ── 룰 목록 ─────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <p className="text-sm font-medium">
          적용 순서 — 우선순위가 작을수록 먼저 적용되고, 직전 결과 금액에 이어서 적용됩니다.
        </p>

        {rules.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            등록된 룰이 없습니다.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="rule-list">
            {rules.map((rule, index) => (
              <li
                key={rule.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
              >
                <span className="text-caption text-muted-foreground">{index + 1}</span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{PRICE_RULE_TYPE_LABEL[rule.ruleType]}</Badge>
                    <span className="text-sm font-medium">{adjustText(rule)}</span>
                    {rule.isActive ? null : <Badge variant="outline">꺼짐</Badge>}
                  </div>
                  <p className="text-caption text-muted-foreground">
                    {conditionText(rule)} · 우선순위 {rule.priority}
                    {rule.floorPrice !== null ? ` · 하한 ${formatKrw(rule.floorPrice)}원` : ""}
                    {rule.capPrice !== null ? ` · 상한 ${formatKrw(rule.capPrice)}원` : ""}
                  </p>
                </div>

                {canEdit ? (
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        call(
                          `/api/vendor/price-rules/${rule.id}`,
                          { method: "PATCH", body: JSON.stringify({ isActive: !rule.isActive }) },
                          rule.isActive ? "룰을 껐습니다." : "룰을 켰습니다.",
                        )
                      }
                    >
                      {rule.isActive ? "끄기" : "켜기"}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        call(`/api/vendor/price-rules/${rule.id}`, { method: "DELETE" }, "룰을 삭제했습니다.")
                      }
                    >
                      삭제
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? <p className="text-sm text-success">{notice}</p> : null}

      <Separator />

      <Tabs defaultValue="simulate">
        <TabsList>
          <TabsTrigger value="simulate">시뮬레이션</TabsTrigger>
          {canEdit ? <TabsTrigger value="new">룰 추가</TabsTrigger> : null}
        </TabsList>

        {/* ── 시뮬레이션 ────────────────────────────────────────────────── */}
        <TabsContent value="simulate" className="space-y-3 pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sim-base">기준 총액 (원)</Label>
              <Input
                id="sim-base"
                type="number"
                min={1}
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sim-date">예식일</Label>
              <Input
                id="sim-date"
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sim-lead">남은 일수</Label>
              <Input
                id="sim-lead"
                type="number"
                min={0}
                value={leadTimeDays}
                onChange={(e) => setLeadTimeDays(e.target.value)}
              />
              <p className="text-caption text-warning">
                리드타임은 <strong>조회 시점</strong>이 기준입니다. 같은 룰도 날마다 결과가 달라집니다.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sim-occupancy">잔여율 (%)</Label>
              <Input
                id="sim-occupancy"
                type="number"
                min={0}
                max={100}
                value={occupancy}
                onChange={(e) => setOccupancy(e.target.value)}
              />
            </div>
          </div>

          <Button type="button" disabled={pending || !eventDate} onClick={simulate}>
            {pending ? "계산 중…" : "시뮬레이션"}
          </Button>

          {evaluation ? (
            <div className="space-y-2 rounded-lg border border-border p-3" data-testid="simulation-result">
              <div className="flex items-baseline justify-between">
                <span className="text-unit text-muted-foreground">최종가</span>
                <span data-amount="" className="text-amount-sm text-foreground">
                  {formatKrw(evaluation.finalPrice)}원
                </span>
              </div>

              <p className="text-caption text-muted-foreground">
                기준 {formatKrw(evaluation.basePrice)}원에서 시작했습니다.
              </p>

              <ol className="space-y-1">
                {evaluation.steps.map((step, index) => (
                  <li key={step.ruleId} className="text-caption">
                    <span className={step.applied ? "text-foreground" : "text-muted-foreground"}>
                      {index + 1}. {PRICE_RULE_TYPE_LABEL[step.ruleType]} —{" "}
                      {step.applied
                        ? `${formatKrw(step.priceBefore)} → ${formatKrw(step.priceAfter)}원`
                        : "적용 안 됨"}
                    </span>
                    <span className="block text-muted-foreground">
                      {step.reason}
                      {step.clampedByGuard ? " · 이 룰의 하한·상한에 걸려 조정됨" : ""}
                    </span>
                  </li>
                ))}
              </ol>

              {evaluation.guardApplied ? (
                <p className="text-caption text-warning">
                  전체 하한·상한에 걸려 최종가가 조정됐습니다
                  {evaluation.effectiveFloor !== null
                    ? ` (하한 ${formatKrw(evaluation.effectiveFloor)}원)`
                    : ""}
                  {evaluation.effectiveCap !== null
                    ? ` (상한 ${formatKrw(evaluation.effectiveCap)}원)`
                    : ""}
                  .
                </p>
              ) : null}

              {evaluation.guardConflict ? (
                <p className="text-caption text-danger">
                  하한가가 상한가보다 큽니다. 하한가를 적용했습니다 — 룰의 가드를 확인해 주세요.
                </p>
              ) : null}
            </div>
          ) : null}
        </TabsContent>

        {/* ── 룰 추가 ───────────────────────────────────────────────────── */}
        {canEdit ? (
          <TabsContent value="new" className="pt-3">
            <form onSubmit={createRule} className="space-y-3" data-testid="rule-form">
              <div className="space-y-1.5">
                <Label htmlFor="rule-type">룰 종류</Label>
                <Select
                  value={draft.ruleType}
                  onValueChange={(value) => setDraft({ ...draft, ruleType: value as PriceRuleType })}
                >
                  <SelectTrigger id="rule-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRICE_RULE_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {PRICE_RULE_TYPE_LABEL[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-caption text-muted-foreground">
                  {PRICE_RULE_TYPE_DESCRIPTION[draft.ruleType].replace(/\*\*/g, "")}
                </p>
              </div>

              {draft.ruleType === "season" ? (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="season-from">시작일</Label>
                    <Input
                      id="season-from"
                      type="date"
                      required
                      value={draft.seasonFrom}
                      onChange={(e) => setDraft({ ...draft, seasonFrom: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="season-to">종료일</Label>
                    <Input
                      id="season-to"
                      type="date"
                      required
                      value={draft.seasonTo}
                      onChange={(e) => setDraft({ ...draft, seasonTo: e.target.value })}
                    />
                  </div>
                </div>
              ) : null}

              {draft.ruleType === "weekday" ? (
                <div className="space-y-1.5">
                  <Label>요일</Label>
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAY_LABEL.map((label, index) => (
                      <div key={label} className="flex items-center gap-1">
                        <Checkbox
                          id={`rule-weekday-${index}`}
                          checked={draft.weekdays.includes(index)}
                          onCheckedChange={(checked) =>
                            setDraft({
                              ...draft,
                              weekdays:
                                checked === true
                                  ? [...new Set([...draft.weekdays, index])]
                                  : draft.weekdays.filter((day) => day !== index),
                            })
                          }
                        />
                        <Label htmlFor={`rule-weekday-${index}`} className="font-normal">
                          {label}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {draft.ruleType === "leadtime" ? (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="lead-min">최소 남은 일수</Label>
                    <Input
                      id="lead-min"
                      type="number"
                      min={0}
                      value={draft.minDays}
                      onChange={(e) => setDraft({ ...draft, minDays: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="lead-max">최대 남은 일수</Label>
                    <Input
                      id="lead-max"
                      type="number"
                      min={0}
                      value={draft.maxDays}
                      onChange={(e) => setDraft({ ...draft, maxDays: e.target.value })}
                    />
                  </div>
                </div>
              ) : null}

              {draft.ruleType === "occupancy" ? (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="occ-min">최소 잔여율 (%)</Label>
                    <Input
                      id="occ-min"
                      type="number"
                      min={0}
                      max={100}
                      value={draft.minRatioBp}
                      onChange={(e) => setDraft({ ...draft, minRatioBp: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="occ-max">최대 잔여율 (%)</Label>
                    <Input
                      id="occ-max"
                      type="number"
                      min={0}
                      max={100}
                      value={draft.maxRatioBp}
                      onChange={(e) => setDraft({ ...draft, maxRatioBp: e.target.value })}
                    />
                  </div>
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="adjust-type">조정 방식</Label>
                  <Select
                    value={draft.adjustType}
                    onValueChange={(value) => setDraft({ ...draft, adjustType: value as AdjustType })}
                  >
                    <SelectTrigger id="adjust-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ADJUST_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {ADJUST_TYPE_LABEL[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="adjust-value">
                    조정 값 {draft.adjustType === "percent_bp" ? "(bp · -1000 = -10%)" : "(원)"}
                  </Label>
                  <Input
                    id="adjust-value"
                    type="number"
                    required
                    value={draft.adjustValue}
                    onChange={(e) => setDraft({ ...draft, adjustValue: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="rule-priority">우선순위</Label>
                  <Input
                    id="rule-priority"
                    type="number"
                    min={0}
                    max={9999}
                    value={draft.priority}
                    onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-floor">하한가 (원)</Label>
                  <Input
                    id="rule-floor"
                    type="number"
                    min={0}
                    value={draft.floorPrice}
                    onChange={(e) => setDraft({ ...draft, floorPrice: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-cap">상한가 (원)</Label>
                  <Input
                    id="rule-cap"
                    type="number"
                    min={0}
                    value={draft.capPrice}
                    onChange={(e) => setDraft({ ...draft, capPrice: e.target.value })}
                  />
                </div>
              </div>

              <Button type="submit" disabled={pending}>
                {pending ? "처리 중…" : "룰 등록"}
              </Button>
            </form>
          </TabsContent>
        ) : null}
      </Tabs>

      {!canEdit ? (
        <p className="text-sm text-muted-foreground">
          가격 룰은 업체 대표 계정만 등록·수정할 수 있습니다. 시뮬레이션은 누구나 볼 수 있습니다.
        </p>
      ) : null}
    </div>
  );
}

export default PricingManager;
