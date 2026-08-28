import { recordEvent } from "@/lib/audit/record";
import { PLANNER_PROMPT_VERSION, buildPlannerSystemPrompt } from "@/lib/core/ai/prompt";
import { TOOL_SPECS } from "@/lib/core/ai/tools";
import {
  DEPLOYMENT_LEDGER_EMPTY,
  type DeploymentLedger,
  type PromptFeature,
  type PromptRow,
  type ReleaseGate,
  RELEASE_GATE_BLOCKED,
  type RuleConsole,
  buildRuleConsole,
} from "@/lib/core/rules/console";
import { DETECT_RULES } from "@/lib/core/rules/detect-rules";
import { REPORT_PROMPT_VERSION, REPORT_SYSTEM } from "@/lib/core/report/prompt";
import { mergeDetectRules } from "@/lib/core/rules/rule-source";
import { SEARCH_PARSE_PROMPT_VERSION, SEARCH_PARSE_SYSTEM } from "@/lib/core/search/prompt";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 룰·프롬프트 콘솔 (S8-06 · F-A-03)
 *
 * **읽는 방식을 셋으로 가른다**(D-120 과 같은 갈림길).
 *
 * | 대상 | 방식 | 왜 |
 * |---|---|---|
 * | 룰·프롬프트 판본·위약금 밴드 | 세션 + **운영자 정책** | **행이 목적**이다 — "어떤 룰이 도는가" 를 한 줄씩 본다(D-115) |
 * | 판본 사용 이력 | **계산** | `ai_call_logs` 에서 세어진다 — 저장하면 낡는다(D-124) |
 * | 켬/끔·지시문·근거 수정 | **서비스롤** | 운영자에게 UPDATE 를 주면 컬럼 권한이 역할 단위라 `pattern_json`·`code` 까지 열린다(D-62 · S8-11 이 만난 제약) |
 *
 * **프롬프트 본문을 여기 복사하지 않는다.** 각 모듈에서 그대로 읽어 온다 — 사본을
 * 두면 판본이 둘이 되고, 그것이 판본 태깅이 막으려던 상황이다.
 */

const PROMPT_SOURCES: { feature: PromptFeature; version: string; body: string }[] = [
  { feature: "report", version: REPORT_PROMPT_VERSION, body: REPORT_SYSTEM },
  {
    feature: "planner",
    version: PLANNER_PROMPT_VERSION,
    // 플래너 프롬프트는 툴 목록을 받아 만들어진다 — **실제로 나가는 문자열**을 보여준다.
    body: buildPlannerSystemPrompt(TOOL_SPECS),
  },
  { feature: "search", version: SEARCH_PARSE_PROMPT_VERSION, body: SEARCH_PARSE_SYSTEM },
];

export type RuleConsolePayload = {
  rules: RuleConsole;
  prompts: PromptRow[];
  ledger: DeploymentLedger;
  gate: ReleaseGate;
  /** 위약금 밴드. **비어 있다는 사실도 상태다**(S5-08 이 시드를 넣지 않기로 했다). */
  penaltyBands: { total: number; draft: number };
};

export async function loadRuleConsole(): Promise<RuleConsolePayload> {
  const supabase = await createClient();

  const [{ data: ruleRows, error: ruleError }, { data: logRows }, { data: ledgerRows }, { data: bandRows }] =
    await Promise.all([
      supabase
        .from("detect_rules")
        .select("code, is_active, version, prompt_fragment, basis_ref")
        .order("code"),
      // **판본 사용 이력은 계산이다**(D-124). `prompt_versions` 에 쓰지 않는다.
      supabase
        .from("ai_call_logs")
        .select("prompt_version, created_at")
        .not("prompt_version", "is", null)
        .order("created_at", { ascending: true })
        .limit(5_000),
      supabase.from("prompt_versions").select("id").limit(1),
      supabase.from("penalty_rules").select("id, is_draft").limit(500),
    ]);

  if (ruleError) throw new Error("RULE_CONSOLE_LOAD_FAILED");

  const rows = (ruleRows ?? []) as {
    code: string;
    is_active: boolean;
    version: string;
    prompt_fragment: string | null;
    basis_ref: string | null;
  }[];

  const merged = mergeDetectRules(DETECT_RULES, rows);

  // 판본별 첫·마지막 호출과 건수. **한 번도 안 불린 판본은 `null`** 이다 —
  // 0으로 적으면 "돌았는데 0번" 으로 읽힌다(S8-07 이 겪은 것).
  const usage = new Map<string, { calls: number; firstSeen: string; lastSeen: string }>();
  for (const log of (logRows ?? []) as { prompt_version: string; created_at: string }[]) {
    const seen = usage.get(log.prompt_version);
    if (seen) {
      seen.calls += 1;
      seen.lastSeen = log.created_at;
    } else {
      usage.set(log.prompt_version, {
        calls: 1,
        firstSeen: log.created_at,
        lastSeen: log.created_at,
      });
    }
  }

  const codeVersions = new Set(PROMPT_SOURCES.map((source) => source.version));
  const orphaned = [...usage.keys()].filter((version) => !codeVersions.has(version));

  const prompts: PromptRow[] = PROMPT_SOURCES.map((source) => ({
    feature: source.feature,
    version: source.version,
    body: source.body,
    bodyLength: source.body.length,
    usage: usage.get(source.version) ?? null,
    // 로그에만 있는 판본은 **어느 기능의 것인지 알 수 없다** — 전부에 같이 보여
    // 운영자가 판단하게 한다(추측해서 한 기능에 붙이면 그 추측이 사실처럼 남는다).
    orphanedVersions: orphaned,
  }));

  const bands = (bandRows ?? []) as { id: string; is_draft: boolean | null }[];

  return {
    rules: buildRuleConsole(DETECT_RULES, merged, rows),
    prompts,
    ledger:
      (ledgerRows ?? []).length === 0
        ? DEPLOYMENT_LEDGER_EMPTY
        : { status: "used", rows: (ledgerRows ?? []).length },
    // 골든셋이 없으므로 항상 blocked 다. 생기면 여기서 실제 결과를 읽는다(FIX-42).
    gate: RELEASE_GATE_BLOCKED,
    penaltyBands: {
      total: bands.length,
      draft: bands.filter((band) => band.is_draft === true).length,
    },
  };
}

