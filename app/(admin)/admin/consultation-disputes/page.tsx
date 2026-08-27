import { redirect } from "next/navigation";

/**
 * /admin/consultation-disputes — 노쇼 분쟁 조율 (F-A-16, §6.4 · S4-10)
 *
 * **같은 큐의 다른 입구다.** S8-03 이 네 출처를 `/admin/disputes` 한 화면으로 모았으므로
 * (D-121) 여기서 목록을 다시 그리면 **같은 큐가 두 벌**이 되고, 그 둘이 갈리는 날
 * 어느 쪽이 맞는지 답할 수 없다.
 *
 * **그렇다고 경로를 없애지 않는다.** §6.4 가 이 경로를 F-A-16 에 배정했고, 지우면
 * 404 가 하나 생긴다(FIX-23 이 세고 있는 그 종류다). 그래서 **필터된 큐로 보낸다** —
 * 북마크도 살고 화면도 하나다.
 */
export default function ConsultationDisputesPage() {
  redirect("/admin/disputes?source=consultation");
}
