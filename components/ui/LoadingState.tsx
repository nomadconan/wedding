import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * 로딩 상태 (T-04b)
 *
 * 명세서 §6 공통 UI 규칙: **로딩·빈 상태·에러 상태 3종을 모든 데이터 화면에 정의한다.**
 * 스피너 대신 실제 콘텐츠 모양의 스켈레톤을 쓴다 — 레이아웃이 튀지 않아
 * 체감 대기시간이 짧고, WebView 성능 가드(§6)에도 유리하다.
 *
 * 접근성(§7.5): `aria-busy` 와 스크린리더 전용 문구로 진행 중임을 알린다.
 */
export type LoadingStateProps = {
  /** 스크린리더에 읽히는 문구. 화면 맥락에 맞게 바꾼다. */
  label?: string;
  /** 반복할 스켈레톤 줄 수. */
  rows?: number;
  /** 카드 형태로 감쌀지 여부. 목록 화면은 true, 인라인 영역은 false. */
  variant?: "list" | "block" | "amount";
  className?: string;
};

export function LoadingState({
  label = "불러오는 중입니다",
  rows = 3,
  variant = "list",
  className,
}: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn("w-full", className)}
      data-testid="loading-state"
    >
      <span className="sr-only">{label}</span>

      {variant === "amount" ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-44" />
          <Skeleton className="h-3 w-32" />
        </div>
      ) : variant === "block" ? (
        <div className="space-y-3">
          {Array.from({ length: rows }).map((_, index) => (
            <Skeleton key={index} className="h-4 w-full last:w-2/3" />
          ))}
        </div>
      ) : (
        <ul className="space-y-3">
          {Array.from({ length: rows }).map((_, index) => (
            <li key={index} className="rounded-lg border border-border p-4">
              <div className="flex items-start gap-3">
                <Skeleton className="h-12 w-12 shrink-0 rounded-md" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/5" />
                  <Skeleton className="h-3 w-3/5" />
                  <Skeleton className="h-6 w-28" />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default LoadingState;
