"use client";

import type { MouseEvent, Ref } from "react";

import { Button } from "@/components/ui/button";
import type { ButtonVariant } from "@/components/ui/buttonVariants";
import {
  INVALID_WORKSPACE_ID_CODE,
  MISSING_WORKSPACE_ID_CODE,
  pageWorkspaceRefusalText,
  WORKSPACE_CHANGED_CODE,
  WORKSPACE_CHANGED_MESSAGE,
} from "@/lib/workspaceChanged";

/**
 * R33 pages L5: the sentences a read is refused with when the page was drawn
 * for another workspace (a switch in another tab) or has no id. Asking again
 * sends the same id and gets the same answer; only reloading draws the page
 * for the active workspace. The pages keep the refusal as its sentence
 * (readWorkspaceRefusalText), so the sentence is what is matched.
 */
const RELOAD_SENTENCES: ReadonlySet<string> = new Set(
  [
    pageWorkspaceRefusalText(WORKSPACE_CHANGED_CODE),
    pageWorkspaceRefusalText(MISSING_WORKSPACE_ID_CODE),
    pageWorkspaceRefusalText(INVALID_WORKSPACE_ID_CODE),
    WORKSPACE_CHANGED_MESSAGE,
  ].filter((text): text is string => text !== null),
);

/** Whether a load error's sentence is a workspace refusal, whose step is Reload page. */
export function loadErrorAsksReload(message: string | null | undefined): boolean {
  return typeof message === "string" && RELOAD_SENTENCES.has(message);
}

interface LoadErrorProps {
  /** The sentence the failed read gave. */
  message: string;
  /** A sentence after it, about this page (Create: why the connections are needed). */
  detail?: string;
  /** Asks again; never called for a workspace refusal. */
  onRetry: (event: MouseEvent<HTMLButtonElement>) => void;
  retryLabel?: string;
  /** "inline": the sentence and a link-style button in one line (Add many's platforms). */
  layout?: "stack" | "inline";
  retryRef?: Ref<HTMLButtonElement>;
}

/**
 * One control for a read that failed: the sentence and the step. For a
 * workspace refusal the step is Reload page; otherwise the site's own Retry.
 */
export function LoadError({ message, detail, onRetry, retryLabel = "Retry", layout = "stack", retryRef }: LoadErrorProps) {
  const reload = loadErrorAsksReload(message);
  const text = detail ? `${message} ${detail}` : message;
  const variant: ButtonVariant = layout === "inline" ? "link" : "outline";
  const button = (
    <Button
      ref={retryRef}
      size="sm"
      variant={variant}
      onClick={(event) => {
        if (reload) window.location.reload();
        else onRetry(event);
      }}
    >
      {reload ? "Reload page" : retryLabel}
    </Button>
  );
  if (layout === "inline") {
    return (
      <>
        {text} {button}
      </>
    );
  }
  return (
    <div className="flex flex-col items-start gap-3">
      <p>{text}</p>
      {button}
    </div>
  );
}

/**
 * R33 lead review: Load more after its last press was refused. A switch or a
 * missing id can only be refused again, so the button is Reload page; any
 * other failure (shown in the page's own line or toast) keeps Load more.
 */
export function LoadMoreButton({
  error,
  loading,
  onLoadMore,
}: {
  /** The last Load more failure's sentence, or null. */
  error: string | null;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const reload = loadErrorAsksReload(error);
  return (
    <Button
      variant="outline"
      size="sm"
      loading={!reload && loading}
      onClick={() => {
        if (reload) window.location.reload();
        else onLoadMore();
      }}
    >
      {reload ? "Reload page" : "Load more"}
    </Button>
  );
}
