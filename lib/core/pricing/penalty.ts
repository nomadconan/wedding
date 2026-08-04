// 위약금 룰 엔진 — AI 불사용, 순수 함수. vitest 경계값 테스트 필수.
export type PenaltyInput = {
  serviceType: "agency" | "hall";
  contractDate: string;   // ISO
  eventDate: string;      // ISO
  cancelDate: string;     // ISO
  totalAmount: number;
  paidAmount: number;
};

export type PenaltyResult = {
  fairPenalty: number;
  formula: string;   // 산식 설명
  basis: string;     // 소비자분쟁해결기준 근거
};

export function calcPenalty(_input: PenaltyInput): PenaltyResult {
  // TODO: 소비자분쟁해결기준(결혼준비대행/예식장) 시점 밴드별 산식 구현
  throw new Error("not implemented");
}
