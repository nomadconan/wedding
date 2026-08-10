"use client";

/**
 * 디자인 시스템 카탈로그 (T-04b)
 *
 * ⚠ **개발 확인용 화면이다. 프로덕션 라우트가 아니다.**
 *   - 라우트 그룹 `(dev)` 는 개발 중 시각 확인 전용이며 제품 내비게이션에서 연결하지 않는다.
 *   - 실제 배포 전에 이 그룹을 미들웨어나 `feature_flags` 로 차단한다(T-02b·배포 태스크).
 *   - 여기 있는 문구·금액은 전부 **더미 데이터**다. 실제 업체·계약 정보가 아니다.
 *
 * 목적: 토큰과 공통 컴포넌트를 한 화면에서 눈으로 대조한다.
 * 새 컴포넌트를 만들면 여기에 반드시 추가한다 — 카탈로그에 없으면 없는 컴포넌트로 취급한다.
 */

import { useState } from "react";

import { AdminShell } from "@/components/layout/AdminShell";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { AiDisclaimer } from "@/components/domain/AiDisclaimer";
import { BrokerNotice } from "@/components/domain/BrokerNotice";
import { PriceDisplay } from "@/components/domain/PriceDisplay";
import { SortCriteriaBadge } from "@/components/domain/SortCriteriaBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/LoadingState";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";

/** 카탈로그 섹션 래퍼. */
function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 border-t border-border pt-8">
      <div>
        <h2 className="text-display-sm text-foreground">{title}</h2>
        {note ? <p className="mt-1 text-sm text-muted-foreground">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** 색 견본. */
function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="space-y-1">
      <div className={`h-14 rounded-md border border-border ${className}`} />
      <p className="text-caption text-muted-foreground">{name}</p>
    </div>
  );
}

/** 셸 미리보기 프레임 — 전체 화면 셸을 카탈로그 안에서 보기 위한 틀. */
function ShellPreview({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-caption font-medium text-muted-foreground">{label}</p>
      <div className="h-[560px] overflow-auto rounded-lg border border-border bg-background">
        {children}
      </div>
    </div>
  );
}

