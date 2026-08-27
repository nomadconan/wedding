// 감사 로그 조회·표현 (S8-02 · F-A-09 · 명세서 §6.4 `/admin/audit` · §4.3)
//
// **화면이 판단하지 않게 한다.** 무엇을 필터로 받을지, 두 표를 어떻게 한 줄로 세울지,
// 무엇을 가릴지, CSV 로 어떻게 내보낼지 — 전부 여기 있고 테스트가 붙잡는다.
//
// 이 파일은 프레임워크를 모른다(CLAUDE.md §3.1). DB 도 모른다 — 행을 받아 모양만 바꾼다.

import { z } from "zod";

// ── 조회 조건 ───────────────────────────────────────────────────────────────

/** 한 번에 가져올 행 수. 감사 로그는 길어서 상한이 없으면 화면이 멈춘다. */
export const AUDIT_PAGE_SIZE = 50;

/** 내보내기 상한. 브라우저가 받아 낼 수 있는 크기이면서 한 달치를 담는다. */
export const AUDIT_EXPORT_LIMIT = 5_000;

/**
 * 필터.
 *
 * **전부 선택이다.** 아무것도 안 고르면 최근 것부터 보여준다 — 감사 로그를 여는 사람은
 * 대개 "방금 뭐가 있었나" 를 먼저 보고, 조건은 그 다음에 좁힌다.
 */
export const AuditQuerySchema = z
  .object({
    /** `actor_role`. 누가 한 일인가. */
    actorRole: z.string().trim().min(1).max(40).optional(),
    /** `action`. 무슨 일인가. */
    action: z.string().trim().min(1).max(80).optional(),
    /** `target_type`. 무엇에 한 일인가. */
    targetType: z.string().trim().min(1).max(80).optional(),
    /** 특정 대상 하나를 따라갈 때. */
    targetId: z.string().uuid().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    /** 이어 받기. 마지막 행의 `created_at` 을 그대로 넘긴다. */
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(AUDIT_EXPORT_LIMIT).optional(),
  })
  .strict();

export type AuditQuery = z.infer<typeof AuditQuerySchema>;

/**
 * URL 쿼리스트링을 조건으로 바꾼다.
 *
 * **틀린 값을 거절하지 않고 버린다.** 운영자가 주소창을 손으로 고쳤을 때 감사 로그가
 * 통째로 오류가 되면 안 된다 — 감사 로그는 사고가 났을 때 여는 화면이고, 그때 화면이
 * 안 열리는 것이 가장 나쁘다. 못 알아들은 조건은 **없는 것으로 치고 나머지로 조회**한다.
 */
export function parseAuditQuery(params: Record<string, string | undefined>): AuditQuery {
  const candidate: Record<string, unknown> = {};

  for (const key of ["actorRole", "action", "targetType", "targetId", "from", "to", "before"]) {
    const value = params[key];
    if (value) candidate[key] = value;
  }
  if (params.limit) candidate.limit = params.limit;

  const parsed = AuditQuerySchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  // 문제가 된 칸만 떨어뜨리고 다시 시도한다.
  const bad = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
  for (const key of bad) delete candidate[key];

  const retry = AuditQuerySchema.safeParse(candidate);

  return retry.success ? retry.data : {};
}

/** 필터가 실제로 좁히고 있는가. 화면이 "전체 보는 중" 을 구분하는 데 쓴다. */
export function isNarrowed(query: AuditQuery): boolean {
  return Boolean(
    query.actorRole || query.action || query.targetType || query.targetId || query.from || query.to,
  );
}

// ── 두 표를 한 줄로 ─────────────────────────────────────────────────────────
//
// `audit_logs` 는 **행위**(누가 무엇을 했다)이고 `entity_events` 는 **전이**(무엇이
// 어떤 상태가 됐다)다. 분쟁을 조사할 때 필요한 것은 둘을 **시간순으로 섞은 하나**이며,
// 그것이 §6.4 가 말하는 '증적 타임라인' 이다.

export type AuditLogRow = {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  /** 조율 결정의 근거가 된 이벤트 id 목록(§3.8). */
  resolutionBasis: string[] | null;
};

export type EntityEventRow = {
  id: string;
  occurredAt: string;
  entityType: string;
  entityId: string;
  eventType: string;
  actorId: string | null;
  actorRole: string | null;
  beforeState: string | null;
  afterState: string | null;
  source: string | null;
  memo: string | null;
};

