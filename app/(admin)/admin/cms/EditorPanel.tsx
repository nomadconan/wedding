"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  CONTENT_STATUS_HINT,
  CONTENT_STATUS_LABEL,
  ContentCreateSchema,
  ContentUpdateSchema,
  contentStatus,
  publishTransition,
} from "@/lib/core/content/cms";
import { CONTENT_TYPES, CONTENT_TYPE_LABEL, TOOL_CTAS } from "@/lib/core/content/content";

/**
 * 콘텐츠 에디터 (S8-08 · F-A-05)
 *
 * ── 이 폼이 지키는 규칙 ─────────────────────────────────────────────────────
 * 1. **'발행' 버튼을 따로 두지 않는다.** 공개 시각 하나가 초안·예약·발행을 정하므로
 *    버튼을 나누면 시각과 버튼이 어긋날 수 있다. 대신 **저장하면 무슨 일이
 *    일어나는지 미리 적는다**(`publishTransition`).
 * 2. **공개 중인 글을 내릴 때 URL 이 죽는다는 사실을 먼저 말한다.** 색인된 주소가
 *    404 가 되는 것은 되돌리기 어려운 일이다.
 * 3. **CTA 는 레지스트리에서 고른다**(D-98). 자유 입력이면 없는 키가 저장되고
 *    공개 화면이 그 자리를 조용히 비운다 — 편집자는 링크를 걸었다고 믿는다.
 * 4. **사유가 필수다.** 판본마다 남으며 없으면 판본 목록에서 서로 구분되지 않는다.
 */
export type EditorPanelProps = {
  now: string;
  post: {
    id: string;
    slug: string;
    type: string;
    title: string;
    bodyMd: string | null;
    publishedAt: string | null;
    seo: {
      description: string | null;
      keywords: string[];
      tools: string[];
      regionCode: string | null;
      category: string | null;
    };
  } | null;
};

