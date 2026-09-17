// AI 회귀 골든셋 진입점 (FIX-42 · 명세서 §7.5)
//
// 프레임워크를 모른다 — 테스트(`npm run ai:golden`)와 운영자 콘솔(`/admin/rules`)이
// **같은 함수**를 부른다. 둘이 각자 계산하면 화면이 말하는 게이트와 배포를 막는
// 게이트가 갈리고, 그러면 화면을 믿을 수 없다(S8-06 이 `buildRuleConsole` 에서
// 병합을 다시 구현하지 않은 것과 같은 이유다).

export { CLAUSE_CASES } from "./clauses";
export { CONTRACT_CASES } from "./contracts";
export { MODEL_CASES, type ModelCase } from "./model-cases";

export {
  GOLDEN_CASES,
  GOLDEN_UNMEASURED,
  coverageGaps,
  runCase,
  runGoldenSet,
  runModelCase,
  ruleCoverage,
  type GoldenFailure,
  type GoldenResult,
  type ModelCheck,
  type RuleCoverage,
} from "./run";

export {
  GOLDEN_PATHS,
  GOLDEN_PATH_LABEL,
  type GoldenCase,
  type GoldenCaseKind,
  type GoldenCheck,
  type GoldenPath,
} from "./types";