export type TimelineEntry = {
  kind: "action" | "transition";
  id: string;
  at: string;
  actorId: string | null;
  actorRole: string | null;
  /** 화면에 그대로 쓰는 한 줄. */
  label: string;
  targetType: string;
  targetId: string | null;
  /** 상태 전이. 행위 행에는 없다. */
  transition: { before: string | null; after: string | null } | null;
  /** 바뀐 칸 목록. 전이 행에는 없다. */
  changes: FieldChange[];
  /** 근거 이벤트 id. 조율 결정에만 있다. */
  resolutionBasis: string[];
  memo: string | null;
};

/**
 * 시간순으로 섞는다. **최근이 위**다.
 *
 * 같은 시각이면 `id` 로 갈라 **순서를 고정한다** — 흔들리면 같은 화면을 두 번 열었을 때
 * 순서가 달라지고, 그것이 증적이라면 읽는 사람이 기록을 의심하게 된다.
 */
export function buildTimeline(logs: AuditLogRow[], events: EntityEventRow[]): TimelineEntry[] {
  const fromLogs: TimelineEntry[] = logs.map((row) => ({
    kind: "action",
    id: row.id,
    at: row.createdAt,
    actorId: row.actorId,
    actorRole: row.actorRole,
    label: describeAction(row.action),
    targetType: row.targetType,
    targetId: row.targetId,
    transition: null,
    changes: diffFields(row.beforeJson, row.afterJson),
    resolutionBasis: row.resolutionBasis ?? [],
    memo: null,
  }));

  const fromEvents: TimelineEntry[] = events.map((row) => ({
    kind: "transition",
    id: row.id,
    at: row.occurredAt,
    actorId: row.actorId,
    actorRole: row.actorRole,
    label: describeAction(row.eventType),
    targetType: row.entityType,
    targetId: row.entityId,
    transition: { before: row.beforeState, after: row.afterState },
    changes: [],
    resolutionBasis: [],
    memo: row.memo,
  }));

  return [...fromLogs, ...fromEvents].sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;

    return a.id < b.id ? 1 : -1;
  });
}

// ── 무엇이 바뀌었나 ─────────────────────────────────────────────────────────

export type FieldChange = { field: string; before: string; after: string };

/**
 * **가리는 칸.** `before_json`/`after_json` 은 각 라우트가 자유롭게 담는 객체라
 * 개인정보가 섞일 수 있다. 화면·CSV 어디에도 값을 내보내지 않고 **바뀌었다는 사실만** 남긴다.
 *
 * §7.3(로그 금지 항목)과 같은 취지다 — 저장을 막는 것은 각 라우트의 몫이고, 여기서는
 * **이미 저장된 것을 내보내지 않는** 두 번째 방어선을 둔다.
 */
const REDACTED_KEYS = [
  "phone", "phone_hash", "phoneHash",
  "email",
  "biz_no", "bizNo", "biz_no_enc", "business_number",
  "account", "account_no", "accountNo", "bank_account",
  "storage_path", "storagePath", "path", "paths", "evidence_paths",
  "token", "invite_token", "inviteToken", "secret", "key", "password",
  "name", "display_name", "displayName", "contact",
  "memo", "note", "body", "content", "message", "reason_text",
];

export const REDACTED_PLACEHOLDER = "(가림)";

function isRedacted(field: string): boolean {
  const lower = field.toLowerCase();

  return REDACTED_KEYS.some((key) => lower === key.toLowerCase());
}

