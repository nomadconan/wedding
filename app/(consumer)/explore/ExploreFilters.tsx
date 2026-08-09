"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AVAILABILITY_FILTER_NOTICE,
  BUDGET_FILTER_NOTICE,
  EXPLORE_SORTS,
  EXPLORE_SORT_PENDING,
  type ExploreSort,
} from "@/lib/core/schemas/explore";
import { STYLE_TAGS, STYLE_TAG_LABEL, type StyleTag } from "@/lib/core/schemas/onboarding";
import { VENDOR_CATEGORIES, VENDOR_CATEGORY_LABEL } from "@/lib/core/schemas/vendor";
import { SORT_CRITERIA } from "@/components/domain/SortCriteriaBadge";

/**
 * 탐색 필터 (F-C-10, §6.2 `/explore`)
 *
 * 필터 상태는 **URL 이 갖는다.** 링크를 그대로 공유하면 같은 결과가 나와야 하고,
 * 뒤로 가기가 조건을 되돌려야 한다. 그래서 컴포넌트는 URL 을 고쳐 쓰기만 한다.
 *
 * 375px 기준이라 사이드바가 아니라 **접히는 블록**이다(§6 — 화면당 정보량 최소화).
 */
export type ExploreFiltersProps = {
  defaults: {
    region: string;
    category: string;
    budgetMin: string;
    budgetMax: string;
    guestCount: string;
    date: string;
    styleTags: StyleTag[];
    onlyAvailable: boolean;
    sort: ExploreSort;
  };
};

/**
 * 걸린 조건 수. 접힌 상태에서도 몇 개가 걸렸는지 보여 준다.
 * 도메인의 `activeFilterKeys` 와 **같은 묶음 규칙**을 쓴다(예산은 하한·상한을 하나로 센다).
 */
function countActive(defaults: ExploreFiltersProps["defaults"]): number {
  let count = 0;

  if (defaults.region !== "") count += 1;
  if (defaults.category !== "") count += 1;
  if (defaults.budgetMin !== "" || defaults.budgetMax !== "") count += 1;
  if (defaults.guestCount !== "") count += 1;
  if (defaults.date !== "") count += 1;
  if (defaults.styleTags.length > 0) count += 1;
  if (defaults.onlyAvailable) count += 1;

  return count;
}

