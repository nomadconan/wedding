import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  CHAT_ROOM_STATUSES,
  MESSAGE_MAX_LENGTH,
  QUICK_REPLIES,
  RETRACTED_TEXT,
  attachmentPath,
  canRetract,
  canSend,
  formatDuration,
  inboxOrder,
  isMine,
  messageProblem,
  previewText,
  roomIdFromAttachmentPath,
  slaState,
  unreadBadge,
  unreadCount,
  validateAttachment,
  type SlaState,
} from "./chat";
import {
  ChatMessageActionSchema,
  OpenRoomSchema,
  VendorChatActionSchema,
  quickReplyBody,
} from "../schemas/chat";

const ROOM = "00000000-0000-0000-0000-0000000000a1";
const USER_A = "00000000-0000-0000-0000-0000000000b1";
const USER_B = "00000000-0000-0000-0000-0000000000b2";
const VENDOR = "00000000-0000-0000-0000-0000000000c1";

describe("편 판정", () => {
  it("같은 편의 메시지가 내 것이다", () => {
    expect(isMine("couple", "couple")).toBe(true);
    expect(isMine("vendor", "vendor")).toBe(true);
  });

  it("상대 편의 메시지는 내 것이 아니다", () => {
    expect(isMine("vendor", "couple")).toBe(false);
    expect(isMine("couple", "vendor")).toBe(false);
  });

  // system 카드는 서버가 남긴 것이라 어느 편도 아니다 — 양쪽 모두 가운데 카드로 본다.
  it("system 은 어느 편의 것도 아니다", () => {
    expect(isMine("system", "couple")).toBe(false);
    expect(isMine("system", "vendor")).toBe(false);
  });
});

describe("방 상태", () => {
  it("active 에서만 보낼 수 있다", () => {
    expect(canSend("active")).toBe(true);
    expect(canSend("archived")).toBe(false);
    expect(canSend("blocked")).toBe(false);
  });

  it("상태 값 집합은 DB CHECK 와 같다", () => {
    expect([...CHAT_ROOM_STATUSES]).toEqual(["active", "archived", "blocked"]);
  });
});

describe("회수", () => {
  const base = { senderId: USER_A, senderType: "couple" as const, retractedAt: null };

  it("자기가 보낸 것만 회수한다", () => {
    expect(canRetract(base, USER_A)).toBe(true);
    expect(canRetract(base, USER_B)).toBe(false);
  });

  it("이미 회수한 것은 다시 회수하지 않는다", () => {
    expect(canRetract({ ...base, retractedAt: "2026-08-10T00:00:00Z" }, USER_A)).toBe(false);
  });

  // 서버가 남긴 카드를 사용자가 내릴 수 있으면 안내가 사라진다.
  it("system 카드는 회수 대상이 아니다", () => {
    expect(canRetract({ senderId: null, senderType: "system", retractedAt: null }, USER_A)).toBe(
      false,
    );
  });

  it("시간 제한을 두지 않는다 — 오래된 메시지도 회수된다", () => {
    expect(canRetract({ ...base }, USER_A)).toBe(true);
  });
});

describe("안읽음", () => {
  const messages = [
    { senderType: "vendor" as const, createdAt: "2026-08-10T01:00:00Z" },
    { senderType: "couple" as const, createdAt: "2026-08-10T02:00:00Z" },
    { senderType: "vendor" as const, createdAt: "2026-08-10T03:00:00Z" },
    { senderType: "system" as const, createdAt: "2026-08-10T04:00:00Z" },
  ];

  it("상대 편 메시지만 센다", () => {
    // 커플 입장: vendor 2 + system 1 = 3
    expect(unreadCount(messages, null, "couple")).toBe(3);
    // 업체 입장: couple 1 + system 1 = 2
    expect(unreadCount(messages, null, "vendor")).toBe(2);
  });

  it("마지막 읽은 시각 이후만 센다", () => {
    expect(unreadCount(messages, "2026-08-10T03:00:00Z", "couple")).toBe(1);
    expect(unreadCount(messages, "2026-08-10T04:00:00Z", "couple")).toBe(0);
  });

  it("한 번도 열지 않은 방은 상대 메시지 전부가 안읽음이다", () => {
    expect(unreadCount(messages, null, "couple")).toBe(3);
  });

  it("배지는 99를 넘기지 않는다", () => {
    expect(unreadBadge(0)).toBeNull();
    expect(unreadBadge(1)).toBe("1");
    expect(unreadBadge(99)).toBe("99");
    expect(unreadBadge(100)).toBe("99+");
  });
});

