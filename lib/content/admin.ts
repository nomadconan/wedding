import { revalidatePath } from "next/cache";

import { recordEvent } from "@/lib/audit/record";
import {
  type ContentCreateInput,
  type ContentSeoInput,
  type ContentStatus,
  type ContentUnpublishInput,
  type ContentUpdateInput,
  type RevisionField,
  type RevisionSnapshot,
  type RevisionSummary,
  changedFields,
  contentStatus,
} from "@/lib/core/content/cms";
import type { ContentType } from "@/lib/core/content/content";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 콘텐츠 CMS (S8-08 · F-A-05)
 *
 * **읽는 방식을 둘로 가른다**(D-120 과 같은 갈림길).
 *
 * | 대상 | 방식 | 왜 |
 * |---|---|---|
 * | 목록·리비전 | 세션 + **운영자 정책** | **행이 목적**이다 — 편집하려면 미발행 초안이 보여야 한다(D-115) |
 * | 쓰기 전부 | **서비스롤** | `content_posts` 에 쓰기 정책을 아예 두지 않았다(0060) — 정책이 생기는 날 아무 로그인 사용자나 우리 이름으로 글을 발행하게 된다 |
 *
 * **발행 상태를 저장하지 않는다.** `published_at` 하나에서 계산되고 공개 판정은
 * RLS 가 한다 — 예약 발행에 배치가 없는 이유이기도 하다(시각이 지나면 조회 조건이
 * 스스로 참이 된다).
 */
export type CmsPost = {
  id: string;
  slug: string;
  type: ContentType;
  title: string;
  bodyMd: string | null;
  seo: unknown;
  publishedAt: string | null;
  status: ContentStatus;
  authorId: string | null;
  updatedAt: string;
  createdAt: string;
  revisions: RevisionSummary[];
  /** 마지막 저장에서 바뀐 칸. 첫 판본이면 빈 목록이다(비교 대상이 없다는 뜻). */
  lastChanged: RevisionField[];
};

const POST_COLUMNS =
  "id, slug, type, title, body_md, seo_json, published_at, author_id, created_at, updated_at";

type PostRow = {
  id: string;
  slug: string;
  type: ContentType;
  title: string;
  body_md: string | null;
  seo_json: unknown;
  published_at: string | null;
  author_id: string | null;
  created_at: string;
  updated_at: string;
};

type RevisionRow = {
  post_id: string;
  revision: number;
  title: string;
  body_md: string | null;
  seo_json: unknown;
  published_at: string | null;
  editor_id: string | null;
  note: string;
  created_at: string;
};

export async function loadCmsPosts(now: Date): Promise<CmsPost[]> {
  const supabase = await createClient();

  const [{ data: postData, error }, { data: revisionData }] = await Promise.all([
    supabase.from("content_posts").select(POST_COLUMNS).order("updated_at", { ascending: false }).limit(200),
    // **임베드로 끌어오지 않는다.** 정책이 다른 두 표를 한 쿼리로 묶으면 한쪽이
    // 조용히 비어 나온다(함정 1 · S8-02 가 `profiles` 에서 물린 자리).
    supabase
      .from("content_revisions")
      .select("post_id, revision, title, body_md, seo_json, published_at, editor_id, note, created_at")
      .order("revision", { ascending: false })
      .limit(1_000),
  ]);

  if (error) throw new Error("CMS_LOAD_FAILED");

  const posts = (postData ?? []) as PostRow[];
  const revisions = (revisionData ?? []) as RevisionRow[];

  const byPost = new Map<string, RevisionRow[]>();
  for (const row of revisions) {
    const bucket = byPost.get(row.post_id) ?? [];
    bucket.push(row);
    byPost.set(row.post_id, bucket);
  }

  return posts.map((row) => {
    const mine = (byPost.get(row.id) ?? []).sort((a, b) => b.revision - a.revision);
    const latest = mine[0] ?? null;
    const previous = mine[1] ?? null;

    return {
      id: row.id,
      slug: row.slug,
      type: row.type,
      title: row.title,
      bodyMd: row.body_md,
      seo: row.seo_json,
      publishedAt: row.published_at,
      status: contentStatus(row.published_at, now),
      authorId: row.author_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revisions: mine.map((rev) => ({
        revision: rev.revision,
        title: rev.title,
        publishedAt: rev.published_at,
        note: rev.note,
        editorId: rev.editor_id,
        createdAt: rev.created_at,
        // **본문을 목록에 싣지 않는다** — 판본 목록은 훑어보는 화면이다.
        bodyLength: (rev.body_md ?? "").length,
      })),
      lastChanged:
        latest === null
          ? []
          : changedFields(previous === null ? null : toSnapshot(previous), toSnapshot(latest)),
    };
  });
}

function toSnapshot(row: RevisionRow): RevisionSnapshot {
  return {
    title: row.title,
    bodyMd: row.body_md,
    seo: row.seo_json,
    publishedAt: row.published_at,
  };
}

