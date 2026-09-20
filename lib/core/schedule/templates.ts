/**
 * 역산 템플릿 (S7-08 · 명세서 §2.1 F-C-04 · §3.2 · IDEA-02)
 *
 * **진실은 코드가 갖고 DB 는 사본이다.** 검출 룰(S7-01)이 세운 것과 같은 구조다 —
 * 여기서 목록을 정의하고 `seed.sql` 이 그것을 `task_templates`·
 * `task_template_dependencies` 로 옮기며, `db:rls` 가 둘을 대조한다. 사본은 어긋날 수
 * 있고 어긋나면 조용하기 때문이다.
 *
 * **순서가 템플릿에 들어 있다**(IDEA-02). 자동 생성이 태스크를 만들면서 이 순서를
 * `task_dependencies` 로 함께 옮긴다(S7-18 이 그 표를 만들었다).
 *
 * **오프셋은 추정이지 사실이 아니다.** D-360~D-0 은 일반적인 준비 흐름이며, 그래서
 * 선행 미완을 잠그지 않는다(§3.2) — 스드메를 먼저 계약하고 홀을 나중에 잡는 커플이
 * 있고 그것이 틀린 것이 아니다.
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

/**
 * 준비 축 어휘.
 *
 * **여섯에서 아홉이 됐다**(C-4a). 넷을 더해 달라는 요구(답례품 · 상견례 · 예복·한복 ·
 * 축의금 정산)를 받았는데, **기존 여섯에 우겨 넣으면 매핑이 거짓말을 한다** —
 * 예복·한복을 `sdm` 에 넣으면 그 칸은 `sold`(studio·dress·makeup·video)라서 화면이
 * "여기서 살 수 있어요" 라고 말하지만 **한복을 파는 곳은 우리에게 없다**. 답례품·
 * 축의금은 아예 들어갈 칸이 없다. D-206 이 두 축을 합치지 않기로 한 이유가 그대로
 * 여기에도 적용된다 — **칸이 없으면 만들지, 있는 칸의 뜻을 늘리지 않는다.**
 */
