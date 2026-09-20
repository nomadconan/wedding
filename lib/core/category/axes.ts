/**
 * 카테고리 두 축과 그 사이의 매핑 (C-2a · D-206)
 *
 * **프레임워크를 모르는 순수 모듈이다**(CLAUDE.md §3.1).
 *
 * ── 왜 두 축인가 ───────────────────────────────────────────────────────────
 *
 * 이 리포에는 결혼 카테고리를 말하는 어휘가 **여럿**이고, 그중 둘이 서로 다른 것을 센다.
 *
 * | 축 | 어휘 | 세는 것 |
 * |---|---|---|
 * | **파는 축** | `VENDOR_CATEGORIES` (6) | 마켓플레이스가 **파는 것** — `vendors`·`products`·탐색 필터 |
 * | **준비 축** | `TASK_CATEGORIES` (9) | 예비부부가 **준비하는 것** — `tasks`·`task_templates`·체크리스트 |
 *
 * **겹치는 값은 `hall` 하나뿐이다.** 그 이유가 둘이 다른 것을 세기 때문이다 —
 * 체크리스트가 말하는 **예단·혼수·서류·허니문·양가·예복·답례를 마켓플레이스는 팔 수 없고**, 반대로
 * `studio`·`dress`·`makeup`·`video` 넷은 준비 축에서 **`sdm` 한 칸**이다.
 *
 * **하나로 합치지 않는다**(D-206). 합치면 둘 중 하나가 거짓말을 한다 — *팔 수 없는
 * 카테고리를 탐색 필터에 세우거나*, *준비 항목을 업체 카테고리 수에 맞춰 잘라내거나*다.
 * 후자는 범위 축소라 애초에 금지다(CLAUDE.md §2.1).
 *
 * ── 왜 표가 아니라 코드인가 (C-2a 판단) ───────────────────────────────────
 *
 * "스드메 = 스튜디오·드레스·메이크업·영상" 은 **운영 파라미터가 아니라 구조**다.
 * 요율·보증금처럼 운영하며 바뀌는 값이 아니라 **낱말의 뜻**이며, 운영자가 런타임에
 * 바꿀 일이 아니다. 표로 두면 RLS 정책·관리 화면·마이그레이션이 붙고 **환경마다 다른
 * 매핑**이 생길 수 있는데, 그것이 정확히 막으려는 것이다.
 *
 * 그리고 **이 리포에 이미 같은 모양이 있다** — `lib/core/budget/budget.ts` 의
 * `VENDOR_TO_BUDGET_CATEGORY` 가 업체 축 → 예산 축 매핑을 코드로 들고 테스트가 고정한다.
 * 새 방식을 만들지 않고 그 자리를 따랐다.
 *
 * **파는 축이 넓어질 때 매핑을 같은 커밋에서 고쳐야 하는 것은 비용이 아니라 목적이다** —
 * *어떤 준비 항목을 위한 카테고리인지* 를 정하지 않고 파는 축만 늘리는 것이 바로
 * 막으려는 드리프트다. 아래 완전성 검사가 그것을 강제한다.
 */

import { VENDOR_CATEGORIES, type VendorCategory } from "../schemas/vendor";
import { TASK_CATEGORIES, TASK_CATEGORY_LABEL, type TaskCategory } from "../schedule/templates";

export { VENDOR_CATEGORIES, TASK_CATEGORIES };
export type { VendorCategory, TaskCategory };

// =============================================================================
// 매핑 — 세 가지 상태를 **구분해서** 돌려준다
// =============================================================================

/**
 * 준비 항목에서 **파는 것으로 갈 수 있는가**.
 *
 * 세 상태를 하나로 뭉치지 않는 이유는 **화면이 서로 다른 말을 해야 하기** 때문이다.
 * 빈 배열 하나로 표현하면 "파는 게 없다" 와 "아직 안 정했다" 가 같아 보이고,
 * 빈 목록은 늘 **'아직 안 불러왔다'** 로 읽힌다(D-99·D-147·D-157 이 같은 결을 말한다).
 */
export type PrepMapping =
  | {
      /** 파는 곳이 있다. */
      readonly kind: "sold";
      readonly vendorCategories: readonly VendorCategory[];
    }
  | {
      /** 파는 것이 없다. **의도된 상태**이며 `why` 가 어느 쪽인지 가른다. */
      readonly kind: "not_sold";
      /**
       * `not_a_purchase` — **애초에 살 것이 아니다.** 관공서 일·양가 합의처럼
       *   플랫폼이 팔 수 있는 물건이 아니다. 카테고리를 늘려도 달라지지 않는다.
       * `not_yet_listed` — **살 것이긴 한데 우리가 아직 그 카테고리를 열지 않았다.**
       *   파는 축이 넓어지면 `sold` 로 바뀔 자리다(C-2 이후).
       */
      readonly why: "not_a_purchase" | "not_yet_listed";
      readonly note: string;
    };

