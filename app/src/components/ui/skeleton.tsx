import { type ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";

/**
 * Loading placeholder. Size it with utility classes (`h-4 w-32`, etc.).
 * Decorative — hidden from assistive tech; announce loading state separately.
 */
export function Skeleton({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}
