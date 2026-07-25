import { forwardRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";

/** Base field styling shared by Input, Textarea and Select. */
export const fieldBaseClasses =
  "w-full rounded-[var(--radius)] border border-input bg-background text-sm text-foreground shadow-xs transition-colors placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/40";

export type InputProps = ComponentPropsWithoutRef<"input">;

/** Single-line text field. Forwards `aria-invalid` for error styling. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, ...props },
  ref
) {
  return (
    <input
      ref={ref}
      type={type ?? "text"}
      className={cn(
        fieldBaseClasses,
        "h-10 px-3 py-2",
        // The native file button is the one control that escaped the design
        // system — style it to read as a secondary button. Padding is kept
        // small enough to sit inside the field's h-10 without growing it.
        "file:mr-3 file:h-6 file:cursor-pointer file:rounded-[calc(var(--radius)-0.125rem)] file:border-0 file:bg-secondary file:px-2.5 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80",
        className
      )}
      {...props}
    />
  );
});
