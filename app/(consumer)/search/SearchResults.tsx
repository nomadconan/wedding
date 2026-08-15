import Link from "next/link";

import { AiDisclaimer } from "@/components/domain/AiDisclaimer";
import { SortCriteriaBadge } from "@/components/domain/SortCriteriaBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  AVAILABILITY_SCAN_LIMIT,
  createPublicClient,
} from "@/lib/explore/query";
import {
  EXPLORE_FILTER_LABEL,
  LIST_PRICE_NOTICE,
  type ExploreFilterKey,
} from "@/lib/core/schemas/explore";
import type { StyleTag } from "@/lib/core/schemas/onboarding";
import {
  CONDITION_ORIGIN_LABEL,
  type SearchCondition,
  type SearchField,
} from "@/lib/core/schemas/search";
import { conditionChipLabel, emptyFieldLabel } from "@/lib/core/search/filter";
import { hasMeaningfulLeftover } from "@/lib/core/search/parse";
import type { FitScore } from "@/lib/core/search/rank";
import { cartChoicesFor, isInCart, loadViewerState } from "@/lib/explore/viewer";
import { conditionSearch, toSearchInput, type SearchResultRow } from "@/lib/search/query";
import { getSessionUser } from "@/lib/supabase/auth";

import { VendorCard } from "../explore/VendorCard";
import { ConditionEditor } from "./ConditionEditor";

/**
 * 조건 검색 결과 (F-C-30 · 명세서 §5.5 · §6.2)
 *
 * 조회는 API 와 **같은 함수**(`conditionSearch`)를 쓴다 — 화면이 자기 파이프라인을 따로
 * 돌리면 `GET /api/search` 로 확인한 결과와 화면이 갈린다(S3-03 에서 세운 규칙).
 *
 * 이 화면이 반드시 지켜야 하는 것 셋.
 *  · **랭킹 기준 배지**를 결과 수와 무관하게 항상 보인다(D-03 · §5.5 4단계).
 *  · **파싱 결과를 칩으로 되돌려 보여주고 고칠 수 있게** 한다(§5.5).
 *  · **AI 고지를 상시 노출**한다 — 조건 해석에 모델이 관여할 수 있다(CLAUDE.md §2.3).
 */
