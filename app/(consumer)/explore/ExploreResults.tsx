import Link from "next/link";

import { SortCriteriaBadge } from "@/components/domain/SortCriteriaBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  EXPLORE_FILTER_LABEL,
  LIST_PRICE_NOTICE,
  type ExploreFilterKey,
} from "@/lib/core/schemas/explore";
import { findMyCouple } from "@/lib/couple/membership";
import {
  AVAILABILITY_SCAN_LIMIT,
  createPublicClient,
  searchVendors,
  toFilterInput,
} from "@/lib/explore/query";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";

import { VendorCard } from "./VendorCard";

/**
 * 목록 결과 (F-C-10)
 *
 * 조회를 **페이지가 아니라 이 컴포넌트가** 한다. 이유는 라우트 구조에 있다 —
 * `loading.tsx` 를 두면 그 경계가 **자식 라우트(`/explore/[vendorId]`)까지** 감싸서
 * 응답이 먼저 흘러나가고, 그러면 상세 화면의 `notFound()` 가 404 를 못 만든다
 * (200 + 없음 화면이 되어 버린다 — S3-01 에서 겪은 스트리밍 문제와 같은 원인).
 * 그래서 로딩 경계를 라우트가 아니라 **페이지 안쪽 Suspense** 로 내렸다.
 */
export async function ExploreResults({ params }: { params: string }) {
  const search = new URLSearchParams(params);
  const input = toFilterInput(search);

  let outcome;
  try {
    outcome = await searchVendors(createPublicClient(), input);
  } catch {
    return (
      <ErrorState
        code="VENDOR_SEARCH_FAILED"
        title="업체를 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }

  if (!outcome.ok) {
    return (
      <div className="space-y-3">
        <ErrorState
          code="VENDOR_INVALID_FILTER"
          title="조건을 확인해 주세요"
          description={outcome.issues[0]?.message ?? "필터 값을 다시 확인해 주세요."}
        />
        <Link href="/explore" className="block text-center text-sm font-medium text-brand-600">
          조건 초기화
        </Link>
      </div>
    );
  }

  const { result } = outcome;

  const user = await getSessionUser();
  const inCart = user ? await cartProductIds(user.id) : new Set<string>();
  const wished = user ? await wishedProductIds(user.id) : new Set<string>();

  return (
    <div className="space-y-4">
      {/* 정렬 기준은 목록 맨 위에 둔다. **0건이어도 노출한다** — 무엇으로 줄 세웠는지는
          결과 수와 무관한 사실이고, 감추면 유료 노출이 없다는 증명이 사라진다(D-03). */}
      <div className="space-y-2">
        <SortCriteriaBadge criteria={result.sort} />
        <p className="text-caption text-muted-foreground">{LIST_PRICE_NOTICE}</p>
      </div>

      <p className="text-sm text-muted-foreground" data-testid="explore-total">
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
                      href={`/explore?${relaxedQuery(search, hint.key)}`}
                      className="text-sm font-medium text-brand-600"
                    >
                      {EXPLORE_FILTER_LABEL[hint.key]} 조건 풀기 · {hint.count}개
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Link href="/explore" className="text-sm font-medium text-brand-600">
                조건 초기화
              </Link>
            )
          }
        />
      ) : (
        <ul className="space-y-3">
          {result.rows.map((row) => (
            <li key={row.productId}>
              <VendorCard
                row={row}
                inCart={inCart.has(row.productId)}
                inWishlist={wished.has(row.productId)}
                signedIn={Boolean(user)}
                showAvailability={input.date !== null}
              />
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

/** 조건 하나를 뺀 링크. 도메인의 `withoutFilter` 와 같은 규칙을 쓴다. */
function relaxedQuery(params: URLSearchParams, key: ExploreFilterKey): string {
  const next = new URLSearchParams(params);
  const drop = (...names: string[]) => names.forEach((name) => next.delete(name));

  if (key === "region") drop("region");
  if (key === "category") drop("category");
  if (key === "budget") drop("budgetMin", "budgetMax");
  if (key === "guestCount") drop("guestCount");
  // 날짜를 풀면 '자리 있는 곳만'도 함께 풀린다 — 날짜 없이는 성립하지 않는 조건이다.
  if (key === "date") drop("date", "onlyAvailable");
  if (key === "styleTags") drop("styleTags");
  if (key === "onlyAvailable") drop("onlyAvailable");

  next.delete("page");

  return next.toString();
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
    <Link href={`/explore?${next.toString()}`} className="text-sm font-medium text-brand-600">
      {children}
    </Link>
  );
}

/** 우리 커플 장바구니에 담긴 상품 id. 담기 자체는 S3-05 이고 여기서는 표시만 한다. */
async function cartProductIds(userId: string): Promise<Set<string>> {
  const membership = await findMyCouple(userId);
  if (!membership) return new Set();

  const admin = createAdminClient();

  const { data: cart } = await admin
    .from("carts")
    .select("id")
    .eq("couple_id", membership.coupleId)
    .eq("status", "active")
    .maybeSingle();

  if (!cart) return new Set();

  const { data: items } = await admin.from("cart_items").select("product_id").eq("cart_id", cart.id);

  return new Set((items ?? []).map((item) => (item as { product_id: string }).product_id));
}

export default ExploreResults;

/** 우리 커플이 찜한 상품 id. 카드의 '찜함' 표시에만 쓴다. */
async function wishedProductIds(userId: string): Promise<Set<string>> {
  const membership = await findMyCouple(userId);
  if (!membership) return new Set();

  const admin = createAdminClient();

  const { data } = await admin
    .from("wishlists")
    .select("product_id")
    .eq("couple_id", membership.coupleId)
    .not("product_id", "is", null);

  return new Set((data ?? []).map((row) => (row as { product_id: string }).product_id));
}
