import { describe, expect, it } from "vitest";

import {
  STAFF_RESTRICTIONS,
  VENDOR_MEMBER_ROLES,
  VendorMemberInviteSchema,
  VendorMemberRoleChangeSchema,
  countOwners,
  removeBlocker,
  roleChangeBlocker,
  type MemberLike,
} from "../schemas/vendor-member";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const STAFF_C = "33333333-3333-4333-8333-333333333333";

const soloOwner: MemberLike[] = [
  { userId: OWNER_A, role: "owner" },
  { userId: STAFF_C, role: "staff" },
];

const twoOwners: MemberLike[] = [
  { userId: OWNER_A, role: "owner" },
  { userId: OWNER_B, role: "owner" },
  { userId: STAFF_C, role: "staff" },
];

describe("VendorMemberInviteSchema (F-V-13)", () => {
  it("이메일을 소문자로 정규화한다 — 대소문자 차이로 중복 초대가 생기지 않게", () => {
    expect(VendorMemberInviteSchema.parse({ email: "  Staff@Local.TEST " }).email).toBe(
      "staff@local.test",
    );
  });

  it("역할 기본값은 staff 다 — 초대는 가장 좁은 권한에서 시작한다", () => {
    expect(VendorMemberInviteSchema.parse({ email: "a@b.co" }).role).toBe("staff");
  });

  it("잘못된 이메일을 거부한다", () => {
    expect(() => VendorMemberInviteSchema.parse({ email: "not-an-email" })).toThrow();
    expect(() => VendorMemberInviteSchema.parse({ email: "" })).toThrow();
  });

  it("정의되지 않은 역할을 거부한다", () => {
    expect(() => VendorMemberInviteSchema.parse({ email: "a@b.co", role: "admin" })).toThrow();
    expect(() => VendorMemberRoleChangeSchema.parse({ role: "manager" })).toThrow();
  });

  it("역할은 owner·staff 둘뿐이다", () => {
    expect(VENDOR_MEMBER_ROLES).toEqual(["owner", "staff"]);
  });
});

describe("roleChangeBlocker — 마지막 대표 보호", () => {
  it("대표가 하나뿐이면 강등할 수 없다", () => {
    expect(roleChangeBlocker(soloOwner, OWNER_A, "staff")?.code).toBe("LAST_OWNER");
  });

  it("대표가 둘이면 강등할 수 있다", () => {
    expect(roleChangeBlocker(twoOwners, OWNER_A, "staff")).toBeNull();
  });

  it("담당자를 대표로 올리는 것은 언제나 가능하다", () => {
    expect(roleChangeBlocker(soloOwner, STAFF_C, "owner")).toBeNull();
  });

  it("같은 역할로 바꾸려 하면 막는다", () => {
    expect(roleChangeBlocker(soloOwner, STAFF_C, "staff")?.code).toBe("NO_CHANGE");
  });

  it("없는 멤버는 찾을 수 없다고 답한다", () => {
    expect(roleChangeBlocker(soloOwner, OWNER_B, "staff")?.code).toBe("MEMBER_NOT_FOUND");
  });
});

describe("removeBlocker — 자기 제거·마지막 대표 보호", () => {
  it("자기 자신은 제거할 수 없다", () => {
    expect(removeBlocker(twoOwners, OWNER_A, OWNER_A)?.code).toBe("SELF_REMOVE");
  });

  it("자기 제거 금지는 담당자에게도 같다", () => {
    expect(removeBlocker(twoOwners, STAFF_C, STAFF_C)?.code).toBe("SELF_REMOVE");
  });

  it("마지막 대표는 제거할 수 없다", () => {
    expect(removeBlocker(soloOwner, OWNER_A, STAFF_C)?.code).toBe("LAST_OWNER");
  });

  it("대표가 둘이면 한 명은 제거할 수 있다", () => {
    expect(removeBlocker(twoOwners, OWNER_B, OWNER_A)).toBeNull();
  });

  it("담당자는 제거할 수 있다", () => {
    expect(removeBlocker(soloOwner, STAFF_C, OWNER_A)).toBeNull();
  });

  it("자기 제거 금지가 마지막 대표 판정보다 먼저다 — 더 구체적인 사유를 알려준다", () => {
    expect(removeBlocker(soloOwner, OWNER_A, OWNER_A)?.code).toBe("SELF_REMOVE");
  });
});

describe("countOwners", () => {
  it("대표 수를 센다", () => {
    expect(countOwners(soloOwner)).toBe(1);
    expect(countOwners(twoOwners)).toBe(2);
    expect(countOwners([])).toBe(0);
  });
});

describe("staff 제한 안내 (§3.9)", () => {
  it("가격·정산·멤버 관리가 제한 목록에 있다", () => {
    const joined = STAFF_RESTRICTIONS.join(" ");

    expect(joined).toContain("판매가");
    expect(joined).toContain("정산");
    expect(joined).toContain("멤버");
  });
});
