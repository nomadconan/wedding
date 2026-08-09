// 재고 CSV 파서 (S2-05 · F-V-05 "외부 캘린더 CSV 임포트")
//
// **새 의존성을 쓰지 않는다.** 필요한 것은 따옴표와 줄바꿈을 다루는 최소한의 파서뿐이고,
// 그 정도는 여기서 만들어 테스트로 고정하는 편이 낫다.
//
// **부분 반영하지 않는다.** 한 행이라도 틀리면 전체를 거부하고 행별 오류를 돌려준다.
// 재고는 예약 가능 여부와 직결된다 — 절반만 들어간 재고는 어느 날짜가 반영됐는지
// 모른 채 다시 올리게 만들고, 그 재시도가 중복·누락을 만든다.

import { SlotInputSchema, type SlotInput } from "../schemas/inventory";

/** CSV 헤더. 순서는 자유이며 이름으로 찾는다. */
export const CSV_HEADERS = ["date", "time", "capacity", "product_id"] as const;

export const CSV_TEMPLATE = [
  "date,time,capacity,product_id",
  "2026-10-10,11:00,1,",
  "2026-10-10,14:00,1,",
  "2026-10-11,11:00,2,",
].join("\n");

export type CsvRowError = { line: number; message: string };

export type CsvParseResult =
  | { ok: true; slots: SlotInput[] }
  | { ok: false; errors: CsvRowError[] };

/**
 * 한 줄을 칸으로 나눈다. 따옴표 안의 쉼표는 값의 일부다.
 * 엑셀이 내보내는 `""` 이스케이프도 처리한다.
 */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }

      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current.trim());

  return cells;
}

/**
 * CSV 를 슬롯 목록으로 바꾼다.
 *
 * 빈 줄과 BOM 은 무시한다. 그 외에는 **한 행이라도 틀리면 전체 실패**다.
 * 반환하는 `line` 은 사람이 세는 줄 번호(1부터, 헤더 포함)다 — 파일에서 바로 찾을 수 있어야 한다.
 */
export function parseInventoryCsv(text: string): CsvParseResult {
  const errors: CsvRowError[] = [];
  const slots: SlotInput[] = [];

  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim().length > 0);

  if (headerIndex === -1) {
    return { ok: false, errors: [{ line: 1, message: "내용이 비어 있습니다." }] };
  }

  const headers = splitCsvLine(lines[headerIndex]).map((cell) => cell.toLowerCase());

  for (const required of ["date", "time", "capacity"] as const) {
    if (!headers.includes(required)) {
      errors.push({
        line: headerIndex + 1,
        message: `헤더에 '${required}' 열이 없습니다. 첫 줄은 ${CSV_HEADERS.join(",")} 입니다.`,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const at = (cells: string[], name: string) => {
    const index = headers.indexOf(name);

    return index === -1 ? "" : (cells[index] ?? "");
  };

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim().length === 0) continue;

    const cells = splitCsvLine(raw);
    const capacityRaw = at(cells, "capacity");
    const productRaw = at(cells, "product_id");

    const parsed = SlotInputSchema.safeParse({
      date: at(cells, "date"),
      time: at(cells, "time"),
      // 숫자 변환을 여기서 한다. 빈 칸을 0으로 바꾸지 않는다 — 정원 누락과 0은 다른 실수다.
      capacity: capacityRaw === "" ? undefined : Number(capacityRaw),
      productId: productRaw === "" ? null : productRaw,
    });

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({ line: i + 1, message: `${issue.path.join(".") || "행"}: ${issue.message}` });
      }

      continue;
    }

    slots.push(parsed.data);
  }

  if (slots.length === 0 && errors.length === 0) {
    errors.push({ line: headerIndex + 1, message: "등록할 행이 없습니다." });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, slots };
}
