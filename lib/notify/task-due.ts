import { readIntSetting } from "@/lib/app-settings";
import { leadTimeOf, orderDeadline } from "@/lib/core/product/lead-time";
import { daysUntil } from "@/lib/core/schedule/graph";
import { dedupeKey } from "@/lib/core/schemas/notification";
import {
  TASK_DUE_INTERVAL_SETTING_KEY,
  TASK_DUE_LEAD_SETTING_KEY,
  emptyCounts,
  isSendPoint,
  taskDueSchedule,
  type TaskDueCounts,
  type TaskDueSchedule,
} from "@/lib/core/notify/task-due";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";

import { sendNotification } from "./send";

/**
 * 기한 알림 배치 (C-4d · `task-due-notifications`, 매일 · 명세서 §4.5)
 *
 * ── 무엇을 알리는가 — 둘이다 ────────────────────────────────────────────────
 *  1. **체크리스트 항목의 기한**(`tasks.due_date` · C-4a 가 항목을 늘렸다)
 *  2. **담은 상품의 주문 기한**(예식일 − `products.lead_time_days` · C-4b 가 만들었다)
 *
 * **토픽은 하나**(`task_due`)다 — 사용자에게 둘 다 *"이 날짜까지 해야 한다"* 이고
 * 다른 것은 어디로 가는가뿐이다. 템플릿이 그것을 가른다.
 *
 * ── 왜 `dday-notifications` 에 넣지 않았나 ──────────────────────────────────
 * `job_runs` 는 배치 단위로 남는다. 한 라우트에 묶으면 **무엇이 실패했는지 못 가르고**
 * 한쪽 장애가 다른 쪽 발송을 막는다. 주기도 성격도 다르다(예식일 하나 / 항목마다).
 *
 * ── 네 갈래를 알림에서도 지킨다 (C-4b · D-225) ──────────────────────────────
 *  · `deadline`        → 보낸다
 *  · `not_declared`    → **안 보낸다.** 업체가 안 적은 기한을 우리가 지어내지 않는다
 *  · `no_deadline`     → **안 보낸다.** 업체가 "따로 기한 없음" 이라고 말했다
 *  · `no_wedding_date` → **안 보낸다.** 커플이 예식일을 안 정했다
 * 셋을 **각각 다른 사유로 센다** — 합치면 "왜 안 갔는지" 를 운영이 못 본다.
 *
 * ── 파라미터가 없으면 아무것도 보내지 않는다 (§7.4) ─────────────────────────
 * `blocked` 로 끝내고 사유를 `job_runs` 에 남긴다. **0건 발송과 구분된다** — 전자는
 * "못 보냈다" 이고 후자는 "보낼 게 없었다" 이며, 운영이 할 일이 다르다.
 *
 * ── 멱등 열쇠에 날짜가 아니라 **지점**을 넣는다 ─────────────────────────────
 * 배치가 하루에 두 번 돌거나 재실행돼도 같은 지점은 한 번만 나간다. 열쇠에 실행
 * 날짜를 넣으면 재실행 때 다른 열쇠가 되어 중복이 나간다(`dday` 가 마일스톤을 넣은
 * 것과 같은 이유).
 */
export type TaskDueRunResult = TaskDueCounts & {
  /** 파라미터가 없어 아무것도 안 보낸 경우의 사유. 정상 실행이면 `null`. */
  blocked: string | null;
  leadDays: number | null;
  intervalDays: number | null;
};

type CoupleRow = { id: string; wedding_date: string | null };