/**
 * 조회 결과. `unmapped` 는 **매핑이 없는 것이 아니라 아직 안 한 것**이며 **결함**이다 —
 * 아래 `assertPrepAxisFullyMapped()` 와 단위 테스트가 알려진 카테고리에서는
 * 이 값이 나올 수 없게 막는다. 런타임에 모르는 문자열이 들어올 때만 나온다.
 */
export type PrepResolution = PrepMapping | { readonly kind: "unmapped"; readonly note: string };

/**
 * 준비 축 → 파는 축.
 *
 * **`TASK_CATEGORIES` 를 하나도 빠짐없이 갖는다.** 타입이 그것을 요구하고
 * (`Record<TaskCategory, …>`) 테스트가 한 번 더 센다 — 타입만으로는 **새 준비 카테고리가
 * 생겼을 때** 컴파일이 막아 주지만, 컴파일을 고치려고 아무 값이나 넣는 것까지는 못 막는다.
 */
export const PREP_TO_VENDOR: Readonly<Record<TaskCategory, PrepMapping>> = {
  hall: { kind: "sold", vendorCategories: ["hall"] },

  // 스드메 한 칸이 파는 축 넷에 대응한다 — 이것이 두 축을 합칠 수 없는 이유의 절반이다.
  sdm: { kind: "sold", vendorCategories: ["studio", "dress", "makeup", "video"] },

  yedan: {
    kind: "not_sold",
    why: "not_yet_listed",
    note: "예단·예물은 아직 등록 카테고리에 없어요.",
  },
  honsu: {
    kind: "not_sold",
    why: "not_yet_listed",
    note: "혼수(가전·가구)는 아직 등록 카테고리에 없어요.",
  },
  honeymoon: {
    kind: "not_sold",
    why: "not_yet_listed",
    note: "신혼여행은 아직 등록 카테고리에 없어요.",
  },

  // 서류는 관공서 일이라 **카테고리를 늘려도 팔 것이 생기지 않는다.**
  // 위 셋과 같은 칸에 두면 "언젠가 열리겠지" 로 읽힌다.
  document: {
    kind: "not_sold",
    why: "not_a_purchase",
    note: "혼인신고·여권 같은 서류는 사고파는 일이 아니라 직접 하셔야 해요.",
  },

  // ── C-4a 가 더한 셋 ───────────────────────────────────────────────────────
  //
  // **셋을 서로 다른 칸에 둔 것이 판단이다.** 하나로 묶어 `not_yet_listed` 로
  // 적으면 상견례·축의금처럼 **애초에 살 것이 아닌 일**까지 "언젠가 열리겠지" 로
  // 읽힌다 — `document` 를 위 셋과 갈라 둔 것과 같은 이유다.
  family: {
    kind: "not_sold",
    why: "not_a_purchase",
    note: "상견례·축의금 정산은 양가가 직접 정하는 일이라 사고파는 것이 아니에요.",
  },
  attire: {
    kind: "not_sold",
    why: "not_yet_listed",
    // **`dress` 로 보내지 않는다.** 그쪽은 신부 웨딩드레스이고, 신랑 예복·양가
    // 한복을 그리로 보내면 **틀린 목적지**를 자신 있게 알려 주는 셈이다.
    note: "신랑 예복·한복은 아직 등록 카테고리에 없어요.",
  },
  gift: {
    kind: "not_sold",
    why: "not_yet_listed",
    note: "답례품은 아직 등록 카테고리에 없어요.",
  },
};

/** 준비 카테고리인가. */
export function isTaskCategory(value: string | null | undefined): value is TaskCategory {
  return (TASK_CATEGORIES as readonly string[]).includes(value ?? "");
}

/** 파는(업체) 카테고리인가. */
export function isVendorCategory(value: string | null | undefined): value is VendorCategory {
  return (VENDOR_CATEGORIES as readonly string[]).includes(value ?? "");
}

/**
 * 준비 항목의 카테고리로 **파는 곳을 찾는다.**
 *
 * 모르는 값이면 `unmapped` 다 — **빈 `sold` 로 접지 않는다.** 접으면 화면이
 * "파는 게 없다" 고 말하는데 사실은 **분류를 못 한 것**이라, 사용자가 우리 결함을
 * 자기 사정으로 읽게 된다.
 */
export function vendorCategoriesForPrep(category: string | null | undefined): PrepResolution {
  if (!isTaskCategory(category)) {
    return {
      kind: "unmapped",
      note: "이 준비 항목이 어떤 카테고리인지 아직 정하지 못했어요.",
    };
  }
  return PREP_TO_VENDOR[category];
}

/**
 * 파는 축 → 준비 축(역방향). **앞의 표에서 만든다** — 두 벌로 적으면 어긋나고,
 * 어긋나면 조용하다.
 *
 * 한 업체 카테고리가 여러 준비 항목에 걸릴 수 있으므로 배열이다.
 */
