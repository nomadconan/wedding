/**
 * 이미지·아이콘 자산 매니페스트 — 단일 진실 (T-02c)
 *
 * 규약
 * - 슬롯 id 는 `{영역}.{슬롯}` 점 표기. 코드는 항상 id 로만 자산을 참조한다.
 * - path 는 `/images/{그룹}/{화면}-{슬롯}@{W}x{H}.{png|svg}` 형식이며 `public/` 기준 절대 경로다.
 * - 실제 이미지 교체는 **같은 경로·같은 파일명으로 덮어쓰기**만 한다. 코드 수정 불필요.
 * - alt 는 접근성 필수값이다(명세서 §7.5 WCAG 2.1 AA). 빈 문자열 금지.
 *
 * 슬롯 근거: docs/07_개발명세서.md §6 화면 명세의 **R1 화면**에서 실제로 이미지가 필요한 곳만 정의한다.
 * 새 슬롯을 추가하려면 docs/ASSETS.md 의 절차를 따른다.
 *
 * 확장자 선택 기준
 * - svg: 로고·심볼·브랜드 아이콘·빈 상태 일러스트(벡터로 제작·교체되는 것)
 * - png: OG·히어로·가이드 썸네일·온보딩 일러스트(래스터로 제작·교체되는 것)
 */

export type AssetSlot = {
  /** 'landing.hero' 형태의 점 표기 슬롯 id */
  id: string;
  /** public 기준 절대 경로 */
  path: string;
  width: number;
  height: number;
  /** 접근성 대체 텍스트 (필수) */
  alt: string;
  /** 용도 설명 — 어느 화면·기능에서 쓰는지 */
  note?: string;
};

