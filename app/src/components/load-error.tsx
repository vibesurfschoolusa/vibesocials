"use client";

import type { MouseEvent, Ref } from "react";

import { Button } from "@/components/ui/button";
import type { ButtonVariant } from "@/components/ui/buttonVariants";
import { focusFirstOf, isHiddenElement, isWatchedForFocus } from "@/lib/focusAfter";
import { keeperStandAside } from "@/lib/focusKeeper";
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

/** How often the watch below looks, and for how long at most (a slow load). */
export const RETRY_FOCUS_CHECK_MS = 50;
export const RETRY_FOCUS_WATCH_MS = 30_000;

/** A status line beside the content: `role="status"`, or an announced sr-only line (Team). */
function isStatusLine(element: Element): boolean {
  return element.getAttribute("role") === "status" || /(^|\s)sr-only(\s|$)/.test(element.getAttribute("class") ?? "");
}

function firstButtonIn(element: Element): HTMLElement | null {
  if (element.tagName === "BUTTON") return element as HTMLElement;
  // An SVG icon in a test DOM can lack `children`.
  for (const child of Array.from(element.children ?? [])) {
    const found = firstButtonIn(child);
    if (found) return found;
  }
  return null;
}

/**
 * R41 review L1: the one rule for focus after a LoadError's Retry. The press
 * swaps the Alert, and the button with it, for the loading view, so focus fell
 * to the page body. Every site renders the Alert in a container that stays
 * (with its status line beside it), so this watches that container: while a
 * status line there has text, focus goes to it; once the load settles, to
 * what took the Alert's place (the list, the card, or the new error's Retry).
 * As in useRetryFocus, the page's focus keeper stands aside for the pressed
 * button and the status line, and focus the person moved is never pulled back.
 */
export function focusThroughRetry(pressed: HTMLElement): () => void {
  let alert: Element | null = pressed.parentElement ?? null;
  while (alert && alert.getAttribute("role") !== "alert") alert = alert.parentElement;
  const holder = alert?.parentElement ?? null;
  if (!alert || !holder) return () => {};
  const before = new Set(Array.from(holder.children));
  const releases = [keeperStandAside(pressed)];
  let placed: HTMLElement | null = null;
  let waited = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    for (const end of releases.splice(0)) end();
  };
  const check = () => {
    if (done) return;
    // The page went (or, in a test, its document did).
    if (typeof document === "undefined") return finish();
    const active = document.activeElement as HTMLElement | null;
    const free = !active || active === document.body || active === pressed || active === placed || !active.isConnected;
    if (!free) return finish();
    if (!pressed.isConnected) {
      const shown = Array.from(holder.children) as HTMLElement[];
      const status = shown.find((element) => isStatusLine(element) && (element.textContent ?? "").trim() !== "");
      if (status) {
        if (status !== placed && focusFirstOf([status])) {
          placed = status;
          releases.push(keeperStandAside(status));
        }
      } else {
        const result = shown.find((element) => !before.has(element) && !isStatusLine(element) && !isHiddenElement(element));
        if (result) {
          const again = result.getAttribute("role") === "alert" ? firstButtonIn(result) : null;
          focusFirstOf([again ?? result]);
          return finish();
        }
      }
    }
    waited += RETRY_FOCUS_CHECK_MS;
    if (waited >= RETRY_FOCUS_WATCH_MS) return finish();
    setTimeout(check, RETRY_FOCUS_CHECK_MS);
  };
  setTimeout(check, 0);
  return finish;
}

interface LoadErrorProps {
  /** The sentence the failed read gave. */
  message: string;
  /** A sentence after it, about this page (Create: why the connections are needed). */
  detail?: string;
  /** Asks again; never called for a workspace refusal. LoadError keeps focus through it (focusThroughRetry). */
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
        if (reload) {
          window.location.reload();
          return;
        }
        // Read before onRetry: React may reuse the event object afterwards.
        const pressed = (event?.currentTarget as HTMLElement | null | undefined) ?? null;
        onRetry(event);
        // A site that placed focus itself (Create's focusAfterPress) keeps its own target.
        if (pressed && !isWatchedForFocus(pressed)) focusThroughRetry(pressed);
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
