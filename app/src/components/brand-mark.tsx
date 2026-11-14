import { cn } from "@/lib/cn";

/**
 * The logo mark: the app icon (app/icon.svg, which Next serves at /icon.svg),
 * the brand's gradient hexagon with a V from public/VS_logo.png, so the app,
 * the browser tab and the installed app show the same mark. An image rather
 * than inline SVG, so its gradient ids cannot clash when the mark appears twice
 * on one page (the sidebar and the mobile top bar).
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small static SVG; next/image adds nothing for it
    <img src="/icon.svg" alt="" aria-hidden width={32} height={32} className={cn("h-8 w-8 shrink-0", className)} />
  );
}
