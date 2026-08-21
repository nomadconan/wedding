import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import { ensureBudget, loadBudget } from "@/lib/budget/loader";
import { BUDGET_SHARED_TOTAL_NOTE } from "@/lib/core/budget/budget";
import { BudgetUpdateSchema } from "@/lib/core/schemas/budget";
import { findMyCouple } from "@/lib/couple/membership";
import { createPublicClient } from "@/lib/explore/query";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/PUT /api/budget — 예산 배분·실지출 (F-C-05 · 명세서 §4.2)
 *
 * §4.2 는 이 경로 하나에 **조회·갱신·실지출 등록** 셋을 얹었다. 그래서 PUT 은
 * **행위 union** 이다(`/api/tasks` 와 같은 모양).
 *
 * ── 총예산은 `couples.total_budget` 하나다 ─────────────────────────────────
 * 장바구니 예산 기준선(D-77)이 이미 그 값을 쓴다. `budgets.total_amount` 에 두면
 * **두 화면이 다른 숫자를 말하고**, 그 컬럼은 `not null default 0` 이라 '미정' 을
 * 표현하지도 못한다(0045).
 *
 * ── 인가의 최종 경계는 RLS 다 ──────────────────────────────────────────────
 * 세션 클라이언트로 쓴다. `budgets`·`budget_items`·`expenses` 정책이 커플 구성원만
 * 쓰게 한다(0005 [12][13][14] — 플래너는 **읽기만**).
 */

