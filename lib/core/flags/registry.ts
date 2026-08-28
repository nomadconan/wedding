// 피처 플래그 레지스트리 (S8-12 · F-A-10)
//
// ══════════════════════════════════════════════════════════════════════════
// **코드가 어떤 플래그가 존재하는지 정하고, DB 가 그것이 켜져 있는지 정한다.**
// ══════════════════════════════════════════════════════════════════════════
//
// S7-01 이 검출 룰에서, S8-06 이 그 콘솔에서 세운 것과 같은 나눔이다.
//
//   코드가 갖는 것   플래그의 **존재**와 뜻 · 부분 스위치의 이름 · 개방 조건의 출처
//   DB 가 갖는 것    **켬/끔**(`enabled`) · 부분 스위치 값과 개방 조건 서술(`rollout_json`)
//
// **DB 에만 있는 키는 아무도 안 읽는다.** `isFeatureEnabled("없는키")` 를 부르는 코드가
// 없으므로 그 행은 켜 두어도 아무 일도 일어나지 않는다 — 화면은 "켜짐" 이라 적는데
// 기능은 닫혀 있다. 콘솔이 그런 행을 **드러낸다**(감추면 그 상태가 영원히 남는다).
//
// **코드에 있는데 DB 에 행이 없으면 꺼진 것이다.** `isFeatureEnabled` 가 그렇게 읽고
// (행이 없으면 false) 콘솔도 같은 말을 한다 — 두 곳이 갈리면 스위치가 거짓말을 한다.

/** 부분 공개 스위치. **코드가 이름을 갖는다** — 자유 JSON 편집을 열지 않는 이유다. */
export type PartialSwitch = { key: string; label: string; hint: string };

export type FlagSpec = {
  key: string;
  label: string;
  /** 이 플래그가 무엇을 여닫는가. 화면이 그대로 적는다. */
  effect: string;
  /**
   * **끄면 되돌아가지 않는 것.** 플래그는 되돌릴 수 있지만 켜져 있는 동안 벌어진 일은
   * 되돌릴 수 없다 — 누르기 전에 그 사실을 말한다.
   */
  irreversible: string;
  /** 개방 조건이 어디에 적혀 있는가(D-67 — `rollout_json` 에 적어 둔다). */
  conditionSource: string;
  /** 코드가 실제로 읽는 부분 스위치. 없으면 켬/끔만 있는 플래그다. */
  partials: PartialSwitch[];
};

export const FLAG_SPECS: readonly FlagSpec[] = [
  {
    key: "community.enabled",
    label: "커뮤니티",
    effect:
      "`/community` 세 화면과 업체 상세의 '커뮤니티 언급' 섹션이 열립니다. 꺼면 그 경로가 404 가 됩니다.",
    irreversible:
      "켜 둔 동안 쓰인 글·댓글·신고는 끄더라도 남습니다. 끄는 것은 입구를 닫는 것이지 기록을 지우는 것이 아닙니다.",
    conditionSource: "rollout_json.done · rollout_json.reason (D-67 — 무엇을 채워야 열리는지)",
    partials: [],
  },
  {
    key: "schedule.views",
    label: "준비 순서 뷰",
    effect:
      "`/checklist` 의 표현 넷을 각각 켜고 끕니다. 기본(역산 타임라인)까지 끄면 화면이 고를 것이 없어집니다.",
    irreversible:
      "표현을 끄면 그 뷰를 쓰던 사용자는 다음 방문에서 그것을 찾지 못합니다. 데이터는 그대로입니다.",
    conditionSource: "O-16 (표현별 실효 판정 · 측정은 S8-01 지표가 붙은 뒤)",
    // **키 이름을 코드가 갖는다.** `enabledViews` 가 읽는 것과 같아야 하며
    // `db:rls` 가 두 곳을 대조한다.
    partials: [
      { key: "timeline", label: "A 역산 타임라인", hint: "기본 표현입니다. 끄면 남는 표현이 기본이 됩니다." },
      { key: "progress", label: "B 카테고리 진행 게이지", hint: "" },
      { key: "next", label: "C 다음 할 일 카드", hint: "홈과 같은 컴포넌트를 씁니다." },
      { key: "graph", label: "D 의존 관계 뷰", hint: "" },
    ],
  },
];

export function specOf(key: string): FlagSpec | null {
  return FLAG_SPECS.find((spec) => spec.key === key) ?? null;
}

// =============================================================================
// 콘솔이 보는 모양
// =============================================================================

export type FlagRow = {
  key: string;
  label: string;
  effect: string;
  irreversible: string;
  conditionSource: string;
  /** 지금 켜져 있는가. **DB 행이 없으면 `false`** — `isFeatureEnabled` 와 같은 규칙이다. */
  enabled: boolean;
  /** DB 에 행이 있는가. 없으면 꺼진 것이고, 켜려면 행을 만들어야 한다. */
  inDatabase: boolean;
  /** 코드가 이 키를 아는가. 모르면 **아무도 안 읽는 행**이다. */
  inCode: boolean;
  partials: { key: string; label: string; hint: string; on: boolean }[];
  /** `rollout_json` 에서 부분 스위치를 뺀 나머지 — 개방 조건 서술이다(D-67). */
  conditions: Record<string, unknown>;
  updatedAt: string | null;
};