/**
 * 공개 화면의 캐시를 무효화한다.
 *
 * **`/guides` 는 `revalidate = 300` 으로 굳는다**(S7-10 · SEO 화면이라 굳는 것이 목적이다).
 * 그 상태에서 발행하면 공개 페이지에 **최대 5분 뒤에야** 나타나고, 내리면 **최대 5분 동안
 * 계속 열린다.**
 *
 * 뒤쪽이 특히 나쁘다 — 오탈자·법적 문제로 글을 내리는 것은 급한 일인데, 화면은 '내렸다'
 * 고 말하고 실제 URL 은 살아 있다. **화면이 거짓말을 하는 상태**다(S8-08 흐름 점검이
 * 실제로 이것에 걸렸다: '내려간 글은 즉시 404' 가 **이미 404 였던 탓에** 통과했다).
 *
 * 그래서 쓰기 경로가 끝날 때마다 해당 경로를 무효화한다. 캐시 전략은 그대로 두고
 * (평상시에는 굳는 것이 맞다) **우리가 바꾼 순간만** 예외로 만든다.
 *
 * **목록·사이트맵도 함께 무효화한다** — 상세만 고치면 목록에는 없는 글이 상세로만
 * 열리거나, 사이트맵이 없는 글을 계속 가리킨다.
 */
function revalidateContent(slug: string, previousSlug?: string): void {
  revalidatePath("/guides");
  revalidatePath(`/guides/${slug}`);
  // 슬러그가 바뀌었으면 **옛 주소도** 무효화한다 — 안 그러면 그 URL 이 옛 본문을
  // 계속 보여준다(주소를 바꾼 이유가 대개 그 본문이다).
  if (previousSlug !== undefined && previousSlug !== slug) revalidatePath(`/guides/${previousSlug}`);
  revalidatePath("/sitemap.xml");
}

export type CmsResult =
  | { ok: true; postId: string }
  | { ok: false; status: number; code: string; message: string };

function toSeoJson(seo: ContentSeoInput): Record<string, unknown> {
  // DB 는 snake_case 를 읽고(`parseSeo` 가 둘 다 받지만) **쓰는 쪽에서 한 모양으로
  // 고정한다** — 두 표기가 섞이면 어느 쪽이 최신인지 알 수 없다.
  return {
    description: seo.description,
    keywords: seo.keywords,
    tools: seo.tools,
    region_code: seo.regionCode,
    category: seo.category,
  };
}

/** 판본을 붙인다. **본문이 바뀌었든 아니든 저장할 때마다 남긴다** — 사유가 판본의 값이다. */
async function appendRevision(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    postId: string;
    title: string;
    bodyMd: string | null;
    seoJson: Record<string, unknown>;
    publishedAt: string | null;
    editorId: string;
    note: string;
  },
): Promise<void> {
  const { data } = await admin
    .from("content_revisions")
    .select("revision")
    .eq("post_id", input.postId)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();

  const next = ((data as { revision: number } | null)?.revision ?? 0) + 1;

  await admin.from("content_revisions").insert({
    post_id: input.postId,
    revision: next,
    title: input.title,
    body_md: input.bodyMd,
    seo_json: input.seoJson,
    published_at: input.publishedAt,
    editor_id: input.editorId,
    note: input.note,
  });
}

