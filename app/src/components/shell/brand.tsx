import Link from "next/link";

import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/cn";

/**
 * Vibe Socials wordmark + logo mark. The mark's gradient is the brand accent
 * here only, never on buttons or headings elsewhere.
 */
export function Brand({
  className,
  onNavigate,
}: {
  className?: string;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href="/"
      onClick={onNavigate}
      className={cn(
        "inline-flex items-center gap-2.5 rounded-[var(--radius)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      <BrandMark className="rounded-lg shadow-sm" />
      <span className="text-base font-semibold tracking-tight text-foreground">
        Vibe Socials
      </span>
    </Link>
  );
}
