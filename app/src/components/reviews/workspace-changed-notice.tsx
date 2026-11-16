"use client";

import type { Ref } from "react";

import { Button } from "@/components/ui/button";

import { WORKSPACE_CHANGED_RELOAD_MESSAGE } from "./workspace-changed";

/** R27 lead follow-up: Reload clears a typed reply, so a refused press says to copy it first. */
export const COPY_BEFORE_RELOAD = "Copy anything you typed, then reload.";

/** R27: reloads the page, drawing it for the active workspace. */
export function ReloadPageButton({ buttonRef }: { buttonRef?: Ref<HTMLButtonElement> }) {
  return (
    <Button ref={buttonRef} type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
      Reload
    </Button>
  );
}

/**
 * A status region on the page from the first render; shown, it says the
 * sentence and offers Reload. `copyHint`: after a refused press, where typed
 * text is still on the page.
 */
export function WorkspaceChangedNotice({
  shown,
  copyHint = false,
  reloadRef,
}: {
  shown: boolean;
  copyHint?: boolean;
  reloadRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div role="status" className="mb-6 flex flex-col items-start gap-3 empty:mb-0 empty:sr-only">
      {shown ? (
        <>
          <p className="text-sm text-foreground">{WORKSPACE_CHANGED_RELOAD_MESSAGE}</p>
          {copyHint ? <p className="text-sm text-muted-foreground">{COPY_BEFORE_RELOAD}</p> : null}
          <ReloadPageButton buttonRef={reloadRef} />
        </>
      ) : null}
    </div>
  );
}
