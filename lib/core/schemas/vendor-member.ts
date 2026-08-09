// 업체 멤버·권한 스키마 (S2-07 · 명세서 §2.2 F-V-13, §3.3 vendor_members, §3.9)
//
// 역할은 둘뿐이다.
//   owner  가격·정산을 포함한 전부. 멤버 관리도 owner 만 한다.
//   staff  조회와 운영 업무. **가격·정산 UPDATE 불가**(§3.9) — RLS 가 강제한다.
//
// 여기 있는 판정 함수는 화면·API 가 **함께** 쓴다. 두 곳에 따로 적으면
// 화면은 통과인데 서버가 막는(또는 반대) 상황이 생긴다.

import { z } from "zod";

export const VENDOR_MEMBER_ROLES = ["owner", "staff"] as const;
export type VendorMemberRole = (typeof VENDOR_MEMBER_ROLES)[number];
export const VendorMemberRoleSchema = z.enum(VENDOR_MEMBER_ROLES);

export const VENDOR_MEMBER_ROLE_LABEL: Record<VendorMemberRole, string> = {
  owner: "대표",
  staff: "담당자",
};

export const VENDOR_MEMBER_ROLE_DESCRIPTION: Record<VendorMemberRole, string> = {
  owner: "상품·판매가·정산을 포함한 모든 항목을 관리합니다.",
  staff: "조회와 운영 업무만 합니다. 판매가·추가금·정산은 바꿀 수 없습니다.",
};

/** staff 가 할 수 없는 일. 화면에 그대로 적어 준다 — 나중에 막히는 것보다 미리 아는 편이 낫다. */
export const STAFF_RESTRICTIONS = [
  "상품 등록·수정과 판매가 변경",
  "추가금 사전 등록·수정",
  "상품 게시·게시 해제",
  "업체 프로필 수정",
  "정산 정보 변경",
  "멤버 초대·권한 변경",
] as const;

/** 멤버 초대(POST /api/vendor/members). */
export const VendorMemberInviteSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("이메일 형식을 확인해 주세요.")
    .max(200),
  role: VendorMemberRoleSchema.default("staff"),
});

export type VendorMemberInvite = z.input<typeof VendorMemberInviteSchema>;

/** 역할 변경(PATCH). */
export const VendorMemberRoleChangeSchema = z.object({
  role: VendorMemberRoleSchema,
});

export type MemberLike = { userId: string; role: VendorMemberRole };

/** 차단 사유. 코드로 비교하고 문구는 그대로 화면에 쓴다. */
export type MemberActionBlocker = { code: string; message: string };

/**
 * 역할을 바꿀 수 있는가.
 *
 * **마지막 owner 는 강등할 수 없다.** owner 가 0명이면 아무도 가격을 못 고치는
 * 잠긴 업체가 되고, 되돌리려면 운영자가 개입해야 한다.
 */
export function roleChangeBlocker(
  members: MemberLike[],
  targetUserId: string,
  nextRole: VendorMemberRole,
): MemberActionBlocker | null {
  const target = members.find((member) => member.userId === targetUserId);

  if (!target) return { code: "MEMBER_NOT_FOUND", message: "멤버를 찾을 수 없습니다." };
  if (target.role === nextRole) return { code: "NO_CHANGE", message: "이미 같은 역할입니다." };

  if (target.role === "owner" && nextRole !== "owner" && countOwners(members) <= 1) {
    return {
      code: "LAST_OWNER",
      message: "마지막 대표는 담당자로 바꿀 수 없습니다. 다른 대표를 먼저 지정해 주세요.",
    };
  }

  return null;
}

/**
 * 멤버를 제거할 수 있는가.
 *
 * **자기 자신은 제거할 수 없다.** 실수로 자기 접근 권한을 없애는 사고를 막는다.
 * 마지막 owner 도 제거할 수 없다 — 강등과 같은 이유다.
 */
export function removeBlocker(
  members: MemberLike[],
  targetUserId: string,
  actorUserId: string,
): MemberActionBlocker | null {
  const target = members.find((member) => member.userId === targetUserId);

  if (!target) return { code: "MEMBER_NOT_FOUND", message: "멤버를 찾을 수 없습니다." };

  if (targetUserId === actorUserId) {
    return {
      code: "SELF_REMOVE",
      message: "자기 자신은 제거할 수 없습니다. 다른 대표에게 요청하세요.",
    };
  }

  if (target.role === "owner" && countOwners(members) <= 1) {
    return {
      code: "LAST_OWNER",
      message: "마지막 대표는 제거할 수 없습니다. 다른 대표를 먼저 지정해 주세요.",
    };
  }

  return null;
}

export function countOwners(members: MemberLike[]): number {
  return members.filter((member) => member.role === "owner").length;
}

/**
 * 미가입 이메일 초대는 이번 범위가 아니다(S2-09).
 * 문구를 한 곳에 두어 API 오류와 화면 안내가 갈라지지 않게 한다.
 */
export const UNREGISTERED_INVITE_MESSAGE =
  "아직 가입하지 않은 이메일입니다. 상대방이 먼저 회원가입을 마치면 초대할 수 있습니다.";
