// 다이내믹 프라이싱 룰 평가 (S2-06 · 명세서 §2.2 F-V-06, §3.3 price_rules)
//
//  * **순수 함수다.** DB 도 React 도 모른다. 요율 엔진(rates.ts)과 같은 계층·같은 방식이다.
//  * **basis point 정수 연산만** 쓴다. 부동소수점 누산이 없다(penalty.ts 와 동일).
//  * **같은 입력이면 항상 같은 결과**여야 한다. 그래서 적용 순서를 전순서로 못박는다.
//
// ── 적용 순서 (결정성의 핵심) ────────────────────────────────────────────────
//   1) priority 오름차순 — 작은 값이 먼저
//   2) 같으면 rule_type 고정 순서: season → weekday → leadtime → occupancy
//   3) 같으면 createdAt 오름차순 (먼저 만든 룰이 먼저)
//   4) 같으면 id 오름차순
// 4단계까지 가면 두 룰이 완전히 같은 값을 가질 수 없으므로 **순서가 유일하게 정해진다.**
//
// 요율(commission_rates)은 한 시점에 **하나만** 적용돼야 해서 겹침을 DB 가 거부했다.
// 프라이싱 룰은 **여러 개가 함께 적용되는 것이 정상**이다(시즌 + 주말). 그래서 거부가
// 아니라 순서를 못박는 방식으로 결정성을 얻는다.
//
// ── 적용 방식 ────────────────────────────────────────────────────────────────
// 각 룰은 **직전 결과 금액에** 적용된다(순차 적용). 순서가 정해져 있으므로 결정적이며,
// 화면은 단계별 before → after 를 그대로 보여준다. 결과만 보여주면 업체가 룰을 못 고친다.

import {
  weekdayOf,
  type AdjustType,
  type PriceRuleCondition,
  type PriceRuleType,
} from "../schemas/price-rule";

/** 평가 대상 룰. DB 행을 그대로 옮긴 형태다. */
export type EvaluablePriceRule = {
  id: string;
  ruleType: PriceRuleType;
  condition: PriceRuleCondition;
  adjustType: AdjustType;
  adjustValue: number;
  floorPrice: number | null;
  capPrice: number | null;
  priority: number;
  isActive: boolean;
  createdAt: string;
  productId: string | null;
  /** 화면 표시용 이름. 평가에는 쓰지 않는다. */
  label?: string;
};

/** 평가 시점의 사실들. "지금"에 해당하는 값은 전부 호출자가 넘긴다. */
export type PriceContext = {
  eventDate: string;
  leadTimeDays: number;
  /** 잔여율(bp). null 이면 재고 정보가 없다는 뜻이고, 잔여율 룰은 적용되지 않는다. */
  occupancyRatioBp: number | null;
  productId?: string | null;
};

export type RuleStep = {
  ruleId: string;
  ruleType: PriceRuleType;
  label?: string;
  applied: boolean;
  /** 적용되지 않았다면 그 이유. 업체가 룰을 고칠 수 있어야 한다. */
  reason: string;
  priceBefore: number;
  priceAfter: number;
  /** 이 룰의 가드에 걸려 금액이 잘렸는가. */
  clampedByGuard: boolean;
};

export type PriceEvaluation = {
  basePrice: number;
  finalPrice: number;
  steps: RuleStep[];
  /** 적용된 룰들의 가드를 합친 값. floor 는 최댓값, cap 은 최솟값이 이긴다. */
  effectiveFloor: number | null;
  effectiveCap: number | null;
  /** 마지막 전체 가드에서 금액이 잘렸는가. */
  guardApplied: boolean;
  /** 하한가가 상한가보다 큰 모순 설정이었는가. 이때는 하한가를 택한다. */
  guardConflict: boolean;
};

const RULE_TYPE_ORDER: Record<PriceRuleType, number> = {
  season: 0,
  weekday: 1,
  leadtime: 2,
  occupancy: 3,
};

