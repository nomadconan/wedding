import { recordEvent } from "@/lib/audit/record";
import { canRequestListing, validateProfile } from "@/lib/core/planner/profile";
import type { PlannerProfileInput } from "@/lib/core/schemas/planner";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 플래너 등록·프로필 (S6-02 · F-C-18 · D-16 · D-23)
 *
 * ── 왜 서비스롤인가 ─────────────────────────────────────────────────────────
 * 0005 가 본인에게 INSERT·UPDATE 를 열어 뒀지만, **상태 전이만은 서버가 판정한다** —
 * 그대로 두면 누구나 `status='active'` 로 바꿔 심사가 형해화된다(0037 트리거가 최종
 * 경계이고 이 파일은 그 앞단이다).
 *
 * ── 요금을 다루지 않는다 ────────────────────────────────────────────────────
 * `fee_json` 에 아무것도 쓰지 않는다. 요율은 `planner_fee_rates`(S5-01)가 갖고 계약
 * 확정 시 스냅샷된다(D-16). DB CHECK 도 빈 객체를 요구한다(0037).
 */
export type PlannerFailure = { status: number; code: string; message: string };

function failure(status: number, code: string, message: string): PlannerFailure {
  return { status, code, message };
}

export function isPlannerFailure(value: unknown): value is PlannerFailure {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

/**
 * 프로필 등록·수정.
 *
 * **등록은 심사를 거치지만 서류를 받지 않는다.** 업체 입점(F-V-01)은 사업자등록번호·
 * 신고번호·서류가 필요하지만 플래너는 프리랜서 개인이고 명세 F-C-18 도 "프로필·요금·
 * 리뷰" 까지만 적었다. 대신 **완성되지 않은 프로필은 공개 신청을 할 수 없다** —
 * 빈 프로필이 마켓에 섞이면 고객은 목록 전체를 신뢰하지 않는다.
 */
export async function upsertProfile(input: {
  userId: string;
  profile: PlannerProfileInput;
}): Promise<{ plannerId: string; created: boolean } | PlannerFailure> {
  const admin = createAdminClient();
  const valid = validateProfile(input.profile);

  if (!valid.ok) return failure(422, `PLANNER_INVALID_${valid.field.toUpperCase()}`, valid.detail);

  const { data: existingRow } = await admin
    .from("planners")
    .select("id, status")
    .eq("user_id", input.userId)
    .maybeSingle();

  const existing = existingRow as { id: string; status: string } | null;

  // **요금을 담지 않는다.** profile_json 에 headline·bio·careerYears·categories 만 넣고
  // regions 는 컬럼으로 간다(0004 가 배열 컬럼으로 만들어 뒀다).
  const payload = {
    user_id: input.userId,
    profile_json: {
      headline: input.profile.headline,
      bio: input.profile.bio,
      careerYears: input.profile.careerYears,
      categories: input.profile.categories,
    },
    regions: input.profile.regions,
  };

  if (existing) {
    const { error } = await admin.from("planners").update(payload).eq("id", existing.id);

    if (error) return failure(500, "PLANNER_UPDATE_FAILED", "프로필을 저장하지 못했습니다.");

    await recordEvent({
      entityType: "planner",
      entityId: existing.id,
      eventType: "planner_profile_updated",
      actor: { id: input.userId, role: "planner" },
      // 카테고리·지역 수만. 소개 본문은 넣지 않는다(§7.3).
      memo: `categories=${input.profile.categories.length} regions=${input.profile.regions.length}`,
    });

    return { plannerId: existing.id, created: false };
  }

  const { data: created, error } = await admin
    .from("planners")
    // 등록은 언제나 `pending` 에서 시작한다 — 공개는 심사의 결과다.
    .insert({ ...payload, status: "pending" })
    .select("id")
    .maybeSingle();

  if (error || !created) {
    return failure(500, "PLANNER_CREATE_FAILED", "플래너 등록을 저장하지 못했습니다.");
  }

  const plannerId = (created as { id: string }).id;

  await recordEvent({
    entityType: "planner",
    entityId: plannerId,
    eventType: "planner_registered",
    actor: { id: input.userId, role: "planner" },
    afterState: "pending",
    memo: `categories=${input.profile.categories.length}`,
  });

  return { plannerId, created: true };
}

/**
 * 공개 신청 · 내리기.
 *
 * **본인이 `active` 로 올리지 못한다.** 여기서 보내는 것은 `pending`(신청)과
 * `paused`(내리기)뿐이고, 공개는 운영자 경로가 정한다 — 0037 트리거가 최종 경계다.
 */
export async function changeListing(input: {
  userId: string;
  action: "request_listing" | "pause";
}): Promise<{ status: string } | PlannerFailure> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("planners")
    .select("id, status, profile_json, regions")
    .eq("user_id", input.userId)
    .maybeSingle();

  const row = data as {
    id: string;
    status: string;
    profile_json: Record<string, unknown>;
    regions: string[];
  } | null;

  if (!row) return failure(404, "PLANNER_NOT_FOUND", "먼저 프로필을 등록해 주세요.");

  if (input.action === "pause") {
    if (row.status !== "active") {
      return failure(422, "PLANNER_NOT_LISTED", "공개 중일 때만 내릴 수 있어요.");
    }

    await admin.from("planners").update({ status: "paused" }).eq("id", row.id);

    await recordEvent({
      entityType: "planner",
      entityId: row.id,
      eventType: "planner_paused",
      actor: { id: input.userId, role: "planner" },
      beforeState: row.status,
      afterState: "paused",
    });

    return { status: "paused" };
  }

  // **완성되지 않은 프로필은 신청할 수 없다.**
  const profile = {
    headline: (row.profile_json.headline as string | undefined) ?? "",
    bio: (row.profile_json.bio as string | undefined) ?? "",
    careerYears: Number(row.profile_json.careerYears ?? 0),
    categories: ((row.profile_json.categories as string[] | undefined) ?? []) as never,
    regions: row.regions ?? [],
  };

  if (!canRequestListing(profile)) {
    return failure(
      422,
      "PLANNER_PROFILE_INCOMPLETE",
      "한 줄 소개·경력·카테고리·활동 지역을 모두 채우면 공개를 신청할 수 있어요.",
    );
  }

  if (row.status === "active") {
    return failure(422, "PLANNER_ALREADY_LISTED", "이미 공개 중이에요.");
  }

  await admin.from("planners").update({ status: "pending" }).eq("id", row.id);

  await recordEvent({
    entityType: "planner",
    entityId: row.id,
    eventType: "planner_listing_requested",
    actor: { id: input.userId, role: "planner" },
    beforeState: row.status,
    afterState: "pending",
  });

  // **알림을 보내지 않는다.** 방금 본인이 누른 일이고 결과는 화면이 바로 말한다 —
  // 자기 행동을 자기에게 알리는 것은 알림함을 소음으로 채운다. 알림이 필요한 시점은
  // **운영자가 승인·보류할 때**인데 그 경로가 아직 없다(FIX-17 로 기록).
  return { status: "pending" };
}
