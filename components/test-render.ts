import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * 컴포넌트 테스트 보조 (S1-02 · S1-03)
 *
 * 새 의존성(jsdom·testing-library)을 넣지 않기 위해 `react-dom/server` 의 정적 렌더
 * 결과 문자열만 검사한다. 이 프로젝트의 공통 컴포넌트 테스트는 "규칙이 화면에 남아 있는가"
 * 를 고정하는 것이 목적이라 DOM 상호작용이 필요 없다.
 */

/** 정적 마크업 문자열. 클래스·data 속성까지 그대로 들어 있다. */
export function html(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/** 태그를 걷어낸 사람이 읽는 텍스트. 공백은 한 칸으로 정규화한다. */
export function text(element: ReactElement): string {
  return html(element)
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** 소스 자체를 검사할 때 쓴다 — "이 파일에 문구·요율이 박혀 있지 않은가" 같은 규칙용. */
export function readSource(url: string): string {
  return readFileSync(fileURLToPath(url), "utf8");
}
