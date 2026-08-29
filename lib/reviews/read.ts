import {
  type RatingSample,
  type VendorRating,
  rateVendor,
} from "@/lib/core/review/rating";
import { REVIEWABLE_BOOKING_STATUSES, type ReviewBlockReason } from "@/lib/core/review/write";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 검증 후기 읽기 (S8-11 · F-C-17 · F-V-11)
 *
 * **공개 후기는 세션 클라이언트로 읽는다.** `reviews_select_public` 정책이
 * `status='published' and retracted_at is null` 을 강제하므로 **비공개·철회된 후기가
 * 목록에 섞일 수 없다** — 앱이 조건을 빠뜨려도 DB 가 막는다(CLAUDE.md §5.5).
 * 여기서 `.eq("status", ...)` 를 손으로 다시 적지 않는 이유가 그것이다. 두 곳에
 * 적으면 한 곳이 낡는다.
 *
 * **평점은 저장하지 않고 셀 때마다 센다**(0058 §6). 캐시 칸을 만들면 후기 하나가
 * 철회될 때 두 곳이 갈리고, 갈렸을 때 어느 쪽이 맞는지 화면으로는 알 수 없다.
 */

/** 화면·API 가 함께 읽는 컬럼. 한 곳에서 관리해야 응답 모양이 갈라지지 않는다. */
export const PUBLIC_REVIEW_COLUMNS =
  "id, vendor_id, score_price, score_response, score_fulfillment, body, disclosed_amount, vendor_reply, vendor_replied_at, created_at";

export type PublicReview = {
  id: string;
  vendorId: string;
  scorePrice: number | null;
  scoreResponse: number | null;
  scoreFulfillment: number | null;
  body: string | null;
  disclosedAmount: number | null;
  vendorReply: string | null;
  vendorRepliedAt: string | null;
  createdAt: string;
};

type PublicRow = {
  id: string;
  vendor_id: string;
  score_price: number | null;
  score_response: number | null;
  score_fulfillment: number | null;
  body: string | null;
  disclosed_amount: number | null;
  vendor_reply: string | null;
  vendor_replied_at: string | null;
  created_at: string;
};

function toPublic(row: PublicRow): PublicReview {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    scorePrice: row.score_price,
    scoreResponse: row.score_response,
    scoreFulfillment: row.score_fulfillment,
    body: row.body,
    disclosedAmount: row.disclosed_amount,
    vendorReply: row.vendor_reply,
    vendorRepliedAt: row.vendor_replied_at,
    createdAt: row.created_at,
  };
}

export function toRatingSample(review: PublicReview): RatingSample {
  return {
    scorePrice: review.scorePrice,
    scoreResponse: review.scoreResponse,
    scoreFulfillment: review.scoreFulfillment,
  };
}

/** 업체 상세에 실리는 공개 후기. 최신순이며 상한을 둔다. */
export async function loadVendorReviews(vendorId: string, limit = 50): Promise<PublicReview[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("reviews")
    .select(PUBLIC_REVIEW_COLUMNS)
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error("REVIEW_LOAD_FAILED");

  return ((data ?? []) as PublicRow[]).map(toPublic);
}

/**
 * 업체 평점.
 *
 * **표시 상한(`loadVendorReviews` 의 50건)과 분모를 같이 쓰지 않는다** — 목록은
 * 잘라도 되지만 평점의 분모를 자르면 "51번째 후기부터는 평점에 없다" 가 된다.
 * 그래서 점수 세 칸만 따로, 상한 없이 읽는다.
 */
export async function loadVendorRating(vendorId: string): Promise<VendorRating> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("reviews")
    .select("score_price, score_response, score_fulfillment")
    .eq("vendor_id", vendorId);

  if (error) throw new Error("REVIEW_RATING_FAILED");

  const rows = (data ?? []) as {
    score_price: number | null;
    score_response: number | null;
    score_fulfillment: number | null;
  }[];

  return rateVendor(
    rows.map((row) => ({
      scorePrice: row.score_price,
      scoreResponse: row.score_response,
      scoreFulfillment: row.score_fulfillment,
    })),
  );
}

/**
 * 후기 작성 폼의 전제 (F-C-17).
 *
 * **화면이 자격을 판정하지 않는다** — 여기서 읽어 오는 조건은 `reviews_insert`
 * 정책이 검사하는 것과 같은 조건이고, 둘이 갈리면 **RLS 가 이긴다.** 이 함수의
 * 목적은 "저장 버튼을 눌러야 거절당하는" 경험을 없애는 것뿐이다.
 *
 * 서비스롤로 읽되 **대상은 세션에서 확인한 user id 로 좁힌다.**
 */
