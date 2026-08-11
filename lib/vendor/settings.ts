import { recordEvent } from "@/lib/audit/record";
import type { NotificationChannel, NotificationTopic } from "@/lib/core/schemas/notification";
import {
  isVendorChannelAllowed,
  isWithinBusinessHours,
  nextBusinessStart,
  resolveRecipients,
  type BusinessHour,
  type RecipientMode,
} from "@/lib/core/vendor/vendor-settings";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 업체 조직 설정 (S4-14 · F-V-14)
 *
 * `route.ts` 는 HTTP 메서드 외의 export 를 허용하지 않으므로 화면·API·발송 경로가
 * 함께 쓰는 것을 여기에 둔다.
 *
 * ── 발송 경로에서 이 파일을 부른다 ──────────────────────────────────────────
 * 채팅·문의·상담이 각자 "누구에게 보낼까" 를 결정하던 것을 **한 함수로 모은다**
 * (`vendorRecipients`). 세 곳이 각자 판단하면 설정이 한 곳에만 반영되는 날이 온다.
 */
type Client = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

/** 한국 표준시. 업체가 등록한 "월 10:00" 은 이 오프셋의 시각이다(S4-07 과 같은 규칙). */
export const KST_OFFSET_MINUTES = 540;

export type VendorSettings = {
  recipientMode: RecipientMode;
  defaultAssigneeId: string | null;
  businessHours: BusinessHour[];
  deferOffhours: boolean;
};

/** 설정 행이 없으면 기본값이다 — 업체가 아직 아무것도 정하지 않은 상태. */
export const DEFAULT_VENDOR_SETTINGS: VendorSettings = {
  recipientMode: "all",
  defaultAssigneeId: null,
  businessHours: [],
  deferOffhours: true,
};

function toSettings(row: Record<string, unknown> | null): VendorSettings {
  if (row === null) return DEFAULT_VENDOR_SETTINGS;

  return {
    recipientMode: (row.recipient_mode as RecipientMode) ?? "all",
    defaultAssigneeId: (row.default_assignee_id as string | null) ?? null,
    businessHours: Array.isArray(row.business_hours) ? (row.business_hours as BusinessHour[]) : [],
    deferOffhours: (row.defer_offhours as boolean | null) ?? true,
  };
}

export async function loadVendorSettings(
  supabase: Client,
  vendorId: string,
): Promise<VendorSettings> {
  const { data } = await supabase
    .from("vendor_settings")
    .select("recipient_mode, default_assignee_id, business_hours, defer_offhours")
    .eq("vendor_id", vendorId)
    .maybeSingle();

  return toSettings(data as Record<string, unknown> | null);
}

/** 발송 경로용. 서비스롤로 읽는다 — 알림을 보내는 쪽은 그 업체 멤버가 아니다. */
export async function loadVendorSettingsAdmin(vendorId: string): Promise<VendorSettings> {
  const { data } = await createAdminClient()
    .from("vendor_settings")
    .select("recipient_mode, default_assignee_id, business_hours, defer_offhours")
    .eq("vendor_id", vendorId)
    .maybeSingle();

  return toSettings(data as Record<string, unknown> | null);
}

export type VendorChannelPrefs = Record<string, Partial<Record<NotificationChannel, boolean>>>;

export async function loadVendorChannelPrefs(
  supabase: Client,
  vendorId: string,
): Promise<VendorChannelPrefs> {
  const { data } = await supabase
    .from("vendor_notification_prefs")
    .select("topic, channel_flags")
    .eq("vendor_id", vendorId);

  return Object.fromEntries(
    ((data ?? []) as { topic: string; channel_flags: Record<string, boolean> }[]).map((row) => [
      row.topic,
      row.channel_flags ?? {},
    ]),
  );
}

// =============================================================================
// 발송 대상 — 채팅·문의·상담이 함께 쓴다
// =============================================================================

export type VendorDelivery = {
  /** 이 건의 알림을 받을 사람. */
  recipients: string[];
  /**
   * 지금 보내도 되는가. `false` 면 영업시간 밖이고 업체가 미루기를 켠 상태다.
   *
   * **판정(SLA)은 이 값과 무관하다** — 여기서 미루는 것은 알림 시각뿐이다
   * (0026 주석 2번). 미룬 알림은 다음 영업 시작에 배치가 보낸다.
   */
  sendNow: boolean;
  /** 미룬다면 언제까지. `sendNow` 가 true 면 null. */
  deferUntil: string | null;
};

/**
 * 이 업체에 알림을 보낼 대상과 시점.
 *
 * **판정은 순수 함수가 한다**(`resolveRecipients`·`isWithinBusinessHours`). 이
 * 함수는 DB 에서 값을 읽어 넘길 뿐이다.
 */
export async function vendorDelivery(input: {
  vendorId: string;
  /** 이 건에 배정된 담당자(채팅방·문의 대상). 없으면 null. */
  assignedTo?: string | null;
  now: Date;
}): Promise<VendorDelivery> {
  const admin = createAdminClient();
  const settings = await loadVendorSettingsAdmin(input.vendorId);

  const { data: memberRows } = await admin
    .from("vendor_members")
    .select("user_id")
    .eq("vendor_id", input.vendorId);

  const memberIds = ((memberRows ?? []) as { user_id: string }[]).map((row) => row.user_id);

  const recipients = resolveRecipients({
    mode: settings.recipientMode,
    memberIds,
    assignedTo: input.assignedTo ?? null,
    defaultAssignee: settings.defaultAssigneeId,
  });

  const open = isWithinBusinessHours(settings.businessHours, input.now, KST_OFFSET_MINUTES);

  if (open || !settings.deferOffhours) {
    return { recipients, sendNow: true, deferUntil: null };
  }

  const next = nextBusinessStart(settings.businessHours, input.now, KST_OFFSET_MINUTES);

  // 미룰 곳을 못 찾으면(영업시간 등록이 이상하면) 즉시 보낸다 — 미루다 영영 안 가는
  // 것보다 낫다.
  return next === null
    ? { recipients, sendNow: true, deferUntil: null }
    : { recipients, sendNow: false, deferUntil: next.toISOString() };
}

