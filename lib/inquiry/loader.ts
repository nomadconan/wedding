import {
  slaState,
  type SlaState,
  type SlaThreshold,
  type TargetStatus,
} from "@/lib/core/inquiry/inquiry";
import type { QuoteItemView, QuoteView } from "@/lib/core/schemas/inquiry";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 문의·견적 서버 공통 조각 (S4-12)
 *
 * `route.ts` 는 HTTP 메서드 외의 export 를 허용하지 않으므로 화면·API 가 함께 쓰는
 * 것을 여기에 둔다.
 *
 * **세션 클라이언트로 읽는다.** 0005 의 정책이 그대로 경계다 — 고객은 자기 문의를,
 * 업체는 자기에게 온 문의를 본다. 서비스롤은 (가) 운영 파라미터와 (나) 견적 쓰기에만
 * 쓴다(0024 가 쓰기 권한을 회수했기 때문이며, 그 이유는 그 파일 주석에 있다).
 */
type Client = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export const INQUIRY_COLUMNS =
  "id, couple_id, event_date, guest_count, region_code, budget_total, categories, note, request_json, status, closed_at, created_at";

export const TARGET_COLUMNS =
  "id, inquiry_id, vendor_id, status, responded_at, sla_deadline, declined_at, decline_reason_code, first_viewed_at, created_at";

export const QUOTE_COLUMNS =
  "id, inquiry_target_id, product_id, total_amount, cap_total, discount_total, base_price_snapshot, valid_until, status, vendor_memo, sent_at, decided_at, pricing_context_json, pricing_steps_json, created_at";

export const QUOTE_ITEM_COLUMNS =
  "id, quote_id, item_type, product_id, product_option_id, category_code, label, amount, cap_amount, discount_amount, is_option, is_mandatory";

type QuoteRow = {
  id: string;
  inquiry_target_id: string;
  product_id: string;
  total_amount: number;
  cap_total: number;
  discount_total: number;
  base_price_snapshot: number;
  valid_until: string | null;
  status: string;
  vendor_memo: string | null;
  sent_at: string | null;
  pricing_context_json: Record<string, unknown> | null;
  pricing_steps_json: unknown;
};

type QuoteItemRow = {
  id: string;
  quote_id: string;
  item_type: "base" | "option";
  category_code: string;
  label: string;
  amount: number;
  cap_amount: number;
  discount_amount: number;
  is_option: boolean;
  is_mandatory: boolean;
};

// =============================================================================
// 운영 파라미터 (§7.4 — 값은 app_settings 가 갖는다)
// =============================================================================

/**
 * `app_settings` 를 읽는다. 행이 없으면 **null** 이다 — 코드가 기본값을 지어내지 않는다.
 * `app_settings` 에는 클라이언트 정책이 없으므로 서비스롤로 읽는다.
 */
async function readSetting(key: string): Promise<Record<string, unknown> | null> {
  const { data } = await createAdminClient()
    .from("app_settings")
    .select("value_json")
    .eq("key", key)
    .maybeSingle();

  return (data?.value_json ?? null) as Record<string, unknown> | null;
}

export async function loadSlaThreshold(): Promise<SlaThreshold | null> {
  const value = await readSetting("inquiry.sla_response_minutes");
  if (value === null) return null;

  const minutes = Number(value.minutes);
  const warnPercent = Number(value.warnPercent);

  if (!Number.isFinite(minutes) || minutes <= 0) return null;

  return {
    minutes,
    warnPercent:
      Number.isFinite(warnPercent) && warnPercent > 0 && warnPercent <= 100 ? warnPercent : 100,
  };
}

/** 동시 문의 상한. 없으면 null — 호출부가 가장 보수적으로(1곳) 다룬다. */
export async function loadMaxTargets(): Promise<number | null> {
  const value = await readSetting("inquiry.max_targets");
  if (value === null) return null;

  const max = Number(value.max);

  return Number.isFinite(max) && max > 0 ? Math.trunc(max) : null;
}

// =============================================================================
// 견적
// =============================================================================

export function toQuoteView(
  row: QuoteRow,
  items: QuoteItemRow[],
  productName: string | null,
): QuoteView {
  return {
    id: row.id,
    inquiryTargetId: row.inquiry_target_id,
    productId: row.product_id,
    productName,
    status: row.status,
    totalAmount: row.total_amount,
    capTotal: row.cap_total,
    discountTotal: row.discount_total,
    basePriceSnapshot: row.base_price_snapshot,
    validUntil: row.valid_until,
    vendorMemo: row.vendor_memo,
    sentAt: row.sent_at,
    items: items.map(
      (item): QuoteItemView => ({
        id: item.id,
        itemType: item.item_type,
        label: item.label,
        categoryCode: item.category_code,
        amount: item.amount,
        capAmount: item.cap_amount,
        discountAmount: item.discount_amount,
        isOption: item.is_option,
        isMandatory: item.is_mandatory,
      }),
    ),
    pricingContext: row.pricing_context_json ?? {},
    pricingSteps: Array.isArray(row.pricing_steps_json)
      ? (row.pricing_steps_json as Record<string, unknown>[])
      : [],
  };
}

