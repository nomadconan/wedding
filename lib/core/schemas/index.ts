// lib/core 스키마 진입점 (명세서 §5.1 — API 입출력·AI 출력은 zod 로 양방향 검증)
//
// 프레임워크 의존 금지. React/Next 를 import 하지 않는다(CLAUDE.md §3.1).

export {
  AI_DISCLAIMER,
  FindingSchema,
  ReportSchema,
  SeveritySchema,
  type Finding,
  type Report,
  type ReportInput,
  type Severity,
} from "./report";

export {
  ContractPenaltyTermSchema,
  PENALTY_CATEGORIES,
  PenaltyBandSchema,
  PenaltyCategorySchema,
  PenaltyInputSchema,
  PenaltyResultSchema,
  PenaltyRuleSetSchema,
  PenaltySettlementSchema,
  bpToPercent,
  percentToBp,
  type ContractPenaltyTerm,
  type PenaltyBand,
  type PenaltyCategory,
  type PenaltyInput,
  type PenaltyResult,
  type PenaltyRuleSet,
  type PenaltySettlement,
} from "./penalty";

export {
  BasisPointSchema,
  COMMISSION_SCOPE_ORDER,
  InstantSchema,
  MoneySchema,
  PLANNER_FEE_SCOPE_ORDER,
  PlannerFeeInputSchema,
  RATE_SCOPES,
  RateQuerySchema,
  RateRecordSchema,
  RateScopeSchema,
  SettlementInputSchema,
  SettlementResultSchema,
  type PlannerFeeInput,
  type RateQuery,
  type RateRecord,
  type RateScope,
  type SettlementInput,
  type SettlementResult,
} from "./rates";

export {
  AmountValueSchema,
  OrderAddOnsSchema,
  OrderLineInputSchema,
  OrderPlannerFeeSchema,
  type OrderAddOns,
  type OrderLineInput,
  type OrderPlannerFee,
} from "./order";

export {
  ESTIMATE_CATEGORIES,
  ESTIMATE_CATEGORY_LABEL,
  ESTIMATE_FLAGS,
  EstimateCategorySchema,
  EstimateComparisonSchema,
  EstimateFlagSchema,
  EstimateItemSchema,
  EstimateParseResultSchema,
  NormalizedEstimateSchema,
  type EstimateCategory,
  type EstimateComparison,
  type EstimateFlag,
  type EstimateItem,
  type EstimateParseResult,
  type NormalizedEstimate,
} from "./estimate";
