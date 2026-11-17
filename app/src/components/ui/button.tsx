"use client";

import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

import { cn } from "@/lib/cn";
import { Spinner } from "@/components/ui/spinner";
import { buttonVariants, type ButtonSize, type ButtonVariant } from "@/components/ui/buttonVariants";

export type { ButtonSize, ButtonVariant } from "@/components/ui/buttonVariants";

export interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Show a spinner and ignore presses while an action is in flight. The button
   * stays focusable (aria-disabled, not disabled), so keyboard focus stays on it.
   */
  loading?: boolean;
}

/**
 * Primary interactive control. Variants: primary | secondary | outline | ghost
 * | destructive | link. Sizes: sm | md | lg | icon (square). Set `loading` to
 * show a spinner and ignore presses. For navigation, render an anchor with
 * {@link ButtonLink} or apply {@link buttonVariants} to a `next/link` `<Link>`.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, disabled, children, type, className, onClick, ...props },
  ref
) {
  // R25 pages L6: a real `disabled` while loading dropped keyboard focus to the
  // page body. A loading button keeps focus and cancels the press instead, so a
  // submit button can't submit (Enter in a field clicks it, and a cancelled
  // click submits nothing).
  const busy = loading && !disabled;
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={loading || undefined}
      className={buttonVariants({ variant, size, className: cn(busy && "cursor-not-allowed opacity-50", className) })}
      {...props}
      onClick={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {loading ? <Spinner size={size === "lg" ? "md" : "sm"} /> : null}
      {children}
    </button>
  );
});

export interface ButtonLinkProps extends ComponentPropsWithoutRef<"a"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

/**
 * Anchor styled as a button (for external links or when an `<a>` is required).
 * For internal routing prefer `<Link className={buttonVariants(...)}>`.
 */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  function ButtonLink({ variant = "primary", size = "md", className, children, ...props }, ref) {
    return (
      <a ref={ref} className={buttonVariants({ variant, size, className })} {...props}>
        {children}
      </a>
    );
  }
);
