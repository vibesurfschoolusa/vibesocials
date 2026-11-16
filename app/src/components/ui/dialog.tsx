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
import { isNoAnswer } from "@/lib/requestNoAnswer";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Ref-counted body scroll lock. Nested dialogs (e.g. a ConfirmDialog opened
// from inside a Dialog) must not restore `overflow` while an ancestor is still
// open — only the first lock saves the original value and the last unlock
// restores it.
let scrollLockCount = 0;
let savedBodyOverflow = "";

function lockBodyScroll() {
  if (scrollLockCount === 0) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLockCount += 1;
}

function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = savedBodyOverflow;
  }
}

function headingsIn(element: Element): HTMLElement[] {
  if (/^H[1-6]$/.test(element.tagName)) return [element as HTMLElement];
  return Array.from(element.children).flatMap(headingsIn);
}

const FIELD_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);

/** What FOCUSABLE_SELECTOR matches, read from attributes so it needs no layout. */
function isFocusable(element: Element): boolean {
  const tabindex = element.getAttribute("tabindex");
  if (tabindex !== null) return tabindex !== "-1";
  if (FIELD_TAGS.has(element.tagName)) return !element.hasAttribute("disabled");
  return element.tagName === "A" && element.hasAttribute("href");
}

function firstFocusableIn(element: Element): HTMLElement | null {
  if (isFocusable(element)) return element as HTMLElement;
  for (const child of Array.from(element.children)) {
    const found = firstFocusableIn(child);
    if (found) return found;
  }
  return null;
}

/**
 * R26 pages L4: where focus goes when a confirmed action removed the button
 * that opened the dialog (Team Remove, Queue Cancel/Delete/Publish, a Media
 * delete, "Create link"), recorded when the dialog opens. Level by level from
 * the trigger outwards: the next row's first control, then the previous
 * row's, then the headings above, nearest first. Controls in the trigger's own
 * row come first but go with it, so the first one still on the page is the
 * neighbouring row, or the section heading when no row is left.
 */
export function focusFallbacks(trigger: HTMLElement | null): HTMLElement[] {
  const found: HTMLElement[] = [];
  const add = (element: HTMLElement | null | undefined) => {
    if (element && element !== trigger && !found.includes(element)) found.push(element);
  };
  let child: Element | null = trigger;
  while (child?.parentElement) {
    const siblings = Array.from(child.parentElement.children);
    const at = siblings.indexOf(child);
    add(siblings.slice(at + 1).map(firstFocusableIn).find(Boolean));
    add(siblings.slice(0, at).reverse().map(firstFocusableIn).find(Boolean));
    for (const heading of siblings.slice(0, at).flatMap(headingsIn).reverse()) add(heading);
    child = child.parentElement;
  }
  return found;
}

/**
 * Focus the trigger if it is still on the page, else the first fallback that
 * is. A fallback never scrolls the page (lead review: Queue's heading is at
 * the top, the card that went was far down). Returns whether a fallback took it.
 */
export function restoreFocus(trigger: HTMLElement | null, fallbacks: HTMLElement[]): boolean {
  if (!trigger) return false;
  if (trigger.isConnected) {
    trigger.focus();
    return false;
  }
  const target = fallbacks.find((candidate) => candidate.isConnected);
  if (!target) return false;
  if (/^H[1-6]$/.test(target.tagName) && !target.hasAttribute("tabindex")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  return true;
}

/**
 * Lead follow-up: a caller can remove the trigger after the dialog closed
 * (Queue's series cancel reads the list again), when focus was already given
 * back to it. So look again on the next frame and after these delays, and only
 * if the trigger is gone and focus fell to the page body. The watch ends after
 * one restore, and as soon as focus has been anywhere but the body and the
 * trigger since close: focus the person moved is never pulled back.
 */
export const FOCUS_RECHECK_MS = [1000, 3000];

interface FocusSchedule {
  frame(run: () => void): void;
  later(run: () => void, ms: number): void;
}

const browserSchedule: FocusSchedule = {
  frame: (run) => window.requestAnimationFrame(run),
  later: (run, ms) => window.setTimeout(run, ms),
};

type FocusDocument = Pick<Document, "activeElement" | "body" | "addEventListener" | "removeEventListener">;

export function watchFocusAfterClose(
  trigger: HTMLElement | null,
  fallbacks: HTMLElement[],
  schedule: FocusSchedule = browserSchedule,
  doc: FocusDocument = document,
): void {
  if (!trigger) return;
  let done = false;
  let checksLeft = 1 + FOCUS_RECHECK_MS.length;
  const stop = () => {
    done = true;
    doc.removeEventListener("focusin", onFocusIn);
  };
  function onFocusIn(event: Event) {
    if (event.target !== trigger) stop();
  }
  const check = () => {
    checksLeft -= 1;
    if (!done) {
      const active = doc.activeElement;
      if (active && active !== doc.body && active !== trigger) stop();
      else if (!trigger.isConnected && restoreFocus(trigger, fallbacks)) stop();
    }
    if (checksLeft === 0 && !done) stop();
  };
  doc.addEventListener("focusin", onFocusIn);
  schedule.frame(check);
  for (const ms of FOCUS_RECHECK_MS) schedule.later(check, ms);
}

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
 * trigger on close (or, when the trigger is gone, to the nearest heading above
 * it: focusFallbacks). Controlled via `open` / `onOpenChange`.
 */
export function Dialog({ open, onOpenChange, children, label, className }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const fallbacks = useRef<HTMLElement[]>([]);

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
    fallbacks.current = focusFallbacks(previouslyFocused.current);

    lockBodyScroll();

    // Move focus into the dialog.
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? panel)?.focus();

    return () => {
      unlockBodyScroll();
      restoreFocus(previouslyFocused.current, fallbacks.current);
      watchFocusAfterClose(previouslyFocused.current, fallbacks.current);
    };
  }, [open]);

  // Dev-only: warn when a Dialog is opened with no accessible name (no
  // <DialogTitle> rendered and no `label` prop). Read via ref on a macrotask so
  // a title registered by a child effect is already reflected.
  const hasNameRef = useRef(false);
  useEffect(() => {
    hasNameRef.current = hasTitle || Boolean(label);
  }, [hasTitle, label]);
  useEffect(() => {
    if (!open || process.env.NODE_ENV === "production") return;
    const timer = window.setTimeout(() => {
      if (!hasNameRef.current) {
        console.warn(
          "<Dialog> has no accessible name. Render a <DialogTitle> or pass a `label` prop."
        );
      }
    }, 0);
    return () => window.clearTimeout(timer);
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

      // Focus escaped the panel entirely — pull it back in rather than let the
      // user Tab into the page behind the modal.
      if (!(active instanceof Node) || !panel.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === panel)) {
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
            "relative z-10 flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-y-auto rounded-[calc(var(--radius)+0.125rem)] border border-border bg-card text-card-foreground shadow-lg outline-none",
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

export const DialogHeader = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function DialogHeader({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn("flex shrink-0 flex-col gap-1.5 p-6 pb-0", className)}
        {...props}
      />
    );
  }
);

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