async function quotesFor(
  supabase: Client,
  targetIds: string[],
): Promise<Map<string, QuoteView[]>> {
  const byTarget = new Map<string, QuoteView[]>();
  if (targetIds.length === 0) return byTarget;

  const { data: quoteRows } = await supabase
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .in("inquiry_target_id", targetIds)
    .order("created_at", { ascending: false });

  const quotes = (quoteRows ?? []) as QuoteRow[];
  if (quotes.length === 0) return byTarget;

  const { data: itemRows } = await supabase
    .from("quote_items")
    .select(QUOTE_ITEM_COLUMNS)
    .in("quote_id", quotes.map((quote) => quote.id));

  const items = new Map<string, QuoteItemRow[]>();
  for (const item of (itemRows ?? []) as QuoteItemRow[]) {
    items.set(item.quote_id, [...(items.get(item.quote_id) ?? []), item]);
  }

  // 상품 이름은 공개 데이터라 같은 세션으로 읽는다.
  const { data: productRows } = await supabase
    .from("products")
    .select("id, name")
    .in("id", [...new Set(quotes.map((quote) => quote.product_id))]);

  const productNames = new Map(
    ((productRows ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]),
  );

  for (const quote of quotes) {
    const view = toQuoteView(
      quote,
      items.get(quote.id) ?? [],
      productNames.get(quote.product_id) ?? null,
    );

    byTarget.set(quote.inquiry_target_id, [...(byTarget.get(quote.inquiry_target_id) ?? []), view]);
  }

  return byTarget;
}

// =============================================================================
// 소비자 문의함
// =============================================================================

export type InquiryTargetView = {
  id: string;
  vendorId: string;
  vendorName: string;
  status: TargetStatus;
  respondedAt: string | null;
  slaDeadline: string | null;
  declinedAt: string | null;
  declineReasonCode: string | null;
  firstViewedAt: string | null;
  createdAt: string;
  sla: SlaState | null;
  quotes: QuoteView[];
};

export type InquiryView = {
  id: string;
  eventDate: string | null;
  guestCount: number | null;
  regionCode: string | null;
  budgetTotal: number | null;
  categories: string[];
  note: string | null;
  status: string;
  createdAt: string;
  targets: InquiryTargetView[];
};