export async function createPost(
  input: ContentCreateInput & { operatorId: string; operatorRole: string | null; now: Date },
): Promise<CmsResult> {
  const admin = createAdminClient();
  const seoJson = toSeoJson(input.seo);

  const { data, error } = await admin
    .from("content_posts")
    .insert({
      slug: input.slug,
      type: input.type,
      title: input.title,
      body_md: input.bodyMd,
      seo_json: seoJson,
      published_at: input.publishedAt,
      author_id: input.operatorId,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    // 슬러그는 unique 다. **URL 이 겹친다는 사실을 그대로 알린다** — 일반 오류로
    // 뭉뚱그리면 편집자가 왜 저장이 안 되는지 모른다.
    return error?.code === "23505"
      ? { ok: false, status: 409, code: "CMS_SLUG_TAKEN", message: "이미 쓰고 있는 주소입니다." }
      : { ok: false, status: 500, code: "CMS_CREATE_FAILED", message: "글을 만들지 못했습니다." };
  }

  await appendRevision(admin, {
    postId: data.id,
    title: input.title,
    bodyMd: input.bodyMd,
    seoJson,
    publishedAt: input.publishedAt,
    editorId: input.operatorId,
    note: input.note,
  });

  await recordEvent({
    entityType: "content_post",
    entityId: data.id,
    eventType: "content_created",
    actor: { id: input.operatorId, role: input.operatorRole },
    afterState: contentStatus(input.publishedAt, input.now),
    source: "admin",
    // **본문도 사유 문안도 담지 않는다**(§7.3). 행과 리비전이 이미 갖고 있다.
    memo: `type:${input.type}`,
  });

  await writeAuditLog(admin, {
    actorId: input.operatorId,
    actorRole: input.operatorRole,
    action: "content_created",
    targetType: "content_post",
    targetId: data.id,
    before: {},
    after: { slug: input.slug, status: contentStatus(input.publishedAt, input.now) },
  });

  revalidateContent(input.slug);

  return { ok: true, postId: data.id };
}

export async function updatePost(
  input: ContentUpdateInput & { operatorId: string; operatorRole: string | null; now: Date },
): Promise<CmsResult> {
  const admin = createAdminClient();

  const { data: current } = await admin
    .from("content_posts")
    .select("id, published_at, slug")
    .eq("id", input.postId)
    .maybeSingle();

  if (!current) {
    return { ok: false, status: 404, code: "CMS_NOT_FOUND", message: "글을 찾을 수 없습니다." };
  }

  const seoJson = toSeoJson(input.seo);

  const { error } = await admin
    .from("content_posts")
    .update({
      slug: input.slug,
      type: input.type,
      title: input.title,
      body_md: input.bodyMd,
      seo_json: seoJson,
      published_at: input.publishedAt,
    })
    .eq("id", input.postId);

  if (error) {
    return error.code === "23505"
      ? { ok: false, status: 409, code: "CMS_SLUG_TAKEN", message: "이미 쓰고 있는 주소입니다." }
      : { ok: false, status: 500, code: "CMS_UPDATE_FAILED", message: "글을 저장하지 못했습니다." };
  }

  await appendRevision(admin, {
    postId: input.postId,
    title: input.title,
    bodyMd: input.bodyMd,
    seoJson,
    publishedAt: input.publishedAt,
    editorId: input.operatorId,
    note: input.note,
  });

  const before = contentStatus(current.published_at, input.now);
  const after = contentStatus(input.publishedAt, input.now);

  await recordEvent({
    entityType: "content_post",
    entityId: input.postId,
    eventType: before === after ? "content_edited" : "content_status_changed",
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: before,
    afterState: after,
    source: "admin",
  });

  await writeAuditLog(admin, {
    actorId: input.operatorId,
    actorRole: input.operatorRole,
    action: "content_updated",
    targetType: "content_post",
    targetId: input.postId,
    // **슬러그 변경은 URL 변경이다.** 값으로 남긴다 — 밖에서 걸린 링크가 죽은
    // 이유를 나중에 이 기록으로 답한다(개인정보가 아니다).
    before: { slug: current.slug, status: before },
    after: { slug: input.slug, status: after },
  });

  revalidateContent(input.slug, current.slug);

  return { ok: true, postId: input.postId };
}

/**
 * 내리기.
 *
 * **행을 지우지 않는다**(0060 §5). 색인된 URL 이 죽고 되돌릴 방법이 없다 —
 * `published_at = null` 이면 공개 정책이 즉시 가리고 행과 리비전은 남는다.
 * 다시 올릴 때 같은 슬러그로 돌아온다.
 */
export async function unpublishPost(
  input: ContentUnpublishInput & { operatorId: string; operatorRole: string | null; now: Date },
): Promise<CmsResult> {
  const admin = createAdminClient();

  const { data: current } = await admin
    .from("content_posts")
    .select("id, slug, title, body_md, seo_json, published_at")
    .eq("id", input.postId)
    .maybeSingle();

  if (!current) {
    return { ok: false, status: 404, code: "CMS_NOT_FOUND", message: "글을 찾을 수 없습니다." };
  }

  if (current.published_at === null) {
    return {
      ok: false,
      status: 409,
      code: "CMS_ALREADY_DRAFT",
      message: "이미 공개되지 않은 글입니다.",
    };
  }

  const { error } = await admin
    .from("content_posts")
    .update({ published_at: null })
    .eq("id", input.postId);

  if (error) {
    return { ok: false, status: 500, code: "CMS_UNPUBLISH_FAILED", message: "내리지 못했습니다." };
  }

  await appendRevision(admin, {
    postId: input.postId,
    title: current.title,
    bodyMd: current.body_md,
    seoJson: (current.seo_json ?? {}) as Record<string, unknown>,
    publishedAt: null,
    editorId: input.operatorId,
    note: input.note,
  });

  await recordEvent({
    entityType: "content_post",
    entityId: input.postId,
    eventType: "content_unpublished",
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: contentStatus(current.published_at, input.now),
    afterState: "draft",
    source: "admin",
  });

  await writeAuditLog(admin, {
    actorId: input.operatorId,
    actorRole: input.operatorRole,
    action: "content_unpublished",
    targetType: "content_post",
    targetId: input.postId,
    before: { status: contentStatus(current.published_at, input.now) },
    after: { status: "draft" },
  });

  revalidateContent(current.slug);

  return { ok: true, postId: input.postId };
}

/** 운영자 액션은 `audit_logs` 에도 남기고 **근거 이벤트 id 를 함께** 남긴다(§7.2). */
async function writeAuditLog(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    actorId: string;
    actorRole: string | null;
    action: string;
    targetType: string;
    targetId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<void> {
  const { data: basisRows } = await admin
    .from("entity_events")
    .select("id")
    .eq("actor_id", input.actorId)
    .order("occurred_at", { ascending: false })
    .limit(5);

  const basis = ((basisRows ?? []) as { id: string }[]).map((row) => row.id);

  await admin.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_role: input.actorRole,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    before_json: input.before,
    after_json: input.after,
    // 빈 배열은 CHECK 이 막는다.
    resolution_basis: basis.length > 0 ? basis : null,
  });
}