export type RuleActionResult =
  | { ok: true; code: string }
  | { ok: false; status: number; code: string; message: string };

/**
 * 룰 하나의 운영자 자산을 고친다.
 *
 * **서비스롤로 쓴다**(D-62). 운영자에게 UPDATE 정책을 주면 컬럼 권한이 **역할 단위**라
 * `pattern_json`·`code`·`severity_default` 까지 함께 열린다 — 그 셋이 열리면 스캔이
 * 멈추거나(오타 정규식) 리포트의 판정 기준이 배포 밖에서 바뀐다.
 *
 * **여기서 만질 칸을 코드가 나열한다.** DB 정책으로는 못 막는 종류이며(정책은 행을
 * 정하지 칸을 정하지 않는다) 서비스롤이라 컬럼 권한도 적용되지 않는다 — 그래서
 * **이 함수가 유일한 경계**이고, `update()` 에 넘기는 객체가 그 목록 그대로여야 한다.
 *
 * **사유가 필수다.** 룰을 끄는 것은 계약서에서 그 조항을 안 보겠다는 뜻이고,
 * 나중에 "왜 이 조항이 리포트에 없었나" 를 답해야 한다.
 */
export async function updateRule(input: {
  code: string;
  isActive: boolean;
  promptFragment: string | null;
  basisRef: string | null;
  reason: string;
  operatorId: string;
  operatorRole: string | null;
}): Promise<RuleActionResult> {
  const admin = createAdminClient();

  const { data: current } = await admin
    .from("detect_rules")
    // **행 id 가 필요하다.** `entity_events.entity_id`·`audit_logs.target_id` 는 uuid 라
    // 룰 코드를 그대로 넣을 수 없다 — 넣으면 증적 적재가 조용히 실패한다
    // (`recordEvent` 는 실패해도 본 작업을 되돌리지 않는다). 코드는 memo 로 남긴다.
    .select("id, code, is_active, prompt_fragment, basis_ref")
    .eq("code", input.code)
    .maybeSingle();

  if (!current) {
    return { ok: false, status: 404, code: "RULE_NOT_FOUND", message: "룰을 찾을 수 없습니다." };
  }

  // **코드에 없는 룰은 고치지 않는다.** 고쳐 봐야 실행되지 않으므로 화면이
  // "고쳤다" 고 말하는 것 자체가 거짓이 된다.
  if (!DETECT_RULES.some((rule) => rule.code === input.code)) {
    return {
      ok: false,
      status: 409,
      code: "RULE_NOT_IN_CODE",
      message: "코드에 없는 룰이라 실행되지 않습니다. 배포로 추가해야 합니다.",
    };
  }

  const { error } = await admin
    .from("detect_rules")
    // **이 세 칸만.** 목록을 늘리려면 위 주석의 이유부터 다시 읽는다.
    .update({
      is_active: input.isActive,
      prompt_fragment: input.promptFragment,
      basis_ref: input.basisRef,
    })
    .eq("code", input.code);

  if (error) {
    return { ok: false, status: 500, code: "RULE_UPDATE_FAILED", message: "저장하지 못했습니다." };
  }

  await recordEvent({
    entityType: "detect_rule",
    entityId: current.id,
    eventType: current.is_active === input.isActive ? "rule_edited" : "rule_toggled",
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: current.is_active ? "active" : "inactive",
    afterState: input.isActive ? "active" : "inactive",
    source: "admin",
    // **지시문·사유 본문을 담지 않는다**(§7.3). 행과 감사 로그가 갖는다.
    // 남길 사실은 **어느 룰인가** — id 만으로는 나중에 읽는 사람이 못 알아본다.
    memo: `rule:${input.code}`,
  });

  await writeAuditLog(admin, {
    actorId: input.operatorId,
    actorRole: input.operatorRole,
    action: "detect_rule_updated",
    targetType: "detect_rule",
    targetId: current.id,
    // **짧은 값이라 그대로 남긴다** — S8-08 이 리비전 표를 만든 것과 다른 판단이다.
    // 그쪽은 본문을 덮어써 다시 셀 수 없었고, 여기서 바뀌는 것은 켬/끔과 짧은 문구다.
    before: { code: input.code, active: current.is_active },
    after: { active: input.isActive, reason: input.reason },
  });

  return { ok: true, code: input.code };
}

/** 운영자 액션은 `audit_logs` 에도 남기고 **근거 이벤트 id 를 함께** 남긴다(§7.2). */
async function writeAuditLog(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    actorId: string;
    actorRole: string | null;
    action: string;
    targetType: string;
    targetId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<void> {
  const { data: basisRows } = await admin
    .from("entity_events")
    .select("id")
    .eq("actor_id", input.actorId)
    .order("occurred_at", { ascending: false })
    .limit(5);

  const basis = ((basisRows ?? []) as { id: string }[]).map((row) => row.id);

  await admin.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_role: input.actorRole,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    before_json: input.before,
    after_json: input.after,
    // 빈 배열은 CHECK 이 막는다.
    resolution_basis: basis.length > 0 ? basis : null,
  });
}