export type ReviewFormContext =
  | { ok: false; reason: ReviewBlockReason; existingReviewId?: string }
  | {
      ok: true;
      bookingId: string;
      coupleId: string;
      vendorId: string;
      vendorName: string;
      totalAmount: number;
    };

export async function loadReviewFormContext(
  userId: string,
  bookingId: string,
): Promise<ReviewFormContext> {
  const admin = createAdminClient();

  const { data: booking } = await admin
    .from("bookings")
    .select("id, couple_id, vendor_id, status, total_amount")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return { ok: false, reason: "not_a_member" };

  // **예약 id 만으로는 아무것도 알려주지 않는다.** 소속이 아니면 "그런 예약이 없다"
  // 와 같은 답을 준다 — 남의 예약의 존재 여부를 알려줄 이유가 없다.
  const { data: member } = await admin
    .from("couple_members")
    .select("user_id")
    .eq("couple_id", booking.couple_id)
    .eq("user_id", userId)
    .in("member_role", ["owner", "partner"])
    .maybeSingle();

  if (!member) return { ok: false, reason: "not_a_member" };

  if (!(REVIEWABLE_BOOKING_STATUSES as readonly string[]).includes(booking.status)) {
    return { ok: false, reason: "booking_not_reviewable" };
  }

  const { data: existing } = await admin
    .from("reviews")
    .select("id")
    .eq("booking_id", bookingId)
    .maybeSingle();

  if (existing) {
    return { ok: false, reason: "already_written", existingReviewId: existing.id };
  }

  const { data: vendor } = await admin
    .from("vendors")
    .select("name")
    .eq("id", booking.vendor_id)
    .maybeSingle();

  return {
    ok: true,
    bookingId: booking.id,
    coupleId: booking.couple_id,
    vendorId: booking.vendor_id,
    vendorName: vendor?.name ?? "등록 업체",
    totalAmount: booking.total_amount,
  };
}

/**
 * 아직 후기를 쓰지 않은 거래 (F-C-17 진입점).
 *
 * `/me` 의 후기 진입점을 채운다. **S8-11 이 이것을 만들 때는 §6.2 가 진입점으로
 * 삼는 `/bookings/[id]`(예약 상세)가 없었다** — 화면을 만들고 가리키는 곳을 두지
 * 않는 것이 이 리포에서 반복된 실수라(FIX-25 가 세던 다섯) `/me` 가 임시로 맡았다.
 * **S5-10 이 예약 상세를 세우면서 둘 다 진입점이 됐고, 여기를 지우지 않는다** —
 * 쓸 수 있는 것이 모여 보이는 곳과 예약마다 들어가는 곳은 쓰임새가 다르다.
 */
export type ReviewableBooking = {
  bookingId: string;
  vendorId: string;
  vendorName: string;
  totalAmount: number;
};

export async function loadReviewableBookings(coupleId: string): Promise<ReviewableBooking[]> {
  const admin = createAdminClient();

  const { data: bookings } = await admin
    .from("bookings")
    .select("id, vendor_id, total_amount")
    .eq("couple_id", coupleId)
    .in("status", [...REVIEWABLE_BOOKING_STATUSES]);

  const rows = (bookings ?? []) as { id: string; vendor_id: string; total_amount: number }[];
  if (rows.length === 0) return [];

  // **이미 쓴 것은 뺀다.** 거둔 후기도 '이미 쓴' 것이다 — `booking_id` 가 unique 라
  // 다시 쓸 수 없고, 버튼을 그려 두면 눌렀을 때 409 가 뜬다.
  const { data: written } = await admin
    .from("reviews")
    .select("booking_id")
    .in("booking_id", rows.map((row) => row.id));

  const done = new Set(((written ?? []) as { booking_id: string }[]).map((row) => row.booking_id));
  const pending = rows.filter((row) => !done.has(row.id));
  if (pending.length === 0) return [];

  const { data: vendors } = await admin
    .from("vendors")
    .select("id, name")
    .in("id", [...new Set(pending.map((row) => row.vendor_id))]);

  const names = new Map(
    ((vendors ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]),
  );

  return pending.map((row) => ({
    bookingId: row.id,
    vendorId: row.vendor_id,
    vendorName: names.get(row.vendor_id) ?? "등록 업체",
    totalAmount: row.total_amount,
  }));
}