export const TASK_CATEGORIES = [
  "hall",
  "sdm",
  "yedan",
  "honsu",
  "document",
  "honeymoon",
  /** 양가가 함께 정하고 정리하는 일 — 상견례 · 축의금 정산(C-4a). */
  "family",
  /** 입는 것 중 신부 드레스가 아닌 것 — 신랑 예복 · 양가 한복(C-4a). */
  "attire",
  /** 하객에게 돌려주는 것 — 답례품 · 답례 인사(C-4a). */
  "gift",
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** §2.1 의 여섯에 C-4a 가 셋을 더했다. */
export const TASK_CATEGORY_LABEL: Record<TaskCategory, string> = {
  hall: "웨딩홀",
  sdm: "스드메",
  yedan: "예단·예물",
  honsu: "혼수",
  document: "서류",
  honeymoon: "허니문",
  family: "양가",
  attire: "예복·한복",
  gift: "답례",
};

export type ScheduleTemplate = {
  /** 안정 키. uuid 가 아니라 이 값이 정체성이다(S7-18). */
  code: string;
  category: TaskCategory;
  title: string;
  /**
   * 예식일 기준 오프셋(D-360 → -360).
   *
   * **양수는 예식 뒤다**(C-4a). 축의금 정산·혼인신고 제출·답례처럼 예식이 끝나야
   * 시작되는 일이 있는데, 전에는 목록이 전부 음수라 **적을 자리가 없었다**.
   * DB 에도 부호 제약이 없었으므로(실측) 막고 있던 것은 제약이 아니라 **목록 자체**였다.
   */
  offsetDays: number;
  /** 이 템플릿보다 **먼저** 끝나야 하는 코드. */
  dependsOn: readonly string[];
};

/**
 * 템플릿 판본.
 *
 * 목록이 바뀌면 올린다 — `db:rls` 가 코드↔DB 판본을 대조하므로 시드를 다시 넣지 않으면
 * 검사가 어긋남을 알린다(S7-01 과 같은 방식).
 */
export const SCHEDULE_TEMPLATES_VERSION = "2026-09-21-a";

/**
 * 역산 목록.
 *
 * **선행은 '없으면 곤란한 것' 만 건다.** 순서를 촘촘히 걸수록 그래프는 정교해 보이지만
 * 현실과 어긋날 확률이 함께 오르고, 어긋난 순서는 사용자가 지우려 든다(§3.2 — 잠그면
 * 우회하려고 의존을 지우고 그때 데이터가 망가진다). 그래서 **날짜·장소가 정해져야
 * 성립하는 것**과 **계약이 있어야 진행되는 것**에만 건다.
 */
export const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
  // ── 홀 — 날짜와 장소가 모든 것의 앞에 온다 ─────────────────────────────────
  {
    code: "T-hall-tour",
    category: "hall",
    title: "웨딩홀 투어·상담",
    offsetDays: -330,
    dependsOn: [],
  },
  {
    code: "T-hall-contract",
    category: "hall",
    title: "웨딩홀 계약",
    offsetDays: -300,
    dependsOn: ["T-hall-tour"],
  },
  {
    code: "T-hall-guest-count",
    category: "hall",
    title: "예상 하객 수 정리",
    offsetDays: -120,
    // 보증인원은 홀 계약 조건이라 계약이 먼저다.
    dependsOn: ["T-hall-contract"],
  },
  {
    code: "T-hall-meal",
    category: "hall",
    title: "식사·연회 메뉴 확정",
    offsetDays: -60,
    dependsOn: ["T-hall-guest-count"],
  },
  {
    code: "T-hall-rehearsal",
    category: "hall",
    title: "예식 진행 순서 확정",
    offsetDays: -21,
    dependsOn: ["T-hall-contract"],
  },

  // ── 스드메 ─────────────────────────────────────────────────────────────────
  {
    code: "T-sdm-contract",
    category: "sdm",
    title: "스드메 계약",
    offsetDays: -270,
    // 날짜가 정해져야 스튜디오·드레스 일정을 잡는다.
    dependsOn: ["T-hall-contract"],
  },
  {
    code: "T-sdm-dress-fitting",
    category: "sdm",
    title: "드레스 가봉",
    offsetDays: -120,
    dependsOn: ["T-sdm-contract"],
  },
  {
    code: "T-sdm-studio",
    category: "sdm",
    title: "스튜디오 촬영",
    offsetDays: -150,
    dependsOn: ["T-sdm-contract"],
  },
  {
    code: "T-sdm-album",
    category: "sdm",
    title: "앨범 사진 고르기",
    offsetDays: -90,
    dependsOn: ["T-sdm-studio"],
  },

  // ── 예단·예물 ──────────────────────────────────────────────────────────────
  {
    code: "T-yedan-talk",
    category: "yedan",
    title: "양가 예단 범위 상의",
    offsetDays: -180,
    dependsOn: [],
  },
  {
    code: "T-yedan-prepare",
    category: "yedan",
    title: "예단·예물 준비",
    offsetDays: -90,
    dependsOn: ["T-yedan-talk"],
  },

  // ── 혼수 ───────────────────────────────────────────────────────────────────
  {
    code: "T-honsu-home",
    category: "honsu",
    title: "신혼집 계약",
    offsetDays: -210,
    dependsOn: [],
  },
  {
    code: "T-honsu-furniture",
    category: "honsu",
    title: "가전·가구 준비",
    offsetDays: -60,
    // 집이 정해져야 크기와 배치를 정한다.
    dependsOn: ["T-honsu-home"],
  },

  // ── 서류 ───────────────────────────────────────────────────────────────────
  {
    code: "T-doc-invitation",
    category: "document",
    title: "청첩장 주문",
    offsetDays: -60,
    // 날짜·장소가 인쇄물에 들어간다.
    dependsOn: ["T-hall-contract"],
  },
  {
    code: "T-doc-invitation-send",
    category: "document",
    title: "청첩장 전달",
    offsetDays: -30,
    dependsOn: ["T-doc-invitation", "T-hall-guest-count"],
  },
  {
    code: "T-doc-marriage",
    category: "document",
    title: "혼인신고 서류 확인",
    offsetDays: -14,
    dependsOn: [],
  },
  {
    code: "T-doc-marriage-file",
    category: "document",
    title: "혼인신고 제출",
    // **예식 뒤다.** 서류 '확인'(D-14)만 있고 실제 '제출' 이 없었다(B-1 조사 4-2).
    offsetDays: 30,
    dependsOn: ["T-doc-marriage"],
  },

  // ── 허니문 ─────────────────────────────────────────────────────────────────
  {
    code: "T-honeymoon-plan",
    category: "honeymoon",
    title: "허니문 일정·예산 정하기",
    offsetDays: -150,
    dependsOn: ["T-hall-contract"],
  },
  {
    code: "T-honeymoon-booking",
    category: "honeymoon",
    title: "항공·숙소 예약",
    offsetDays: -120,
    dependsOn: ["T-honeymoon-plan"],
  },
  {
    code: "T-honeymoon-doc",
    category: "honeymoon",
    title: "여권·비자 확인",
    offsetDays: -60,
    dependsOn: ["T-honeymoon-plan"],
  },
// ── 양가 — 함께 정하고 함께 정리한다 ──────────────────────────────────────
  {
    code: "T-family-meeting",
    category: "family",
    title: "상견례",
    offsetDays: -320,
    // **홀 투어의 선행으로 걸지 않는다.** 양가가 만나기 전에 홀을 보러 다니는 커플이
    // 있고 그것이 틀린 것이 아니다(§3.2 — 없으면 곤란한 것만 건다).
    dependsOn: [],
  },
  {
    code: "T-family-settlement",
    category: "family",
    title: "축의금 정산",
    // **예식 뒤다.** 받은 뒤에야 셀 수 있다.
    offsetDays: 7,
    dependsOn: [],
  },

  // ── 예복·한복 — 신부 드레스가 아닌 입을 것 ────────────────────────────────
  {
    code: "T-attire-fitting",
    category: "attire",
    title: "예복·한복 맞춤",
    offsetDays: -90,
    // 날짜가 정해져야 맞춤·대여 일정을 잡는다(드레스 가봉과 같은 이유).
    dependsOn: ["T-hall-contract"],
  },

  // ── 답례 — 하객에게 돌려주는 것 ───────────────────────────────────────────
  {
    code: "T-gift-prepare",
    category: "gift",
    title: "답례품 준비",
    offsetDays: -30,
    // 수량이 하객 수에서 나온다.
    dependsOn: ["T-hall-guest-count"],
  },
  {
    code: "T-gift-thanks",
    category: "gift",
    title: "답례 인사",
    // **예식 뒤다.** 와 준 사람이 정해져야 한다.
    offsetDays: 14,
    dependsOn: ["T-gift-prepare"],
  },
];

