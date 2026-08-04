// 검출 룰 정의 진입점. 룰 20종은 supabase seed(detect_rules)와 코드에서 동기 관리.
// 프레임워크 의존 금지 (Expo 재사용 대비).
export type DetectRule = {
  code: string;            // 예: "PENALTY_BASIS"
  docType: "agency" | "hall" | "studio" | "dress" | "makeup" | "etc";
  title: string;
  severityDefault: "red" | "yellow";
  basisRef: string;        // 표준약관·기준 조항 참조
  promptFragment: string;  // AI 검출 지시문
  active: boolean;
};

export const DETECT_RULES: DetectRule[] = [
  // TODO: 룰 20종 정의 (docs/03 목록: 위약금 기준·환불·플래너 교체 통지·추가비용 명시·청약철회·지연배상·관할 등)
];
