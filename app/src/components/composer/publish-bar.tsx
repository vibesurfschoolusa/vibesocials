"use client";

import { useEffect, useRef } from "react";

import { TikTokConsentDeclaration } from "@/components/tiktok-post-settings";
import { Button } from "@/components/ui/button";

/** What the Create page's submit control shows; see submitControl in create-post-form.tsx. */
export interface SubmitControlView {
  label: string;
  loading: boolean;
  disabled: boolean;
  /** The one line saying why a press will not send, or null. */
  reason: string | null;
}

/** The CSS variable the toast container adds to its bottom offset (ui/toast.tsx). */
export const PUBLISH_BAR_OFFSET_VAR = "--publish-bar-offset";

/** The variable's value for the bar's height; 0 while it is hidden (md and up). */
export function publishBarOffset(height: number): string {
  return `${height}px`;
}

/**
 * The Create page's submit button, kept in reach at the bottom of a phone's
 * screen (M1): under the previews and the publish options the form's own
 * button sat a long scroll down. It submits the form by id, so a press runs
 * the form's own handler and confirm dialog. Below `md` only; the form hides
 * its own button there, so one submit control is announced, not two.
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
  // puts its height where the toast container reads it. Display none (md and
  // up) measures 0, so a desktop's toasts stay where they were.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const root = document.documentElement.style;
    const measure = () => root.setProperty(PUBLISH_BAR_OFFSET_VAR, publishBarOffset(bar.offsetHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.removeProperty(PUBLISH_BAR_OFFSET_VAR);
    };
  }, [dialogOpen]);

  if (dialogOpen) return null;
  return (
    <div
      ref={barRef}
      className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden">
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
        <p id="publish-bar-reason" className="mt-1.5 truncate text-xs text-muted-foreground">
          {control.reason}
        </p>
      ) : null}
    </div>
  );
}
