import Image from "next/image"

import type { Feature } from "@/config/site"

export function FeatureCard({ feature }: { feature: Feature }) {
  const fromBottom = feature.image.anchor === "bottom"
  return (
    <li className="flex flex-col overflow-hidden rounded-media border border-line bg-raised">
      <div
        className={`relative aspect-[5/4] px-8 ${fromBottom ? "pb-0" : "pt-8"}`}
      >
        <div
          className={`relative h-full overflow-hidden border-line-strong ${
            fromBottom
              ? "rounded-b-[10px] border-x border-b fade-out-top"
              : "rounded-t-[10px] border-x border-t fade-out-bottom"
          }`}
        >
          <Image
            src={feature.image.src}
            alt={feature.image.alt}
            fill
            sizes="(min-width: 1024px) 320px, (min-width: 768px) 45vw, 90vw"
            className={
              fromBottom
                ? "object-cover object-bottom"
                : "object-cover object-top"
            }
          />
        </div>
      </div>
      <div className="border-t border-line p-7">
        <h3 className="text-h3">{feature.title}</h3>
        <p className="mt-2.5 text-[15px] leading-relaxed text-muted-foreground">
          {feature.description}
        </p>
      </div>
    </li>
  )
}
