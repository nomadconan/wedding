import { conversationTitle, type PlannerMessageView, type ToolCard } from "@/lib/core/ai/conversation";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 대화 저장·조회 (S7-06 · 명세서 §3.6)
 *
 * **저장은 서비스롤이다.** `ai_messages` 에는 INSERT 정책이 없다(0005) — 클라이언트가
 * 직접 쓸 수 없다는 뜻이고, 그래야 "모델이 이렇게 말했다" 는 기록을 당사자가 만들 수
 * 없다. 열람은 커플 스코프로 RLS 가 연다.
 *
 * **커플 id 를 인자로 받되 호출자가 세션에서 유도한다.** 이 모듈은 서비스롤을 쥐고
 * 있으므로 스스로 경계를 만들지 않는다 — 모든 조회에 `couple_id` 를 명시로 걸고,
 * 대화를 이어 쓸 때는 **그 대화가 이 커플 것인지 먼저 확인**한다. 확인 없이 id 만
 * 믿으면 남의 대화에 이어 쓸 수 있다.
 */

export type StoredMessage = {
  id: string;
  role: string;
  content: string | null;
  tool_calls_json: unknown;
  created_at: string;
  token_in: number | null;
  token_out: number | null;
};

export type ConversationSummary = { id: string; title: string | null; lastMessageAt: string | null };

/** 커플의 대화 목록. 최근 순. */
export async function listConversations(
  coupleId: string,
  limit = 20,
): Promise<ConversationSummary[]> {
  const { data } = await createAdminClient()
    .from("ai_conversations")
    .select("id, title, last_message_at")
    .eq("couple_id", coupleId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  return ((data ?? []) as { id: string; title: string | null; last_message_at: string | null }[]).map(
    (row) => ({ id: row.id, title: row.title, lastMessageAt: row.last_message_at }),
  );
}

/** 이 대화가 이 커플 것인가. **id 만 믿지 않는다.** */
export async function ownsConversation(coupleId: string, conversationId: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("ai_conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("couple_id", coupleId)
    .maybeSingle();

  return data !== null;
}

export async function loadMessages(conversationId: string): Promise<StoredMessage[]> {
  const { data } = await createAdminClient()
    .from("ai_messages")
    .select("id, role, content, tool_calls_json, created_at, token_in, token_out")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  return (data ?? []) as StoredMessage[];
}

/** 화면이 그리는 모양으로. 카드는 `tool_calls_json` 에 함께 저장해 다시 열어도 보인다. */
export function toMessageViews(rows: readonly StoredMessage[]): PlannerMessageView[] {
  return rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({
      id: row.id,
      role: row.role as "user" | "assistant",
      text: row.content ?? "",
      createdAt: row.created_at,
      cards: Array.isArray(row.tool_calls_json) ? (row.tool_calls_json as ToolCard[]) : [],
    }));
}

/**
 * 대화를 연다.
 *
 * `context_snapshot_json` 에 **그 시점의 커플 맥락**을 박는다(§3.6). 나중에 예산·예식일이
 * 바뀌어도 이 대화가 무엇을 보고 답했는지 재현할 수 있어야 한다 — 요율 스냅샷과 같은
 * 이유다(D-16).
 */
export async function createConversation(input: {
  coupleId: string;
  firstMessage: string;
  contextSnapshot: unknown;
}): Promise<string | null> {
  const { data } = await createAdminClient()
    .from("ai_conversations")
    .insert({
      couple_id: input.coupleId,
      title: conversationTitle(input.firstMessage),
      context_snapshot_json: (input.contextSnapshot ?? {}) as Record<string, unknown>,
    })
    .select("id")
    .maybeSingle();

  return (data as { id: string } | null)?.id ?? null;
}

export async function appendMessage(input: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  cards?: readonly ToolCard[];
  tokenIn?: number | null;
  tokenOut?: number | null;
}): Promise<string | null> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("ai_messages")
    .insert({
      conversation_id: input.conversationId,
      role: input.role,
      content: input.content,
      // 카드는 **툴이 돌려준 값**이지 모델의 말이 아니다. 다시 열었을 때 같은 카드가
      // 보이도록 메시지와 함께 둔다 — 재조회하면 그 사이 값이 바뀌어 "그때 본 것" 이
      // 아니게 된다.
      tool_calls_json: input.cards === undefined ? null : input.cards,
      token_in: input.tokenIn ?? null,
      token_out: input.tokenOut ?? null,
    })
    .select("id")
    .maybeSingle();

  await admin
    .from("ai_conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", input.conversationId);

  return (data as { id: string } | null)?.id ?? null;
}

// =============================================================================
// 상한 계산 — 값은 app_settings 가, 사용량은 저장된 메시지가 갖는다
// =============================================================================

/**
 * 오늘 이 커플이 쓴 사용자 턴 수.
 *
 * **저장하지 않고 센다.** 카운터 컬럼을 두면 자정 리셋 배치가 필요하고, 그 배치가
 * 늦은 만큼 사용자는 못 쓰거나 더 쓴다(0027·0032 가 세운 것과 같은 규칙 — 소진·만료를
 * 저장하지 않는다).
 *
 * `asOf` 는 호출자가 넘긴다. 서버 시계로 조용히 정하면 같은 요청이 시각에 따라 다르게
 * 판정된다.
 */
export async function turnsUsedToday(coupleId: string, asOf: string): Promise<number> {
  const admin = createAdminClient();

  const { data: conversations } = await admin
    .from("ai_conversations")
    .select("id")
    .eq("couple_id", coupleId);

  const ids = ((conversations ?? []) as { id: string }[]).map((row) => row.id);
  if (ids.length === 0) return 0;

  const { count } = await admin
    .from("ai_messages")
    .select("id", { count: "exact", head: true })
    .in("conversation_id", ids)
    .eq("role", "user")
    .gte("created_at", `${asOf}T00:00:00Z`)
    .lt("created_at", `${asOf}T23:59:59.999Z`);

  return count ?? 0;
}

/** 이 대화가 지금까지 쓴 토큰. 세션 상한의 근거다(§5.6 — 비용 사고는 한 세션에서 난다). */
export async function sessionTokens(conversationId: string | null): Promise<number> {
  if (conversationId === null) return 0;

  const { data } = await createAdminClient()
    .from("ai_messages")
    .select("token_in, token_out")
    .eq("conversation_id", conversationId);

  return ((data ?? []) as { token_in: number | null; token_out: number | null }[]).reduce(
    (sum, row) => sum + (row.token_in ?? 0) + (row.token_out ?? 0),
    0,
  );
}
