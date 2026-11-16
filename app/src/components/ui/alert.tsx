"use client";

import { forwardRef, useImperativeHandle, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";

import { useAnnounceOnShow } from "@/components/ui/announcer";
import { cn } from "@/lib/cn";

export type AlertVariant = "info" | "success" | "warning" | "danger";

const VARIANT_META: Record<
  AlertVariant,
  { container: string; icon: string; Icon: LucideIcon; role: "alert" | null }
> = {
  info: {
    container: "border-primary/25 bg-primary/10",
    icon: "text-primary",
    Icon: Info,
    role: null,
  },
  success: {
    container: "border-success/25 bg-success/10",
    icon: "text-success",
    Icon: CheckCircle2,
    role: null,
  },
  warning: {
    container: "border-warning/25 bg-warning/10",
    icon: "text-warning",
    Icon: AlertTriangle,
    role: "alert",
  },
  danger: {
    container: "border-destructive/25 bg-destructive/10",
    icon: "text-destructive",
    Icon: AlertCircle,
    role: "alert",
  },
};

export interface AlertProps extends ComponentPropsWithoutRef<"div"> {
  variant?: AlertVariant;
  title?: string;
  children?: ReactNode;
  /** Override the default icon, or pass `false` to hide it. */
  icon?: ReactNode | false;
}

/**
 * Inline callout. Tinted surface + intent icon; body text uses `foreground`
 * for guaranteed AA contrast on the tint. `warning`/`danger` announce as
 * `role="alert"`. R30 PP2 (lead): `info`/`success` have no role of their own
 * (as a status region, one added already filled might not be read); they
 * announce their text through the page's announcer when added after the
 * page's first render or when it changes. An explicit `role` (one inside a
 * status region of its own) opts out.
 */
export const Alert = forwardRef<HTMLDivElement, AlertProps>(function Alert(
  { variant = "info", title, children, icon, className, ...props },
  ref
) {
  const meta = VARIANT_META[variant];
  const DefaultIcon = meta.Icon;
  const own = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => own.current as HTMLDivElement);
  useAnnounceOnShow(() => own.current?.textContent ?? "", meta.role === null && !("role" in props));

  return (
    <div
      ref={own}
      role={meta.role ?? undefined}
      className={cn(
        "flex gap-3 rounded-[var(--radius)] border p-4 text-foreground",
        meta.container,
        className
      )}
      {...props}
    >
      {icon !== false ? (
        <span className={cn("mt-0.5 flex-shrink-0 [&_svg]:h-5 [&_svg]:w-5", meta.icon)}>
          {icon ?? <DefaultIcon aria-hidden />}
        </span>
      ) : null}
      {/* R20 pages L2: min-w-0 lets the text shrink below its longest word (a long email address). */}
      <div className="flex min-w-0 flex-col gap-1">
        {title ? <p className="text-sm font-semibold leading-none">{title}</p> : null}
        {children ? <div className="text-sm text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
});
