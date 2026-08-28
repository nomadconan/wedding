import { describe, expect, it } from "vitest";

import {
  CONTENT_STATUSES,
  ContentCreateSchema,
  ContentSeoSchema,
  ContentUnpublishSchema,
  ContentUpdateSchema,
  REVISION_FIELDS,
  changedFields,
  contentStatus,
  isPublic,
  publishTransition,
} from "./cms";
import { TOOL_CTAS } from "./content";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const PAST = "2026-08-01T00:00:00.000Z";
const FUTURE = "2026-09-01T00:00:00.000Z";
const UUID = "11111111-1111-4111-8111-111111111111";

const seo = {
  description: "설명",
  keywords: ["웨딩"],
  tools: [] as string[],
  regionCode: null,
  category: null,
};

const post = {
  slug: "wedding-hall-guide",
  type: "guide" as const,
  title: "웨딩홀 고르는 법",
  bodyMd: "## 본문",
  seo,
  publishedAt: null as string | null,
  note: "초안 작성",
};

// ══════════════════════════════════════════════════════════════════════════
// 상태는 저장되지 않고 계산된다
// ══════════════════════════════════════════════════════════════════════════

describe("contentStatus", () => {
  it("시각이 없으면 초안이다", () => {
    expect(contentStatus(null, NOW)).toBe("draft");
    expect(isPublic(null, NOW)).toBe(false);
  });

  it("과거면 발행됨이다", () => {
    expect(contentStatus(PAST, NOW)).toBe("published");
    expect(isPublic(PAST, NOW)).toBe(true);
  });

  it("미래면 예약이고 아직 공개가 아니다", () => {
    expect(contentStatus(FUTURE, NOW)).toBe("scheduled");
    expect(isPublic(FUTURE, NOW)).toBe(false);
  });

  it("**경계값(지금 이 순간)은 공개다** — RLS 의 `<= now()` 와 같은 방향이다", () => {
    expect(contentStatus(NOW.toISOString(), NOW)).toBe("published");
  });

  it("상태가 셋뿐이다", () => {
    expect(CONTENT_STATUSES).toEqual(["draft", "scheduled", "published"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 저장 입력
// ══════════════════════════════════════════════════════════════════════════

describe("ContentCreateSchema", () => {
  it("초안은 본문이 없어도 저장된다 — 쓰다 만 글을 둘 수 있어야 한다", () => {
    expect(ContentCreateSchema.safeParse({ ...post, bodyMd: null }).success).toBe(true);
  });

  it("**발행하려면 본문이 있어야 한다** (DB CHECK 과 같은 말)", () => {
    const parsed = ContentCreateSchema.safeParse({ ...post, bodyMd: null, publishedAt: PAST });

    expect(parsed.success).toBe(false);
  });

  it("빈 본문으로도 발행할 수 없다", () => {
    expect(
      ContentCreateSchema.safeParse({ ...post, bodyMd: "   ", publishedAt: PAST }).success,
    ).toBe(false);
  });

  it.each([
    ["대문자", "Wedding-Guide"],
    ["공백", "wedding guide"],
    ["밑줄", "wedding_guide"],
    ["한글", "웨딩홀"],
    ["끝 하이픈", "wedding-"],
  ])("슬러그에 %s 를 허용하지 않는다 — URL 그 자체다", (_label, slug) => {
    expect(ContentCreateSchema.safeParse({ ...post, slug }).success).toBe(false);
  });

  it("정상 슬러그는 통과한다", () => {
    expect(ContentCreateSchema.safeParse({ ...post, slug: "a1-b2-c3" }).success).toBe(true);
  });

  it("**사유가 필수다** — 없으면 판본 목록에서 서로 구분되지 않는다", () => {
    expect(ContentCreateSchema.safeParse({ ...post, note: "  " }).success).toBe(false);
  });

  it("정의되지 않은 유형은 거절한다", () => {
    expect(ContentCreateSchema.safeParse({ ...post, type: "news" }).success).toBe(false);
  });

  it("제목이 비면 거절한다", () => {
    expect(ContentCreateSchema.safeParse({ ...post, title: "   " }).success).toBe(false);
  });

  it("수정 스키마는 대상 글 id 를 요구한다", () => {
    expect(ContentUpdateSchema.safeParse(post).success).toBe(false);
    expect(ContentUpdateSchema.safeParse({ ...post, postId: UUID }).success).toBe(true);
  });

  it("내리기에도 사유가 필수다", () => {
    expect(ContentUnpublishSchema.safeParse({ postId: UUID, note: "" }).success).toBe(false);
    expect(ContentUnpublishSchema.safeParse({ postId: UUID, note: "오탈자" }).success).toBe(true);
  });
});

describe("ContentSeoSchema", () => {
  it("**등록되지 않은 CTA 키를 막는다** — 저장되면 화면이 조용히 비운다(D-98)", () => {
    expect(ContentSeoSchema.safeParse({ ...seo, tools: ["no-such-tool"] }).success).toBe(false);
  });

  it("레지스트리에 있는 키는 받는다", () => {
    expect(ContentSeoSchema.safeParse({ ...seo, tools: [TOOL_CTAS[0].key] }).success).toBe(true);
  });

  it("빈 목록은 정상이다", () => {
    expect(ContentSeoSchema.safeParse(seo).success).toBe(true);
  });

  it("설명은 비워 둘 수 있다", () => {
    expect(ContentSeoSchema.safeParse({ ...seo, description: null }).success).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 리비전
// ══════════════════════════════════════════════════════════════════════════

describe("changedFields", () => {
  const snap = { title: "제목", bodyMd: "본문", seo: { a: 1 }, publishedAt: null };

  it("**첫 판본은 '전부 바뀜' 이 아니라 빈 목록이다** — 비교 대상이 없다는 뜻이다", () => {
    expect(changedFields(null, snap)).toEqual([]);
  });

  it("같으면 아무것도 없다", () => {
    expect(changedFields(snap, { ...snap })).toEqual([]);
  });

  it("바뀐 칸만 낸다", () => {
    expect(changedFields(snap, { ...snap, title: "새 제목" })).toEqual(["title"]);
    expect(changedFields(snap, { ...snap, publishedAt: PAST })).toEqual(["publishedAt"]);
  });

  it("본문의 null 과 빈 문자열을 같게 본다 — 사용자에게 같은 상태다", () => {
    expect(changedFields({ ...snap, bodyMd: null }, { ...snap, bodyMd: "" })).toEqual([]);
  });

  it("SEO 는 내용으로 비교한다", () => {
    expect(changedFields(snap, { ...snap, seo: { a: 2 } })).toEqual(["seo"]);
    expect(changedFields(snap, { ...snap, seo: { a: 1 } })).toEqual([]);
  });

  it("여러 칸이 바뀌면 전부 낸다", () => {
    expect(changedFields(snap, { title: "x", bodyMd: "y", seo: {}, publishedAt: PAST })).toEqual([
      ...REVISION_FIELDS,
    ]);
  });
});

describe("publishTransition", () => {
  it("바뀌지 않으면 그렇다고 말한다", () => {
    expect(publishTransition(PAST, PAST, NOW).kind).toBe("none");
  });

  it("초안 → 과거 시각은 즉시 발행이다", () => {
    const t = publishTransition(null, PAST, NOW);

    expect(t.kind).toBe("publish");
    expect(t.label).toContain("즉시");
  });

  it("초안 → 미래 시각은 예약이다", () => {
    const t = publishTransition(null, FUTURE, NOW);

    expect(t.kind).toBe("schedule");
    expect(t.kind === "schedule" && t.at).toBe(FUTURE);
  });

  it("**공개 중인 글을 내리면 URL 이 죽는다는 것을 미리 말한다**", () => {
    const t = publishTransition(PAST, null, NOW);

    expect(t.kind).toBe("unpublish");
    expect(t.label).toContain("URL");
  });

  it("예약을 취소하면 URL 얘기를 하지 않는다 — 애초에 열린 적이 없다", () => {
    const t = publishTransition(FUTURE, null, NOW);

    expect(t.kind).toBe("unpublish");
    expect(t.label).not.toContain("URL");
  });

  it("예약 시각만 바뀌면 재예약이다", () => {
    const t = publishTransition(FUTURE, "2026-09-05T00:00:00.000Z", NOW);

    expect(t.kind).toBe("reschedule");
  });
});
