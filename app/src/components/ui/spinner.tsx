import { Loader2 } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";

type SpinnerSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
};

export interface SpinnerProps extends Omit<ComponentPropsWithoutRef<"svg">, "children"> {
  size?: SpinnerSize;
  /** Accessible label. When set, the spinner exposes a live status region;
   *  otherwise it is decorative (`aria-hidden`) — e.g. inside a button. */
  label?: string;
}

/**
 * Indeterminate loading spinner. Decorative by default (pass `label` to
 * announce a standalone loading region to assistive tech).
 */
export const Spinner = forwardRef<SVGSVGElement, SpinnerProps>(function Spinner(
  { size = "md", label, className, ...props },
  ref
) {
  return (
    <Loader2
      ref={ref}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("animate-spin text-current", SIZE_CLASSES[size], className)}
      {...props}
    />
  );
});
