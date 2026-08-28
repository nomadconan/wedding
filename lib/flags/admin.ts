import { recordEvent } from "@/lib/audit/record";
import { type FlagRow, buildFlagConsole, specOf } from "@/lib/core/flags/registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 피처 플래그 콘솔 (S8-12 · F-A-10)
 *
 * **읽는 방식이 다른 콘솔과 다르다.** 다른 표는 운영자 SELECT **정책**으로 열었지만
 * (D-115 — 행이 목적이면 정책) `feature_flags` 는 **테이블 GRANT 자체가 회수된 유일한
 * 표**라(D-15) 정책을 쓰려면 GRANT 부터 복구해야 한다. 그 순간 "키 목록 = 미공개 기능
 * 로드맵" 을 막던 두 번째 층이 사라진다 — 그래서 **SECURITY DEFINER 함수 하나를 문으로**
 * 둔다(S8-01 이 지표에서 쓴 방식). 경계는 여전히 DB 안이다.
 *
 * **함수를 세션 클라이언트로 부른다.** 경계가 `is_operator()` 라 서비스롤로 부르면
 * `auth.uid()` 가 없어 막힌다 — `db:rls` 가 그것을 확인한다.
 *
 * **쓰기는 서비스롤이다**(D-62). 정책을 주려면 역시 GRANT 가 필요하다.
 */

export type FlagConsole = {
  flags: FlagRow[];
  unknownInDatabase: string[];
  missingInDatabase: string[];
  enabledCount: number;
  /**
   * 지역·세그먼트 부분 공개. **만들지 않았다** — 그 조건을 읽는 코드가 없어서,
   * 화면에 넣으면 **집행되지 않는 조치**가 된다(S8-09 가 사용자 제재에서 정한 것과
   * 같은 판단 · D-143). 화면·API 가 그 사실을 싣는다.
   */
  segmentRollout: { available: false; reason: string };
};

const SEGMENT_UNAVAILABLE = {
  available: false as const,
  reason:
    "지역·사용자 세그먼트 부분 공개는 아직 없습니다. rollout_json 에 세그먼트를 적어도 그것을 읽는 코드가 없어, 화면에 설정 칸을 두면 '설정했는데 아무 일도 안 일어나는' 상태가 됩니다. 지금 있는 부분 공개는 코드가 선언한 표현 스위치뿐입니다.",
};

export async function loadFlagConsole(): Promise<FlagConsole> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_feature_flags");
  if (error) throw new Error("FLAG_LOAD_FAILED");

  const rows = (data ?? []) as {
    key: string;
    enabled: boolean;
    rollout_json: unknown;
    updated_at: string;
  }[];

  return { ...buildFlagConsole(rows), segmentRollout: SEGMENT_UNAVAILABLE };
}

export type FlagResult =
  | { ok: true; key: string }
  | { ok: false; status: number; code: string; message: string };

/**
 * 플래그 토글 (F-A-10).
 *
 * **조건 미충족 상태로 켜는 것을 막지 않는다**(D-145) — 긴급 롤백이 이 플래그의 정의된
 * 용도이고(§1.3 NOTE) 조건은 기계가 판정할 수 있는 형태가 아니다. 대신 **사유가
 * 필수**이며 어긋난 상태를 화면이 드러낸다.
 *
 * **`updated_by` 를 입력으로 받지 않는다.** 세션이 정한다 — 받으면 남의 이름으로
 * "이 사람이 켰다" 는 기록이 만들어진다(D-144 와 같은 자리).
 *
 * **`rollout_json` 을 자유 편집하지 않는다.** 코드가 선언한 부분 스위치만 덮어쓰고
 * 나머지 키(개방 조건 서술 · D-67)는 **그대로 보존**한다 — 오타 하나가 기능을 닫는다.
 */
