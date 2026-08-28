// 콘텐츠 CMS 규약 (S8-08 · F-A-05)
//
// ══════════════════════════════════════════════════════════════════════════
// **발행 상태를 저장하지 않는다.**
// ══════════════════════════════════════════════════════════════════════════
//
// 초안·예약·발행은 `published_at` 하나에서 계산된다: `null` 이면 초안, 미래면 예약,
// 과거면 발행. 상태 컬럼을 따로 두면 두 값이 갈리고, 갈렸을 때 **어느 쪽이 공개
// 여부의 진실인지 화면으로는 알 수 없다** — 공개 판정은 이미 RLS 하나가 하고 있다
// (`published_at <= now()` · 0005 [58]). 계산 가능한 값을 저장하지 않는다(D-124).
//
// **예약 발행에 배치가 필요 없다는 뜻이기도 하다.** 시각이 지나면 정책이 스스로
// 참이 된다 — 배치가 상태를 갈아 주는 구조였다면 배치가 멈춘 날 글이 안 나간다.

import { z } from "zod";

import { CONTENT_TYPES, SLUG_MAX_LENGTH, SLUG_PATTERN, TOOL_CTAS } from "./content";

export const CONTENT_STATUSES = ["draft", "scheduled", "published"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const CONTENT_STATUS_LABEL: Record<ContentStatus, string> = {
  draft: "초안",
  scheduled: "발행 예약",
  published: "발행됨",
};

export const CONTENT_STATUS_HINT: Record<ContentStatus, string> = {
  draft: "공개되지 않습니다. 목록·상세·사이트맵 어디에도 나오지 않습니다.",
  scheduled: "그 시각이 지나면 자동으로 공개됩니다 — 배치가 아니라 조회 조건이 바뀝니다.",
  published: "지금 공개 중입니다. 검색에 색인될 수 있습니다.",
};

/** `published_at` 하나로 상태를 정한다. **저장된 값이 아니라 계산이다.** */
export function contentStatus(publishedAt: string | null, now: Date): ContentStatus {
  if (publishedAt === null) return "draft";

  return Date.parse(publishedAt) <= now.getTime() ? "published" : "scheduled";
}

export function isPublic(publishedAt: string | null, now: Date): boolean {
  return contentStatus(publishedAt, now) === "published";
}

// =============================================================================
// 편집 입력
// =============================================================================

const KNOWN_TOOL_KEYS = TOOL_CTAS.map((cta) => cta.key);

/**
 * SEO 필드 (F-A-05 'SEO 메타·JSON-LD 필드').
 *
 * **CTA 키는 레지스트리에 있는 것만 받는다**(D-98). 없는 키를 저장하면 공개 화면이
 * 그 자리를 조용히 비우고, 운영자는 링크를 걸었다고 믿는다 — `parseSeo` 가 읽기
 * 쪽에서 걸러 내지만 **쓰기에서 막는 편이 낫다**: 걸러진 값은 화면에 안 보이므로
 * 잘못 적었다는 사실 자체가 전달되지 않는다.
 */
export const ContentSeoSchema = z.object({
  description: z.string().trim().max(300).nullable(),
  keywords: z.array(z.string().trim().min(1).max(40)).max(20),
  tools: z
    .array(z.string())
    .max(6)
    .refine((keys) => keys.every((key) => KNOWN_TOOL_KEYS.includes(key)), {
      message: "등록되지 않은 CTA 키입니다. 목록에 있는 것만 고를 수 있습니다.",
    }),
  regionCode: z.string().trim().max(40).nullable(),
  category: z.string().trim().max(40).nullable(),
});
export type ContentSeoInput = z.infer<typeof ContentSeoSchema>;

/**
 * 글 저장.
 *
 * **`publishedAt` 을 문자열로 받는다.** `null` 이면 초안이고, 값이 있으면 그 시각에
 * 공개된다 — **과거 시각을 막지 않는다**: '지금 발행' 이 곧 과거 시각이고, 예전
 * 날짜로 소급 발행하는 것도 편집자의 정당한 선택이다. 화면이 그 결과를 미리 적는다.
 *
 * **사유(`note`)가 필수다.** 리비전마다 남으며, 없으면 판본 목록에서 서로 구분되지
 * 않는다(DB CHECK 이 같은 말을 한다 · 0060).
 */
const postBody = {
  slug: z
    .string()
    .trim()
    .min(1)
    .max(SLUG_MAX_LENGTH)
    .regex(SLUG_PATTERN, "영문 소문자·숫자·하이픈만 쓸 수 있습니다."),
  type: z.enum(CONTENT_TYPES),
  title: z.string().trim().min(1, "제목을 적어 주세요.").max(200),
  bodyMd: z.string().max(100_000).nullable(),
  seo: ContentSeoSchema,
  publishedAt: z.string().datetime().nullable(),
  note: z.string().trim().min(1, "무엇을 왜 고쳤는지 적어 주세요.").max(500),
};

export const ContentCreateSchema = z.object(postBody).refine(publishNeedsBody, {
  message: "발행하려면 본문이 있어야 합니다.",
  path: ["bodyMd"],
});
export type ContentCreateInput = z.infer<typeof ContentCreateSchema>;

export const ContentUpdateSchema = z
  .object({ ...postBody, postId: z.string().uuid() })
  .refine(publishNeedsBody, { message: "발행하려면 본문이 있어야 합니다.", path: ["bodyMd"] });
export type ContentUpdateInput = z.infer<typeof ContentUpdateSchema>;

/**
 * **발행에는 본문이 있어야 한다.** DB CHECK(`content_posts_published_body_chk`)이 같은
 * 말을 하지만 여기서도 막는다 — 저장을 눌러야 거절당하는 경험을 만들지 않기 위해서다.
 * 초안은 본문이 없어도 된다(쓰다 만 글을 저장할 수 있어야 한다).
 */
function publishNeedsBody(value: { bodyMd: string | null; publishedAt: string | null }): boolean {
  if (value.publishedAt === null) return true;

  return (value.bodyMd ?? "").trim().length > 0;
}

/** 발행 취소('내리기'). **행을 지우지 않는다** — 색인된 URL 이 죽고 되돌릴 수 없다. */
export const ContentUnpublishSchema = z.object({
  postId: z.string().uuid(),
  note: z.string().trim().min(1, "왜 내리는지 적어 주세요.").max(500),
});
export type ContentUnpublishInput = z.infer<typeof ContentUnpublishSchema>;

// =============================================================================
// 리비전
// =============================================================================

export type RevisionSummary = {
  revision: number;
  title: string;
  publishedAt: string | null;
  note: string;
  editorId: string | null;
  createdAt: string;
  /** 본문 글자 수. **본문을 목록에 싣지 않는다** — 판본 목록은 훑어보는 화면이다. */
  bodyLength: number;
};

/**
 * 판본 사이에 무엇이 바뀌었나.
 *
 * **본문 내용을 비교해 보여주지 않는다.** 어느 칸이 바뀌었는지만 낸다 — S8-02 가
 * 감사 로그에서 정한 것과 같은 규칙이다(값이 아니라 바뀐 칸). 여기서는 개인정보가
 * 아니라 **읽기 쉬움**이 이유다: 마크다운 본문의 문자 단위 diff 는 목록 화면에서
 * 아무도 안 읽는다. 본문 자체는 판본을 열면 그대로 있다.
 */
export const REVISION_FIELDS = ["title", "bodyMd", "seo", "publishedAt"] as const;
export type RevisionField = (typeof REVISION_FIELDS)[number];

export const REVISION_FIELD_LABEL: Record<RevisionField, string> = {
  title: "제목",
  bodyMd: "본문",
  seo: "SEO",
  publishedAt: "공개 시각",
};

export type RevisionSnapshot = {
  title: string;
  bodyMd: string | null;
  seo: unknown;
  publishedAt: string | null;
};

export function changedFields(
  previous: RevisionSnapshot | null,
  next: RevisionSnapshot,
): RevisionField[] {
  // 첫 판본은 비교 대상이 없다. **"전부 바뀌었다" 고 적지 않는다** — 그것은 사실이
  // 아니라 비교가 없다는 뜻이고, 화면이 '첫 판본' 이라고 말하는 편이 정확하다.
  if (previous === null) return [];

  const changed: RevisionField[] = [];

  if (previous.title !== next.title) changed.push("title");
  if ((previous.bodyMd ?? "") !== (next.bodyMd ?? "")) changed.push("bodyMd");
  if (JSON.stringify(previous.seo ?? {}) !== JSON.stringify(next.seo ?? {})) changed.push("seo");
  if (previous.publishedAt !== next.publishedAt) changed.push("publishedAt");

  return changed;
}

/**
 * 이 저장이 공개 상태를 바꾸는가.
 *
 * 화면이 저장 전에 **무슨 일이 일어날지** 적기 위한 값이다 — '발행' 버튼과 '저장'
 * 버튼을 따로 두지 않고, 시각을 어떻게 두었느냐로 결과가 정해진다는 것을 보인다.
 */
export type PublishTransition =
  | { kind: "none"; label: string }
  | { kind: "publish"; label: string }
  | { kind: "schedule"; label: string; at: string }
  | { kind: "unpublish"; label: string }
  | { kind: "reschedule"; label: string; at: string };

export function publishTransition(
  before: string | null,
  after: string | null,
  now: Date,
): PublishTransition {
  const from = contentStatus(before, now);
  const to = contentStatus(after, now);

  if (before === after) return { kind: "none", label: "공개 상태는 그대로입니다." };

  if (to === "draft") {
    return {
      kind: "unpublish",
      label:
        from === "published"
          ? "지금 공개 중인 글이 내려갑니다. 그 URL 은 더 이상 열리지 않습니다."
          : "예약이 취소되고 초안으로 돌아갑니다.",
    };
  }

  if (to === "published") {
    return { kind: "publish", label: "저장하는 즉시 공개됩니다." };
  }

  return from === "scheduled"
    ? { kind: "reschedule", label: "공개 예정 시각이 바뀝니다.", at: after as string }
    : { kind: "schedule", label: "그 시각이 지나면 공개됩니다.", at: after as string };
}
