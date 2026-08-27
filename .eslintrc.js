/**
 * ESLint 설정.
 *
 * **`.eslintrc.json` 에서 옮겨 왔다(S8-05).** JSON 은 주석을 담지 못하는데, 아래
 * `no-restricted-imports` 는 **왜 막는지**가 규칙 자체만큼 중요하다 — 이유가 없으면
 * 다음 사람이 "왜 안 되지" 하고 예외를 뚫는다. ESLint 는 `.eslintrc.js` 를 `.json` 보다
 * 먼저 고르므로 둘을 같이 두면 진실이 둘이 된다. 그래서 `.json` 은 지웠다.
 */
module.exports = {
  extends: ["next/core-web-vitals"],
  ignorePatterns: [
    "node_modules/",
    ".next/",
    "out/",
    "coverage/",
    "tmp/",
    "_local_reports/",
    "types/database.ts",
    "supabase/",
  ],
  overrides: [
    {
      /**
       * `lib/core` 는 프레임워크 무관이어야 한다 (CLAUDE.md §3.1).
       *
       * Expo 전환 시 `lib/core` 를 패키지로 승격해 그대로 재사용하는 것이 전제이고,
       * React/Next 를 import 하는 순간 그 전제가 깨진다. **T-04 가 미뤄 둔 규칙을
       * S8-05 가 붙였다** — 당시엔 수정 허용 범위가 `lib/core`·테스트로 한정돼
       * 설정 파일을 건드릴 수 없었다.
       *
       * **`lib/core/no-framework-imports.test.ts` 를 지우지 않았다.** 둘은 잡는
       * 시점이 다르다: 린트는 에디터에서 **타이핑하는 즉시** 빨간 줄을 긋고, 테스트는
       * `npm run test` 에서 잡는다. 그리고 테스트는 린트가 못 보는 것을 본다 —
       * 이 파일이 지워지거나 `ignorePatterns` 가 넓어져도 테스트는 계속 돈다.
       * 방어선을 하나로 줄이면 그 하나가 꺼졌을 때 아무도 모른다.
       */
      files: ["lib/core/**/*.ts", "lib/core/**/*.tsx"],
      // 테스트는 제외한다 — 시험 대상을 import 해야 하고, 실제로
      // `no-framework-imports.test.ts` 자신이 `node:fs` 를 쓴다.
      excludedFiles: ["lib/core/**/*.test.ts", "lib/core/**/*.spec.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              { name: "react", message: "lib/core 는 프레임워크 무관이다(CLAUDE.md §3.1). 화면 층으로 옮긴다." },
              { name: "react-dom", message: "lib/core 는 프레임워크 무관이다(CLAUDE.md §3.1)." },
              { name: "next", message: "lib/core 는 프레임워크 무관이다(CLAUDE.md §3.1)." },
              { name: "@anthropic-ai/sdk", message: "AI 클라이언트는 lib/ai(서버 전용)에 둔다(CLAUDE.md §3.1)." },
              { name: "@supabase/supabase-js", message: "DB 접근은 lib/supabase 에 둔다. lib/core 는 순수 로직이다." },
              { name: "@supabase/ssr", message: "DB 접근은 lib/supabase 에 둔다. lib/core 는 순수 로직이다." },
            ],
            patterns: [
              { group: ["next/*"], message: "lib/core 는 프레임워크 무관이다(CLAUDE.md §3.1)." },
              { group: ["@supabase/*"], message: "DB 접근은 lib/supabase 에 둔다. lib/core 는 순수 로직이다." },
              {
                group: ["@/lib/supabase/*", "@/lib/ai/*", "@/components/*", "@/app/*"],
                message: "lib/core 는 바깥 층을 import 하지 않는다. 의존 방향은 한쪽이다(CLAUDE.md §3.1).",
              },
            ],
          },
        ],
      },
    },
  ],
};