export const SCHEDULE_TEMPLATE_CODES: ReadonlySet<string> = new Set(
  SCHEDULE_TEMPLATES.map((template) => template.code),
);

/** 간선 목록. 시드와 자동 생성이 같은 배열을 본다. */
export function templateEdges(): { templateCode: string; dependsOnCode: string }[] {
  return SCHEDULE_TEMPLATES.flatMap((template) =>
    template.dependsOn.map((dependsOnCode) => ({ templateCode: template.code, dependsOnCode })),
  );
}

/**
 * 목록이 스스로 온전한가.
 *
 * 시드를 만들기 전에 **코드가 자기 목록을 검사한다** — 없는 코드를 가리키는 선행이나
 * 순환이 시드에 들어가면 DB 트리거가 막지만(S7-18), 그때는 이미 `db:reset` 이 깨진
 * 뒤다. 여기서 먼저 잡는다.
 */
export type TemplateDefect =
  | { kind: "unknown_dependency"; code: string; dependsOn: string }
  | { kind: "self_dependency"; code: string }
  | { kind: "cycle"; codes: string[] }
  /** 선행이 나보다 늦게 시작한다. 순환은 아니지만 순서가 뒤집힌 목록이다. */
  | { kind: "offset_inversion"; code: string; dependsOn: string };

export function templateDefects(
  templates: readonly ScheduleTemplate[] = SCHEDULE_TEMPLATES,
): TemplateDefect[] {
  const byCode = new Map(templates.map((template) => [template.code, template]));
  const defects: TemplateDefect[] = [];

  for (const template of templates) {
    for (const dependsOn of template.dependsOn) {
      if (dependsOn === template.code) {
        defects.push({ kind: "self_dependency", code: template.code });
        continue;
      }

      const parent = byCode.get(dependsOn);

      if (parent === undefined) {
        defects.push({ kind: "unknown_dependency", code: template.code, dependsOn });
        continue;
      }

      // 선행은 **먼저** 끝나야 하므로 오프셋이 더 앞(더 작은 값)이어야 한다.
      if (parent.offsetDays > template.offsetDays) {
        defects.push({ kind: "offset_inversion", code: template.code, dependsOn });
      }
    }
  }

  // 순환 — 깊이 우선으로 되짚는다. 목록이 스무 개 남짓이라 단순 탐색으로 충분하다.
  const state = new Map<string, "visiting" | "done">();

  const walk = (code: string, stack: string[]): void => {
    if (state.get(code) === "done") return;

    if (state.get(code) === "visiting") {
      defects.push({ kind: "cycle", codes: [...stack.slice(stack.indexOf(code)), code] });

      return;
    }

    state.set(code, "visiting");

    for (const dependsOn of byCode.get(code)?.dependsOn ?? []) {
      if (byCode.has(dependsOn)) walk(dependsOn, [...stack, code]);
    }

    state.set(code, "done");
  };

  for (const template of templates) walk(template.code, []);

  return defects;
}
