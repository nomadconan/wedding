/**
 * `react-dom/server` 최소 타입 선언 (S1-02 · S1-03)
 *
 * 컴포넌트 테스트가 `renderToStaticMarkup` 하나만 쓰는데 `@types/react-dom` 이 설치돼 있지 않다.
 * 새 의존성 추가는 보고 대상이라(CLAUDE.md 작업 제약) 쓰는 함수 하나만 선언해 둔다.
 *
 * `@types/react-dom` 을 들이게 되면 **이 파일을 지운다.** 남겨 두면 정식 타입을 가린다.
 */
declare module "react-dom/server" {
  import type { ReactElement } from "react";

  export function renderToStaticMarkup(element: ReactElement): string;
}
