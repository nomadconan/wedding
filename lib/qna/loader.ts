import { SIMILAR_LIMIT, SIMILAR_THRESHOLD, type QnaPostView } from "@/lib/core/schemas/qna";

/**
 * 문의게시판 조회 (S4-05 · F-C-28 · F-V-16)
 *
 * 표와 RLS 는 S4-01(0021)이 만들었다. **읽기는 전부 세션 클라이언트**다 — 공개글은
 * anon 도 보고(`qna_posts_select_public`), 비공개글은 작성자와 해당 업체만 본다.
 * 여기서 `is_public` 을 다시 거르지 않는 이유가 그것이다: 거르면 경계가 둘이 된다.
 */
type Client = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export const QNA_POST_COLUMNS =
  "id, vendor_id, author_id, title, body, is_public, status, answered_at, created_at";

type PostRow = {
  id: string;
  vendor_id: string;
  author_id: string;
  title: string;
  body: string;
  is_public: boolean;
  status: string;
  answered_at: string | null;
  created_at: string;
};

type AnswerRow = {
  id: string;
  post_id: string;
  body: string;
  created_at: string;
  updated_at: string;
};

export async function loadQnaPosts(
  supabase: Client,
  options: { vendorId: string; viewerId: string | null; limit?: number },
): Promise<QnaPostView[]> {
  const { data: postRows, error } = await supabase
    .from("qna_posts")
    .select(QNA_POST_COLUMNS)
    .eq("vendor_id", options.vendorId)
    .order("created_at", { ascending: false })
    .limit(options.limit ?? 50);

  if (error) throw new Error("QNA_LOAD_FAILED");

  const posts = (postRows ?? []) as PostRow[];
  if (posts.length === 0) return [];

  // 답변의 가시성은 질문을 따라간다 — RLS 의 `can_read_qna_post()` 가 판정한다(0021).
  const { data: answerRows } = await supabase
    .from("qna_answers")
    .select("id, post_id, body, created_at, updated_at")
    .in("post_id", posts.map((post) => post.id))
    .order("created_at", { ascending: true });

  const answers = new Map<string, AnswerRow[]>();
  for (const row of (answerRows ?? []) as AnswerRow[]) {
    answers.set(row.post_id, [...(answers.get(row.post_id) ?? []), row]);
  }

  return posts.map((post) => ({
    id: post.id,
    vendorId: post.vendor_id,
    authorId: post.author_id,
    title: post.title,
    body: post.body,
    isPublic: post.is_public,
    status: post.status,
    answeredAt: post.answered_at,
    createdAt: post.created_at,
    isMine: options.viewerId !== null && post.author_id === options.viewerId,
    answers: (answers.get(post.id) ?? []).map((answer) => ({
      id: answer.id,
      body: answer.body,
      createdAt: answer.created_at,
      updatedAt: answer.updated_at,
    })),
  }));
}

/**
 * 유사 질문 (F-C-28 — "같은 업체의 유사 질문 노출로 중복 문의를 줄인다")
 *
 * 0024 가 깐 `idx_qna_posts_similarity`(pg_trgm GIN)를 탄다. `similarity()` 는
 * PostgREST 로 부를 수 없으므로 **RPC 없이** `ilike` 로 후보를 좁힌 뒤 애플리케이션에서
 * 3-gram 유사도를 재계산한다 — 새 DB 함수를 만들면 마이그레이션이 하나 더 필요하고,
 * 후보 수가 업체당 수십 건이라 비용이 문제가 되지 않는다.
 *
 * **공개글만 본다.** 비공개 질문을 "비슷한 질문" 으로 보여주면 그 자체가 유출이다 —
 * RLS 가 작성자·업체에게는 보여주지만, 여기서는 목적이 다르므로 한 번 더 좁힌다.
 */
export async function loadSimilarQuestions(
  supabase: Client,
  options: { vendorId: string; text: string },
): Promise<{ id: string; title: string; answered: boolean }[]> {
  const query = options.text.trim();
  if (query.length < 2) return [];

  const { data } = await supabase
    .from("qna_posts")
    .select("id, title, body, status, is_public")
    .eq("vendor_id", options.vendorId)
    .eq("is_public", true)
    .in("status", ["open", "answered"])
    .limit(200);

  const candidates = (data ?? []) as {
    id: string;
    title: string;
    body: string;
    status: string;
  }[];

  return candidates
    .map((post) => ({
      id: post.id,
      title: post.title,
      answered: post.status === "answered",
      score: trigramContainment(query, `${post.title} ${post.body}`),
    }))
    .filter((post) => post.score >= SIMILAR_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, SIMILAR_LIMIT)
    .map(({ id, title, answered }) => ({ id, title, answered }));
}

/**
 * 문자 3-gram **포함도**(containment).
 *
 * 한국어는 형태소 분석기 없이 어절로 쪼개면 거의 맞지 않는다("주차 가능한가요" vs
 * "주차장 있나요" 는 한 토큰도 겹치지 않는다). 문자 n-gram 이 그 문제를 우회한다 —
 * pg_trgm 과 같은 발상이다.
 *
 * **자카드가 아니라 포함도를 쓴다.** pg_trgm 의 `similarity()` 는 자카드
 * (공유 / 합집합)인데, 짧은 질의를 긴 글과 비교하면 분모가 글 길이에 끌려가 점수가
 * 구조적으로 낮아진다. "주차 공간 문의"(3-gram 8개)를 두 문장짜리 글과 견주면 전부
 * 겹쳐도 0.2를 못 넘는다. 여기서 묻는 것은 "두 글이 얼마나 닮았나" 가 아니라
 * **"내가 쓰려는 질문이 이미 저기 있나"** 이므로, 분모는 **질의 쪽**이어야 한다.
 */
function trigramContainment(query: string, target: string): number {
  const left = trigrams(query);
  const right = trigrams(target);

  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const gram of left) {
    if (right.has(gram)) shared += 1;
  }

  return shared / left.size;
}

function trigrams(value: string): Set<string> {
  const normalized = ` ${value.toLowerCase().replace(/\s+/g, " ").trim()} `;
  const grams = new Set<string>();

  for (let index = 0; index + 3 <= normalized.length; index += 1) {
    grams.add(normalized.slice(index, index + 3));
  }

  return grams;
}

/** 업체 화면의 미답변 큐(F-V-16). 0021 의 부분 인덱스를 탄다. */
export async function loadVendorQna(
  supabase: Client,
  vendorId: string,
): Promise<{ posts: QnaPostView[]; unansweredCount: number }> {
  const posts = await loadQnaPosts(supabase, { vendorId, viewerId: null, limit: 100 });

  return {
    posts,
    unansweredCount: posts.filter((post) => post.status === "open").length,
  };
}

/** 업체 이름. 공개 데이터라 익명 클라이언트로도 읽힌다. */
export async function loadVendorName(
  supabase: Client,
  vendorId: string,
): Promise<{ id: string; name: string; category: string } | null> {
  const { data } = await supabase
    .from("vendors")
    .select("id, name, category")
    .eq("id", vendorId)
    .eq("status", "active")
    .maybeSingle();

  return (data as { id: string; name: string; category: string } | null) ?? null;
}