export const DialogBody = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function DialogBody({ className, ...props }, ref) {
    return (
      <div ref={ref} className={cn("min-h-0 overflow-y-auto p-6 text-sm text-foreground", className)} {...props} />
    );
  }
);

export const DialogFooter = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function DialogFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "flex shrink-0 flex-col-reverse gap-2 p-6 pt-0 sm:flex-row sm:justify-end",
          className
        )}
        {...props}
      />
    );
  }
);

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

/**
 * Thrown by a ConfirmDialog `onConfirm` that has already told the person what
 * went wrong (a toast, a line on the page). The dialog stays open and says
 * nothing more, so a failure is never shown twice.
 */
export class ConfirmFailureShown extends Error {
  constructor(reason = "CONFIRM_FAILURE_SHOWN") {
    super(reason);
    this.name = "ConfirmFailureShown";
  }
}

export const CONFIRM_UNREACHABLE_MESSAGE =
  "We couldn't reach Vibe Socials, so nothing changed. Check your connection and try again.";
export const CONFIRM_FAILED_MESSAGE = "Something went wrong, nothing changed. Try again.";

/**
 * What ConfirmDialog (and a page's own Create link) says when a request
 * fails (R25 new-customer L1): nothing for a ConfirmFailureShown; for a request
 * that got no answer (lib/requestNoAnswer: a rejection of the fetch call
 * itself, not any TypeError) `unreachableText`; for anything else a plain
 * sentence, never the raw error, and the error goes to the console.
 */
export function confirmFailureText(
  error: unknown,
  unreachableText: string = CONFIRM_UNREACHABLE_MESSAGE,
): string | null {
  if (error instanceof ConfirmFailureShown) return null;
  if (isNoAnswer(error)) return unreachableText;
  console.error("[ConfirmDialog] Unexpected failure:", error);
  return CONFIRM_FAILED_MESSAGE;
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
  /**
   * Keeps the confirm button disabled while the caller is still working out
   * what it will do (e.g. the Queue looking up the other half of a Feed and
   * Story post). Off by default.
   */
  confirmDisabled?: boolean;
  /**
   * What the dialog says when the request never left, if "nothing changed"
   * isn't sure (Queue's Publish may have gone out).
   */
  unreachableText?: string;
}

/**
 * Convenience confirmation modal — the accessible replacement for `confirm()`.
 * Awaits `onConfirm` (showing a loading state) and closes on success. On a
 * throw it stays open for a retry: a ConfirmFailureShown was already shown by
 * the caller; anything else the dialog says itself (confirmFailureText).
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
  confirmDisabled = false,
  unreachableText,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A sentence from the last try belongs to that opening only.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setFailure(null);
  }

  const handleConfirm = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (error) {
      // Stays open for a retry, and never silent (R25 new-customer L1).
      setFailure(confirmFailureText(error, unreachableText));
    } finally {
      setBusy(false);
    }
  }, [onConfirm, onOpenChange, unreachableText]);

  const confirmVariant: ButtonVariant = destructive ? "destructive" : "primary";
  const resolvedConfirmText = confirmText ?? (destructive ? "Delete" : "Confirm");

  return (
    <Dialog open={open} onOpenChange={busy ? () => undefined : onOpenChange} className="max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
      </DialogHeader>
      <DialogFooter className="pt-6">
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
          {cancelText}
        </Button>
        <Button variant={confirmVariant} onClick={handleConfirm} loading={busy} disabled={confirmDisabled}>
          {resolvedConfirmText}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
