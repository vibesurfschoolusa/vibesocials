"use client";

import type { Ref } from "react";

import { Button } from "@/components/ui/button";

import { WORKSPACE_CHANGED_RELOAD_MESSAGE } from "./workspace-changed";

/** R27: reloads the page, drawing it for the active workspace. */
export function ReloadPageButton({ buttonRef }: { buttonRef?: Ref<HTMLButtonElement> }) {
  return (
    <Button ref={buttonRef} type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
      Reload
    </Button>
  );
}

/** A status region on the page from the first render; shown, it says the sentence and offers Reload. */
export function WorkspaceChangedNotice({ shown, reloadRef }: { shown: boolean; reloadRef?: Ref<HTMLButtonElement> }) {
  return (
    <div role="status" className="mb-6 flex flex-col items-start gap-3 empty:mb-0 empty:sr-only">
      {shown ? (
        <>
          <p className="text-sm text-foreground">{WORKSPACE_CHANGED_RELOAD_MESSAGE}</p>
          <ReloadPageButton buttonRef={reloadRef} />
        </>
      ) : null}
    </div>
  );
}
