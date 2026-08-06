import Image, { type ImageProps } from "next/image";

import { ASSETS, type AssetId } from "@/lib/assets/manifest";

/**
 * 매니페스트 슬롯 id 하나로 이미지를 렌더한다 (T-02c).
 *
 *   <AssetImage id="landing.hero" priority />
 *
 * src·width·height·alt 는 `lib/assets/manifest.ts` 에서 자동 주입된다.
 * 실제 이미지를 같은 경로에 덮어써도 이 컴포넌트를 쓰는 화면은 수정할 필요가 없다.
 *
 * - `id` 는 `AssetId` 로 좁혀져 있어 매니페스트에 없는 값은 **타입 에러**가 난다.
 * - `alt` 는 화면 맥락상 다른 문구가 필요할 때만 덮어쓴다. 기본값은 매니페스트 값.
 *   장식용이라 대체 텍스트가 불필요하면 `alt=""` 를 명시한다(WCAG 2.1 AA, 명세서 §7.5).
 * - SVG 슬롯은 `unoptimized` 로 넘긴다. Next 이미지 최적화는 SVG 를 거부하며,
 *   벡터라 최적화 이득도 없다.
 */
export type AssetImageProps = Omit<ImageProps, "src" | "width" | "height" | "alt"> & {
  id: AssetId;
  alt?: string;
};

export function AssetImage({ id, alt, ...rest }: AssetImageProps) {
  const slot = ASSETS[id];

  return (
    <Image
      src={slot.path}
      width={slot.width}
      height={slot.height}
      alt={alt ?? slot.alt}
      unoptimized={slot.path.endsWith(".svg")}
      {...rest}
    />
  );
}

export default AssetImage;
