"use client";

import { useEffect, useRef } from "react";

import { TikTokConsentDeclaration } from "@/components/tiktok-post-settings";
import { Button } from "@/components/ui/button";

/** What the Create page's submit control shows; see submitControl in create-post-form.tsx. */
export interface SubmitControlView {
  label: string;
  loading: boolean;
  disabled: boolean;
  /** The line (up to two) saying why a press will not send, or null. */
  reason: string | null;
}

/** The CSS variable the toast container adds to its bottom offset (ui/toast.tsx). */
export const PUBLISH_BAR_OFFSET_VAR = "--publish-bar-offset";

/**
 * The page's scroll-padding-bottom while the bar is mounted, so a control the
 * browser scrolls into view (Tab, a field focused by an error, scrollIntoView)
 * stops above the bar, not under it (WCAG 2.4.11). No fallback: with the
 * variable absent (md and up, nothing written) the value is invalid and the
 * padding stays auto, so a desktop is unchanged.
 */
export const PUBLISH_BAR_SCROLL_PADDING = `var(${PUBLISH_BAR_OFFSET_VAR})`;

/**
 * The variable's value for the bar's height, or null for a hidden bar (a
 * dialog open, or md and up), which measures 0: writing that would collapse
 * the spacer while a dialog is open, and the browser's scroll would then leave
 * the end of the form under the bar once it closed. The last real height stays.
 */
export function publishBarOffset(height: number): string | null {
  return height > 0 ? `${height}px` : null;
}

/**
 * The Create page's submit button, kept in reach at the bottom of a phone's
 * screen (M1): under the previews and the publish options the form's own
 * button sat a long scroll down. It submits the form by id, so a press runs
 * the form's own handler and confirm dialog. Below `md` only; the form hides
 * its own button there, so one submit control is announced, not two. It
 * steps away while any modal dialog is open (the publish confirm, "Remove all
 * photos"), read from the page itself so no dialog's state has to reach it.
 */
export function PublishBar({
  formId,
  control,
  dialogOpen,
  tiktokDeclaration,
}: {
  formId: string;
  control: SubmitControlView;
  /** A confirm dialog is open: the bar steps out of its way. */
  dialogOpen: boolean;
  /** TikTok is a target: its declaration sits directly above this button (barTikTokDeclaration). */
  tiktokDeclaration: { brandedContent: boolean } | null;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  // Toasts sit above the bar while it shows, not over its button: the bar
  // puts its height where the toast container reads it. Display none measures
  // 0 and writes nothing: a desktop's toasts stay where they were, and a bar
  // hidden by a dialog keeps its room (publishBarOffset).
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const root = document.documentElement.style;
    const measure = () => {
      const offset = publishBarOffset(bar.offsetHeight);
      if (offset !== null) root.setProperty(PUBLISH_BAR_OFFSET_VAR, offset);
    };
    measure();
    root.setProperty("scroll-padding-bottom", PUBLISH_BAR_SCROLL_PADDING);
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.removeProperty(PUBLISH_BAR_OFFSET_VAR);
      root.removeProperty("scroll-padding-bottom");
    };
  }, [dialogOpen]);

  if (dialogOpen) return null;
  return (
    <div
      ref={barRef}
      className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden [body:has([role=dialog][aria-modal=true])_&]:hidden">
      {tiktokDeclaration ? (
        <div className="mb-2">
          <TikTokConsentDeclaration brandedContent={tiktokDeclaration.brandedContent} />
        </div>
      ) : null}
      <Button
        type="submit"
        form={formId}
        loading={control.loading}
        disabled={control.disabled}
        aria-describedby={control.reason ? "publish-bar-reason" : undefined}
        className="w-full"
      >
        {control.label}
      </Button>
      {control.reason ? (
        <p id="publish-bar-reason" className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
          {control.reason}
        </p>
      ) : null}
    </div>
  );
}
