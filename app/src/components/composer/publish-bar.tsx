"use client";

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
  if (dialogOpen) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden">
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
