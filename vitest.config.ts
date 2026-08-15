import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// 단위 테스트 설정.
//
// 1) lib/core — 도메인 로직(검출 룰·위약금·가격 계산·zod 스키마). React/Next 를
//    import 하지 않으므로 node 환경으로 충분하다(CLAUDE.md §3.1).
// 2) components — 공통 컴포넌트가 **규칙을 그대로 렌더하는지** 고정하는 테스트.
//    `react-dom/server` 의 정적 렌더 결과 문자열만 검사하므로 jsdom 도, 테스트 라이브러리도
//    필요 없다. 새 의존성을 넣지 않기 위한 선택이다(S1-02·S1-03).
//    상호작용(클릭·포커스) 검증이 필요해지면 그때 E2E(Playwright)와 함께 도입한다.
export default defineConfig({
  // tsconfig 의 `jsx: "preserve"` 는 Next 빌드용이라 esbuild 가 JSX 를 그대로 남긴다.
  // 테스트 변환에서는 automatic 런타임으로 바꿔야 .tsx 가 실행된다.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: [
      "lib/core/**/*.test.ts",
      "lib/core/**/*.spec.ts",
      "lib/core/**/__tests__/**/*.ts",
      "components/**/*.test.tsx",
      // 3) lib/payments — **결제 어댑터의 계약**(멱등 · 프로덕션에서 스텁 거부).
      //    `lib/core` 가 아닌 것을 여기 넣는 이유: 어댑터는 DB 도 React 도 모르지만
      //    서버 전용이라 core 에 둘 수 없고, 동시에 **깨지면 돈이 두 번 빠지는**
      //    불변식이라 시험 없이 둘 수 없다(S4-08 의 보증금 스텁은 이 시험이 없었다).
      //    node 환경으로 충분하다 — 어댑터는 프레임워크를 import 하지 않는다.
      "lib/payments/**/*.test.ts",
      // S5-07. 지급 어댑터도 같은 이유다 — 깨지면 **보내지 않은 돈이 나갔다고
      // 기록**되고, 업체는 정산서의 '지급 완료' 를 보며 오지 않는 입금을 기다린다.
      "lib/settlements/**/*.test.ts",
      // S5-09. 에스크로 어댑터 — 깨지면 **맡기지도 않은 돈을 맡았다고 기록**하고
      // 고객은 "안전거래로 보호받고 있다" 는 화면을 보며 안심한다.
      "lib/escrow/**/*.test.ts",
      // S7-20. AI 툴 핸들러의 **권한 경계**. 깨지면 대화 한 줄로 남의 커플 데이터가
      // 나가고, 그 사고는 화면에 아무 흔적도 남기지 않는다. 소스를 글자로 읽는
      // 검사라 서버 API 를 끌어오지 않는다(`lib/core/no-framework-imports` 와 같은 방식).
      "lib/ai/**/*.test.ts",
    ],
    exclude: ["node_modules/**", ".next/**", "tmp/**", "_local_reports/**"],
    coverage: {
      include: ["lib/core/**/*.ts", "components/**/*.tsx"],
      exclude: ["lib/core/**/*.test.ts", "lib/core/**/*.spec.ts", "components/**/*.test.tsx"],
    },
  },
});
