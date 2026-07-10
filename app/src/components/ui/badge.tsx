import { forwardRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";

export type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "success"
  | "warning"
  | "danger"
  | "neutral";

const BADGE_VARIANTS: Record<BadgeVariant, string> = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  outline: "border-border text-foreground",
  // Status pills: subtle tint + intent-colored text. The -ontint text tokens
  // are darkened in light mode so the 12px label clears WCAG AA (>=4.5:1) on
  // the 10-percent tint in both themes.
  success: "border-success/25 bg-success/10 text-success-ontint",
  warning: "border-warning/25 bg-warning/10 text-warning-ontint",
  danger: "border-destructive/25 bg-destructive/10 text-danger-ontint",
  neutral: "border-border bg-muted text-neutral-ontint",
};

export interface BadgeProps extends ComponentPropsWithoutRef<"span"> {
  variant?: BadgeVariant;
}

/**
 * Compact status/label pill. Use `success | warning | danger | neutral` for
 * post/connection status; `default | secondary | outline` for generic labels.
 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant = "default", className, ...props },
  ref
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        BADGE_VARIANTS[variant],
        className
      )}
      {...props}
    />
  );
});
