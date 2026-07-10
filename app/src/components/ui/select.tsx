import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/cn";
import { fieldBaseClasses } from "@/components/ui/input";

export type SelectProps = ComponentPropsWithoutRef<"select">;

/**
 * Styled native `<select>`. Pass `<option>`s as children. Uses a native select
 * for zero-JS accessibility and mobile ergonomics; a chevron is layered on top.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...props },
  ref
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          fieldBaseClasses,
          "h-10 appearance-none pl-3 pr-9 py-2",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
});