/** `datetime-local` 은 초·타임존이 없다. ISO ↔ 입력값을 한 곳에서만 바꾼다. */
function toLocalInput(iso: string | null): string {
  if (iso === null) return "";

  return new Date(iso).toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string | null {
  if (value.trim() === "") return null;
  const parsed = new Date(`${value}:00Z`);

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function EditorPanel({ post, now }: EditorPanelProps) {
  const router = useRouter();
  const nowDate = new Date(now);

  const [open, setOpen] = useState(post === null);
  const [slug, setSlug] = useState(post?.slug ?? "");
  const [type, setType] = useState(post?.type ?? "guide");
  const [title, setTitle] = useState(post?.title ?? "");
  const [bodyMd, setBodyMd] = useState(post?.bodyMd ?? "");
  const [publishAt, setPublishAt] = useState(toLocalInput(post?.publishedAt ?? null));
  const [description, setDescription] = useState(post?.seo.description ?? "");
  const [keywords, setKeywords] = useState((post?.seo.keywords ?? []).join(", "));
  const [tools, setTools] = useState<string[]>(post?.seo.tools ?? []);
  const [regionCode, setRegionCode] = useState(post?.seo.regionCode ?? "");
  const [category, setCategory] = useState(post?.seo.category ?? "");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publishedAt = fromLocalInput(publishAt);
  const payload = {
    slug: slug.trim(),
    type,
    title: title.trim(),
    bodyMd: bodyMd.trim() === "" ? null : bodyMd,
    seo: {
      description: description.trim() === "" ? null : description.trim(),
      keywords: keywords
        .split(",")
        .map((word) => word.trim())
        .filter((word) => word.length > 0),
      tools,
      regionCode: regionCode.trim() === "" ? null : regionCode.trim(),
      category: category.trim() === "" ? null : category.trim(),
    },
    publishedAt,
    note: note.trim(),
  };

  const parsed =
    post === null
      ? ContentCreateSchema.safeParse(payload)
      : ContentUpdateSchema.safeParse({ ...payload, postId: post.id });
  const problem = parsed.success ? null : parsed.error.issues[0]?.message ?? "입력을 확인해 주세요.";

  const transition = publishTransition(post?.publishedAt ?? null, publishedAt, nowDate);
  const nextStatus = contentStatus(publishedAt, nowDate);

  async function submit(method: "POST" | "PATCH") {
    if (!parsed.success) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/content", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const result = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!result.ok) {
        setError(result.error?.message ?? "저장하지 못했습니다.");

        return;
      }

      setNote("");
      if (post === null) {
        setSlug("");
        setTitle("");
        setBodyMd("");
        setOpen(false);
      }
      router.refresh();
    } catch {
      setError("저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  async function unpublish() {
    if (post === null || note.trim().length === 0) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/content", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: post.id, note: note.trim() }),
      });
      const result = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!result.ok) {
        setError(result.error?.message ?? "내리지 못했습니다.");

        return;
      }

      setNote("");
      router.refresh();
    } catch {
      setError("내리지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        편집
      </Button>
    );
  }

  const field = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3" data-testid="cms-editor">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-caption font-medium text-foreground">주소(슬러그)</span>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} className={field} data-testid="cms-slug" />
          <span className="text-caption text-muted-foreground">
            공개 주소가 됩니다 — <code>/guides/{slug || "…"}</code>. 발행 뒤 바꾸면 예전 주소가
            죽습니다.
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-caption font-medium text-foreground">유형</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
            {CONTENT_TYPES.map((value) => (
              <option key={value} value={value}>
                {CONTENT_TYPE_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-caption font-medium text-foreground">제목</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} data-testid="cms-title" />
      </label>

      <label className="block space-y-1">
        <span className="text-caption font-medium text-foreground">본문 (마크다운)</span>
        <textarea
          value={bodyMd}
          onChange={(e) => setBodyMd(e.target.value)}
          rows={10}
          className={`${field} resize-y font-mono`}
          data-testid="cms-body"
        />
        <span className="text-caption text-muted-foreground">
          제목(h1)은 위 &apos;제목&apos;이 갖습니다. 본문은 h2 부터 시작하세요.
        </span>
      </label>

      {/* ── SEO ─────────────────────────────────────────────────────────── */}
      <fieldset className="space-y-2 rounded-md border border-border p-3">
        <legend className="px-1 text-caption font-medium text-foreground">SEO · JSON-LD</legend>

        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">설명 (meta description)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={field} />
        </label>

        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">키워드 (쉼표로 구분)</span>
          <input value={keywords} onChange={(e) => setKeywords(e.target.value)} className={field} />
        </label>

        <div className="space-y-1">
          <span className="text-caption text-muted-foreground">
            도구 CTA — <strong>목록에 있는 것만 고를 수 있습니다.</strong> 없는 키를 저장하면
            공개 화면이 그 자리를 조용히 비웁니다.
          </span>
          <div className="flex flex-wrap gap-2">
            {TOOL_CTAS.map((cta) => (
              <Button
                key={cta.key}
                type="button"
                size="sm"
                variant={tools.includes(cta.key) ? "default" : "outline"}
                onClick={() =>
                  setTools((current) =>
                    current.includes(cta.key)
                      ? current.filter((key) => key !== cta.key)
                      : [...current, cta.key],
                  )
                }
              >
                {cta.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-caption text-muted-foreground">지역 코드 (선택)</span>
            <input value={regionCode} onChange={(e) => setRegionCode(e.target.value)} className={field} />
          </label>
          <label className="block space-y-1">
            <span className="text-caption text-muted-foreground">카테고리 (선택)</span>
            <input value={category} onChange={(e) => setCategory(e.target.value)} className={field} />
          </label>
        </div>
        <span className="text-caption text-muted-foreground">
          둘 다 있으면 글 아래에 그 지역·카테고리의 가격 분포 링크가 붙습니다.
        </span>
      </fieldset>

      {/* ── 공개 시각 ───────────────────────────────────────────────────── */}
      <fieldset className="space-y-2 rounded-md border border-border p-3">
        <legend className="px-1 text-caption font-medium text-foreground">공개</legend>

        <label className="block space-y-1">
          <span className="text-caption text-muted-foreground">
            공개 시각 (UTC · 비우면 초안)
          </span>
          <input
            type="datetime-local"
            value={publishAt}
            onChange={(e) => setPublishAt(e.target.value)}
            className={field}
            data-testid="cms-published-at"
          />
        </label>

        <p className="text-caption text-muted-foreground">
          저장 뒤 상태 — <strong>{CONTENT_STATUS_LABEL[nextStatus]}</strong>.{" "}
          {CONTENT_STATUS_HINT[nextStatus]}
        </p>

        {transition.kind !== "none" ? (
          <p
            className={`text-caption ${transition.kind === "unpublish" ? "text-warning" : "text-muted-foreground"}`}
            data-testid="cms-transition"
          >
            {transition.label}
          </p>
        ) : null}

        <p className="text-caption text-muted-foreground">
          <strong>&apos;발행&apos; 버튼은 없습니다.</strong> 공개 시각 하나가 초안·예약·발행을
          정합니다 — 예약은 배치가 아니라 조회 조건이라, 시각이 지나면 스스로 공개됩니다.
        </p>
      </fieldset>

      <label className="block space-y-1">
        <span className="text-caption font-medium text-foreground">
          이번 수정 사유 (필수 — 판본마다 남습니다)
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          className={`${field} resize-none`}
          data-testid="cms-note"
        />
      </label>

      {problem !== null && (title !== "" || slug !== "") ? (
        <p role="alert" className="text-sm text-warning">
          {problem}
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending || problem !== null}
          onClick={() => void submit(post === null ? "POST" : "PATCH")}
        >
          {pending ? "저장 중…" : post === null ? "글 만들기" : "저장"}
        </Button>

        {post !== null && post.publishedAt !== null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || note.trim().length === 0}
            onClick={() => void unpublish()}
          >
            내리기 (행은 남습니다)
          </Button>
        ) : null}

        {post !== null ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            접기
          </Button>
        ) : null}
      </div>
    </div>
  );
}
