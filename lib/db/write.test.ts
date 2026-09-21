import { describe, expect, it, vi } from "vitest";

import { WriteFailedError, mustWrite, tryWrite } from "./write";

const ok = () => Promise.resolve({ error: null, data: [{ id: "x" }] });
const failing = (code: string | null = "23505", message = "duplicate key value 010-1234-5678") =>
  Promise.resolve({ error: { code, message } });

describe("mustWrite — 상태 표는 실패하면 던진다", () => {
  it("성공하면 응답을 그대로 돌려준다", async () => {
    const result = await mustWrite("payments.update:mark-paid", ok());

    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ id: "x" }]);
  });

  it("실패하면 던진다 — 조용히 넘어가지 않는다", async () => {
    await expect(mustWrite("payments.update:mark-paid", failing())).rejects.toBeInstanceOf(
      WriteFailedError,
    );
  });

  it("자리 이름과 PG 코드를 들고 있다", async () => {
    const error = await mustWrite("payments.update:mark-paid", failing("23503")).catch((e) => e);

    expect(error.where).toBe("payments.update:mark-paid");
    expect(error.code).toBe("23503");
  });

  it("**메시지에 값이 실리지 않는다**(§5.3) — 유니크 위반 상세에 전화번호가 온다", async () => {
    const error = await mustWrite("x.update:y", failing("23505")).catch((e) => e);

    expect(error.message).not.toContain("010-1234-5678");
    expect(error.message).toContain("x.update:y");
    expect(error.message).toContain("23505");
  });

  it("코드가 없어도 던지고 `unknown` 으로 적는다 — null 을 성공으로 읽지 않는다", async () => {
    const error = await mustWrite("x.update:y", failing(null)).catch((e) => e);

    expect(error).toBeInstanceOf(WriteFailedError);
    expect(error.code).toBe("unknown");
  });
});

describe("tryWrite — 던지면 더 많이 잃는 자리", () => {
  it("성공하면 true 다", async () => {
    expect(await tryWrite("webhook.update:mark-processed", ok())).toBe(true);
  });

  it("실패하면 false 이고 던지지 않는다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await tryWrite("webhook.update:mark-processed", failing())).toBe(false);

    spy.mockRestore();
  });

  it("**삼키지 않는다** — 로그를 남긴다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await tryWrite("webhook.update:mark-processed", failing("23505"));

    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0][0]);

    expect(line).toContain("webhook.update:mark-processed");
    expect(line).toContain("23505");
    // **값은 남기지 않는다**(§5.3).
    expect(line).not.toContain("010-1234-5678");

    spy.mockRestore();
  });

  it("성공했을 때는 조용하다 — 늘 경보하는 채널이 아니다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await tryWrite("x.update:y", ok());

    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});
