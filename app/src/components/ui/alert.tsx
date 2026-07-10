import { type ReactNode } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";

export type AlertVariant = "info" | "success" | "warning" | "danger";

const VARIANT_META: Record<
  AlertVariant,
  { container: string; icon: string; Icon: LucideIcon; role: "status" | "alert" }
> = {
  info: {
    container: "border-primary/25 bg-primary/10",
    icon: "text-primary",
    Icon: Info,
    role: "status",
  },
  success: {
    container: "border-success/25 bg-success/10",
    icon: "text-success",
    Icon: CheckCircle2,
    role: "status",
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

export interface AlertProps {
  variant?: AlertVariant;
  title?: string;
  children?: ReactNode;
  /** Override the default icon, or pass `false` to hide it. */
  icon?: ReactNode | false;
  className?: string;
}

/**
 * Inline callout. Tinted surface + intent icon; body text uses `foreground`
 * for guaranteed AA contrast on the tint. `warning`/`danger` announce as
 * `role="alert"`, `info`/`success` as `role="status"`.
 */
export function Alert({ variant = "info", title, children, icon, className }: AlertProps) {
  const meta = VARIANT_META[variant];
  const DefaultIcon = meta.Icon;

  return (
    <div
      role={meta.role}
      className={cn(
        "flex gap-3 rounded-[var(--radius)] border p-4 text-foreground",
        meta.container,
        className
      )}
    >
      {icon !== false ? (
        <span className={cn("mt-0.5 flex-shrink-0 [&_svg]:h-5 [&_svg]:w-5", meta.icon)}>
          {icon ?? <DefaultIcon aria-hidden />}
        </span>
      ) : null}
      <div className="flex flex-col gap-1">
        {title ? <p className="text-sm font-semibold leading-none">{title}</p> : null}
        {children ? <div className="text-sm text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}