/** 전순서. 같은 값이 나올 수 없을 때까지 비교한다. */
export function comparePriceRules(a: EvaluablePriceRule, b: EvaluablePriceRule): number {
  if (a.priority !== b.priority) return a.priority - b.priority;

  const typeDiff = RULE_TYPE_ORDER[a.ruleType] - RULE_TYPE_ORDER[b.ruleType];
  if (typeDiff !== 0) return typeDiff;

  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 조건 판정. 적용 여부와 사유를 함께 돌려준다. */
export function matchRule(
  rule: EvaluablePriceRule,
  context: PriceContext,
): { matched: boolean; reason: string } {
  if (!rule.isActive) return { matched: false, reason: "꺼진 룰입니다." };

  if (rule.productId && rule.productId !== (context.productId ?? null)) {
    return { matched: false, reason: "다른 상품에만 적용되는 룰입니다." };
  }

  const condition = rule.condition;

  switch (condition.ruleType) {
    case "season": {
      const inRange = condition.from <= context.eventDate && context.eventDate <= condition.to;

      return {
        matched: inRange,
        reason: inRange
          ? `예식일이 ${condition.from} ~ ${condition.to} 안에 있습니다.`
          : `예식일이 ${condition.from} ~ ${condition.to} 밖입니다.`,
      };
    }

    case "weekday": {
      const weekday = weekdayOf(context.eventDate);
      const inSet = condition.weekdays.includes(weekday);

      return {
        matched: inSet,
        reason: inSet ? "지정한 요일입니다." : "지정한 요일이 아닙니다.",
      };
    }

    case "leadtime": {
      const { minDays, maxDays } = condition;
      const days = context.leadTimeDays;

      if (minDays !== null && days < minDays) {
        return { matched: false, reason: `남은 일수 ${days}일이 최소 ${minDays}일보다 적습니다.` };
      }

      if (maxDays !== null && days > maxDays) {
        return { matched: false, reason: `남은 일수 ${days}일이 최대 ${maxDays}일을 넘습니다.` };
      }

      return { matched: true, reason: `남은 일수 ${days}일이 조건 안에 있습니다.` };
    }

    case "occupancy": {
      if (context.occupancyRatioBp === null) {
        return { matched: false, reason: "그날의 재고 정보가 없어 잔여율을 알 수 없습니다." };
      }

      const { minRatioBp, maxRatioBp } = condition;
      const ratio = context.occupancyRatioBp;

      if (minRatioBp !== null && ratio < minRatioBp) {
        return { matched: false, reason: `잔여율 ${bpToPercentText(ratio)}가 최소 ${bpToPercentText(minRatioBp)}보다 낮습니다.` };
      }

      if (maxRatioBp !== null && ratio > maxRatioBp) {
        return { matched: false, reason: `잔여율 ${bpToPercentText(ratio)}가 최대 ${bpToPercentText(maxRatioBp)}를 넘습니다.` };
      }

      return { matched: true, reason: `잔여율 ${bpToPercentText(ratio)}가 조건 안에 있습니다.` };
    }
  }
}

/** bp 를 사람이 읽는 퍼센트로. 표시 전용이며 계산에 쓰지 않는다. */
export function bpToPercentText(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = Math.abs(bp % 100);

  return fraction === 0 ? `${whole}%` : `${whole}.${String(fraction).padStart(2, "0")}%`;
}

/** 조정 한 번. 반올림은 penalty.ts·rates.ts 와 같은 방식이다(0.5 는 +∞ 방향). */
function applyAdjust(price: number, adjustType: AdjustType, adjustValue: number): number {
  if (adjustType === "amount_krw") return price + adjustValue;

  const product = price * adjustValue;

  if (!Number.isSafeInteger(product)) {
    throw new RangeError("금액에 비율을 적용하면 정수 안전 범위를 벗어납니다.");
  }

  return price + Math.round(product / 10_000);
}

function clamp(price: number, floor: number | null, cap: number | null): number {
  let next = price;
  if (cap !== null && next > cap) next = cap;
  if (floor !== null && next < floor) next = floor;

  return next;
}

/**
 * 룰을 순서대로 적용해 최종가를 만든다.
 *
 * 가드는 **두 번** 건다.
 *  1. 각 룰을 적용한 직후 그 룰의 floor/cap 으로 자른다.
 *  2. 마지막에 **적용된 모든 룰의 가드를 합친 값**으로 다시 자른다 —
 *     앞선 룰의 하한을 뒤 룰이 뚫고 내려가는 것을 막기 위해서다.
 *
 * 하한가가 상한가보다 크면 설정이 모순이다. 이때는 **하한가를 택하고** 그 사실을 알린다
 * (더 낮은 값을 택하면 업체가 의도하지 않은 손해를 본다).
 */
export function evaluatePriceRules(
  basePrice: number,
  rules: EvaluablePriceRule[],
  context: PriceContext,
): PriceEvaluation {
  if (!Number.isInteger(basePrice) || basePrice < 0) {
    throw new RangeError("기준 금액은 0 이상 정수여야 합니다.");
  }

  const ordered = [...rules].sort(comparePriceRules);
  const steps: RuleStep[] = [];

  let price = basePrice;
  let effectiveFloor: number | null = null;
  let effectiveCap: number | null = null;

  for (const rule of ordered) {
    const { matched, reason } = matchRule(rule, context);

    if (!matched) {
      steps.push({
        ruleId: rule.id,
        ruleType: rule.ruleType,
        ...(rule.label === undefined ? {} : { label: rule.label }),
        applied: false,
        reason,
        priceBefore: price,
        priceAfter: price,
        clampedByGuard: false,
      });

      continue;
    }

    const before = price;
    const adjusted = applyAdjust(before, rule.adjustType, rule.adjustValue);
    // 음수 금액은 어떤 경우에도 나오지 않는다.
    const bounded = Math.max(0, adjusted);
    const after = clamp(bounded, rule.floorPrice, rule.capPrice);

    if (rule.floorPrice !== null) {
      effectiveFloor = effectiveFloor === null ? rule.floorPrice : Math.max(effectiveFloor, rule.floorPrice);
    }

    if (rule.capPrice !== null) {
      effectiveCap = effectiveCap === null ? rule.capPrice : Math.min(effectiveCap, rule.capPrice);
    }

    steps.push({
      ruleId: rule.id,
      ruleType: rule.ruleType,
      ...(rule.label === undefined ? {} : { label: rule.label }),
      applied: true,
      reason,
      priceBefore: before,
      priceAfter: after,
      clampedByGuard: after !== bounded,
    });

    price = after;
  }

  const guardConflict =
    effectiveFloor !== null && effectiveCap !== null && effectiveFloor > effectiveCap;

  const beforeFinalGuard = price;
  // 모순이면 하한가가 이긴다.
  const finalPrice = guardConflict
    ? effectiveFloor!
    : clamp(price, effectiveFloor, effectiveCap);

  return {
    basePrice,
    finalPrice,
    steps,
    effectiveFloor,
    effectiveCap,
    guardApplied: finalPrice !== beforeFinalGuard,
    guardConflict,
  };
}
