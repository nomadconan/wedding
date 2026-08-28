import { describe, expect, it } from "vitest";

import {
  FLAG_SPECS,
  buildFlagConsole,
  conditionNotice,
  emptyPartialWarning,
  specOf,
} from "./registry";

const row = (over: Partial<{ key: string; enabled: boolean; rollout_json: unknown; updated_at: string }> = {}) => ({
  key: "community.enabled",
  enabled: true,
  rollout_json: { done: ["S7-14"], reason: "세 층이 갖춰짐" },
  updated_at: "2026-08-28T00:00:00.000Z",
  ...over,
});

const scheduleRow = (partials: Record<string, boolean>) =>
  row({
    key: "schedule.views",
    enabled: true,
    rollout_json: { ...partials, decided_by: "O-16" },
  });

// ══════════════════════════════════════════════════════════════════════════
// 코드가 존재를, DB 가 켬/끔을 정한다
// ══════════════════════════════════════════════════════════════════════════

describe("buildFlagConsole", () => {
  it("**DB 에 행이 없으면 꺼진 것이다** — isFeatureEnabled 와 같은 규칙", () => {
    const view = buildFlagConsole([]);
    const community = view.flags.find((flag) => flag.key === "community.enabled");

    expect(community?.enabled).toBe(false);
    expect(community?.inDatabase).toBe(false);
    expect(view.missingInDatabase).toContain("community.enabled");
  });

  it("행이 있으면 그 값이 켬/끔이다", () => {
    const view = buildFlagConsole([row({ enabled: false })]);

    expect(view.flags.find((flag) => flag.key === "community.enabled")?.enabled).toBe(false);
  });

  it("**코드가 모르는 키도 목록에 남긴다** — 감추면 그 상태가 영원히 남는다", () => {
    const view = buildFlagConsole([row({ key: "ghost.flag", enabled: true })]);
    const ghost = view.flags.find((flag) => flag.key === "ghost.flag");

    expect(ghost?.inCode).toBe(false);
    expect(ghost?.effect).toContain("아무 일도 일어나지 않습니다");
    expect(view.unknownInDatabase).toEqual(["ghost.flag"]);
  });

  it("**아무도 안 읽는 행을 '열려 있는 기능' 으로 세지 않는다**", () => {
    const view = buildFlagConsole([row({ key: "ghost.flag", enabled: true })]);

    expect(view.enabledCount).toBe(0);
  });

  it("부분 스위치를 rollout_json 에서 읽는다", () => {
    const view = buildFlagConsole([
      scheduleRow({ timeline: true, progress: false, next: true, graph: false }),
    ]);
    const schedule = view.flags.find((flag) => flag.key === "schedule.views");

    expect(schedule?.partials.map((partial) => [partial.key, partial.on])).toEqual([
      ["timeline", true],
      ["progress", false],
      ["next", true],
      ["graph", false],
    ]);
  });

  it("**부분 스위치를 뺀 나머지가 개방 조건 서술이다**(D-67)", () => {
    const view = buildFlagConsole([
      scheduleRow({ timeline: true, progress: true, next: true, graph: true }),
    ]);
    const schedule = view.flags.find((flag) => flag.key === "schedule.views");

    expect(schedule?.conditions).toEqual({ decided_by: "O-16" });
    expect(Object.keys(schedule?.conditions ?? {})).not.toContain("timeline");
  });

  it("rollout_json 이 객체가 아니면 빈 객체로 읽는다 — 화면이 서야 한다", () => {
    const view = buildFlagConsole([row({ rollout_json: ["배열"] })]);

    expect(view.flags[0].conditions).toEqual({});
  });

  it("선언된 플래그가 둘이고 각각 뜻·되돌릴 수 없는 것을 적는다", () => {
    expect(FLAG_SPECS).toHaveLength(2);
    for (const spec of FLAG_SPECS) {
      expect(spec.effect.length).toBeGreaterThan(10);
      expect(spec.irreversible.length).toBeGreaterThan(10);
      expect(spec.conditionSource.length).toBeGreaterThan(3);
    }
  });

  it("specOf 가 모르는 키에 null 을 준다", () => {
    expect(specOf("community.enabled")).not.toBeNull();
    expect(specOf("nope")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 조건 미충족 상태로 켜기 — 막지 않고 드러낸다 (D-145)
// ══════════════════════════════════════════════════════════════════════════

describe("conditionNotice", () => {
  const flag = buildFlagConsole([row()]).flags.find((f) => f.key === "community.enabled")!;

  it("**켜는 조치에 조건을 읽으라고 말한다 — 막지 않는다**", () => {
    const notice = conditionNotice(flag, true);

    expect(notice).not.toBeNull();
    expect(notice).toContain("막지는 않지만");
  });

  it("끄는 조치에는 말하지 않는다 — 긴급 롤백을 방해하지 않는다", () => {
    expect(conditionNotice(flag, false)).toBeNull();
  });

  it("조건이 안 적혀 있으면 **적어 달라고** 한다 (빈칸을 정상으로 두지 않는다)", () => {
    const bare = buildFlagConsole([row({ rollout_json: {} })]).flags[0];
    const notice = conditionNotice(bare, true);

    expect(notice).toContain("적혀 있지 않습니다");
  });
});

describe("emptyPartialWarning", () => {
  const schedule = buildFlagConsole([
    scheduleRow({ timeline: true, progress: true, next: true, graph: true }),
  ]).flags.find((f) => f.key === "schedule.views")!;

  it("**표현을 전부 끄면 미리 말한다** — 기능은 켜져 있는데 고를 것이 없다", () => {
    const warning = emptyPartialWarning(schedule, {
      timeline: false,
      progress: false,
      next: false,
      graph: false,
    });

    expect(warning).not.toBeNull();
    expect(warning).toContain("고를 것이 없습니다");
  });

  it("하나라도 남으면 경고하지 않는다", () => {
    expect(
      emptyPartialWarning(schedule, { timeline: true, progress: false, next: false, graph: false }),
    ).toBeNull();
  });

  it("부분 스위치가 없는 플래그에는 해당 없음이다", () => {
    const community = buildFlagConsole([row()]).flags.find((f) => f.key === "community.enabled")!;

    expect(emptyPartialWarning(community, {})).toBeNull();
  });
});