async function context() {
  const user = await getSessionUser();
  if (!user) return { error: fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.") } as const;

  const membership = await findMyCouple(user.id);
  if (!membership) {
    return { error: fail(404, "BUDGET_COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.") } as const;
  }

  return { user, membership } as const;
}

export async function GET() {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const supabase = await createClient();
  const view = await loadBudget(supabase, createPublicClient(), {
    coupleId: ctx.membership.coupleId,
  });

  return ok({ ...view, sharedTotalNote: BUDGET_SHARED_TOTAL_NOTE });
}

export async function PUT(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "BUDGET_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = BudgetUpdateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const coupleId = ctx.membership.coupleId;
  const input = parsed.data;

  // ── 총예산 ────────────────────────────────────────────────────────────────
  if (input.action === "set_total") {
    const { data: updated } = await supabase
      .from("couples")
      // **`null` 을 그대로 넣는다 — 그것이 '미정' 이다.** 0으로 바꾸면 담는 즉시
      // "예산 0원 대비 초과" 가 뜨는데 그건 사실이 아니라 설정이 빈 것이다.
      .update({ total_budget: input.totalBudget })
      .eq("id", coupleId)
      .select("id");

    if ((updated ?? []).length === 0) {
      return fail(403, "BUDGET_FORBIDDEN", "이 예산을 고칠 권한이 없어요.");
    }

    await recordEvent({
      entityType: "couple",
      entityId: coupleId,
      eventType: "budget_total_changed",
      actor: { id: ctx.user.id },
      // **금액을 남기지 않는다**(§7.3). 남길 사실은 "정했는가·지웠는가" 다.
      memo: input.totalBudget === null ? "cleared" : "set",
    });

    return ok({ totalBudget: input.totalBudget });
  }

  const budgetId = await ensureBudget(supabase, coupleId);
  if (budgetId === null) {
    return fail(500, "BUDGET_NOT_READY", "예산을 준비하지 못했어요.");
  }

  // ── 카테고리 계획 ─────────────────────────────────────────────────────────
  if (input.action === "set_plan") {
    // `null` 은 **계획을 지우는 것**이다 — 0원 계획과 다르다.
    const removing = input.allocations.filter((item) => item.plannedAmount === null);
    const upserting = input.allocations.filter((item) => item.plannedAmount !== null);

    if (removing.length > 0) {
      await supabase
        .from("budget_items")
        .delete()
        .eq("budget_id", budgetId)
        .in("category", removing.map((item) => item.category));
    }

    if (upserting.length > 0) {
      const { error } = await supabase.from("budget_items").upsert(
        upserting.map((item) => ({
          budget_id: budgetId,
          category: item.category,
          planned_amount: item.plannedAmount as number,
        })),
        // 유니크(0045)가 있어야 성립하는 경로다 — 없으면 같은 카테고리가 두 줄로 선다.
        { onConflict: "budget_id,category" },
      );

      if (error) return fail(500, "BUDGET_PLAN_FAILED", "계획을 저장하지 못했어요.");
    }

    await recordEvent({
      entityType: "couple",
      entityId: coupleId,
      eventType: "budget_plan_changed",
      actor: { id: ctx.user.id },
      memo: `categories:${input.allocations.length}`,
    });

    return ok({ changed: input.allocations.length });
  }

  // ── 권장을 계획으로 ───────────────────────────────────────────────────────
  if (input.action === "apply_recommendation") {
    const view = await loadBudget(supabase, createPublicClient(), { coupleId });

    const indexed = view.recommendations.filter(
      (item): item is Extract<typeof item, { kind: "indexed" }> => item.kind === "indexed",
    );

    // **기준이 없으면 권장하지 않는다** — 적용할 것도 없다.
    if (indexed.length === 0) {
      return fail(
        422,
        "BUDGET_NO_RECOMMENDATION",
        "아직 참가격 기준이 없어 권장액을 만들 수 없어요.",
      );
    }

    const plannedAlready = new Set(
      view.lines.filter((line) => line.planned !== null).map((line) => line.category),
    );

    // **기본은 덮지 않는다.** 사용자가 손으로 고친 값을 조용히 지우면 이 화면은
    // 자기가 정하지 않은 숫자를 보여주는 화면이 된다.
    const target = input.overwrite
      ? indexed
      : indexed.filter((item) => !plannedAlready.has(item.category));

    if (target.length > 0) {
      const { error } = await supabase.from("budget_items").upsert(
        target.map((item) => ({
          budget_id: budgetId,
          category: item.category,
          planned_amount: item.amount,
        })),
        { onConflict: "budget_id,category" },
      );

      if (error) return fail(500, "BUDGET_PLAN_FAILED", "계획을 저장하지 못했어요.");
    }

    // **권장의 근거를 스냅샷으로 남긴다**(D-16·D-23 과 같은 이유) — 지수가 갱신돼도
    // "그때 무엇을 근거로 권했나" 를 답할 수 있어야 한다.
    await supabase
      .from("budgets")
      .update({
        allocation_json: {
          applied_at_region: view.regionCode,
          items: indexed.map((item) => ({
            category: item.category,
            amount: item.amount,
            sample_size: item.sampleSize,
            source: item.sourceLabel,
          })),
        },
      })
      .eq("id", budgetId);

    await recordEvent({
      entityType: "couple",
      entityId: coupleId,
      eventType: "budget_recommendation_applied",
      actor: { id: ctx.user.id },
      memo: `applied:${target.length} skipped:${indexed.length - target.length}`,
    });

    return ok({ applied: target.length, skipped: indexed.length - target.length });
  }

  // ── 실지출 ────────────────────────────────────────────────────────────────
  if (input.action === "add_expense") {
    const { data: created, error } = await supabase
      .from("expenses")
      .insert({
        couple_id: coupleId,
        category: input.category,
        amount: input.amount,
        paid_at: input.paidAt,
        memo: input.memo,
        // 손으로 적은 지출이다. **계약 금액은 여기 들어오지 않는다**(bookings 가 진실).
        source_ref: null,
      })
      .select("id")
      .maybeSingle();

    const expenseId = (created as { id: string } | null)?.id ?? null;
    if (error || expenseId === null) {
      return fail(500, "BUDGET_EXPENSE_FAILED", "지출을 저장하지 못했어요.");
    }

    await recordEvent({
      entityType: "couple",
      entityId: coupleId,
      eventType: "budget_expense_added",
      actor: { id: ctx.user.id },
      // **메모와 금액을 남기지 않는다**(§7.3). 남길 사실은 카테고리뿐이다.
      memo: `category:${input.category}`,
    });

    return ok({ expenseId }, { status: 201 });
  }

  const { data: removed } = await supabase
    .from("expenses")
    .delete()
    .eq("id", input.expenseId)
    .eq("couple_id", coupleId)
    .select("id");

  // **없는 지출을 지워도 실패가 아니다** — 결과가 요청한 대로다(D-80 과 같은 규칙).
  const deleted = (removed ?? []).length > 0;

  if (deleted) {
    await recordEvent({
      entityType: "couple",
      entityId: coupleId,
      eventType: "budget_expense_removed",
      actor: { id: ctx.user.id },
      memo: null,
    });
  }

  return ok({ expenseId: input.expenseId, deleted });
}
