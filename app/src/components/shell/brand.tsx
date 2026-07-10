import Link from "next/link";

import { cn } from "@/lib/cn";

/**
 * Vibe Socials wordmark + logo mark. The gradient survives here only — a subtle
 * brand accent, never on buttons or headings elsewhere.
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
      <span
        aria-hidden
        className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-700 text-sm font-bold text-white shadow-sm"
      >
        VS
      </span>
      <span className="text-base font-semibold tracking-tight text-foreground">
        Vibe Socials
      </span>
    </Link>
  );
}