export async function loadMyInquiries(
  supabase: Client,
  options: { threshold: SlaThreshold | null; now: Date },
): Promise<InquiryView[]> {
  // RLS 가 자기 커플의 문의만 보여준다.
  const { data: inquiryRows, error } = await supabase
    .from("inquiries")
    .select(INQUIRY_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw new Error("INQUIRY_LOAD_FAILED");

  const inquiries = (inquiryRows ?? []) as Record<string, unknown>[];
  if (inquiries.length === 0) return [];

  const { data: targetRows } = await supabase
    .from("inquiry_targets")
    .select(TARGET_COLUMNS)
    .in("inquiry_id", inquiries.map((row) => row.id as string));

  const targets = (targetRows ?? []) as Record<string, unknown>[];

  const { data: vendorRows } = await supabase
    .from("vendors")
    .select("id, name")
    .in("id", [...new Set(targets.map((row) => row.vendor_id as string))]);

  const vendorNames = new Map(
    ((vendorRows ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]),
  );

  const quotesByTarget = await quotesFor(
    supabase,
    targets.map((row) => row.id as string),
  );

  return inquiries.map((inquiry) => ({
    id: inquiry.id as string,
    eventDate: (inquiry.event_date as string | null) ?? null,
    guestCount: (inquiry.guest_count as number | null) ?? null,
    regionCode: (inquiry.region_code as string | null) ?? null,
    budgetTotal: (inquiry.budget_total as number | null) ?? null,
    categories: (inquiry.categories as string[] | null) ?? [],
    note: (inquiry.note as string | null) ?? null,
    status: inquiry.status as string,
    createdAt: inquiry.created_at as string,
    targets: targets
      .filter((target) => target.inquiry_id === inquiry.id)
      .map((target) => ({
        id: target.id as string,
        vendorId: target.vendor_id as string,
        vendorName: vendorNames.get(target.vendor_id as string) ?? "이름을 불러오지 못한 업체",
        status: target.status as TargetStatus,
        respondedAt: (target.responded_at as string | null) ?? null,
        slaDeadline: (target.sla_deadline as string | null) ?? null,
        declinedAt: (target.declined_at as string | null) ?? null,
        declineReasonCode: (target.decline_reason_code as string | null) ?? null,
        firstViewedAt: (target.first_viewed_at as string | null) ?? null,
        createdAt: target.created_at as string,
        sla: slaState(
          target.status as TargetStatus,
          target.created_at as string,
          options.now,
          options.threshold,
        ),
        quotes: quotesByTarget.get(target.id as string) ?? [],
      })),
  }));
}

// =============================================================================
// 업체 인박스
// =============================================================================

export type VendorInquiryView = InquiryTargetView & {
  inquiryId: string;
  eventDate: string | null;
  guestCount: number | null;
  regionCode: string | null;
  budgetTotal: number | null;
  categories: string[];
  note: string | null;
  inquiryStatus: string;
};

export async function loadVendorInbox(
  supabase: Client,
  options: { vendorId: string; threshold: SlaThreshold | null; now: Date },
): Promise<VendorInquiryView[]> {
  // RLS 가 자기 업체에 온 것만 보여준다. vendor_id 조건은 화면 필터일 뿐이다.
  const { data: targetRows, error } = await supabase
    .from("inquiry_targets")
    .select(TARGET_COLUMNS)
    .eq("vendor_id", options.vendorId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw new Error("INQUIRY_LOAD_FAILED");

  const targets = (targetRows ?? []) as Record<string, unknown>[];
  if (targets.length === 0) return [];

  const { data: inquiryRows } = await supabase
    .from("inquiries")
    .select(INQUIRY_COLUMNS)
    .in("id", [...new Set(targets.map((row) => row.inquiry_id as string))]);

  const inquiries = new Map(
    ((inquiryRows ?? []) as Record<string, unknown>[]).map((row) => [row.id as string, row]),
  );

  const quotesByTarget = await quotesFor(
    supabase,
    targets.map((row) => row.id as string),
  );

  const { data: vendorRow } = await supabase
    .from("vendors")
    .select("name")
    .eq("id", options.vendorId)
    .maybeSingle();

  const vendorName = (vendorRow as { name?: string } | null)?.name ?? "";

  return targets.map((target) => {
    const inquiry = inquiries.get(target.inquiry_id as string) ?? {};

    return {
      id: target.id as string,
      inquiryId: target.inquiry_id as string,
      vendorId: target.vendor_id as string,
      vendorName,
      status: target.status as TargetStatus,
      respondedAt: (target.responded_at as string | null) ?? null,
      slaDeadline: (target.sla_deadline as string | null) ?? null,
      declinedAt: (target.declined_at as string | null) ?? null,
      declineReasonCode: (target.decline_reason_code as string | null) ?? null,
      firstViewedAt: (target.first_viewed_at as string | null) ?? null,
      createdAt: target.created_at as string,
      sla: slaState(
        target.status as TargetStatus,
        target.created_at as string,
        options.now,
        options.threshold,
      ),
      quotes: quotesByTarget.get(target.id as string) ?? [],
      eventDate: (inquiry.event_date as string | null) ?? null,
      guestCount: (inquiry.guest_count as number | null) ?? null,
      regionCode: (inquiry.region_code as string | null) ?? null,
      budgetTotal: (inquiry.budget_total as number | null) ?? null,
      categories: (inquiry.categories as string[] | null) ?? [],
      note: (inquiry.note as string | null) ?? null,
      inquiryStatus: (inquiry.status as string | null) ?? "open",
    };
  });
}

/**
 * 견적 폼이 고를 수 있는 것 — **업체가 등록한 상품과 그 상품의 추가금뿐이다.**
 * 이 목록 밖의 것은 화면에 나타나지 않고, 나타나더라도 DB 가 거부한다(0024).
 */
export async function loadQuotableProducts(
  supabase: Client,
  vendorId: string,
): Promise<
  {
    id: string;
    name: string;
    category: string;
    basePrice: number;
    options: { id: string; name: string; price: number; isMandatory: boolean }[];
  }[]
> {
  const { data: productRows } = await supabase
    .from("products")
    .select("id, name, category, base_price_total, status")
    .eq("vendor_id", vendorId)
    .eq("status", "published")
    .order("name");

  const products = (productRows ?? []) as {
    id: string;
    name: string;
    category: string;
    base_price_total: number;
  }[];

  if (products.length === 0) return [];

  const { data: optionRows } = await supabase
    .from("product_options")
    .select("id, product_id, name, price, is_mandatory")
    .in("product_id", products.map((product) => product.id));

  const options = new Map<string, { id: string; name: string; price: number; isMandatory: boolean }[]>();
  for (const row of (optionRows ?? []) as {
    id: string;
    product_id: string;
    name: string;
    price: number;
    is_mandatory: boolean;
  }[]) {
    options.set(row.product_id, [
      ...(options.get(row.product_id) ?? []),
      { id: row.id, name: row.name, price: row.price, isMandatory: row.is_mandatory },
    ]);
  }

  return products.map((product) => ({
    id: product.id,
    name: product.name,
    category: product.category,
    basePrice: product.base_price_total,
    options: options.get(product.id) ?? [],
  }));
}