export function ExploreFilters({ defaults }: ExploreFiltersProps) {
  const activeCount = countActive(defaults);
  const router = useRouter();
  const searchParams = useSearchParams();

  const [open, setOpen] = useState(activeCount > 0);
  const [styleTags, setStyleTags] = useState<StyleTag[]>(defaults.styleTags);
  const [date, setDate] = useState(defaults.date);
  const [onlyAvailable, setOnlyAvailable] = useState(defaults.onlyAvailable);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();

    const put = (key: string, value: string) => {
      if (value.trim() !== "") next.set(key, value.trim());
    };

    put("region", String(form.get("region") ?? ""));
    put("category", String(form.get("category") ?? ""));
    put("budgetMin", String(form.get("budgetMin") ?? ""));
    put("budgetMax", String(form.get("budgetMax") ?? ""));
    put("guestCount", String(form.get("guestCount") ?? ""));
    put("date", date);
    styleTags.forEach((tag) => next.append("styleTags", tag));
    // 날짜가 없으면 성립하지 않는 조건이다. 켠 채로 보내면 422 가 된다.
    if (onlyAvailable && date !== "") next.set("onlyAvailable", "true");
    put("sort", String(form.get("sort") ?? ""));

    router.push(next.toString() === "" ? "/explore" : `/explore?${next.toString()}`);
  }

  function reset() {
    setStyleTags([]);
    setDate("");
    setOnlyAvailable(false);
    router.push("/explore");
  }

  const sortValue = searchParams.get("sort") ?? defaults.sort;

  return (
    <section className="rounded-lg border border-border" data-testid="explore-filters">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-medium text-foreground">
          조건으로 찾기
          {activeCount > 0 ? (
            <span className="ml-1 text-brand-600">· {activeCount}개 적용</span>
          ) : null}
        </span>
        <span className="text-caption text-muted-foreground">{open ? "접기" : "펼치기"}</span>
      </button>

      {open ? (
        <form className="space-y-4 border-t border-border p-4" onSubmit={submit}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="region">지역</Label>
              <Input id="region" name="region" placeholder="서울" defaultValue={defaults.region} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="category">카테고리</Label>
              <select
                id="category"
                name="category"
                defaultValue={defaults.category}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">전체</option>
                {VENDOR_CATEGORIES.map((code) => (
                  <option key={code} value={code}>
                    {VENDOR_CATEGORY_LABEL[code]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="budgetMax">예산 (원)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="budgetMin"
                name="budgetMin"
                inputMode="numeric"
                placeholder="최소"
                defaultValue={defaults.budgetMin}
              />
              <span className="text-muted-foreground">~</span>
              <Input
                id="budgetMax"
                name="budgetMax"
                inputMode="numeric"
                placeholder="최대"
                defaultValue={defaults.budgetMax}
              />
            </div>
            {/* 무엇이 포함된 금액인지 밝히지 않은 예산 필터는 사용자를 오해시킨다(D-17). */}
            <p className="text-caption text-muted-foreground">{BUDGET_FILTER_NOTICE}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="guestCount">하객 수</Label>
              <Input
                id="guestCount"
                name="guestCount"
                inputMode="numeric"
                placeholder="200"
                defaultValue={defaults.guestCount}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="date">예식일</Label>
              <Input
                id="date"
                name="date"
                type="date"
                value={date}
                onChange={(event) => {
                  setDate(event.target.value);
                  if (event.target.value === "") setOnlyAvailable(false);
                }}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>스타일</Label>
            <div className="grid grid-cols-2 gap-2">
              {STYLE_TAGS.map((tag) => (
                <div key={tag} className="flex items-center gap-2">
                  <Checkbox
                    id={`filter-style-${tag}`}
                    checked={styleTags.includes(tag)}
                    onCheckedChange={(checked) =>
                      setStyleTags((prev) =>
                        checked === true
                          ? [...new Set([...prev, tag])]
                          : prev.filter((value) => value !== tag),
                      )
                    }
                  />
                  <Label htmlFor={`filter-style-${tag}`} className="font-normal">
                    {STYLE_TAG_LABEL[tag]}
                  </Label>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Checkbox
                id="onlyAvailable"
                checked={onlyAvailable}
                disabled={date === ""}
                onCheckedChange={(checked) => setOnlyAvailable(checked === true)}
              />
              <Label htmlFor="onlyAvailable" className="font-normal">
                그날 자리 있는 곳만 보기
              </Label>
            </div>
            {/* 캘린더를 안 올린 업체를 조용히 빼지 않는다. 거르기는 사용자가 고른다. */}
            <p className="text-caption text-muted-foreground">{AVAILABILITY_FILTER_NOTICE}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sort">정렬</Label>
            <select
              id="sort"
              name="sort"
              defaultValue={sortValue}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {EXPLORE_SORTS.map((code) => (
                <option key={code} value={code}>
                  {SORT_CRITERIA[code]}
                </option>
              ))}
            </select>
            {/*
              지금 못 여는 정렬을 조용히 빼면 "그런 정렬은 없다" 로 읽힌다.
              데이터가 없어서 못 하는 것과 하지 않기로 한 것은 다르다(S2-08 과 같은 원칙).
            */}
            <details className="text-caption text-muted-foreground">
              <summary>준비 중인 정렬 {EXPLORE_SORT_PENDING.length}가지</summary>
              <ul className="mt-1 space-y-1" data-testid="sort-pending">
                {EXPLORE_SORT_PENDING.map((item) => (
                  <li key={item.code}>
                    {item.label} — {item.reason} ({item.task})
                  </li>
                ))}
              </ul>
            </details>
          </div>

          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={reset} className="flex-1">
              초기화
            </Button>
            <Button type="submit" size="touch" className="flex-1">
              적용
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

export default ExploreFilters;