/**
 * 이 사람에게 이 채널로 보내도 되는가 — **조직 층 + 개인 층**.
 *
 * `sendNotification` 은 개인 설정만 본다(0020). 업체 쪽은 조직 설정이 한 겹 더
 * 있으므로 호출 전에 여기서 거른다.
 */
export async function vendorChannelAllowed(input: {
  vendorId: string;
  userId: string;
  topic: NotificationTopic;
  channel: NotificationChannel;
}): Promise<boolean> {
  if (input.channel === "in_app") return true;

  const admin = createAdminClient();

  const [{ data: orgRow }, { data: personalRow }] = await Promise.all([
    admin
      .from("vendor_notification_prefs")
      .select("channel_flags")
      .eq("vendor_id", input.vendorId)
      .eq("topic", input.topic)
      .maybeSingle(),
    admin
      .from("notification_prefs")
      .select("channel_flags")
      .eq("user_id", input.userId)
      .eq("topic", input.topic)
      .maybeSingle(),
  ]);

  return isVendorChannelAllowed({
    channel: input.channel,
    vendorFlags: (orgRow?.channel_flags ?? null) as Partial<Record<NotificationChannel, boolean>> | null,
    personalFlags: (personalRow?.channel_flags ?? null) as Partial<
      Record<NotificationChannel, boolean>
    > | null,
  });
}

// =============================================================================
// 쓰기
// =============================================================================

export type SettingsFailure = { status: number; code: string; message: string };

export async function saveVendorSettings(
  supabase: Client,
  input: {
    vendorId: string;
    actorId: string;
    patch: Partial<{
      recipientMode: RecipientMode;
      defaultAssigneeId: string | null;
      businessHours: BusinessHour[];
      deferOffhours: boolean;
    }>;
  },
): Promise<{ settings: VendorSettings } | SettingsFailure> {
  const row: Record<string, unknown> = { vendor_id: input.vendorId };

  if (input.patch.recipientMode !== undefined) row.recipient_mode = input.patch.recipientMode;
  if (input.patch.defaultAssigneeId !== undefined) {
    row.default_assignee_id = input.patch.defaultAssigneeId;
  }
  if (input.patch.businessHours !== undefined) row.business_hours = input.patch.businessHours;
  if (input.patch.deferOffhours !== undefined) row.defer_offhours = input.patch.deferOffhours;

  // 정책이 owner 전용이라(0026) staff 가 부르면 여기서 끊긴다.
  const { error } = await supabase
    .from("vendor_settings")
    .upsert(row, { onConflict: "vendor_id" });

  if (error) {
    // 트리거가 "기본 담당자는 그 업체 구성원" 을 거절한 경우도 여기로 온다.
    // DB 예외문을 그대로 흘리지 않는다.
    return {
      status: 403,
      code: "VENDOR_SETTINGS_FORBIDDEN",
      message:
        "설정을 저장하지 못했어요. 대표 계정인지, 담당자가 이 업체 구성원인지 확인해 주세요.",
    };
  }

  await recordEvent({
    entityType: "vendor_settings",
    entityId: input.vendorId,
    eventType: "vendor_settings_updated",
    actor: { id: input.actorId, role: "vendor" },
    // 무엇을 바꿨는지만. 값 자체는 표가 들고 있다.
    memo: Object.keys(input.patch).join(","),
  });

  return { settings: await loadVendorSettings(supabase, input.vendorId) };
}

export async function saveVendorChannel(
  supabase: Client,
  input: {
    vendorId: string;
    actorId: string;
    topic: string;
    channel: NotificationChannel;
    enabled: boolean;
  },
): Promise<{ topic: string } | SettingsFailure> {
  const { data: existing } = await supabase
    .from("vendor_notification_prefs")
    .select("id, channel_flags")
    .eq("vendor_id", input.vendorId)
    .eq("topic", input.topic)
    .maybeSingle();

  const flags = {
    ...((existing?.channel_flags ?? {}) as Record<string, boolean>),
    [input.channel]: input.enabled,
  };

  const { error } = existing
    ? await supabase
        .from("vendor_notification_prefs")
        .update({ channel_flags: flags })
        .eq("id", (existing as { id: string }).id)
    : await supabase
        .from("vendor_notification_prefs")
        .insert({ vendor_id: input.vendorId, topic: input.topic, channel_flags: flags });

  if (error) {
    return {
      status: 403,
      code: "VENDOR_CHANNEL_FORBIDDEN",
      message: "수신 채널은 대표만 바꿀 수 있어요.",
    };
  }

  await recordEvent({
    entityType: "vendor_settings",
    entityId: input.vendorId,
    eventType: "vendor_channel_updated",
    actor: { id: input.actorId, role: "vendor" },
    memo: `${input.topic}:${input.channel}=${input.enabled}`,
  });

  return { topic: input.topic };
}