export async function runTaskDueNotifications(today: string): Promise<TaskDueRunResult> {
  const counts = emptyCounts();
  const admin = createAdminClient();

  const schedule: TaskDueSchedule = taskDueSchedule({
    leadDays: await readIntSetting(TASK_DUE_LEAD_SETTING_KEY, "value"),
    intervalDays: await readIntSetting(TASK_DUE_INTERVAL_SETTING_KEY, "value"),
  });

  if (schedule.kind === "blocked") {
    // **훑지도 않는다.** 보낼 수 없는 것이 분명한데 표를 읽으면 그 읽기가 "돌았다" 로
    // 보인다 — 무엇을 했는지가 흐려진다.
    return {
      ...counts,
      blocked: schedule.reason,
      leadDays: null,
      intervalDays: null,
    };
  }

  const { points, leadDays, intervalDays } = schedule;

  // ── 수신자 — 커플 구성원 ──────────────────────────────────────────────────
  const { data: coupleRows } = await admin.from("couples").select("id, wedding_date");
  const couples = (coupleRows ?? []) as CoupleRow[];

  if (couples.length === 0) {
    return { ...counts, blocked: null, leadDays, intervalDays };
  }

  const { data: memberRows } = await admin
    .from("couple_members")
    .select("couple_id, user_id")
    .in("couple_id", couples.map((row) => row.id))
    .in("member_role", ["owner", "partner"]);

  const members = new Map<string, string[]>();
  for (const row of (memberRows ?? []) as { couple_id: string; user_id: string }[]) {
    members.set(row.couple_id, [...(members.get(row.couple_id) ?? []), row.user_id]);
  }

  // 이메일은 **어댑터에만 넘기고 저장하지 않는다**(§7.3). `dday` 와 같은 방식이다.
  const emails = new Map<string, string>();
  const { data: authUsers } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const user of authUsers?.users ?? []) {
    if (user.email) emails.set(user.id, user.email);
  }

  /** 한 대상에 대해 구성원 전원에게 두 채널로 보낸다. `dday` 와 같은 규칙이다. */
  const fanOut = async (input: {
    coupleId: string;
    templateKey: "task_due.remind" | "task_due.order";
    subjectId: string;
    days: number;
    params: Record<string, Json | undefined>;
  }) => {
    const recipients = members.get(input.coupleId) ?? [];

    if (recipients.length === 0) {
      counts.skipped.no_recipient += 1;

      return;
    }

    for (const userId of recipients) {
      for (const channel of ["in_app", "email"] as const) {
        const outcome = await sendNotification({
          userId,
          topic: "task_due",
          channel,
          templateKey: input.templateKey,
          params: input.params,
          dedupeKey: dedupeKey({
            templateKey: input.templateKey,
            subjectId: `${input.subjectId}:${userId}:${channel}`,
            // **날짜가 아니라 지점**이다 — 재실행이 중복을 만들지 않게.
            period: `d-${input.days}`,
          }),
          email: emails.get(userId) ?? null,
        });

        if (outcome.status === "sent") counts.sent += 1;
        else if (outcome.status === "duplicate") counts.duplicate += 1;
        // **끈 것은 실패가 아니다.** 사용자가 고른 결과이며 그 사실도 세어 둔다.
        else if (outcome.status === "skipped") counts.skipped.prefs_off += 1;
        else counts.failed += 1;
      }
    }
  };

  // ── 1. 체크리스트 항목의 기한 ─────────────────────────────────────────────
  const { data: taskRows } = await admin
    .from("tasks")
    .select("id, couple_id, due_date, status")
    .limit(5000);

  for (const task of (taskRows ?? []) as {
    id: string;
    couple_id: string;
    due_date: string | null;
    status: string;
  }[]) {
    counts.scanned += 1;

    // **끝낸 항목에는 보내지 않는다.** 다 한 일을 재촉하면 알림을 통째로 끄게 된다.
    if (task.status === "done") {
      counts.skipped.done += 1;
      continue;
    }
    if (task.due_date === null) {
      counts.skipped.no_due_date += 1;
      continue;
    }

    const days = daysUntil(today, task.due_date);

    if (!isSendPoint(days, points)) {
      counts.skipped.not_a_send_point += 1;
      continue;
    }

    await fanOut({
      coupleId: task.couple_id,
      templateKey: "task_due.remind",
      subjectId: task.id,
      days,
      // **제목을 담지 않는다**(§7.3) — 참조와 숫자만.
      params: { taskId: task.id, days },
    });
  }

  // ── 2. 담은 상품의 주문 기한 ──────────────────────────────────────────────
  //
  // **장바구니를 본다.** 커플과 상품을 잇는 관계 중 *"사려고 보고 있다"* 를 뜻하는
  // 것이 장바구니이고, 주문 기한이 의미를 갖는 자리도 거기다. 찜은 더 느슨한 관심
  // 표시라 넣지 않았다 — 찜 하나에 기한 재촉이 붙으면 찜을 안 하게 된다.
  const weddingByCouple = new Map(couples.map((row) => [row.id, row.wedding_date]));

  const { data: cartRows } = await admin
    .from("carts")
    .select("id, couple_id")
    .eq("status", "active");

  const carts = (cartRows ?? []) as { id: string; couple_id: string }[];

  if (carts.length > 0) {
    const { data: itemRows } = await admin
      .from("cart_items")
      .select("cart_id, vendor_id, product_id")
      .in("cart_id", carts.map((row) => row.id));

    const coupleByCart = new Map(carts.map((row) => [row.id, row.couple_id]));
    const items = (itemRows ?? []) as {
      cart_id: string;
      vendor_id: string;
      product_id: string;
    }[];

    const productIds = [...new Set(items.map((item) => item.product_id))];

    const { data: productRows } = productIds.length
      ? await admin
          .from("products")
          .select("id, lead_time_days, lead_time_note")
          .in("id", productIds)
      : { data: [] };

    const productById = new Map(
      ((productRows ?? []) as {
        id: string;
        lead_time_days: number | null;
        lead_time_note: string | null;
      }[]).map((row) => [row.id, row]),
    );

    // **같은 커플이 같은 상품을 여러 장바구니에 담을 수 있다.** 그때 알림이 두 번
    // 가면 안 되므로 (커플, 상품) 로 접는다 — 멱등 열쇠도 그 짝으로 만든다.
    const seen = new Set<string>();

    for (const item of items) {
      const coupleId = coupleByCart.get(item.cart_id);
      if (coupleId === undefined) continue;

      const pairKey = `${coupleId}:${item.product_id}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      counts.scanned += 1;

      const product = productById.get(item.product_id);
      const deadline = orderDeadline({
        weddingDate: weddingByCouple.get(coupleId) ?? null,
        leadTime: leadTimeOf({
          days: product?.lead_time_days ?? null,
          note: product?.lead_time_note ?? null,
        }),
      });

      // **네 갈래를 그대로 유지한다**(D-225). 셋은 각각 다른 사유로 센다.
      if (deadline.kind === "not_declared") {
        counts.skipped.lead_time_not_declared += 1;
        continue;
      }
      if (deadline.kind === "no_deadline") {
        counts.skipped.no_order_deadline += 1;
        continue;
      }
      if (deadline.kind === "no_wedding_date") {
        counts.skipped.no_due_date += 1;
        continue;
      }

      const days = daysUntil(today, deadline.date);

      if (!isSendPoint(days, points)) {
        counts.skipped.not_a_send_point += 1;
        continue;
      }

      await fanOut({
        coupleId,
        templateKey: "task_due.order",
        subjectId: pairKey,
        days,
        // **상품명·업체명·금액을 담지 않는다**(§7.3) — 참조와 숫자만.
        params: { productId: item.product_id, vendorId: item.vendor_id, days },
      });
    }
  }

  return { ...counts, blocked: null, leadDays, intervalDays };
}
