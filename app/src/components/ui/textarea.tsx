import { forwardRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";
import { fieldBaseClasses } from "@/components/ui/input";

export type TextareaProps = ComponentPropsWithoutRef<"textarea">;

/** Multi-line text field. Shares field styling with Input/Select. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      className={cn(fieldBaseClasses, "min-h-20 px-3 py-2", className)}
      {...props}
    />
  );
});