describe("응답 SLA", () => {
  const threshold = { minutes: 60, warnPercent: 75 };
  const now = new Date("2026-08-10T12:00:00Z");

  it("눈금이 없으면 상태를 만들지 않는다 — 기본값을 지어내지 않는다", () => {
    expect(slaState("2026-08-10T00:00:00Z", now, null)).toBeNull();
    expect(slaState("2026-08-10T00:00:00Z", now, { minutes: 0, warnPercent: 75 })).toBeNull();
  });

  it("기다리는 사람이 없으면 clear 다", () => {
    expect(slaState(null, now, threshold)).toEqual({
      level: "clear",
      elapsedMinutes: null,
      remainingMinutes: null,
    });
  });

  // ── 구간 경계 (CLAUDE.md §7.3) ────────────────────────────────────────────
  it("경계 직전은 waiting 이다", () => {
    // 44분 = 60 * 75% = 45 직전
    expect(slaState("2026-08-10T11:16:00Z", now, threshold)?.level).toBe("waiting");
  });

  it("warnPercent 당일(45분)은 due 다 — 경계값은 넘어간 쪽에 속한다", () => {
    const state = slaState("2026-08-10T11:15:00Z", now, threshold);
    expect(state?.level).toBe("due");
    expect(state?.elapsedMinutes).toBe(45);
    expect(state?.remainingMinutes).toBe(15);
  });

  it("눈금 당일(60분)은 overdue 다", () => {
    const state = slaState("2026-08-10T11:00:00Z", now, threshold);
    expect(state?.level).toBe("overdue");
    expect(state?.remainingMinutes).toBe(0);
  });

  it("눈금을 넘기면 남은 시간이 음수다", () => {
    expect(slaState("2026-08-10T10:00:00Z", now, threshold)?.remainingMinutes).toBe(-60);
  });

  // 서버·클라이언트 시각차로 미래 시각이 들어올 수 있다. 음수 경과는 뜻이 없다.
  it("미래 시각은 0분 경과로 클램프한다", () => {
    expect(slaState("2026-08-10T13:00:00Z", now, threshold)?.elapsedMinutes).toBe(0);
  });

  it("날짜가 아니면 상태를 만들지 않는다", () => {
    expect(slaState("어제", now, threshold)).toBeNull();
  });
});

describe("경과 시간 표기", () => {
  it("분·시간·일 단위로 줄여 쓴다", () => {
    expect(formatDuration(45)).toBe("45분");
    expect(formatDuration(60)).toBe("1시간");
    expect(formatDuration(90)).toBe("1시간 30분");
    expect(formatDuration(1440)).toBe("1일");
    expect(formatDuration(1500)).toBe("1일 1시간");
  });

  it("음수도 절댓값으로 읽는다 — 방향은 화면이 문장으로 말한다", () => {
    expect(formatDuration(-90)).toBe("1시간 30분");
  });
});

