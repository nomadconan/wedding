import { describe, expect, it } from "vitest";

import {
  BROKER_NOTICE,
  BROKER_NOTICE_REQUIRED_PHRASE,
  BROKER_NOTICE_TERMS_HINT,
  BROKER_NOTICE_TERMS_LABEL,
  hasBrokerNotice,
} from "@/lib/core/legal";

import { html, readSource, text } from "../test-render";
import { BrokerNotice } from "./BrokerNotice";

describe("BROKER_NOTICE 문구 (D-24, §7.7)", () => {
  it("플랫폼 지위를 사실로 진술한다", () => {
    expect(BROKER_NOTICE).toContain("통신판매중개자");
    expect(BROKER_NOTICE).toContain(BROKER_NOTICE_REQUIRED_PHRASE);
    expect(hasBrokerNotice(BROKER_NOTICE)).toBe(true);
  });

  it("필수 문구가 빠진 고지를 거부한다", () => {
    expect(hasBrokerNotice("웨딩클리어는 중개 서비스입니다.")).toBe(false);
    expect(hasBrokerNotice("")).toBe(false);
  });

  it("책임 면제·법적 단정 표현을 쓰지 않는다", () => {
    // O-03 법무 검수 전이므로 약관 문안을 여기서 확정하지 않는다.
    for (const banned of [
      "책임을 지지 않",
      "책임이 없습니다",
      "면책",
      "일체의 책임",
      "보증합니다",
      "법적 효력",
    ]) {
      expect(BROKER_NOTICE).not.toContain(banned);
    }
  });

  it("플랫폼이 이행·품질을 보증하는 것처럼 읽히는 표현이 없다", () => {
    for (const banned of ["보장", "안전거래를 책임", "품질을 보증"]) {
      expect(BROKER_NOTICE).not.toContain(banned);
    }
  });
});

describe("BrokerNotice — 문구 변조 불가 (S1-03)", () => {
  it("inline 변형이 lib/core 상수를 그대로 렌더한다", () => {
    expect(text(<BrokerNotice />)).toContain(BROKER_NOTICE);
  });

  it("compact 변형도 같은 문구를 그대로 렌더한다", () => {
    expect(text(<BrokerNotice variant="compact" />)).toContain(BROKER_NOTICE);
  });

  it("컴포넌트 소스에 문구 사본이 없다 — 상수를 읽는 길뿐이다", () => {
    const source = readSource(new URL("./BrokerNotice.tsx", import.meta.url).href);
    // 주석은 규칙 근거를 적는 자리라 검사 대상이 아니다. 실행되는 코드만 본다.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // 코드에 '통신판매중개자'가 나타나면 상수를 우회해 문구를 다시 쓴 것이다.
    expect(code).not.toContain("통신판매중개자");
    expect(code).not.toContain("계약 당사자");
    expect(code).toContain("BROKER_NOTICE");
  });

  it("접기·닫기·툴팁 수단을 두지 않는다 (AiDisclaimer 와 동일)", () => {
    const source = readSource(new URL("./BrokerNotice.tsx", import.meta.url).href);

    for (const banned of ["dismiss", "collapsible", "collapse", "onClose", "closable", "tooltip"]) {
      expect(source.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

describe("BrokerNotice — 변형과 이용약관 자리", () => {
  it("변형을 data 속성으로 구분한다", () => {
    expect(html(<BrokerNotice />)).toContain('data-variant="inline"');
    expect(html(<BrokerNotice variant="compact" />)).toContain('data-variant="compact"');
  });

  it("두 변형 모두 보조 정보(role=note)로 읽힌다", () => {
    expect(html(<BrokerNotice />)).toContain('role="note"');
    expect(html(<BrokerNotice variant="compact" />)).toContain('role="note"');
  });

  it("링크 대상이 없으면 참조 안내만 두고 링크를 만들지 않는다", () => {
    const markup = html(<BrokerNotice />);

    expect(text(<BrokerNotice />)).toContain(BROKER_NOTICE_TERMS_HINT);
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain('data-testid="broker-notice-terms-link"');
  });

  it("링크 대상이 정해지면 이용약관 링크가 붙는다", () => {
    const markup = html(<BrokerNotice termsHref="/terms" />);

    expect(markup).toContain('data-testid="broker-notice-terms-link"');
    expect(markup).toContain('href="/terms"');
    expect(text(<BrokerNotice termsHref="/terms" />)).toContain(BROKER_NOTICE_TERMS_LABEL);
  });

  it("compact 에서도 링크 자리는 같다", () => {
    expect(html(<BrokerNotice variant="compact" termsHref="/terms" />)).toContain(
      'data-testid="broker-notice-terms-link"',
    );
  });
});
