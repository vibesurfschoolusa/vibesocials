"use client";

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button, type ButtonVariant } from "@/components/ui/button";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogContextValue {
  titleId: string;
  descriptionId: string;
  onOpenChange: (open: boolean) => void;
  registerTitle: () => () => void;
  registerDescription: () => () => void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

function useDialogContext(component: string): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error(`${component} must be rendered inside <Dialog>`);
  }
  return ctx;
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /** Accessible name when no <DialogTitle> is rendered. */
  label?: string;
  /** Additional classes for the dialog panel. */
  className?: string;
}

/**
 * Accessible modal dialog: `role="dialog"` + `aria-modal`, focus trap, Esc to
 * close, backdrop-click to close, body scroll lock, and focus restored to the
 * trigger on close. Controlled via `open` / `onOpenChange`.
 */
export function Dialog({ open, onOpenChange, children, label, className }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const [hasTitle, setHasTitle] = useState(false);
  const [hasDescription, setHasDescription] = useState(false);

  const registerTitle = useCallback(() => {
    setHasTitle(true);
    return () => setHasTitle(false);
  }, []);
  const registerDescription = useCallback(() => {
    setHasDescription(true);
    return () => setHasDescription(false);
  }, []);

  // Scroll lock + focus management while open.
  useEffect(() => {
    if (!open) return;

    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    // Move focus into the dialog.
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? panel)?.focus();

    return () => {
      body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open]);

  // Esc to close + Tab focus trap.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  // Render nothing on the server (no document) or when closed. `open` only
  // becomes true via client interaction, so the portal is client-only.
  if (!open || typeof document === "undefined") return null;

  const contextValue: DialogContextValue = {
    titleId,
    descriptionId,
    onOpenChange,
    registerTitle,
    registerDescription,
  };

  return createPortal(
    <DialogContext.Provider value={contextValue}>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm"
          onClick={() => onOpenChange(false)}
          aria-hidden
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          aria-labelledby={hasTitle ? titleId : undefined}
          aria-describedby={hasDescription ? descriptionId : undefined}
          tabIndex={-1}
          className={cn(
            "relative z-10 w-full max-w-lg rounded-[calc(var(--radius)+0.125rem)] border border-border bg-card text-card-foreground shadow-lg outline-none",
            className
          )}
        >
          {children}
        </div>
      </div>
    </DialogContext.Provider>,
    document.body
  );
}

export function DialogHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-1.5 p-6 pb-0", className)}
      {...props}
    />
  );
}

export const DialogTitle = forwardRef<HTMLHeadingElement, ComponentPropsWithoutRef<"h2">>(
  function DialogTitle({ className, ...props }, ref) {
    const { titleId, registerTitle } = useDialogContext("DialogTitle");
    useEffect(() => registerTitle(), [registerTitle]);
    return (
      <h2
        ref={ref}
        id={titleId}
        className={cn("text-lg font-semibold leading-none tracking-tight", className)}
        {...props}
      />
    );
  }
);

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<"p">
>(function DialogDescription({ className, ...props }, ref) {
  const { descriptionId, registerDescription } = useDialogContext("DialogDescription");
  useEffect(() => registerDescription(), [registerDescription]);
  return (
    <p
      ref={ref}
      id={descriptionId}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
});

export function DialogBody({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("p-6 text-sm text-foreground", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 p-6 pt-0 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  );
}

/** Icon-only close button wired to the dialog's `onOpenChange`. */
export function DialogClose({ className }: { className?: string }) {
  const ctx = useDialogContext("DialogClose");
  return (
    <button
      type="button"
      onClick={() => ctx.onOpenChange(false)}
      aria-label="Close dialog"
      className={cn(
        "absolute right-4 top-4 rounded-[var(--radius)] p-1 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <X className="h-4 w-4" />
    </button>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void | Promise<void>;
  /** Style the confirm action as destructive and default its label to "Delete". */
  destructive?: boolean;
}

/**
 * Convenience confirmation modal — the accessible replacement for `confirm()`.
 * Awaits `onConfirm` (showing a loading state) and closes on success.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText = "Cancel",
  onConfirm,
  destructive = false,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  const handleConfirm = useCallback(async () => {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // Keep the dialog open on failure so the user can retry. The caller's
      // onConfirm is responsible for surfacing the error (e.g. via toast);
      // we swallow here only to avoid an unhandled promise rejection.
    } finally {
      setBusy(false);
    }
  }, [onConfirm, onOpenChange]);

  const confirmVariant: ButtonVariant = destructive ? "destructive" : "primary";
  const resolvedConfirmText = confirmText ?? (destructive ? "Delete" : "Confirm");

  return (
    <Dialog open={open} onOpenChange={busy ? () => undefined : onOpenChange} className="max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      <DialogFooter className="pt-6">
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
          {cancelText}
        </Button>
        <Button variant={confirmVariant} onClick={handleConfirm} loading={busy}>
          {resolvedConfirmText}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