describe("인박스 정렬 (F-V-15 미응답 우선)", () => {
  const room = (id: string, level: SlaState["level"], elapsed: number | null, last: string) => ({
    id,
    sla: { level, elapsedMinutes: elapsed, remainingMinutes: null } as SlaState,
    lastMessageAt: last,
  });

  it("지연이 가장 위, 그다음 임박, 그다음 대기, 응답 완료가 마지막이다", () => {
    const sorted = inboxOrder([
      room("clear", "clear", null, "2026-08-10T05:00:00Z"),
      room("waiting", "waiting", 10, "2026-08-10T04:00:00Z"),
      room("overdue", "overdue", 200, "2026-08-10T01:00:00Z"),
      room("due", "due", 50, "2026-08-10T03:00:00Z"),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["overdue", "due", "waiting", "clear"]);
  });

  it("같은 등급이면 오래 기다린 쪽이 위다", () => {
    const sorted = inboxOrder([
      room("short", "overdue", 100, "2026-08-10T05:00:00Z"),
      room("long", "overdue", 400, "2026-08-10T01:00:00Z"),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["long", "short"]);
  });

  it("SLA 를 못 만들면 응답 완료와 같은 자리에 두고 최근 대화 순으로 본다", () => {
    const sorted = inboxOrder([
      { id: "old", sla: null, lastMessageAt: "2026-08-01T00:00:00Z" },
      { id: "new", sla: null, lastMessageAt: "2026-08-09T00:00:00Z" },
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["new", "old"]);
  });
});

describe("첨부 검증 (§7.6 ≤20MB)", () => {
  const ok = { name: "estimate.pdf", mime: "application/pdf", size: 1024 };

  it("규격에 맞으면 통과한다", () => {
    expect(validateAttachment(ok)).toBeNull();
  });

  it("20MB 당일은 통과하고 1바이트 넘으면 막는다 — 상한 경계", () => {
    expect(validateAttachment({ ...ok, size: ATTACHMENT_MAX_BYTES })).toBeNull();
    expect(validateAttachment({ ...ok, size: ATTACHMENT_MAX_BYTES + 1 })?.code).toBe(
      "CHAT_ATTACHMENT_TOO_LARGE",
    );
  });

  it("빈 파일을 막는다", () => {
    expect(validateAttachment({ ...ok, size: 0 })?.code).toBe("CHAT_ATTACHMENT_EMPTY");
  });

  it("이미지·PDF 외의 형식을 막는다", () => {
    expect(validateAttachment({ ...ok, mime: "application/x-msdownload" })?.code).toBe(
      "CHAT_ATTACHMENT_MIME",
    );
    expect(validateAttachment({ ...ok, mime: "image/png" })).toBeNull();
  });

  it("이름이 비면 막는다", () => {
    expect(validateAttachment({ ...ok, name: "   " })?.code).toBe("CHAT_ATTACHMENT_NAME");
  });
});

describe("첨부 경로", () => {
  it("방 id 로 시작한다 — 서버가 경로에서 방을 되찾아 참여를 판정한다", () => {
    const path = attachmentPath(ROOM, "n1", "견적서 (최종).pdf");

    expect(path.startsWith(`${ROOM}/n1/`)).toBe(true);
    expect(roomIdFromAttachmentPath(path)).toBe(ROOM);
  });

  it("한글·공백을 ASCII 로 좁힌다 — 서명 URL 인코딩이 환경마다 갈리지 않게", () => {
    const path = attachmentPath(ROOM, "n1", "견적서 최종.pdf");

    expect(path).toMatch(/^[\w./-]+$/);
    expect(path.endsWith(".pdf")).toBe(true);
  });

  it("이름이 전부 걸러져도 빈 키를 만들지 않는다", () => {
    expect(attachmentPath(ROOM, "n1", "###")).toBe(`${ROOM}/n1/file`);
  });

  it("방 id 로 시작하지 않는 경로는 방을 알려주지 않는다", () => {
    expect(roomIdFromAttachmentPath("../../secret/file.pdf")).toBeNull();
    expect(roomIdFromAttachmentPath("file.pdf")).toBeNull();
  });
});

describe("본문 검증", () => {
  it("본문도 첨부도 없으면 막는다 (DB CHECK 와 같은 판정)", () => {
    expect(messageProblem("   ", [])).not.toBeNull();
  });

  it("첨부만 있어도 보낼 수 있다", () => {
    expect(
      messageProblem("", [{ path: "p", name: "a.png", mime: "image/png", size: 1 }]),
    ).toBeNull();
  });

  it("길이 상한 당일은 통과하고 넘으면 막는다", () => {
    expect(messageProblem("가".repeat(MESSAGE_MAX_LENGTH), [])).toBeNull();
    expect(messageProblem("가".repeat(MESSAGE_MAX_LENGTH + 1), [])).not.toBeNull();
  });

  it("첨부 개수 상한을 넘기면 막는다", () => {
    const files = Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, index) => ({
      path: `p${index}`,
      name: "a.png",
      mime: "image/png",
      size: 1,
    }));

    expect(messageProblem("본문", files)).not.toBeNull();
  });
});

describe("목록 미리보기", () => {
  it("회수된 메시지는 본문 대신 회수 문구를 보여준다", () => {
    expect(previewText({ body: "지울 말", retractedAt: "2026-08-10T00:00:00Z", attachmentCount: 0 })).toBe(
      RETRACTED_TEXT,
    );
  });

  it("본문이 없으면 첨부 개수를 말한다", () => {
    expect(previewText({ body: null, retractedAt: null, attachmentCount: 2 })).toBe("첨부 2개");
  });

  it("메시지가 없는 방도 문장을 갖는다", () => {
    expect(previewText(null)).not.toBe("");
  });
});

describe("빠른 답변 (F-V-15)", () => {
  it("키로 본문을 되찾는다 — 클라이언트가 보낸 문자열을 그대로 믿지 않는다", () => {
    expect(quickReplyBody("greeting")).toBe(QUICK_REPLIES[0].body);
    expect(quickReplyBody("없는키")).toBeNull();
  });

  // §2.3 · §7.7 — 플랫폼이 업체 대신 확정적 약속을 쓰지 않는다.
  it("문안에 확정적 약속·가격 표현을 담지 않는다", () => {
    for (const reply of QUICK_REPLIES) {
      expect(reply.body).not.toMatch(/보장|확정|무조건|최저가|할인/);
    }
  });
});

describe("API 입력 스키마", () => {
  it("방 열기는 업체 id 만 받는다 — 커플 id 를 클라이언트에서 받지 않는다", () => {
    const parsed = OpenRoomSchema.parse({ vendorId: VENDOR });

    expect(parsed).toEqual({ action: "open", vendorId: VENDOR });
    expect("coupleId" in parsed).toBe(false);
  });

  it("보내기는 본문 없이 첨부만으로도 통과한다", () => {
    const parsed = ChatMessageActionSchema.parse({
      action: "send",
      roomId: ROOM,
      attachments: [{ path: "p", name: "a.png", mime: "image/png", size: 10 }],
    });

    expect(parsed.action).toBe("send");
  });

  // 스키마에 본문을 바꾸는 입력이 없다는 것이 요점이다(S4-01: 수정·삭제 금지).
  it("회수는 메시지 id 만 받는다 — 본문을 바꾸는 입력이 없다", () => {
    const parsed = ChatMessageActionSchema.parse({ action: "retract", messageId: ROOM });

    expect(Object.keys(parsed).sort()).toEqual(["action", "messageId"]);
  });

  it("메시지 수정 동작은 존재하지 않는다", () => {
    expect(() =>
      ChatMessageActionSchema.parse({ action: "edit", messageId: ROOM, body: "고침" }),
    ).toThrow();
  });

  it("소비자 API 에는 담당자 배정이 없다", () => {
    expect(() =>
      ChatMessageActionSchema.parse({ action: "assign", roomId: ROOM, userId: USER_A }),
    ).toThrow();
    expect(
      VendorChatActionSchema.parse({ action: "assign", roomId: ROOM, userId: USER_A }).action,
    ).toBe("assign");
  });

  it("배정 해제는 null 로 표현한다", () => {
    expect(
      VendorChatActionSchema.parse({ action: "assign", roomId: ROOM, userId: null }),
    ).toEqual({ action: "assign", roomId: ROOM, userId: null });
  });

  // ── 회귀 방지 ─────────────────────────────────────────────────────────────
  // 화면은 방금 받은 메시지의 created_at 을 그대로 돌려보내 읽음을 올린다. PostgREST 는
  // 그 값을 `+00:00` 오프셋으로 주는데, zod 의 .datetime() 은 기본적으로 Z 만 받는다.
  // 이것이 막히면 읽음 처리가 조용히 422 가 되고 읽음 표시가 영영 붙지 않는다.
  it("읽음 시각은 PostgREST 가 주는 오프셋 표기를 받는다", () => {
    const fromPostgrest = "2026-08-11T14:32:10.123456+00:00";

    expect(
      ChatMessageActionSchema.parse({
        action: "mark_read",
        roomId: ROOM,
        readAt: fromPostgrest,
      }),
    ).toMatchObject({ readAt: fromPostgrest });
  });

  it("읽음 시각은 Z 표기도 받는다", () => {
    expect(
      ChatMessageActionSchema.parse({
        action: "mark_read",
        roomId: ROOM,
        readAt: "2026-08-11T14:32:10.123Z",
      }).action,
    ).toBe("mark_read");
  });

  it("읽음 시각은 생략할 수 있다 — 지금까지 읽은 것으로 본다", () => {
    expect(ChatMessageActionSchema.parse({ action: "mark_read", roomId: ROOM }).action).toBe(
      "mark_read",
    );
  });

  it("날짜가 아닌 읽음 시각은 거부한다", () => {
    expect(() =>
      ChatMessageActionSchema.parse({ action: "mark_read", roomId: ROOM, readAt: "어제" }),
    ).toThrow();
  });

  it("첨부 주소 요청은 개수 상한을 넘기면 거부한다", () => {
    const files = Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, () => ({
      name: "a.png",
      mime: "image/png",
      size: 10,
    }));

    expect(() =>
      ChatMessageActionSchema.parse({ action: "attachment_url", roomId: ROOM, files }),
    ).toThrow();
  });
});