export async function SearchResults({ params }: { params: string }) {
  const search = new URLSearchParams(params);
  const parsed = toSearchInput(search);

  if (!parsed.ok) {
    return (
      <div className="space-y-3">
        <ErrorState
          code="SEARCH_INVALID_CONDITION"
          title="조건을 확인해 주세요"
          description={parsed.issues[0]?.message ?? "조건 값을 다시 확인해 주세요."}
        />
        <Link href="/search" className="block text-center text-sm font-medium text-brand-600">
          검색어만 남기고 다시 하기
        </Link>
      </div>
    );
  }

  const { input } = parsed;

  // 아직 아무것도 묻지 않았다. **빈 조건으로 카탈로그를 쏟지 않는다** — 그건 탐색 화면의 일이다.
  if (input.query.trim() === "" && input.user.length === 0) {
    return (
      <div className="space-y-4">
        <AiDisclaimer />
        <EmptyState
          assetId="explore.empty"
          title="문장으로 적어 보세요"
          description="날짜·지역·하객 수·예산·스타일을 한 줄에 섞어 적어도 됩니다. 읽은 조건은 칩으로 보여드리고, 잘못 읽었으면 고칠 수 있어요."
          action={
            <Link href="/explore" className="text-sm font-medium text-brand-600">
              조건 없이 둘러보기
            </Link>
          }
        />
      </div>
    );
  }

  let outcome;
  try {
    outcome = await conditionSearch(createPublicClient(), input);
  } catch {
    return (
      <ErrorState
        code="SEARCH_FAILED"
        title="검색하지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }

  if (!outcome.ok) {
    return (
      <ErrorState
        code="SEARCH_INVALID_CONDITION"
        title="조건을 확인해 주세요"
        description={outcome.issues[0]?.message ?? "조건 값을 다시 확인해 주세요."}
      />
    );
  }

  const { result } = outcome;
  const user = await getSessionUser();
  const viewer = await loadViewerState(user?.id ?? null);

  const hasDate = result.conditions.some((condition) => condition.field === "date");

  return (
    <div className="space-y-4">
      {/* 조건 해석에 AI 가 관여할 수 있다. 접거나 숨기지 않는다(CLAUDE.md §2.3). */}
      <AiDisclaimer />

      <ConditionSummary conditions={result.conditions} params={search} />

      {result.rejected.length > 0 ? (
        <ul className="space-y-1 rounded-lg border border-border p-3" data-testid="search-rejected">
          {result.rejected.map((item) => (
            <li key={`${item.sourceText}-${item.reason}`} className="text-caption text-muted-foreground">
              <strong className="text-foreground">&lsquo;{item.sourceText}&rsquo;</strong> · {item.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {/* 못 읽은 말을 조용히 삼키지 않는다 — 사용자는 그것도 조건이 됐다고 생각한다. */}
      {hasMeaningfulLeftover(result.leftover) ? (
        <p className="text-caption text-muted-foreground" data-testid="search-leftover">
          &lsquo;{result.leftover}&rsquo; 는 조건으로 옮기지 못했어요. 아래에서 직접 골라 주세요.
        </p>
      ) : null}

      <ConditionEditor
        query={result.query}
        defaults={editorDefaults(result.conditions)}
        emptyFields={result.emptyFields}
      />

      {result.emptyFields.length > 0 ? (
        <p className="text-caption text-muted-foreground" data-testid="search-empty-fields">
          아직 비어 있는 조건 · {result.emptyFields.map(emptyFieldLabel).join(" · ")}
        </p>
      ) : null}

      {/* 랭킹 기준은 **0건이어도** 보인다. 무엇으로 줄 세웠는지는 결과 수와 무관한 사실이다. */}
      <div className="space-y-2">
        <SortCriteriaBadge criteria={result.ranking.code} />

        <details className="rounded-lg border border-border p-3" data-testid="ranking-rules">
          <summary className="text-caption font-medium text-foreground">
            {result.ranking.code === "condition_fit"
              ? "무엇으로 줄 세웠는지 보기"
              : "조건이 없어 가격 낮은 순으로 세웠어요"}
          </summary>
          <ul className="mt-2 space-y-1 text-caption text-muted-foreground">
            {result.ranking.rules.map((rule) => (
              <li key={rule.criterion}>· {rule.label}</li>
            ))}
            <li>· {result.ranking.tieBreak}</li>
            <li>
              · 예산·카테고리는 조건에 맞는 상품만 걸러 내는 데 쓰고 점수로는 세지 않습니다.
            </li>
            <li>
              · 업체가 캘린더나 수용 인원을 등록하지 않은 경우는 감점하지 않고 0점으로 둡니다.
            </li>
          </ul>
        </details>

        <p className="text-caption text-muted-foreground">{LIST_PRICE_NOTICE}</p>
        <p className="text-caption text-muted-foreground" data-testid="search-asof">
          &lsquo;다음 달&rsquo; 같은 날짜는 {result.asOf} 기준으로 읽었어요.
        </p>
      </div>

      <p className="text-sm text-muted-foreground" data-testid="search-total">
        {result.total}개 상품
        {result.truncated ? ` (앞에서 ${AVAILABILITY_SCAN_LIMIT}개까지 확인했어요)` : ""}
      </p>

      {result.rows.length === 0 ? (
        <EmptyState
          assetId="explore.empty"
          title="조건에 맞는 업체가 없어요"
          description={
            result.relaxationHints.length > 0
              ? "아래 조건을 풀면 결과가 나와요."
              : "조건을 조금 넓혀 보시겠어요?"
          }
          action={
            result.relaxationHints.length > 0 ? (
              <ul className="space-y-2" data-testid="relaxation-hints">
                {result.relaxationHints.map((hint) => (
                  <li key={hint.key}>
                    <Link
                      href={relaxHref(search, hint.key)}
                      className="text-sm font-medium text-brand-600"
                    >
                      {EXPLORE_FILTER_LABEL[hint.key]} 조건 풀기 · {hint.count}개
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Link href="/explore" className="text-sm font-medium text-brand-600">
                조건 없이 둘러보기
              </Link>
            )
          }
        />
      ) : (
        <ul className="space-y-3">
          {result.rows.map((row) => (
            <li key={row.productId} className="space-y-1">
              <VendorCard
                row={row}
                carts={cartChoicesFor(viewer, row.productId)}
                inCart={isInCart(viewer, row.productId)}
                inWishlist={viewer.wished.has(row.productId)}
                signedIn={Boolean(user)}
                showAvailability={hasDate}
                showGap={false}
              />
              <FitNote fit={row.fit} />
            </li>
          ))}
        </ul>
      )}

      {result.total > result.pageSize ? (
        <nav className="flex items-center justify-between pt-2" aria-label="페이지 이동">
          <PageLink params={search} page={result.page - 1} disabled={result.page <= 1}>
            이전
          </PageLink>
          <span className="text-caption text-muted-foreground">
            {result.page} / {Math.max(1, Math.ceil(result.total / result.pageSize))}
          </span>
          <PageLink
            params={search}
            page={result.page + 1}
            disabled={result.page * result.pageSize >= result.total}
          >
            다음
          </PageLink>
        </nav>
      ) : null}
    </div>
  );
}

/**
 * 파싱 결과를 되돌려 보여준다(§5.5).
 *
 * 칩마다 **누가 만든 조건인지**와 **지우는 길**을 함께 둔다. 지울 수 없는 조건은 사용자가
 * 바로잡을 수 없고, 바로잡을 수 없는 해석은 결과를 설명하지 못한다.
 */
function ConditionSummary({
  conditions,
  params,
}: {
  conditions: SearchCondition[];
  params: URLSearchParams;
}) {
  if (conditions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="condition-chips">
        읽어 낸 조건이 없어요. 아래에서 직접 골라 주세요.
      </p>
    );
  }

  return (
    <ul className="flex flex-wrap gap-1.5" data-testid="condition-chips">
      {conditions.map((condition) => (
        <li key={condition.field}>
          <span
            className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-caption text-secondary-foreground"
            data-origin={condition.origin}
          >
            {conditionChipLabel(condition)}
            {condition.origin !== "rule" ? (
              <em className="not-italic text-muted-foreground">
                ({CONDITION_ORIGIN_LABEL[condition.origin]})
              </em>
            ) : null}
            <Link
              href={dropHref(params, condition.field)}
              aria-label={`${conditionChipLabel(condition)} 조건 지우기`}
              className="font-medium text-brand-600"
            >
              ×
            </Link>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 이 상품이 왜 그 자리인지. 점수만 적으면 근거가 아니라 숫자가 된다. */
function FitNote({ fit }: { fit: FitScore | null }) {
  if (fit === null || fit.details.length === 0) return null;

  return (
    <details className="px-1" data-testid="fit-note">
      <summary className="text-caption text-muted-foreground">
        조건 부합 {fit.score} / {fit.max}점
      </summary>
      <ul className="mt-1 space-y-0.5">
        {fit.details.map((detail) => (
          <li key={detail.criterion} className="text-caption text-muted-foreground">
            · {detail.note} ({detail.points}점)
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * 조건을 지운 링크.
 *
 * 명시 파라미터를 지우는 것만으로는 부족하다 — 다음 조회에서 **자연어가 그 자리를 다시
 * 채운다.** 그래서 지웠다는 사실을 `drop` 으로 URL 에 남긴다.
 */
function withDropped(params: URLSearchParams, fields: SearchField[]): string {
  const next = new URLSearchParams(params);
  const drops = new Set(next.getAll("drop"));

  next.delete("drop");
  for (const field of fields) {
    next.delete(field);
    drops.add(field);
  }

  drops.forEach((value) => next.append("drop", value));
  next.delete("page");

  return `/search?${next.toString()}`;
}

function dropHref(params: URLSearchParams, field: SearchField): string {
  return withDropped(params, [field]);
}

/** 0건 안내의 '조건 풀기'. 조회 필터 키를 검색 조건 필드로 옮긴다. */
function relaxHref(params: URLSearchParams, key: ExploreFilterKey): string {
  if (key === "budget") return withDropped(params, ["budgetMin", "budgetMax"]);
  // '자리 있는 곳만' 은 조건 검색이 켜지 않는다(§5.5 — 거르지 않고 가점한다).
  if (key === "onlyAvailable") return withDropped(params, []);

  return withDropped(params, [key as SearchField]);
}

function PageLink({
  params,
  page,
  disabled,
  children,
}: {
  params: URLSearchParams;
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) return <span className="text-sm text-muted-foreground">{children}</span>;

  const next = new URLSearchParams(params);
  next.set("page", String(page));

  return (
    <Link href={`/search?${next.toString()}`} className="text-sm font-medium text-brand-600">
      {children}
    </Link>
  );
}

/** 폼 초기값. 지금 걸린 조건을 그대로 채운다 — 폼이 제출되면 그 값이 조건의 전부가 된다. */
function editorDefaults(conditions: SearchCondition[]) {
  const find = <T,>(field: SearchField): T | null => {
    const found = conditions.find((condition) => condition.field === field);

    return found === undefined ? null : (found.value as T);
  };

  const text = (field: SearchField) => {
    const value = find<string | number>(field);

    return value === null ? "" : String(value);
  };

  return {
    region: text("region"),
    category: text("category"),
    budgetMin: text("budgetMin"),
    budgetMax: text("budgetMax"),
    guestCount: text("guestCount"),
    date: text("date"),
    styleTags: find<StyleTag[]>("styleTags") ?? [],
  };
}

export default SearchResults;
