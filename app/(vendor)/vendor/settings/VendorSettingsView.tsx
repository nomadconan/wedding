"use client";

import { Trash2 } from "lucide-react";
import { useCallback, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  BUSINESS_HOURS_SLA_NOTE,
  RECIPIENT_MODES,
  RECIPIENT_MODE_DESCRIPTION,
  RECIPIENT_MODE_LABEL,
  ROUND_ROBIN_NOTE,
  SETTINGS_EMPTY_HOURS,
  SETTINGS_OWNER_ONLY_NOTE,
  TEMPLATE_KIND_DESCRIPTION,
  TEMPLATE_KIND_LABEL,
  TEMPLATE_KINDS,
  VENDOR_TOPICS,
  VENDOR_TOPIC_LABEL,
  formatBusinessHours,
  type BusinessHour,
  type RecipientMode,
  type TemplateKind,
} from "@/lib/core/vendor/vendor-settings";
import {
  INVITE_DELIVERY_PENDING_NOTE,
  INVITES_EMPTY_DESCRIPTION,
  INVITES_EMPTY_TITLE,
  INVITE_STATUS_LABEL,
  type InviteStatus,
} from "@/lib/core/vendor/vendor-invite";
import {
  CHANNEL_LABEL,
  CHANNEL_PENDING,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from "@/lib/core/schemas/notification";
import type { VendorTemplateView } from "@/lib/core/schemas/vendor-settings";
import type { VendorSettings } from "@/lib/vendor/settings";

const SETTINGS_ENDPOINT = "/api/vendor/settings";
const INVITES_ENDPOINT = "/api/vendor/invites";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

type Member = { userId: string; displayName: string | null; role: string };
type Invite = {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  sentAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  inviteUrl: string | null;
};

/**
 * 업체 알림·연동 설정 (F-V-14, §6.3 `/vendor/settings`)
 *
 * **대표만 바꿀 수 있는 것과 담당자도 바꿀 수 있는 것을 화면이 나눠 보여준다.**
 * 다만 화면이 버튼을 숨기는 것으로 끝내지 않는다 — 최종 경계는 RLS 다(0026).
 * staff 가 요청을 직접 보내도 DB 가 거절하고, 화면은 그 결과를 문장으로 옮긴다.
 */
export function VendorSettingsView({
  initialSettings,
  initialChannels,
  initialTemplates,
  initialInvites,
  members,
  isOwner,
}: {
  initialSettings: VendorSettings;
  initialChannels: Record<string, Partial<Record<NotificationChannel, boolean>>>;
  initialTemplates: VendorTemplateView[];
  initialInvites: Invite[];
  members: Member[];
  isOwner: boolean;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [channels, setChannels] = useState(initialChannels);
  const [templates, setTemplates] = useState(initialTemplates);
  const [invites, setInvites] = useState(initialInvites);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [settingsRes, invitesRes] = await Promise.all([
        fetch(SETTINGS_ENDPOINT),
        fetch(INVITES_ENDPOINT),
      ]);
      const settingsBody = await settingsRes.json();
      const invitesBody = await invitesRes.json();

      if (settingsRes.ok && settingsBody.ok) {
        setSettings(settingsBody.data.settings as VendorSettings);
        setChannels(settingsBody.data.channels);
        setTemplates(settingsBody.data.templates as VendorTemplateView[]);
      }

      if (invitesRes.ok && invitesBody.ok) setInvites(invitesBody.data.invites as Invite[]);
    } catch {
      // 화면은 이미 그려져 있다.
    }
  }, []);

  async function call(endpoint: string, body: unknown, key: string) {
    setPending(key);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return null;
      }

      await refresh();

      return payload.data;
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");

      return null;
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="vendor-settings">
      <p className="text-caption text-muted-foreground">{SETTINGS_OWNER_ONLY_NOTE}</p>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? <p className="text-sm text-success-foreground">{notice}</p> : null}

      {/* ── 수신 대상 ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">문의·채팅 알림을 누가 받나요</CardTitle>
          <CardDescription>{ROUND_ROBIN_NOTE}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <fieldset className="space-y-2" disabled={!isOwner}>
            {RECIPIENT_MODES.map((mode) => (
              <label key={mode} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="recipient-mode"
                  value={mode}
                  checked={settings.recipientMode === mode}
                  onChange={() =>
                    void call(
                      SETTINGS_ENDPOINT,
                      { action: "update_settings", recipientMode: mode as RecipientMode },
                      "mode",
                    )
                  }
                  className="mt-1"
                  data-testid={`recipient-${mode}`}
                />
                <span>
                  <span className="text-sm font-medium text-foreground">
                    {RECIPIENT_MODE_LABEL[mode]}
                  </span>
                  <span className="block text-caption text-muted-foreground">
                    {RECIPIENT_MODE_DESCRIPTION[mode]}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="default-assignee">기본 담당자</Label>
            <select
              id="default-assignee"
              disabled={!isOwner}
              value={settings.defaultAssigneeId ?? ""}
              onChange={(event) =>
                void call(
                  SETTINGS_ENDPOINT,
                  {
                    action: "update_settings",
                    defaultAssigneeId: event.target.value === "" ? null : event.target.value,
                  },
                  "assignee",
                )
              }
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
            >
              <option value="">지정 안 함</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.displayName ?? member.userId.slice(0, 8)}
                  {member.role === "owner" ? " (대표)" : ""}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {/* ── 채널 ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">수신 채널</CardTitle>
          <CardDescription>
            업체가 켠 채널 중에서 각자가 끄지 않은 것만 나가요. 앱 알림함은 끌 수 없어요.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {VENDOR_TOPICS.map((topic) => (
            <div key={topic} className="space-y-1.5" data-testid="channel-row" data-topic={topic}>
              <p className="text-sm font-medium text-foreground">
                {VENDOR_TOPIC_LABEL[topic] ?? topic}
              </p>
              <div className="flex flex-wrap gap-3">
                {NOTIFICATION_CHANNELS.map((channel) => {
                  const alwaysOn = channel === "in_app";
                  const enabled = alwaysOn || (channels[topic]?.[channel] ?? true);

                  return (
                    <label key={channel} className="flex items-center gap-1.5">
                      <Checkbox
                        checked={enabled}
                        disabled={!isOwner || alwaysOn}
                        onCheckedChange={(next) =>
                          void call(
                            SETTINGS_ENDPOINT,
                            {
                              action: "update_channel",
                              topic,
                              channel,
                              enabled: next === true,
                            },
                            `${topic}-${channel}`,
                          )
                        }
                      />
                      <span className="text-caption text-muted-foreground">
                        {CHANNEL_LABEL[channel]}
                        {CHANNEL_PENDING[channel] ? " (준비 중)" : ""}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ── 영업시간 ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">영업시간</CardTitle>
          <CardDescription>{BUSINESS_HOURS_SLA_NOTE}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {settings.businessHours.length === 0 ? (
            <p className="text-caption text-muted-foreground">{SETTINGS_EMPTY_HOURS}</p>
          ) : (
            <ul className="space-y-1" data-testid="business-hours">
              {formatBusinessHours(settings.businessHours).map((line, index) => (
                <li key={line} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-foreground">{line}</span>
                  {isOwner ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="시간대 삭제"
                      disabled={pending === "hours"}
                      onClick={() =>
                        void call(
                          SETTINGS_ENDPOINT,
                          {
                            action: "update_settings",
                            businessHours: settings.businessHours.filter((_, i) => i !== index),
                          },
                          "hours",
                        )
                      }
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {isOwner ? (
            <BusinessHourForm
              pending={pending === "hours"}
              onAdd={(hour) =>
                void call(
                  SETTINGS_ENDPOINT,
                  {
                    action: "update_settings",
                    businessHours: [...settings.businessHours, hour],
                  },
                  "hours",
                )
              }
            />
          ) : null}

          <Separator />

          <label className="flex items-center gap-2">
            <Checkbox
              checked={settings.deferOffhours}
              disabled={!isOwner}
              onCheckedChange={(next) =>
                void call(
                  SETTINGS_ENDPOINT,
                  { action: "update_settings", deferOffhours: next === true },
                  "defer",
                )
              }
              data-testid="defer-offhours"
            />
            <span className="text-sm text-foreground">
              영업시간 밖 알림은 다음 영업 시작에 보내기
            </span>
          </label>
        </CardContent>
      </Card>

      {/* ── 템플릿 (S4-04 · S4-12 이월) ─────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">저장한 템플릿</CardTitle>
          <CardDescription>
            빠른 답변과 견적 구성을 저장해 두고 꺼내 써요. 담당자도 만들 수 있어요.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {TEMPLATE_KINDS.map((kind) => (
            <div key={kind} className="space-y-1.5" data-testid="template-group" data-kind={kind}>
              <p className="text-sm font-medium text-foreground">{TEMPLATE_KIND_LABEL[kind]}</p>
              <p className="text-caption text-muted-foreground">
                {TEMPLATE_KIND_DESCRIPTION[kind]}
              </p>

              <ul className="space-y-1">
                {templates
                  .filter((template) => template.kind === kind)
                  .map((template) => (
                    <li
                      key={template.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                      data-testid="template"
                    >
                      <span className="truncate text-sm text-foreground">{template.title}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label="템플릿 삭제"
                        disabled={pending === template.id}
                        onClick={() =>
                          void call(
                            SETTINGS_ENDPOINT,
                            { action: "delete_template", id: template.id },
                            template.id,
                          )
                        }
                      >
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
              </ul>

              {kind === "quick_reply" ? (
                <QuickReplyForm
                  pending={pending === "template"}
                  onAdd={(title, bodyText) =>
                    void call(
                      SETTINGS_ENDPOINT,
                      {
                        action: "create_template",
                        kind: "quick_reply",
                        title,
                        payload: { body: bodyText },
                      },
                      "template",
                    )
                  }
                />
              ) : (
                <p className="text-caption text-muted-foreground">
                  견적 템플릿은 문의·견적 화면에서 견적을 만들 때 저장할 수 있어요.
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ── 멤버 초대 (S2-09) ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">멤버 초대</CardTitle>
          <CardDescription>
            가입하지 않은 이메일도 초대할 수 있어요. 상대가 가입한 뒤 링크를 열면 합류해요.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="rounded-md bg-warning-surface p-2.5 text-caption text-warning-foreground">
            {INVITE_DELIVERY_PENDING_NOTE}
          </p>

          {isOwner ? (
            <InviteForm
              pending={pending === "invite"}
              onInvite={async (email, role) => {
                const data = await call(
                  INVITES_ENDPOINT,
                  { action: "invite", email, role },
                  "invite",
                );

                if (data?.url) setNotice(`초대 링크를 만들었어요: ${data.url}`);
              }}
            />
          ) : (
            <p className="text-caption text-muted-foreground">멤버 초대는 대표만 할 수 있어요.</p>
          )}

          {invites.length === 0 ? (
            <p className="text-caption text-muted-foreground">
              {INVITES_EMPTY_TITLE}. {INVITES_EMPTY_DESCRIPTION}
            </p>
          ) : (
            <ul className="space-y-2" data-testid="invites">
              {invites.map((invite) => (
                <li
                  key={invite.id}
                  className="rounded-md border border-border px-3 py-2"
                  data-testid="invite"
                  data-status={invite.status}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="truncate text-sm text-foreground">{invite.email}</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge variant={invite.status === "pending" ? "default" : "secondary"}>
                        {INVITE_STATUS_LABEL[invite.status as InviteStatus] ?? invite.status}
                      </Badge>
                      <Badge variant="outline">{invite.role === "owner" ? "대표" : "담당자"}</Badge>
                    </div>
                  </div>

                  {invite.inviteUrl ? (
                    <p className="mt-1 break-all text-caption text-muted-foreground">
                      {invite.inviteUrl}
                    </p>
                  ) : null}

                  {isOwner && invite.status !== "accepted" ? (
                    <div className="mt-1.5 flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending === invite.id}
                        onClick={() =>
                          void call(
                            INVITES_ENDPOINT,
                            { action: "resend", id: invite.id },
                            invite.id,
                          )
                        }
                        data-testid="resend-invite"
                      >
                        재발송
                      </Button>
                      {invite.status === "pending" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending === invite.id}
                          onClick={() =>
                            void call(
                              INVITES_ENDPOINT,
                              { action: "revoke", id: invite.id },
                              invite.id,
                            )
                          }
                          data-testid="revoke-invite"
                        >
                          취소
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BusinessHourForm({
  pending,
  onAdd,
}: {
  pending: boolean;
  onAdd: (hour: BusinessHour) => void;
}) {
  const [weekday, setWeekday] = useState(1);
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("19:00");

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor="bh-weekday">요일</Label>
        <select
          id="bh-weekday"
          value={weekday}
          onChange={(event) => setWeekday(Number(event.target.value))}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          {WEEKDAYS.map((label, index) => (
            <option key={label} value={index}>
              {label}요일
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bh-start">시작</Label>
        <input
          id="bh-start"
          type="time"
          value={start}
          onChange={(event) => setStart(event.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bh-end">종료</Label>
        <input
          id="bh-end"
          type="time"
          value={end}
          onChange={(event) => setEnd(event.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        />
      </div>

      <Button
        type="button"
        size="sm"
        disabled={pending}
        onClick={() => onAdd({ weekday, start, end })}
        data-testid="add-business-hour"
      >
        추가
      </Button>
    </div>
  );
}

function QuickReplyForm({
  pending,
  onAdd,
}: {
  pending: boolean;
  onAdd: (title: string, body: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  return (
    <div className="space-y-1.5">
      <Label htmlFor="qr-title">새 빠른 답변</Label>
      <input
        id="qr-title"
        value={title}
        maxLength={60}
        placeholder="이름 (예: 주차 안내)"
        onChange={(event) => setTitle(event.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
      />
      <textarea
        rows={2}
        value={body}
        maxLength={1000}
        placeholder="문장"
        onChange={(event) => setBody(event.target.value)}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      />
      <Button
        type="button"
        size="sm"
        disabled={pending || title.trim().length === 0 || body.trim().length < 2}
        onClick={() => {
          onAdd(title.trim(), body.trim());
          setTitle("");
          setBody("");
        }}
        data-testid="add-quick-reply"
      >
        저장
      </Button>
    </div>
  );
}

function InviteForm({
  pending,
  onInvite,
}: {
  pending: boolean;
  onInvite: (email: string, role: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("staff");

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-48 flex-1 space-y-1.5">
        <Label htmlFor="invite-email">이메일</Label>
        <input
          id="invite-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="invite-role">권한</Label>
        <select
          id="invite-role"
          value={role}
          onChange={(event) => setRole(event.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="staff">담당자</option>
          <option value="owner">대표</option>
        </select>
      </div>

      <Button
        type="button"
        size="sm"
        disabled={pending || email.trim().length === 0}
        onClick={() => {
          onInvite(email.trim(), role);
          setEmail("");
        }}
        data-testid="send-invite"
      >
        초대 보내기
      </Button>
    </div>
  );
}
