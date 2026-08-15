"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { SEARCH_QUERY_MAX } from "@/lib/core/schemas/search";

/**
 * 검색어 입력 (F-C-30 · §6.2 `/search`)
 *
 * **새 검색어는 새 검색이다.** 이전에 칩으로 고쳤던 명시 조건(`region=판교` 등)을 그대로
 * 들고 가면, 문장을 바꿔 넣었는데 결과가 안 바뀌는 화면이 된다 — 사용자는 그것을 고장으로
 * 읽는다. 그래서 제출할 때 파라미터를 **q 하나로 새로 만든다.**
 */
const EXAMPLES = [
  "3월 14일 강남 300인 웨딩홀",
  "판교 250명 예산 3천만원 이하",
  "내년 5월 야외 스몰웨딩",
];

export function SearchBox({ defaultQuery }: { defaultQuery: string }) {
  const router = useRouter();
  const [value, setValue] = useState(defaultQuery);

  function go(query: string) {
    const next = query.trim();
    router.push(next === "" ? "/search" : `/search?q=${encodeURIComponent(next)}`);
  }

  return (
    <section className="space-y-2" data-testid="search-box">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          go(value);
        }}
      >
        <input
          name="q"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={SEARCH_QUERY_MAX}
          placeholder="3월 14일 강남 300인"
          aria-label="조건 검색어"
          className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" size="touch" className="shrink-0">
          찾기
        </Button>
      </form>

      <div className="flex flex-wrap gap-1.5" data-testid="search-examples">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => {
              setValue(example);
              go(example);
            }}
            className="rounded-md border border-border px-2 py-1 text-caption text-muted-foreground"
          >
            {example}
          </button>
        ))}
      </div>
    </section>
  );
}

export default SearchBox;