type RolloutRow = { key: string; enabled: boolean; rollout_json: unknown; updated_at: string };

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 코드 선언과 DB 행을 합친다.
 *
 * **양쪽 어긋남을 둘 다 낸다** — 코드에만 있는 키(행 없음 = 꺼짐)와 DB 에만 있는 키
 * (아무도 안 읽음). 감추면 그 상태가 영원히 남는다(S8-06 이 룰에서 정한 것과 같다).
 */
export function buildFlagConsole(rows: readonly RolloutRow[]): {
  flags: FlagRow[];
  unknownInDatabase: string[];
  missingInDatabase: string[];
  enabledCount: number;
} {
  const byKey = new Map(rows.map((row) => [row.key, row]));

  const known: FlagRow[] = FLAG_SPECS.map((spec) => {
    const row = byKey.get(spec.key);
    const rollout = asObject(row?.rollout_json);
    const partialKeys = new Set(spec.partials.map((partial) => partial.key));

    return {
      key: spec.key,
      label: spec.label,
      effect: spec.effect,
      irreversible: spec.irreversible,
      conditionSource: spec.conditionSource,
      // **행이 없으면 꺼진 것이다.** `isFeatureEnabled` 와 같은 규칙 — 두 곳이 갈리면
      // 스위치가 거짓말을 한다.
      enabled: row?.enabled === true,
      inDatabase: row !== undefined,
      inCode: true,
      partials: spec.partials.map((partial) => ({
        ...partial,
        on: rollout[partial.key] === true,
      })),
      // 부분 스위치를 뺀 나머지가 개방 조건 서술이다.
      conditions: Object.fromEntries(
        Object.entries(rollout).filter(([key]) => !partialKeys.has(key)),
      ),
      updatedAt: row?.updated_at ?? null,
    };
  });

  const orphans: FlagRow[] = rows
    .filter((row) => specOf(row.key) === null)
    .map((row) => ({
      key: row.key,
      label: "코드가 모르는 플래그",
      effect: "이 키를 읽는 코드가 없습니다. 켜 두어도 아무 일도 일어나지 않습니다.",
      irreversible: "—",
      conditionSource: "—",
      enabled: row.enabled,
      inDatabase: true,
      inCode: false,
      partials: [],
      conditions: asObject(row.rollout_json),
      updatedAt: row.updated_at,
    }));

  const flags = [...known, ...orphans];

  return {
    flags,
    unknownInDatabase: orphans.map((flag) => flag.key),
    missingInDatabase: known.filter((flag) => !flag.inDatabase).map((flag) => flag.key),
    // **코드가 아는 플래그 중 켜진 것만 센다** — 아무도 안 읽는 행을 세면 그 수가
    // "지금 열려 있는 기능" 을 뜻하지 않게 된다.
    enabledCount: known.filter((flag) => flag.enabled).length,
  };
}

// =============================================================================
// 조건 미충족 상태로 켜기
// =============================================================================

/**
 * **막지 않는다. 어긋났다는 사실을 드러낸다.** (D-145)
 *
 * D-70 은 "조건이 충족되면 켠다 — 끄고 두면 플래그가 거짓말을 한다" 를 정했다.
 * 반대 방향(조건이 안 채워졌는데 켜기)에 대한 판단이 필요했고, **막지 않기로** 했다.
 *
 *  1. **긴급 롤백이 이 플래그의 정의된 용도다**(§1.3 NOTE — 부분 공개와 긴급 롤백).
 *     장애로 껐다가 되돌리는 순간에 조건 검사가 막으면 **대응이 막힌다.**
 *  2. **조건은 기계가 판정할 수 있는 형태가 아니다.** `rollout_json` 의 `done` 배열과
 *     `reason` 문장은 사람이 읽는 서술이다. 코드가 "충족" 을 판정하는 척하면 **그
 *     판정이 사실처럼 굳는다**(D-123·D-133 이 임계·목표치에서 만난 자리와 같다).
 *  3. 그래서 **화면이 조건을 보여주고 사람이 판단**한다. 대신 **사유가 필수**이고,
 *     증적에 "무엇을 켰는가" 가 남는다.
 *
 * D-70 의 문장("행에 적힌 조건과 스위치가 어긋나면 다음 사람은 무엇을 믿어야 할지
 * 알 수 없다")은 **여기서도 그대로 지켜진다** — 어긋난 상태를 막는 대신 **보이게**
 * 해서, 다음 사람이 그 어긋남을 즉시 안다.
 */
export function conditionNotice(flag: FlagRow, turningOn: boolean): string | null {
  if (!turningOn) return null;
  if (Object.keys(flag.conditions).length === 0) {
    return "이 플래그에는 개방 조건이 적혀 있지 않습니다. 켠 뒤 rollout_json 에 왜 열었는지 남겨 주세요.";
  }

  return "개방 조건이 행에 적혀 있습니다. 아래를 읽고 켜 주세요 — 켜는 것을 막지는 않지만, 조건과 스위치가 어긋나면 다음 사람은 무엇을 믿어야 할지 알 수 없습니다.";
}

/** 부분 스위치를 전부 끄는 조치인가. 그 기능은 켜져 있는데 보여줄 것이 없어진다. */
export function emptyPartialWarning(flag: FlagRow, next: Record<string, boolean>): string | null {
  if (flag.partials.length === 0) return null;
  if (Object.values(next).some(Boolean)) return null;

  return "표현을 모두 끄면 기능은 켜져 있는데 화면에 고를 것이 없습니다. 기능 자체를 끄려면 위의 켬/끔을 쓰세요.";
}
