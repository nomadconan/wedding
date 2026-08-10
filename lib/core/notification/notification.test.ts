import { describe, expect, it } from "vitest";

import { createNoopAdapter, createStubAdapter } from "@/lib/notify/stub";

import {
  ALWAYS_ON_CHANNELS,
  MAX_SEND_ATTEMPTS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TEMPLATES,
  NOTIFICATION_TOPICS,
  NotificationActionSchema,
  TOPIC_LABEL,
  TOPIC_PENDING,
  canRetry,
  dedupeKey,
  isAllowed,
  isTopicLive,
  renderBody,
} from "../schemas/notification";

const UUID = "00000000-0000-0000-0000-0000000000a1";

describe("토픽", () => {
  it("F-C-21 의 네 가지를 모두 담는다", () => {
    for (const topic of ["dday", "schedule", "contract", "care"] as const) {
      expect(NOTIFICATION_TOPICS).toContain(topic);
    }
  });

  it("아직 보내지 않는 토픽은 담당 태스크를 밝힌다", () => {
    for (const [topic, task] of Object.entries(TOPIC_PENDING)) {
      expect(task).toMatch(/^S\d/);
      expect(isTopicLive(topic as never)).toBe(false);
    }
  });

  it("모든 토픽에 이름이 있다", () => {
    for (const topic of NOTIFICATION_TOPICS) {
      expect(TOPIC_LABEL[topic].length).toBeGreaterThan(0);
    }
  });
});

describe("수신 설정", () => {
  it("설정이 없으면 보낸다 — '안 골랐다'와 '거부했다'는 다르다", () => {
    expect(isAllowed("dday", "email", null)).toBe(true);
    expect(isAllowed("dday", "email", {})).toBe(true);
  });

  it("끈 채널로는 보내지 않는다", () => {
    expect(isAllowed("dday", "email", { email: false })).toBe(false);
  });

  it("다른 채널 설정이 서로 영향을 주지 않는다", () => {
    const prefs = { email: false, sms: true };

    expect(isAllowed("dday", "email", prefs)).toBe(false);
    expect(isAllowed("dday", "sms", prefs)).toBe(true);
  });

  it("앱 알림함은 꺼도 켜져 있다 — 끄면 증적을 남길 자리가 사라진다", () => {
    expect(isAllowed("dday", "in_app", { in_app: false })).toBe(true);
    expect(ALWAYS_ON_CHANNELS).toContain("in_app");
  });

  it("채널 목록에 앱 알림함이 있다", () => {
    expect(NOTIFICATION_CHANNELS).toContain("in_app");
  });
});

describe("멱등 키", () => {
  it("같은 대상·같은 기간이면 같은 키다", () => {
    const a = dedupeKey({ templateKey: "dday.remind", subjectId: UUID, period: "2027-05-05" });
    const b = dedupeKey({ templateKey: "dday.remind", subjectId: UUID, period: "2027-05-05" });

    expect(a).toBe(b);
  });

  it("기간이 다르면 다른 키다 — 내일은 다시 보낼 수 있어야 한다", () => {
    expect(dedupeKey({ templateKey: "t", subjectId: UUID, period: "2026-01-01" })).not.toBe(
      dedupeKey({ templateKey: "t", subjectId: UUID, period: "2026-01-02" }),
    );
  });

  it("대상이 다르면 다른 키다", () => {
    expect(dedupeKey({ templateKey: "t", subjectId: "a" })).not.toBe(
      dedupeKey({ templateKey: "t", subjectId: "b" }),
    );
  });

  it("기간을 안 주면 한 번만 보내는 알림이다", () => {
    expect(dedupeKey({ templateKey: "t", subjectId: UUID })).toContain(":once");
  });
});