export default function DesignSystemPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState<"list" | "block" | "amount">("list");

  return (
    <div className="mx-auto max-w-admin space-y-10 p-6 pb-24">
      <header className="space-y-2">
        <Badge variant="secondary">개발 전용 · 프로덕션 라우트 아님</Badge>
        <h1 className="text-display text-foreground">디자인 시스템 카탈로그</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          토큰과 공통 컴포넌트를 한 화면에서 대조한다. 사용 규칙은 <code>docs/DESIGN.md</code> 에
          있다. 아래 금액·업체명은 전부 더미 데이터다.
        </p>
      </header>

      {/* ── 색 ─────────────────────────────────────────────────────────── */}
      <Section
        title="색"
        note="무채색이 기본이고 강조색은 파랑 하나다. 시맨틱 색은 성공·경고·위험 3종만 둔다."
      >
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">무채색</p>
            {/* Tailwind 는 클래스 문자열을 정적으로 스캔한다. `bg-neutral-${step}` 처럼
                조립하면 생성되지 않으므로 전부 그대로 적는다. */}
            <div className="grid grid-cols-4 gap-3 sm:grid-cols-6 lg:grid-cols-11">
              <Swatch name="neutral-0" className="bg-neutral-0" />
              <Swatch name="neutral-50" className="bg-neutral-50" />
              <Swatch name="neutral-100" className="bg-neutral-100" />
              <Swatch name="neutral-200" className="bg-neutral-200" />
              <Swatch name="neutral-300" className="bg-neutral-300" />
              <Swatch name="neutral-400" className="bg-neutral-400" />
              <Swatch name="neutral-500" className="bg-neutral-500" />
              <Swatch name="neutral-600" className="bg-neutral-600" />
              <Swatch name="neutral-700" className="bg-neutral-700" />
              <Swatch name="neutral-800" className="bg-neutral-800" />
              <Swatch name="neutral-900" className="bg-neutral-900" />
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">강조 (brand)</p>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              <Swatch name="brand-50" className="bg-brand-50" />
              <Swatch name="brand-100" className="bg-brand-100" />
              <Swatch name="brand-200" className="bg-brand-200" />
              <Swatch name="brand-500" className="bg-brand-500" />
              <Swatch name="brand-600" className="bg-brand-600" />
              <Swatch name="brand-700" className="bg-brand-700" />
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">시맨틱</p>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              <Swatch name="success" className="bg-success" />
              <Swatch name="success-surface" className="bg-success-surface" />
              <Swatch name="warning" className="bg-warning" />
              <Swatch name="warning-surface" className="bg-warning-surface" />
              <Swatch name="danger" className="bg-danger" />
              <Swatch name="danger-surface" className="bg-danger-surface" />
            </div>
          </div>
        </div>
      </Section>

      {/* ── 타이포 ─────────────────────────────────────────────────────── */}
      <Section
        title="타이포"
        note="금액 스케일(amount)을 본문 스케일과 분리했다. 숫자는 크고 굵게, 단위는 작게."
      >
        <div className="space-y-3">
          <p className="text-display-lg">display-lg · 40px</p>
          <p className="text-display">display · 32px</p>
          <p className="text-display-sm">display-sm · 24px</p>
          <Separator />
          <p className="text-amount-lg" data-amount="">
            12,500,000 <span className="text-xl text-muted-foreground">원</span>
            <span className="ml-2 align-middle text-caption text-muted-foreground">amount-lg</span>
          </p>
          <p className="text-amount" data-amount="">
            12,500,000 <span className="text-base text-muted-foreground">원</span>
            <span className="ml-2 align-middle text-caption text-muted-foreground">amount</span>
          </p>
          <p className="text-amount-sm" data-amount="">
            12,500,000 <span className="text-sm text-muted-foreground">원</span>
            <span className="ml-2 align-middle text-caption text-muted-foreground">amount-sm</span>
          </p>
          <Separator />
          <p className="text-base">base · 본문</p>
          <p className="text-sm text-muted-foreground">sm · 보조 문구</p>
          <p className="text-unit text-muted-foreground">unit · 금액 옆 단위·부가세 표기</p>
          <p className="text-caption text-muted-foreground">caption · 각주</p>
        </div>
      </Section>

      {/* ── 도메인 컴포넌트 ────────────────────────────────────────────── */}
      <Section
        title="도메인 컴포넌트"
        note="서비스 핵심 가치(가격 정찰제·광고 반영 없음·AI 고지)를 화면에서 지키는 컴포넌트다."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">PriceDisplay — 단품(item)</CardTitle>
              <CardDescription>
                총액 → 내역(판매가·추가금·플래너 수수료) → 부가세 순서. 넷 다 필수 prop이라
                생략하면 컴파일이 안 된다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <PriceDisplay
                label="총 견적가"
                amount={12500000}
                basePrice={12500000}
                taxIncluded
                addOns={{ kind: "none" }}
                plannerFee={{ kind: "not_selected" }}
                size="lg"
              />
              <Separator />
              <PriceDisplay
                label="홀 대관 + 식대 (플래너 선택)"
                amount={9540000}
                basePrice={8400000}
                taxIncluded={false}
                addOns={{ kind: "listed", count: 3, total: 720000 }}
                plannerFee={{ kind: "selected", amount: 420000 }}
              />
              <Separator />
              <PriceDisplay
                label="스튜디오 패키지 (추가금 미등록)"
                amount={1800000}
                basePrice={1800000}
                taxIncluded
                addOns={{ kind: "unknown" }}
                plannerFee={{ kind: "unavailable" }}
                size="sm"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">PriceDisplay — 합계(sum)·0원·미정</CardTitle>
              <CardDescription>
                플래너는 카테고리별 부분 선택이라(D-17) 합계 변형이 따로 있다. &quot;0원&quot;과
                &quot;미정&quot;은 다른 정보다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <PriceDisplay
                variant="sum"
                itemCount={4}
                amount={21740000}
                basePrice={20200000}
                taxIncluded
                addOns={{ kind: "listed", count: 5, total: 640000 }}
                plannerFee={{ kind: "selected", amount: 900000, categoryCount: 2 }}
                size="lg"
              />
              <Separator />
              <PriceDisplay
                label="확정된 0원 — 추가금 없음"
                amount={0}
                basePrice={0}
                taxIncluded
                addOns={{ kind: "none" }}
                plannerFee={{ kind: "selected", amount: 0 }}
                size="sm"
              />
              <Separator />
              <PriceDisplay
                label="미정 — 아직 견적이 없다"
                amount="unknown"
                basePrice="unknown"
                taxIncluded={false}
                addOns={{ kind: "unknown" }}
                plannerFee={{ kind: "selected", amount: "unknown" }}
                size="sm"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">SortCriteriaBadge</CardTitle>
              <CardDescription>
                정렬 기준을 노출해 유료 노출이 없음을 화면으로 증명한다(D-03).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <SortCriteriaBadge criteria="price_asc" />
              <SortCriteriaBadge criteria="price_index_gap" />
              <SortCriteriaBadge criteria="response_speed" showNoPaidPlacement={false} />
              <p className="text-caption text-muted-foreground">
                목록 화면은 이 배지 없이 렌더하지 않는다.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">AiDisclaimer</CardTitle>
              <CardDescription>
                AI 결과 화면에 상시 고정 노출. 접기·닫기 옵션이 없다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <AiDisclaimer basisRef="소비자분쟁해결기준(예식업)" />
              <AiDisclaimer
                variant="inline"
                basisRef={["공정거래위원회 표준약관", "소비자분쟁해결기준(사진촬영업)"]}
              />
            </CardContent>
          </Card>

          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle className="text-base">BrokerNotice</CardTitle>
              <CardDescription>
                플랫폼은 통신판매중개자이며 계약 당사자가 아님을 거래 관련 화면(계약·결제·상담
                예약·분쟁)에 고지한다(D-24). 문구는 <code>lib/core/legal.ts</code> 단일 진실이며
                접기·닫기 옵션이 없다.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <p className="text-caption font-medium text-muted-foreground">
                  inline — 결제·계약 화면 하단 고정 (링크 대상 미정)
                </p>
                <BrokerNotice />
                <p className="text-caption font-medium text-muted-foreground">
                  inline — 이용약관 링크가 정해진 경우
                </p>
                <BrokerNotice termsHref="/terms" />
              </div>

              <div className="space-y-2">
                <p className="text-caption font-medium text-muted-foreground">
                  compact — 카드 안 한 줄
                </p>
                <Card>
                  <CardContent className="space-y-3 pt-5">
                    <p className="text-sm font-medium">더미 웨딩홀 A · 계약 요약</p>
                    <PriceDisplay
                      label="1회차 결제 예정액"
                      amount={4900000}
                      basePrice={4500000}
                      taxIncluded
                      addOns={{ kind: "included" }}
                      plannerFee={{ kind: "selected", amount: 400000 }}
                      size="sm"
                    />
                    <Separator />
                    <BrokerNotice variant="compact" termsHref="/terms" />
                  </CardContent>
                </Card>
              </div>
            </CardContent>
          </Card>
        </div>
      </Section>

      {/* ── 상태 3종 ───────────────────────────────────────────────────── */}
      <Section
        title="상태 3종"
        note="명세서 §6 — 모든 데이터 화면에 로딩·빈 상태·에러 상태를 정의한다."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">LoadingState</CardTitle>
              <div className="flex gap-1">
                {(["list", "block", "amount"] as const).map((variant) => (
                  <Button
                    key={variant}
                    size="sm"
                    variant={loading === variant ? "default" : "outline"}
                    onClick={() => setLoading(variant)}
                  >
                    {variant}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              <LoadingState variant={loading} rows={2} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">EmptyState</CardTitle>
              <CardDescription>T-02c 자산 슬롯 id 를 받는다.</CardDescription>
            </CardHeader>
            <CardContent>
              <EmptyState
                assetId="reports.empty"
                title="아직 검토한 계약서가 없어요"
                description="계약서를 올리면 위험 조항을 표준약관 기준과 비교해 정리해 드려요."
                action={<Button size="touch">계약서 올리기</Button>}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">ErrorState</CardTitle>
              <CardDescription>원문·경로를 노출하지 않는다.</CardDescription>
            </CardHeader>
            <CardContent>
              <ErrorState
                code="DOC_ANALYSIS_FAILED"
                onRetry={() => toast({ title: "다시 시도했습니다" })}
              />
            </CardContent>
          </Card>
        </div>
      </Section>

      {/* ── 기본 컴포넌트 ──────────────────────────────────────────────── */}
      <Section title="기본 컴포넌트" note="shadcn/ui 기반. 필요한 것만 들여왔다.">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Button</CardTitle>
              <CardDescription>
                소비자 화면의 주요 액션은 터치 타깃 44px 이상인 <code>size=&quot;touch&quot;</code>
                를 쓴다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button>기본</Button>
                <Button variant="secondary">보조</Button>
                <Button variant="outline">외곽선</Button>
                <Button variant="ghost">고스트</Button>
                <Button variant="link">링크</Button>
                <Button variant="destructive">위험</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm">sm</Button>
                <Button size="default">default</Button>
                <Button size="lg">lg</Button>
                <Button disabled>비활성</Button>
              </div>
              <Button size="touch">touch — 소비자 화면 주요 액션</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Badge · Progress · Skeleton</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge>기본</Badge>
                <Badge variant="secondary">보조</Badge>
                <Badge variant="outline">외곽선</Badge>
                <Badge variant="destructive">위험</Badge>
              </div>
              <div className="space-y-1.5">
                <p className="text-caption text-muted-foreground">온보딩 3 / 6단계</p>
                <Progress value={50} />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">폼</CardTitle>
              <CardDescription>
                한 화면 한 질문 원칙 — 온보딩은 단계당 입력 하나만 둔다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ds-region">예식 지역</Label>
                <Input id="ds-region" placeholder="예: 서울 강남" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ds-category">카테고리</Label>
                <Select>
                  <SelectTrigger id="ds-category">
                    <SelectValue placeholder="선택하세요" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hall">웨딩홀</SelectItem>
                    <SelectItem value="studio">스튜디오</SelectItem>
                    <SelectItem value="dress">드레스</SelectItem>
                    <SelectItem value="makeup">헤어·메이크업</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>하객 규모</Label>
                <RadioGroup defaultValue="150" className="space-y-1.5">
                  {[
                    ["100", "100명 이하"],
                    ["150", "100~200명"],
                    ["250", "200명 이상"],
                  ].map(([value, label]) => (
                    <div key={value} className="flex items-center gap-2">
                      <RadioGroupItem value={value} id={`ds-guest-${value}`} />
                      <Label htmlFor={`ds-guest-${value}`} className="font-normal">
                        {label}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox id="ds-consent" />
                <Label htmlFor="ds-consent" className="font-normal">
                  계약서 원문 24시간 내 파기 정책에 동의합니다
                </Label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tabs · Dialog · Toast</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Tabs defaultValue="summary">
                <TabsList>
                  <TabsTrigger value="summary">요약</TabsTrigger>
                  <TabsTrigger value="findings">위험 조항</TabsTrigger>
                  <TabsTrigger value="missing">누락 조항</TabsTrigger>
                </TabsList>
                <TabsContent value="summary" className="pt-3 text-sm text-muted-foreground">
                  위약·해지 조항에서 기준 대비 편차가 확인됩니다.
                </TabsContent>
                <TabsContent value="findings" className="pt-3 text-sm text-muted-foreground">
                  R-02 · 계약금 전액 몰취 조항
                </TabsContent>
                <TabsContent value="missing" className="pt-3 text-sm text-muted-foreground">
                  불가항력 시 처리 조항
                </TabsContent>
              </Tabs>

              <div className="flex flex-wrap gap-2">
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="outline">다이얼로그 열기</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>계약서를 파기할까요?</DialogTitle>
                      <DialogDescription>
                        분석 결과는 남고 업로드한 원문만 삭제됩니다. 되돌릴 수 없습니다.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button variant="secondary">취소</Button>
                      <Button variant="destructive">파기</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                <Button
                  variant="outline"
                  onClick={() =>
                    toast({
                      title: "견적을 저장했어요",
                      description: "비교표에서 다른 견적과 나란히 볼 수 있어요.",
                    })
                  }
                >
                  토스트 띄우기
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </Section>

      {/* ── 레이아웃 셸 ────────────────────────────────────────────────── */}
      <Section
        title="레이아웃 셸"
        note="소비자는 375px 모바일 퍼스트 + 하단 탭, 업체·운영자는 1280px 데스크톱 + 좌측 사이드바."
      >
        <div className="grid gap-6 xl:grid-cols-2">
          <ShellPreview label="ConsumerShell — 375px 기준">
            <ConsumerShell
              title="탐색"
              activeTab="/explore"
              footer={<Button size="touch">조건에 맞는 업체 보기</Button>}
            >
              <div className="space-y-4">
                <SortCriteriaBadge criteria="price_asc" />
                <Card>
                  <CardContent className="pt-5">
                    <p className="mb-2 text-sm font-medium">더미 웨딩홀 A</p>
                    <PriceDisplay
                      amount={9800000}
                      basePrice={9800000}
                      taxIncluded
                      addOns={{ kind: "listed", count: 2 }}
                      plannerFee={{ kind: "not_selected" }}
                    />
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-5">
                    <p className="mb-2 text-sm font-medium">더미 웨딩홀 B</p>
                    <PriceDisplay
                      amount={12040000}
                      basePrice={11200000}
                      taxIncluded
                      addOns={{ kind: "none" }}
                      plannerFee={{ kind: "selected", amount: 840000 }}
                    />
                  </CardContent>
                </Card>
              </div>
            </ConsumerShell>
          </ShellPreview>

          <ShellPreview label="AdminShell — 1280px 기준 (role=&quot;vendor&quot;)">
            <AdminShell
              role="vendor"
              title="상품·가격"
              description="총액을 등록하지 않으면 상품을 공개할 수 없습니다."
              action={<Button>상품 등록</Button>}
            >
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">등록된 상품</CardTitle>
                </CardHeader>
                <CardContent>
                  <EmptyState
                    assetId="vendor.dashboard.empty"
                    title="등록된 상품이 없습니다"
                    description="총액과 사전 추가금을 함께 등록하면 소비자 탐색 화면에 노출됩니다."
                    action={<Button size="touch">첫 상품 등록하기</Button>}
                  />
                </CardContent>
              </Card>
            </AdminShell>
          </ShellPreview>
        </div>
      </Section>

      <Toaster />
    </div>
  );
}
