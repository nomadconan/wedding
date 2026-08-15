"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BUDGET_FILTER_NOTICE } from "@/lib/core/schemas/explore";
import { STYLE_TAGS, STYLE_TAG_LABEL, type StyleTag } from "@/lib/core/schemas/onboarding";
import { SEARCH_FIELDS, type SearchField } from "@/lib/core/schemas/search";
import { VENDOR_CATEGORIES, VENDOR_CATEGORY_LABEL } from "@/lib/core/schemas/vendor";

/**
 * 조건 직접 고치기 (§5.5 — "파싱 결과는 되돌려 보여주고 **수정 가능하게** 한다")
 *
 * 명세 §5.5 1단계의 실패 처리이기도 하다 — 못 읽은 조건은 **비우고 사용자에게 직접 선택을
 * 요청**한다. 그 요청을 받을 곳이 이 폼이다.
 *
 * **폼이 제출되면 그 값이 조건의 전부다.** 그래서 현재 조건을 미리 채워 두고, 비운 칸은
 * `drop` 으로 URL 에 남긴다 — 비운 것과 안 건드린 것을 구분하지 않으면 "지웠는데 다시
 * 살아나는" 화면이 된다(자연어를 매번 다시 파싱하기 때문이다).
 */
export type ConditionEditorProps = {
  query: string;
  defaults: {
    region: string;
    category: string;
    budgetMin: string;
    budgetMax: string;
    guestCount: string;
    date: string;
    styleTags: StyleTag[];
  };
  /** 아직 비어 있는 조건. 펼침 여부와 안내 문구를 정한다. */
  emptyFields: SearchField[];
};

export function ConditionEditor({ query, defaults, emptyFields }: ConditionEditorProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [styleTags, setStyleTags] = useState<StyleTag[]>(defaults.styleTags);
  const [date, setDate] = useState(defaults.date);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    if (query.trim() !== "") next.set("q", query);

    const filled = new Set<SearchField>();

    const put = (field: SearchField, raw: string) => {
      if (raw.trim() === "") return;
      next.set(field, raw.trim());
      filled.add(field);
    };

    put("region", String(form.get("region") ?? ""));
    put("category", String(form.get("category") ?? ""));
    put("budgetMin", String(form.get("budgetMin") ?? ""));
    put("budgetMax", String(form.get("budgetMax") ?? ""));
    put("guestCount", String(form.get("guestCount") ?? ""));
    put("date", date);

    if (styleTags.length > 0) {
      styleTags.forEach((tag) => next.append("styleTags", tag));
      filled.add("styleTags");
    }

    // 비운 칸은 "지웠다" 는 뜻이다. 안 적으면 다음 조회에서 자연어가 다시 채운다.
    for (const field of SEARCH_FIELDS) {
      if (!filled.has(field)) next.append("drop", field);
    }

    router.push(`/search?${next.toString()}`);
  }

  return (
    <section className="rounded-lg border border-border" data-testid="condition-editor">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-medium text-foreground">
          조건 직접 고치기
          {emptyFields.length > 0 ? (
            <span className="ml-1 text-muted-foreground">· 비어 있는 조건 {emptyFields.length}개</span>
          ) : null}
        </span>
        <span className="text-caption text-muted-foreground">{open ? "접기" : "펼치기"}</span>
      </button>

      {open ? (
        <form className="space-y-4 border-t border-border p-4" onSubmit={submit}>
          <p className="text-caption text-muted-foreground">
            아래 값이 이 검색의 조건이 됩니다. 비운 칸은 조건에서 빠집니다.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="search-region">지역</Label>
              <Input id="search-region" name="region" placeholder="강남" defaultValue={defaults.region} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="search-category">카테고리</Label>
              <select
                id="search-category"
                name="category"
                defaultValue={defaults.category}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">선택 안 함</option>
                {VENDOR_CATEGORIES.map((code) => (
                  <option key={code} value={code}>
                    {VENDOR_CATEGORY_LABEL[code]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="search-budgetMax">예산 (원)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="search-budgetMin"
                name="budgetMin"
                inputMode="numeric"
                placeholder="최소"
                defaultValue={defaults.budgetMin}
              />
              <span className="text-muted-foreground">~</span>
              <Input
                id="search-budgetMax"
                name="budgetMax"
                inputMode="numeric"
                placeholder="최대"
                defaultValue={defaults.budgetMax}
              />
            </div>
            <p className="text-caption text-muted-foreground">{BUDGET_FILTER_NOTICE}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="search-guestCount">하객 수</Label>
              <Input
                id="search-guestCount"
                name="guestCount"
                inputMode="numeric"
                placeholder="300"
                defaultValue={defaults.guestCount}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="search-date">예식일</Label>
              <Input
                id="search-date"
                name="date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>스타일</Label>
            <div className="grid grid-cols-2 gap-2">
              {STYLE_TAGS.map((tag) => (
                <div key={tag} className="flex items-center gap-2">
                  <Checkbox
                    id={`search-style-${tag}`}
                    checked={styleTags.includes(tag)}
                    onCheckedChange={(checked) =>
                      setStyleTags((prev) =>
                        checked === true
                          ? [...new Set([...prev, tag])]
                          : prev.filter((value) => value !== tag),
                      )
                    }
                  />
                  <Label htmlFor={`search-style-${tag}`} className="font-normal">
                    {STYLE_TAG_LABEL[tag]}
                  </Label>
                </div>
              ))}
            </div>
          </div>

          <Button type="submit" size="touch" className="w-full">
            이 조건으로 찾기
          </Button>
        </form>
      ) : null}
    </section>
  );
}

export default ConditionEditor;
