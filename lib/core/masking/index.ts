// 개인정보 마스킹 (명세서 §5.2 3단계 / CLAUDE.md §5.2)
//
//  * AI 전달 **전에** 이름·연락처·주민번호·주소·계좌·사업자번호를 치환한다.
//  * 마스킹 맵은 이 함수의 **반환값으로만** 전달한다.
//    DB·로그·파일에 쓰지 않으며, 이 모듈은 어떤 경우에도 console 을 호출하지 않는다.
//  * 마스킹 실패(차단 대상 패턴 잔존) 시 호출부는 AI 호출을 중단하고 경보를 남긴다.

import {
  BLOCKING_MASK_PATTERNS,
  MASK_PATTERNS,
  PII_KINDS,
  type MaskPattern,
  type PiiKind,
} from "./patterns";

export {
  BLOCKING_MASK_PATTERNS,
  BLOCKING_PII_KINDS,
  MASK_PATTERNS,
  PII_KINDS,
  type MaskPattern,
  type PiiKind,
} from "./patterns";

/** 치환 토큰 → 원문. **메모리 전용**. 직렬화·저장·로깅 금지. */
export type MaskingMap = Readonly<Record<string, string>>;

/** 마스킹 후에도 남아 있는 위험 패턴. */
export type ResidualRisk = {
  kind: PiiKind;
  /** 어떤 패턴이 걸렸는지(patterns.ts 의 id). */
  patternId: string;
  /** 잔존 위치. 원문 값은 담지 않는다 — 경보 로그에 실려 나가면 안 되기 때문이다. */
  index: number;
  /** 잔존 문자열의 길이만 기록한다. */
  length: number;
};

export type MaskingResult = {
  /** 치환이 끝난 텍스트. AI 에는 이 값만 전달한다. */
  masked: string;
  /** 토큰 → 원문 매핑. 메모리 전용. */
  map: MaskingMap;
  /** 종류별 치환 건수. */
  counts: Readonly<Record<PiiKind, number>>;
  /** 마스킹 후 잔존한 차단 대상 패턴. 비어 있어야 정상이다. */
  residual: readonly ResidualRisk[];
  /** residual 이 비어 있으면 true. false 면 AI 호출을 중단해야 한다. */
  complete: boolean;
};

export type MaskingOptions = {
  /**
   * 적용할 종류를 제한한다. 미지정이면 전 종류를 적용한다.
   * (일부만 적용해 잔존 검출 동작을 확인하는 테스트 등에서 사용)
   */
  kinds?: readonly PiiKind[];
};

/** 마스킹이 끝나지 않은 텍스트를 AI 로 보내려 할 때 던지는 오류. */
export class MaskingIncompleteError extends Error {
  readonly residual: readonly ResidualRisk[];

  constructor(residual: readonly ResidualRisk[]) {
    // 메시지에 원문 조각을 담지 않는다(CLAUDE.md §5.3).
    super(
      `마스킹 실패: 차단 대상 패턴 ${residual.length}건이 남아 있습니다 ` +
        `(${[...new Set(residual.map((r) => r.kind))].join(", ")}).`,
    );
    this.name = "MaskingIncompleteError";
    this.residual = residual;
  }
}

function emptyCounts(): Record<PiiKind, number> {
  return PII_KINDS.reduce(
    (acc, kind) => {
      acc[kind] = 0;
      return acc;
    },
    {} as Record<PiiKind, number>,
  );
}

/** 종류별 토큰 접두어. */
const TOKEN_PREFIX: Record<PiiKind, string> = {
  rrn: "RRN",
  biz_no: "BIZ",
  phone: "PHONE",
  email: "EMAIL",
  account: "ACCOUNT",
  address: "ADDR",
  name: "NAME",
};

/** g 플래그 사본. 패턴 원본은 상태를 갖지 않도록 g 없이 정의돼 있다. */
function globalCopy(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
}

/**
 * 텍스트에서 개인정보를 토큰으로 치환한다.
 *
 * 같은 원문 값은 같은 토큰으로 치환한다(결정적). 문서 안에서 동일인이
 * 여러 번 등장해도 AI 가 동일 인물로 인식할 수 있게 하기 위해서다.
 */