/** 값을 한 줄 문자열로. 객체·배열은 펼치지 않고 모양만 알려 준다. */
function render(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}개]`;

  return "{…}";
}

/**
 * `before_json` → `after_json` 에서 **바뀐 칸만** 뽑는다.
 *
 * **통째로 JSON 을 그리지 않는 이유.** 한 칸이 바뀐 것을 보려고 서른 칸을 읽어야 하면
 * 아무도 안 읽는다. 그리고 안 바뀐 칸까지 화면에 뿌리는 것은 필요 없는 노출이다.
 */
export function diffFields(before: unknown, after: unknown): FieldChange[] {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;

  if (typeof a !== "object" || typeof b !== "object") return [];

  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const changes: FieldChange[] = [];

  for (const field of fields) {
    const beforeValue = a[field];
    const afterValue = b[field];
    if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;

    changes.push(
      isRedacted(field)
        ? { field, before: REDACTED_PLACEHOLDER, after: REDACTED_PLACEHOLDER }
        : { field, before: render(beforeValue), after: render(afterValue) },
    );
  }

  return changes;
}

// ── 사람이 읽는 이름 ────────────────────────────────────────────────────────

/**
 * `<도메인>_<동사 과거형>` 을 한국어 한 줄로.
 *
 * **모르는 코드는 지어내지 않고 그대로 보여준다.** 새 액션이 생겼을 때 이 표에 없다고
 * 빈칸이 되면 감사 로그에 구멍이 생긴 것처럼 보인다 — 코드 자체가 이미 정보다.
 */
const ACTION_LABEL: Record<string, string> = {
  vendor_approved: "업체 승인",
  vendor_rejected: "업체 반려",
  vendor_revision_requested: "업체 보완 요청",
  member_invited: "멤버 초대",
  member_removed: "멤버 해제",
  member_role_changed: "멤버 권한 변경",
  price_rule_created: "가격 규칙 생성",
  price_rule_updated: "가격 규칙 수정",
  price_rule_deleted: "가격 규칙 삭제",
  inventory_bulk_updated: "재고 일괄 변경",
  settlement_confirmed: "정산 확정",
  settlement_paid: "정산 지급",
  moderation_applied: "모더레이션 조치",
  rate_created: "요율 등록",
  rate_ended: "요율 종료",
};

export function describeAction(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

/** 필터 드롭다운이 쓸 목록. 실제로 쌓인 값에서 만들되 알려진 것은 이름을 붙인다. */
export function actionOptions(seen: string[]): { value: string; label: string }[] {
  return [...new Set(seen)]
    .sort()
    .map((value) => ({ value, label: describeAction(value) }));
}

// ── 내보내기 (CSV) ──────────────────────────────────────────────────────────

export const AUDIT_CSV_HEADER = [
  "at",
  "kind",
  "actor_role",
  "actor_id",
  "action",
  "target_type",
  "target_id",
  "before_state",
  "after_state",
  "changed_fields",
  "resolution_basis",
] as const;

/**
 * CSV 한 칸을 안전하게 만든다.
 *
 * **수식 주입을 막는다.** `=`·`+`·`-`·`@`(그리고 탭·캐리지리턴)로 시작하는 값은 엑셀이
 * **수식으로 실행**한다. 감사 로그에는 사용자가 넣은 문자열이 섞이므로
 * `=HYPERLINK("http://…"&A1,"click")` 같은 칸을 만들어 두면 **로그를 여는 운영자의
 * 화면에서 실행**된다. 그래서 앞에 작은따옴표를 붙여 문자열로 못 박는다.
 *
 * (RFC 4180 의 인용 규칙만으로는 막히지 않는다 — 인용부호는 값을 감쌀 뿐
 *  엑셀은 그 안의 `=` 를 여전히 수식으로 읽는다.)
 */
export function escapeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const dangerous = /^[=+\-@\t\r]/.test(text);
  const guarded = dangerous ? `'${text}` : text;

  // 인용은 항상 한다. 값에 쉼표·줄바꿈이 없어도 규칙이 하나면 실수가 없다.
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function toCsv(entries: TimelineEntry[]): string {
  const rows = [AUDIT_CSV_HEADER.map(escapeCsvCell).join(",")];

  for (const entry of entries) {
    rows.push(
      [
        entry.at,
        entry.kind,
        entry.actorRole ?? "",
        entry.actorId ?? "",
        entry.label,
        entry.targetType,
        entry.targetId ?? "",
        entry.transition?.before ?? "",
        entry.transition?.after ?? "",
        // **값은 내보내지 않고 칸 이름만** 내보낸다(§7.3).
        entry.changes.map((change) => change.field).join(" "),
        entry.resolutionBasis.join(" "),
      ]
        .map(escapeCsvCell)
        .join(","),
    );
  }

  // CRLF. 엑셀이 LF 만 있는 파일을 한 줄로 읽는 환경이 있다.
  return `${rows.join("\r\n")}\r\n`;
}

/** 내보내기 파일 이름. 언제 뽑은 것인지가 파일명에 남아야 나중에 대조할 수 있다. */
export function exportFilename(now: Date): string {
  return `audit-${now.toISOString().slice(0, 19).replace(/[-:T]/g, "")}.csv`;
}
