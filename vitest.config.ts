import { defineConfig } from "vitest/config";

// lib/core 단위 테스트 전용 설정.
// 도메인 로직(검출 룰·위약금·가격 계산·zod 스키마)은 lib/core 에만 존재하고
// React/Next 를 import 하지 않으므로 node 환경으로 충분하다. (CLAUDE.md §3.1)
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "lib/core/**/*.test.ts",
      "lib/core/**/*.spec.ts",
      "lib/core/**/__tests__/**/*.ts",
    ],
    exclude: ["node_modules/**", ".next/**", "tmp/**", "_local_reports/**"],
    coverage: {
      include: ["lib/core/**/*.ts"],
      exclude: ["lib/core/**/*.test.ts", "lib/core/**/*.spec.ts"],
    },
  },
});