export const VENDOR_TO_PREP: Readonly<Record<VendorCategory, readonly TaskCategory[]>> = (() => {
  const out = {} as Record<VendorCategory, readonly TaskCategory[]>;
  for (const vendor of VENDOR_CATEGORIES) {
    out[vendor] = TASK_CATEGORIES.filter((prep) => {
      const m = PREP_TO_VENDOR[prep];
      return m.kind === "sold" && m.vendorCategories.includes(vendor);
    });
  }
  return Object.freeze(out);
})();

/**
 * 파는 축에 있는데 **어느 준비 항목도 가리키지 않는** 카테고리.
 *
 * 비어 있는 것이 정상이다. 비어 있지 않으면 **파는 축만 늘리고 준비 축을 안 고친 것**이며,
 * 그 상태에서는 체크리스트에서 그 카테고리로 갈 길이 없다.
 */
export function vendorCategoriesWithoutPrep(): readonly VendorCategory[] {
  return VENDOR_CATEGORIES.filter((vendor) => VENDOR_TO_PREP[vendor].length === 0);
}

/**
 * 매핑이 **준비 축 전부를 덮는지** 확인한다. 덮지 못하면 던진다.
 *
 * 타입이 이미 `Record<TaskCategory, …>` 를 요구하지만, 타입만으로는 **컴파일을 고치려고
 * 아무 값이나 넣는 것**까지는 못 막는다. 이 함수가 값을 실제로 본다.
 *
 * **어휘가 비었는지는 여기서 묻지 않는다.** 두 어휘가 `as const` 튜플이라 **타입이 이미
 * 비어 있지 않음을 증명**하고, 그 비교를 적으면 `tsc` 가 "겹치지 않는 비교" 로 막는다
 * (실제로 막혔다). 대신 **수를 세는 일은 단위 테스트와 `db:rls` 가** 한다 — 그쪽은
 * 소스를 문자열로 읽으므로 **정말로 빈 목록이 나올 수 있는 자리**이고, 거기에
 * `length > 0` 가드가 있다(TASKS 운영 규칙 7·8).
 */
export function assertPrepAxisFullyMapped(): void {
  const missing = TASK_CATEGORIES.filter((c) => !(c in PREP_TO_VENDOR));
  if (missing.length > 0) {
    throw new Error(`준비 카테고리에 매핑이 없다: ${missing.join(", ")}`);
  }
  for (const prep of TASK_CATEGORIES) {
    const m = PREP_TO_VENDOR[prep];
    if (m.kind === "sold") {
      if (m.vendorCategories.length === 0) {
        throw new Error(`${prep}: 'sold' 인데 파는 카테고리가 비었다 — 'not_sold' 여야 한다.`);
      }
      const unknown = m.vendorCategories.filter((v) => !isVendorCategory(v));
      if (unknown.length > 0) {
        throw new Error(`${prep}: 파는 축에 없는 값 — ${unknown.join(", ")}`);
      }
    } else if (!m.note.trim()) {
      throw new Error(`${prep}: 'not_sold' 인데 이유 문구가 비었다.`);
    }
  }
}

// =============================================================================
// 화면이 쓰는 문구 — **코드가 갖고 화면이 다시 쓰지 않는다**
// =============================================================================

/**
 * 준비 항목 하나에 대해 화면이 무엇을 보여야 하는가.
 *
 * 문구를 화면에 두면 같은 사실을 **두 곳에 적게** 되고 한쪽만 고쳐진다 —
 * S7-18 이 `WAITING_NOTE` 를 코드에 둔 이유와 같다.
 */
export type PrepLinkView =
  | { readonly kind: "sold"; readonly vendorCategories: readonly VendorCategory[] }
  | { readonly kind: "none"; readonly title: string; readonly note: string };

export function prepLinkView(category: string | null | undefined): PrepLinkView {
  const resolved = vendorCategoriesForPrep(category);
  if (resolved.kind === "sold") {
    return { kind: "sold", vendorCategories: resolved.vendorCategories };
  }
  if (resolved.kind === "not_sold") {
    return {
      kind: "none",
      title:
        resolved.why === "not_a_purchase"
          ? "여기서 파는 것은 없어요"
          : "아직 이 카테고리의 업체가 없어요",
      note: resolved.note,
    };
  }
  // unmapped — **우리 결함이다.** 사용자에게 자기 사정처럼 말하지 않는다.
  return {
    kind: "none",
    title: "분류를 아직 정하지 못했어요",
    note: resolved.note,
  };
}

/** 준비 카테고리의 한글 이름. 라벨표는 준비 축이 이미 갖고 있다 — 두 벌로 만들지 않는다. */
export function prepCategoryLabel(category: TaskCategory): string {
  return TASK_CATEGORY_LABEL[category];
}
