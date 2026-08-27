import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { AnomalyActionSchema } from "@/lib/core/pricing/anomaly";
import { applyAnomalyAction, loadAnomalies } from "@/lib/pricing/curation";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET/PATCH /api/admin/price-anomalies — 미끼가격·추가금 과다 플래그 큐 (F-A-14, §4.3)
 *
 * **GET 은 저장된 큐를 읽는 것이 아니라 지금 세는 것이다.** 플래그는 등록가와 지수에서
 * 계산되는 값이라 저장하지 않는다 — 배치(`price-anomaly-scan`)와 **같은 순수 함수**를
 * 부르므로 둘의 답이 갈릴 수 없다.
 *
 * **임계값이 미결이면 빈 목록이 아니라 `blocked` 를 낸다**(O-19 · 함정 2·3).
 * 화면이 안 그리는 것만으로는 부족하다 — 이 API 를 직접 읽는 사람도 "이상 없음" 과
 * "기준이 없어 보지 않음" 을 구분할 수 있어야 한다.
 *
 * **PATCH 는 판정이 아니라 기록이다**(D-24). 자동 제재·자동 비공개가 없으므로
 * 이 기록이 조치의 전부이며, 조치 셋 다 사유가 필수다.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  try {
    const payload = await loadAnomalies();
    const blocked = payload.bait.status === "blocked" && payload.addon.status === "blocked";

    return ok({
      blocked,
      openIssue: blocked ? "O-19" : null,
      thresholds: payload.thresholds,
      bait: payload.bait,
      addon: payload.addon,
      flags: payload.flags,
    });
  } catch {
    return fail(500, "PRICE_ANOMALY_FAILED", "이상 탐지 큐를 불러오지 못했습니다.");
  }
}

export async function PATCH(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "PRICE_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = AnomalyActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await applyAnomalyAction({
    ...parsed.data,
    operatorId: user.id,
    operatorRole: user.role,
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ targetId: parsed.data.targetId, action: parsed.data.action });
}