describe("재시도", () => {
  it("상한 전까지 다시 시도한다", () => {
    expect(canRetry(0)).toBe(true);
    expect(canRetry(MAX_SEND_ATTEMPTS - 1)).toBe(true);
  });

  it("상한에 닿으면 멈춘다 — 영구 오류가 큐를 막지 않게", () => {
    expect(canRetry(MAX_SEND_ATTEMPTS)).toBe(false);
    expect(canRetry(MAX_SEND_ATTEMPTS + 1)).toBe(false);
  });
});

describe("본문 재구성 (§7.3)", () => {
  it("틀과 참조로 문장을 다시 만든다", () => {
    expect(renderBody("dday.remind", { days: 30 })).toBe("예식일까지 30일 남았어요.");
  });

  it("틀이 없으면 지어내지 않는다", () => {
    expect(renderBody("사라진.틀", {})).toBeNull();
  });

  it("틀은 참조·숫자만 받는다 — 이름·주소를 넣을 자리가 없다", () => {
    // 렌더 결과에 넘기지 않은 값이 섞이지 않는다.
    expect(renderBody("dday.remind", { days: 10, name: "홍길동" })).not.toContain("홍길동");
  });

  it("모든 틀이 토픽에 묶여 있다", () => {
    for (const template of Object.values(NOTIFICATION_TEMPLATES)) {
      expect(NOTIFICATION_TOPICS).toContain(template.topic);
    }
  });
});

describe("알림 동작 입력", () => {
  it("읽음 처리는 id 를 요구한다", () => {
    expect(NotificationActionSchema.parse({ action: "mark_read", id: UUID }).action).toBe(
      "mark_read",
    );
    expect(() => NotificationActionSchema.parse({ action: "mark_read" })).toThrow();
  });

  it("전체 읽음은 인자가 없다", () => {
    expect(NotificationActionSchema.parse({ action: "mark_all_read" })).toEqual({
      action: "mark_all_read",
    });
  });

  it("수신 설정은 토픽·채널·on/off 셋을 요구한다", () => {
    expect(
      NotificationActionSchema.parse({
        action: "set_pref",
        topic: "dday",
        channel: "email",
        enabled: false,
      }),
    ).toMatchObject({ enabled: false });

    expect(() =>
      NotificationActionSchema.parse({ action: "set_pref", topic: "없는토픽", channel: "email", enabled: true }),
    ).toThrow();
  });

  it("정의되지 않은 동작은 거부한다", () => {
    expect(() => NotificationActionSchema.parse({ action: "delete_all" })).toThrow();
  });
});

describe("스텁 어댑터 (D-28)", () => {
  const request = {
    to: { userId: "u1", email: "a@local.test" },
    body: "본문",
    topic: "dday",
    templateKey: "dday.remind",
  };

  it("앱 알림함은 발송사 없이 성공한다 — 기록이 곧 전달이다", async () => {
    const result = await createStubAdapter("in_app").send({ ...request, channel: "in_app" });

    expect(result).toEqual({ ok: true, providerMessageId: null });
  });

  it("이메일은 발송사 id 형식을 흉내 낸다 — 웹훅 대조 경로를 지금 시험할 수 있게", async () => {
    const result = await createStubAdapter("email").send({ ...request, channel: "email" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerMessageId).toMatch(/^stub-email-/);
  });

  it("주소가 없으면 실패하고 다시 시도하지 않는다", async () => {
    const result = await createStubAdapter("email").send({
      ...request,
      channel: "email",
      to: { userId: "u1", email: null },
    });

    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it("계약 전 채널은 성공을 주장하지 않는다 — 켜 뒀다고 나간 것처럼 적으면 거짓 증적이다", async () => {
    for (const channel of ["sms", "push"] as const) {
      const result = await createStubAdapter(channel).send({ ...request, channel });

      expect(result).toMatchObject({ ok: false, retryable: false });
    }
  });

  it("noop 은 아무것도 하지 않고 성공도 주장하지 않는다", async () => {
    const result = await createNoopAdapter("email").send({ ...request, channel: "email" });

    expect(result).toMatchObject({ ok: false, retryable: false });
  });
});
