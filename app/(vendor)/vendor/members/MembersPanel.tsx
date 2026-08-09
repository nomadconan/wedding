"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  VENDOR_MEMBER_ROLES,
  VENDOR_MEMBER_ROLE_DESCRIPTION,
  VENDOR_MEMBER_ROLE_LABEL,
  removeBlocker,
  roleChangeBlocker,
  type VendorMemberRole,
} from "@/lib/core/schemas/vendor-member";
import type { VendorMemberView } from "@/lib/vendor/members";

/**
 * 멤버 관리 (F-V-13, §6.3 `/vendor/members`)
 *
 * 차단 판정은 `lib/core` 의 순수 함수를 쓴다 — **API 와 같은 함수**다.
 * 화면에서 눌리는 버튼이 서버에서 막히는(또는 반대) 일이 생기지 않는다.
 * 최종 경계는 RLS 와 DB 트리거이며 이 비활성화는 가장 바깥 층이다.
 */
export type MembersPanelProps = {
  members: VendorMemberView[];
  currentUserId: string;
  canManage: boolean;
};

export function MembersPanel({ members, currentUserId, canManage }: MembersPanelProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<VendorMemberRole>("staff");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const simple = members.map((member) => ({ userId: member.userId, role: member.role }));

  async function call(path: string, init: RequestInit, successMessage?: string) {
    setPending(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const body = await response.json();

      if (!response.ok || !body.ok) {
        setError(body.error?.message ?? "처리하지 못했어요.");

        return false;
      }

      if (successMessage) setNotice(successMessage);
      router.refresh();

      return true;
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");

      return false;
    } finally {
      setPending(false);
    }
  }

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const done = await call(
      "/api/vendor/members",
      { method: "POST", body: JSON.stringify({ email, role }) },
      "멤버를 추가했습니다.",
    );

    if (done) setEmail("");
  }

  return (
    <div className="space-y-6" data-testid="members-panel">
      <ul className="space-y-2" data-testid="member-list">
        {members.map((member) => {
          const isSelf = member.userId === currentUserId;
          const nextRole: VendorMemberRole = member.role === "owner" ? "staff" : "owner";
          const roleBlocker = roleChangeBlocker(simple, member.userId, nextRole);
          const deleteBlocker = removeBlocker(simple, member.userId, currentUserId);

          return (
            <li
              key={member.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{member.displayName ?? "이름 미등록"}</span>
                  <Badge variant={member.role === "owner" ? "default" : "secondary"}>
                    {VENDOR_MEMBER_ROLE_LABEL[member.role]}
                  </Badge>
                  {isSelf ? <Badge variant="outline">나</Badge> : null}
                  {member.confirmed ? null : <Badge variant="destructive">메일 미인증</Badge>}
                </div>
                <p className="truncate text-caption text-muted-foreground">
                  {member.email ?? "이메일 확인 불가"} · 합류 {member.joinedAt.slice(0, 10)}
                </p>
              </div>

              {canManage ? (
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending || Boolean(roleBlocker)}
                    title={roleBlocker?.message}
                    onClick={() =>
                      call(
                        `/api/vendor/members/${member.userId}`,
                        { method: "PATCH", body: JSON.stringify({ role: nextRole }) },
                        `${VENDOR_MEMBER_ROLE_LABEL[nextRole]}(으)로 바꿨습니다.`,
                      )
                    }
                  >
                    {VENDOR_MEMBER_ROLE_LABEL[nextRole]}로 변경
                  </Button>

                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={pending || Boolean(deleteBlocker)}
                    title={deleteBlocker?.message}
                    onClick={() =>
                      call(
                        `/api/vendor/members/${member.userId}`,
                        { method: "DELETE" },
                        "멤버를 제거했습니다.",
                      )
                    }
                  >
                    제거
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {notice ? <p className="text-sm text-success">{notice}</p> : null}

      {canManage ? (
        <>
          <Separator />

          <form onSubmit={invite} className="space-y-3" data-testid="invite-form">
            <div>
              <p className="text-sm font-medium">멤버 초대</p>
              <p className="text-caption text-muted-foreground">
                이미 웨딩클리어에 가입한 이메일만 연결할 수 있습니다. 상대방이 아직
                가입하지 않았다면 회원가입을 먼저 안내해 주세요.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="invite-email">이메일</Label>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="staff@example.com"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="invite-role">역할</Label>
                <Select value={role} onValueChange={(value) => setRole(value as VendorMemberRole)}>
                  <SelectTrigger id="invite-role" className="min-w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VENDOR_MEMBER_ROLES.map((code) => (
                      <SelectItem key={code} value={code}>
                        {VENDOR_MEMBER_ROLE_LABEL[code]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-end">
                <Button type="submit" disabled={pending}>
                  {pending ? "처리 중…" : "초대"}
                </Button>
              </div>
            </div>

            <p className="text-caption text-muted-foreground">
              {VENDOR_MEMBER_ROLE_DESCRIPTION[role]}
            </p>
          </form>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          멤버 초대·권한 변경은 업체 대표 계정만 할 수 있습니다.
        </p>
      )}
    </div>
  );
}

export default MembersPanel;