export const ASSETS = {
  // ── brand — 로고·심볼·OG (전 영역 공통) ────────────────────────────────
  "brand.logo": {
    id: "brand.logo",
    path: "/images/brand/brand-logo@240x48.svg",
    width: 240,
    height: 48,
    alt: "웨딩클리어",
    note: "헤더·푸터 워드마크. 전 라우트 그룹 공통.",
  },
  "brand.symbol": {
    id: "brand.symbol",
    path: "/images/brand/brand-symbol@512x512.svg",
    width: 512,
    height: 512,
    alt: "웨딩클리어 심볼",
    note: "앱 아이콘·파비콘·PWA 매니페스트 원본. Capacitor 래핑(D-07) 시 아이콘 소스.",
  },
  "brand.og-default": {
    id: "brand.og-default",
    path: "/images/brand/brand-og-default@1200x630.png",
    width: 1200,
    height: 630,
    alt: "웨딩클리어 — 광고 없는 투명 가격 웨딩 직거래 플랫폼",
    note: "페이지별 OG 이미지가 지정되지 않았을 때의 기본값. og:image 표준 비율 1.91:1.",
  },

  // ── marketing — 랜딩·가이드 (§6.1, F-C-24) ─────────────────────────────
  "landing.hero": {
    id: "landing.hero",
    path: "/images/marketing/landing-hero@1600x900.png",
    width: 1600,
    height: 900,
    alt: "여러 웨딩 업체의 총액과 추가금을 나란히 비교하는 웨딩클리어 화면",
    note: "`/` 랜딩 히어로. 가치 제안(광고 없는 투명 가격) 영역. LCP 대상이므로 priority 지정 권장(§7.1).",
  },
  "guide.thumbnail-default": {
    id: "guide.thumbnail-default",
    path: "/images/marketing/guide-thumbnail-default@800x450.png",
    width: 800,
    height: 450,
    alt: "웨딩 준비 가이드 문서 대표 이미지",
    note: "`/guides/[slug]` 목록 카드·본문 상단 대표 이미지의 기본값. 글별 이미지가 있으면 그것을 우선한다.",
  },

  // ── consumer — 온보딩 6단계 일러스트 (§6.1 /onboarding, F-C-01) ────────
  "onboarding.step1": {
    id: "onboarding.step1",
    path: "/images/consumer/onboarding-step-1@480x360.png",
    width: 480,
    height: 360,
    alt: "예식 예정일을 달력에서 고르는 모습",
    note: "온보딩 1단계 — 예식 예정일.",
  },
  "onboarding.step2": {
    id: "onboarding.step2",
    path: "/images/consumer/onboarding-step-2@480x360.png",
    width: 480,
    height: 360,
    alt: "지도에서 예식 지역을 고르는 모습",
    note: "온보딩 2단계 — 지역.",
  },
  "onboarding.step3": {
    id: "onboarding.step3",
    path: "/images/consumer/onboarding-step-3@480x360.png",
    width: 480,
    height: 360,
    alt: "총 예산 금액을 입력하는 모습",
    note: "온보딩 3단계 — 예산 총액.",
  },
  "onboarding.step4": {
    id: "onboarding.step4",
    path: "/images/consumer/onboarding-step-4@480x360.png",
    width: 480,
    height: 360,
    alt: "하객 규모를 고르는 모습",
    note: "온보딩 4단계 — 하객 규모.",
  },
  "onboarding.step5": {
    id: "onboarding.step5",
    path: "/images/consumer/onboarding-step-5@480x360.png",
    width: 480,
    height: 360,
    alt: "선호하는 예식 스타일을 고르는 모습",
    note: "온보딩 5단계 — 스타일 선호.",
  },
  "onboarding.step6": {
    id: "onboarding.step6",
    path: "/images/consumer/onboarding-step-6@480x360.png",
    width: 480,
    height: 360,
    alt: "현재 웨딩 준비 진행 단계를 고르는 모습",
    note: "온보딩 6단계 — 진행 단계. 완료 시 결과 요약으로 이어진다.",
  },

  // ── consumer — 빈 상태 (§6 공통 UI 규칙: 로딩·빈 상태·에러 3종 필수) ───
  "reports.empty": {
    id: "reports.empty",
    path: "/images/consumer/reports-empty@320x240.svg",
    width: 320,
    height: 240,
    alt: "아직 등록된 검토 리포트가 없음",
    note: "`/reports` 빈 상태 (F-C-07). 업로드 CTA와 함께 노출.",
  },
  "budget.empty": {
    id: "budget.empty",
    path: "/images/consumer/budget-empty@320x240.svg",
    width: 320,
    height: 240,
    alt: "아직 등록된 예산 내역이 없음",
    note: "`/budget` 빈 상태 (F-C-05). 총예산 입력 CTA와 함께 노출.",
  },
  "explore.empty": {
    id: "explore.empty",
    path: "/images/consumer/explore-empty@320x240.svg",
    width: 320,
    height: 240,
    alt: "조건에 맞는 업체 검색 결과가 없음",
    note: "`/explore` 필터 결과 0건 빈 상태 (F-C-10). 정렬 기준 배지는 빈 상태에서도 함께 노출한다.",
  },

  // ── vendor — 업체 어드민 빈 상태 (§6.3, F-V-12) ────────────────────────
  "vendor.dashboard.empty": {
    id: "vendor.dashboard.empty",
    path: "/images/vendor/vendor-dashboard-empty@320x240.svg",
    width: 320,
    height: 240,
    alt: "아직 도착한 문의가 없음",
    note: "`/vendor` 대시보드 빈 상태 — 신규 문의·응답 대기 0건.",
  },

  // ── admin — 운영 콘솔 빈 상태 (§6.4, F-A-07) ───────────────────────────
  "admin.dashboard.empty": {
    id: "admin.dashboard.empty",
    path: "/images/admin/admin-dashboard-empty@320x240.svg",
    width: 320,
    height: 240,
    alt: "표시할 지표 데이터가 없음",
    note: "`/admin` 지표 대시보드 빈 상태 — 집계 기간에 데이터가 없을 때.",
  },

  // ── icons — 브랜드 정체성이 담긴 아이콘만 (기능성 글리프는 lucide-react) ─
  "icon.clear-avatar": {
    id: "icon.clear-avatar",
    path: "/images/icons/icon-clear-avatar@64x64.svg",
    width: 64,
    height: 64,
    alt: "AI 플래너 클리어",
    note: "`/planner` 대화 아바타 (F-C-03). 브랜드 캐릭터이므로 파일 슬롯으로 관리한다.",
  },
  "icon.no-paid-placement": {
    id: "icon.no-paid-placement",
    path: "/images/icons/icon-no-paid-placement@24x24.svg",
    width: 24,
    height: 24,
    alt: "검색 순위에 광고 반영 없음",
    note: "정렬 기준 배지 아이콘 (CLAUDE.md §2.2 / §6 공통 UI 규칙). 목록·추천 결과에 상시 노출.",
  },
} as const satisfies Record<string, AssetSlot>;

/** 매니페스트에 등록된 슬롯 id 만 허용하는 좁힌 키 타입 */
export type AssetId = keyof typeof ASSETS;

/** 스크립트·테스트용 순회 배열 */
export const ASSET_LIST: readonly AssetSlot[] = Object.values(ASSETS);

/** 존재가 타입으로 보장된 슬롯 조회 */
export function getAsset(id: AssetId): AssetSlot {
  return ASSETS[id];
}
