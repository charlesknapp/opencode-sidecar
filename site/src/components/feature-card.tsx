import type { Feature } from "@/config/site"
import { FeatureArt } from "@/components/feature-art"
import { FeatureCell } from "@/components/feature-cell"

export function FeatureCard({
  feature,
  index,
}: {
  feature: Feature
  index: number
}) {
  const fromBottom = feature.art.anchor === "bottom"
  return (
    <FeatureCell className="-mr-px -mb-px flex flex-col border-r border-b border-line bg-background transition-[background-color] duration-200 hover:bg-raised">
      <div className="flex items-baseline gap-3 px-7 pt-7">
        <span className="font-mono text-xs text-subtle-foreground tabular-nums">
          {String(index + 1).padStart(2, "0")}
        </span>
        <h3 className="text-h3">{feature.title}</h3>
      </div>
      <p className="mt-2.5 mb-7 px-7 text-[15px] leading-relaxed text-muted-foreground">
        {feature.description}
      </p>
      <div
        className={`relative mt-auto aspect-[5/4] px-7 ${fromBottom ? "pb-7" : ""}`}
      >
        <div
          className={`relative h-full overflow-hidden border-line-strong ${
            fromBottom
              ? "rounded-b-[10px] border-x border-b fade-out-top"
              : "rounded-t-[10px] border-x border-t fade-out-bottom"
          }`}
        >
          <FeatureArt name={feature.art.name} />
        </div>
      </div>
    </FeatureCell>
  )
}
