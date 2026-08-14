import { z } from "zod";

/**
 * 정산 API 입출력 스키마 (S5-07 · §4.3 · CLAUDE.md §6)
 *
 * **금액을 입력으로 받지 않는다.** 지급액은 거래 이력과 상계에서 나오며 서버가
 * 산정한다 — 받으면 **운영자가 지급액을 손으로 적을 수 있고**, 그 순간 정산은 계산이
 * 아니라 재량이 된다. 요청이 말하는 것은 "어느 업체의 어느 기간을" 또는 "어느
 * 정산서를" 까지다.
 */
const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다.");

export const SettlementRunSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("run"),
    vendorId: z.string().uuid("업체 식별자가 올바르지 않습니다."),
    /** 기간을 생략하면 설정된 주기의 이번 기간을 쓴다(§7.4). */
    periodStart: DateOnly.optional(),
    periodEnd: DateOnly.optional(),
  }),
  z.object({
    action: z.literal("confirm"),
    settlementId: z.string().uuid("정산서 식별자가 올바르지 않습니다."),
  }),
  z.object({
    action: z.literal("pay"),
    settlementId: z.string().uuid("정산서 식별자가 올바르지 않습니다."),
    /**
     * 명시적 재지급 회차. **자동 재시도에서는 올리지 않는다** — 올리면 열쇠가 바뀌어
     * 재시도가 새 이체가 되고 돈이 두 번 나간다(`payoutIdempotencyKey`).
     */
    attempt: z.number().int().min(1).max(9).optional(),
  }),
]);

export type SettlementRun = z.infer<typeof SettlementRunSchema>;

/** 업체 이의 제기(F-V-09). **업체가 쓸 수 있는 유일한 값**이며 금액은 못 쓴다. */
export const SettlementNoteSchema = z.object({
  settlementId: z.string().uuid(),
  note: z.string().max(1000, "1000자 이내로 적어 주세요."),
});

export type SettlementNote = z.infer<typeof SettlementNoteSchema>;