export async function setFlag(input: {
  key: string;
  enabled: boolean;
  partials: Record<string, boolean> | null;
  reason: string;
  operatorId: string;
  operatorRole: string | null;
}): Promise<FlagResult> {
  const spec = specOf(input.key);

  if (spec === null) {
    return {
      ok: false,
      status: 409,
      code: "FLAG_NOT_IN_CODE",
      message: "코드가 모르는 플래그입니다. 켜 두어도 아무 일도 일어나지 않습니다.",
    };
  }

  const admin = createAdminClient();

  const { data: current } = await admin
    .from("feature_flags")
    .select("id, key, enabled, rollout_json")
    .eq("key", input.key)
    .maybeSingle();

  if (!current) {
    return {
      ok: false,
      status: 404,
      code: "FLAG_ROW_MISSING",
      message: "이 플래그의 행이 아직 없습니다. 행이 없으면 꺼진 것이며, 만드는 것은 마이그레이션의 몫입니다.",
    };
  }

  const before = asObject(current.rollout_json);
  const declared = new Set(spec.partials.map((partial) => partial.key));

  // **선언된 키만 덮어쓴다.** 나머지는 그대로 — 개방 조건 서술이 사라지면 다음 사람이
  // 무엇을 채워야 열리는지 알 수 없다(D-67).
  const next = { ...before };
  if (input.partials !== null) {
    for (const [key, value] of Object.entries(input.partials)) {
      if (declared.has(key)) next[key] = value;
    }
  }

  const { error } = await admin
    .from("feature_flags")
    // **이 세 칸만.** `key` 는 바꾸지 않는다 — 코드가 문자열로 부르는 값이다.
    .update({ enabled: input.enabled, rollout_json: next, updated_by: input.operatorId })
    .eq("key", input.key);

  if (error) {
    return { ok: false, status: 500, code: "FLAG_UPDATE_FAILED", message: "저장하지 못했습니다." };
  }

  const toggled = current.enabled !== input.enabled;

  await recordEvent({
    entityType: "feature_flag",
    entityId: current.id,
    eventType: toggled ? (input.enabled ? "flag_enabled" : "flag_disabled") : "flag_rollout_changed",
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: current.enabled ? "on" : "off",
    afterState: input.enabled ? "on" : "off",
    source: "admin",
    // **사유 본문을 담지 않는다**(§7.3). 남길 사실은 **어느 플래그인가** — id 만으로는
    // 나중에 읽는 사람이 못 알아본다(S8-06 이 룰에서 정한 것과 같다).
    memo: `flag:${input.key}`,
  });

  await writeAuditLog(admin, {
    actorId: input.operatorId,
    actorRole: input.operatorRole,
    action: toggled ? "feature_flag_toggled" : "feature_flag_rollout_changed",
    targetType: "feature_flag",
    targetId: current.id,
    // **짧은 값이라 그대로 남긴다.** 플래그는 되돌릴 수 있지만 켜져 있던 동안 벌어진
    // 일은 되돌릴 수 없다 — "언제부터 언제까지 켜져 있었나" 가 나중의 질문이다.
    before: { key: input.key, enabled: current.enabled, rollout: before },
    after: { enabled: input.enabled, rollout: next, reason: input.reason },
  });

  return { ok: true, key: input.key };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 운영자 액션은 `audit_logs` 에도 남기고 **근거 이벤트 id 를 함께** 남긴다(§7.2). */
async function writeAuditLog(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    actorId: string;
    actorRole: string | null;
    action: string;
    targetType: string;
    targetId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<void> {
  const { data: basisRows } = await admin
    .from("entity_events")
    .select("id")
    .eq("actor_id", input.actorId)
    .order("occurred_at", { ascending: false })
    .limit(5);

  const basis = ((basisRows ?? []) as { id: string }[]).map((row) => row.id);

  await admin.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_role: input.actorRole,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    before_json: input.before,
    after_json: input.after,
    // 빈 배열은 CHECK 이 막는다.
    resolution_basis: basis.length > 0 ? basis : null,
  });
}
