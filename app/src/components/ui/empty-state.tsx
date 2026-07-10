import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface EmptyStateProps extends ComponentPropsWithoutRef<"div"> {
  /** Icon element (e.g. a lucide icon). Rendered in a muted circle. */
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Optional call to action (e.g. a `<Button>`). */
  action?: ReactNode;
}

/**
 * Centered placeholder for empty lists / zero-data views: icon + title +
 * description + optional action.
 */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { icon, title, description, action, className, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-[calc(var(--radius)+0.125rem)] border border-dashed border-border px-6 py-12 text-center",
        className
      )}
      {...props}
    >
      {icon ? (
        <div
          aria-hidden
          className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:h-6 [&_svg]:w-6"
        >
          {icon}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
});
