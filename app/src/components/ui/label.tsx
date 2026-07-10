import { forwardRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";

/** Form label. Associate with a control via `htmlFor`. */
export const Label = forwardRef<HTMLLabelElement, ComponentPropsWithoutRef<"label">>(
  function Label({ className, ...props }, ref) {
    return (
      <label
        ref={ref}
        className={cn(
          "text-sm font-medium leading-none text-foreground select-none",
          className
        )}
        {...props}
      />
    );
  }
);
