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
    ],
    exclude: ["node_modules/**", ".next/**", "tmp/**", "_local_reports/**"],
    coverage: {
      include: ["lib/core/**/*.ts", "components/**/*.tsx"],
      exclude: ["lib/core/**/*.test.ts", "lib/core/**/*.spec.ts", "components/**/*.test.tsx"],
    },
  },
});
