"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { describeAction } from "@/lib/core/audit/audit";

/**
 * 감사 로그 필터 (S8-02)
 *
 * **드롭다운의 선택지를 코드가 정하지 않는다.** 실제로 쌓인 값에서 만든다 —
 * 목록을 손으로 적어 두면 새 액션이 생겼을 때 **그 액션만 필터로 고를 수 없고**,
 * 그 사실을 아무도 눈치채지 못한다.
 *
 * 상태를 들고 있지 않다. 고르면 그대로 URL 이 바뀌고 서버가 다시 그린다 —
 * 감사 로그는 **주소를 복사해 남에게 보내는** 화면이라 조건이 URL 에 있어야 한다.
 */
export type AuditFiltersProps = {
  facets: { actions: string[]; actorRoles: string[]; targetTypes: string[] };
};

export function AuditFilters({ facets }: AuditFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function apply(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    // 조건이 바뀌면 이어 받기 커서를 버린다. 안 버리면 **다른 조건의 커서**로
    // 조회해 첫 페이지가 통째로 사라진 것처럼 보인다.
    next.delete("before");

    router.push(`/admin/audit${next.toString() ? `?${next}` : ""}`);
  }

  const current = (key: string) => searchParams.get(key) ?? "";

  const selectClass =
    "h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground";

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="audit-filters">
      <div className="space-y-1.5">
        <Label htmlFor="filter-actor-role">행위자</Label>
        <select
          id="filter-actor-role"
          className={selectClass}
          value={current("actorRole")}
          onChange={(event) => apply("actorRole", event.target.value)}
        >
          <option value="">전체</option>
          {facets.actorRoles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="filter-action">액션</Label>
        <select
          id="filter-action"
          className={selectClass}
          value={current("action")}
          onChange={(event) => apply("action", event.target.value)}
        >
          <option value="">전체</option>
          {facets.actions.map((action) => (
            <option key={action} value={action}>
              {describeAction(action)}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="filter-target-type">대상</Label>
        <select
          id="filter-target-type"
          className={selectClass}
          value={current("targetType")}
          onChange={(event) => apply("targetType", event.target.value)}
        >
          <option value="">전체</option>
          {facets.targetTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-end gap-2">
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => router.push("/admin/audit")}
        >
          조건 지우기
        </Button>
      </div>
    </div>
  );
}

export default AuditFilters;