export function maskText(text: string, options: MaskingOptions = {}): MaskingResult {
  const activeKinds = options.kinds ?? PII_KINDS;
  const patterns = MASK_PATTERNS.filter((p) => activeKinds.includes(p.kind));

  const counts = emptyCounts();
  const map: Record<string, string> = {};
  // 원문 → 토큰. 같은 값에 같은 토큰을 재사용한다.
  const assigned = new Map<string, string>();
  const serial = emptyCounts();

  let masked = text;

  for (const pattern of patterns) {
    masked = applyPattern(masked, pattern, { counts, map, assigned, serial });
  }

  const residual = detectResidualPii(masked);

  return {
    masked,
    map,
    counts,
    residual,
    complete: residual.length === 0,
  };
}

type ApplyState = {
  counts: Record<PiiKind, number>;
  map: Record<string, string>;
  assigned: Map<string, string>;
  serial: Record<PiiKind, number>;
};

function applyPattern(text: string, pattern: MaskPattern, state: ApplyState): string {
  const regex = globalCopy(pattern.regex);

  return text.replace(regex, (match, ...args) => {
    // 캡처 그룹만 치환하는 경우(이름 등)를 지원한다.
    const groupIndex = pattern.group;
    const captured = groupIndex === undefined ? match : (args[groupIndex - 1] as string | undefined);

    if (captured === undefined || captured === "") return match;
    if (pattern.skipIf?.test(captured)) return match;
    // 이미 토큰으로 치환된 자리는 다시 건드리지 않는다.
    if (/^\[[A-Z_]+_\d+\]$/.test(captured)) return match;

    let token = state.assigned.get(captured);
    if (token === undefined) {
      state.serial[pattern.kind] += 1;
      token = `[${TOKEN_PREFIX[pattern.kind]}_${state.serial[pattern.kind]}]`;
      state.assigned.set(captured, token);
      state.map[token] = captured;
    }

    state.counts[pattern.kind] += 1;

    return groupIndex === undefined ? token : match.replace(captured, token);
  });
}

/**
 * 텍스트에 차단 대상 개인정보 패턴이 남아 있는지 검사한다.
 *
 * 반환값에는 **원문 값을 담지 않는다** — 위치와 길이만 담는다.
 * 이 결과가 그대로 경보 로그로 나가더라도 개인정보가 유출되지 않게 하기 위해서다.
 */
export function detectResidualPii(text: string): ResidualRisk[] {
  const risks: ResidualRisk[] = [];

  for (const pattern of BLOCKING_MASK_PATTERNS) {
    const regex = globalCopy(pattern.regex);
    let m: RegExpExecArray | null;

    while ((m = regex.exec(text)) !== null) {
      const value = m[0];
      if (pattern.skipIf?.test(value)) continue;

      risks.push({
        kind: pattern.kind,
        patternId: pattern.id,
        index: m.index,
        length: value.length,
      });
    }
  }

  return risks.sort((a, b) => a.index - b.index);
}

/** 마스킹이 완료됐는지 판정한다. */
export function isMaskingComplete(text: string): boolean {
  return detectResidualPii(text).length === 0;
}

/**
 * 마스킹 완료를 단언한다. 실패하면 던진다.
 *
 * AI 호출 직전 게이트로 쓴다 — "일단 호출하고 나중에 처리" 를 구조적으로 막는다
 * (CLAUDE.md §5.2).
 */
export function assertMaskingComplete(text: string): void {
  const residual = detectResidualPii(text);
  if (residual.length > 0) {
    throw new MaskingIncompleteError(residual);
  }
}

/**
 * 마스킹 토큰을 원문으로 되돌린다.
 *
 * **사용자에게 결과를 보여줄 때만** 쓴다. AI 요청 경로에서는 절대 호출하지 않는다.
 */
export function unmaskText(masked: string, map: MaskingMap): string {
  let result = masked;
  for (const [token, original] of Object.entries(map)) {
    result = result.split(token).join(original);
  }
  return result;
}
