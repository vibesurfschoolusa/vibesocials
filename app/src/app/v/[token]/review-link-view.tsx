"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useAnnounceOnShow } from "@/components/ui/announcer";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CLIENT_LINK_LIMIT_WINDOW_SECONDS,
  dailyLimitSentence,
  limitReachedSentence,
  limitWaitSeconds,
  sendAgainSentence,
} from "@/lib/clientLinkLimit";
import { focusAfterPress, focusFirstOf } from "@/lib/focusAfter";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";
import { useRetryFocus } from "@/lib/useRetryFocus";
import {
  REVIEW_ALREADY_APPROVED_MESSAGE,
  REVIEW_LIST_MAX,
  REVIEW_DECISION_MAYBE_SAVED_MESSAGE,
  REVIEW_POST_CHANGED_MESSAGE,
  REVIEW_POST_LOCKED_MESSAGE,
  REVIEW_POST_LOCKED_RELOADED_MESSAGE,
  REVIEW_NOTE_MAX,
  REVIEW_LINK_DAILY_LIMIT_MESSAGE,
  REVIEW_LINK_IP_LIMIT_MESSAGE,
  reviewDecisionOutcome,
} from "@/lib/reviewLink";
// Types only (erased): the card a Feed and Story post folds into (F6).
import type { ReviewCardDTO as ReviewPostDTO } from "@/server/reviewLink";

/** Shown over a list on screen when reloading it failed. */
export const REFRESH_FAILED_MESSAGE = "Couldn't refresh the list. Check your connection and reload the page.";
/** R29 client-journey L2: Send again found the same change request already standing. */
export const REVIEW_CHANGE_ALREADY_SAVED_MESSAGE = "Your change request was already saved. The list was loaded again.";

/**
 * R30 client-journey L3: the notice once the reload has answered. Its claim
 * about the list stands only when the reload worked; otherwise the refresh
 * alert above it says what to do.
 */
const NOT_RELOADED: Record<string, string> = {
  [REVIEW_CHANGE_ALREADY_SAVED_MESSAGE]: "Your change request was already saved.",
  [REVIEW_ALREADY_APPROVED_MESSAGE]: "This post was already approved.",
  [REVIEW_POST_CHANGED_MESSAGE]: "This post was changed after you opened this page.",
  [REVIEW_POST_LOCKED_RELOADED_MESSAGE]: REVIEW_POST_LOCKED_MESSAGE,
};

export function staleNotice(message: string, reloaded: boolean): string {
  return reloaded ? message : (NOT_RELOADED[message] ?? message);
}

/**
 * A card's line under its buttons. `clearAfter`: the count of list reloads
 * that worked when it was set; a later one that works takes it away (the
 * card then shows the post as it now is). Null: it stays.
 */
export interface CardLine {
  text: string;
  clearAfter: number | null;
}

/**
 * R31 client-journey L1 (lead review): the card's line for a refused decision,
 * shown at once, and whether to reload the list. A post changed since the page
 * loaded gets the sentence that is true before the reload answers; the reload
 * runs in the background, so a stalled one never keeps the buttons spinning.
 */
export function cardRefusalStart(
  outcome: { kind: string; message: string },
  reloads: number,
): { line: CardLine; reload: boolean } {
  if (outcome.kind !== "changed") return { line: { text: outcome.message, clearAfter: null }, reload: false };
  return { line: { text: staleNotice(outcome.message, false), clearAfter: reloads }, reload: true };
}

/**
 * Once the reload answered (`reloaded`: its number among the reloads that
 * worked, or null when it failed): it worked, so the new version is on the
 * card; it failed, so the line stays as it is and the refresh alert above the
 * list gives the reload step, once. R33 client-journey L3: the locked line
 * goes with the next reload that works, so a post listed again never shows it
 * over working buttons.
 */
export function cardLineAfterReload(line: CardLine, message: string, reloaded: number | null): CardLine {
  if (reloaded === null) return line;
  return { text: message, clearAfter: keepsCard(message) ? reloaded : null };
}

/** R32 lead review: on a kept card whose post the reloaded list no longer has. */
export const REVIEW_POST_GONE_MESSAGE = "This post can no longer be changed here: it was published, cancelled or moved.";

/**
 * The cards to show: the list as loaded, plus each kept card (one whose
 * refusal reloaded the list) that the list no longer has, marked gone, in
 * time order (no time last), so its typed note, line and focus stay.
 */
export function cardsShown(posts: ReviewPostDTO[], kept: ReviewPostDTO[]): { post: ReviewPostDTO; gone: boolean }[] {
  const listed = new Set(posts.map((post) => post.id));
  const at = (post: ReviewPostDTO) => (post.scheduledFor ? Date.parse(post.scheduledFor) : Number.POSITIVE_INFINITY);
  const cards = posts.map((post) => ({ post, gone: false }));
  for (const post of kept) {
    if (listed.has(post.id)) continue;
    const index = cards.findIndex((card) => at(card.post) > at(post));
    cards.splice(index === -1 ? cards.length : index, 0, { post, gone: true });
  }
  return cards;
}

/**
 * R32 lead's second review: only a post that can no longer be changed here
 * keeps its card; a changed one is still on the list.
 */
export function keepsCard(message: string): boolean {
  return message === REVIEW_POST_LOCKED_RELOADED_MESSAGE;
}

/** After a reload: a kept card whose post is listed again is let go, so it can't come back later. */
export function keptAfterReload(kept: ReviewPostDTO[], listed: ReviewPostDTO[]): ReviewPostDTO[] {
  const ids = new Set(listed.map((post) => post.id));
  const next = kept.filter((post) => !ids.has(post.id));
  return next.length === kept.length ? kept : next;
}

/**
 * R33 pages L6b: a gone card's line takes focus only when the reload its own
 * press started (number `ownReload`) is the one that dropped it, never another
 * card's later reload.
 */
export function goneLineTakesFocus(gone: boolean, ownReload: number | null, reloads: number): boolean {
  return gone && ownReload !== null && ownReload === reloads;
}

/** Where Dismiss sends focus: the next card, else the page's heading (read at the press). */
export function dismissFocusTarget(
  card: Element | null,
  doc: Pick<Document, "querySelector">,
): HTMLElement | null {
  return (card?.nextElementSibling as HTMLElement | null) ?? doc.querySelector<HTMLElement>("main h1");
}

/** The line as shown, given the count of list reloads that worked. */
export function shownCardLine(line: CardLine | null, reloads: number): string | null {
  if (!line) return null;
  if (line.clearAfter !== null && reloads > line.clearAfter) return null;
  return line.text;
}

/** A decision limit in force: its sentence, and when it ends by itself (ms), if the page can tell. */
export interface DecisionLimit {
  sentence: string;
  endsAfterMs: number | null;
}

/** On the pressed card once the hourly wait has ended and the decisions are back. */
export const DECISIONS_BACK_MESSAGE = "You can send again.";

/**
 * R41: a decision's 429 from either limit (the network's hour, the link's
 * day) refuses every press until it ends, so every decision is turned off and
 * the sentence, worded from the wait, says why. R41 review: the hourly one
 * ends within the hour, so the page turns the decisions back on by itself and
 * names no reload (which would empty a typed note). Null otherwise.
 */
function decisionLimit(response: Response, data: unknown): DecisionLimit | null {
  if (response.status !== 429) return null;
  const error = (data as { error?: unknown } | null)?.error;
  const wait = limitWaitSeconds(response, data);
  if (error === REVIEW_LINK_IP_LIMIT_MESSAGE) {
    return { sentence: sendAgainSentence(wait), endsAfterMs: (wait ?? CLIENT_LINK_LIMIT_WINDOW_SECONDS) * 1000 };
  }
  if (error === REVIEW_LINK_DAILY_LIMIT_MESSAGE) return { sentence: dailyLimitSentence(wait), endsAfterMs: null };
  return null;
}

/**
 * R41 review: nothing typed is lost. A card's change note is kept for this
 * tab, by link and post, so a reload (the daily limit's step) brings it back;
 * a send that went clears it. A convenience: without storage it lives in the
 * card only.
 */
function noteKey(token: string, postId: string): string {
  return `vs-review-note:${token}:${postId}`;
}

export function keptNote(token: string, postId: string): string {
  try {
    return window.sessionStorage.getItem(noteKey(token, postId)) ?? "";
  } catch {
    return "";
  }
}

export function keepNote(token: string, postId: string, note: string): void {
  try {
    if (note) window.sessionStorage.setItem(noteKey(token, postId), note);
    else window.sessionStorage.removeItem(noteKey(token, postId));
  } catch {
    // Private mode or blocked storage: the note stays in the card.
  }
}

/** The route's `already`: this request wrote nothing, as an earlier one had. */
export function alreadyStood(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && (data as { already?: unknown }).already === true);
}

/** Shown when the first load failed. */
const LOAD_FAILED_MESSAGE = "Couldn't load the posts. Check your connection and try again.";

/** R7-client-journey L5: under the list when it holds the first 100 of more. */
export const REVIEW_MORE_SENTENCE = `Showing the next ${REVIEW_LIST_MAX} scheduled posts; more appear as these go out.`;

/** The sentence, when the server says cards were left out (server/reviewLink.ts listReviewPosts). */
export function ReviewListMore({ more }: { more: boolean }) {
  return more ? <p className="text-sm text-muted-foreground">{REVIEW_MORE_SENTENCE}</p> : null;
}

/**
 * The client's side of a review link (2026-11-10): the upcoming posts, each
 * with "Looks good" and "Ask for a change". Times are formatted here, in the
 * viewer's own time zone, which the server does not know.
 */

function formatWhen(iso: string | null): string {
  if (!iso) return "No time set";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function PostMedia({ post }: { post: ReviewPostDTO }) {
  if (!post.media) return null;
  return (
    <div className="relative overflow-hidden bg-muted">
      {post.media.mimeType.startsWith("video/") ? (
        <video
          src={post.media.url}
          controls
          playsInline
          preload="metadata"
          className="max-h-[28rem] w-full bg-black object-contain"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- the post's already-public storage address, as media-thumb.tsx
        <img src={post.media.url} alt="" className="max-h-[28rem] w-full object-contain" />
      )}
      {post.mediaCount > 1 ? (
        <span className="absolute right-2 top-2 rounded-full bg-slate-950/75 px-2 py-0.5 text-xs font-medium text-white">
          {post.mediaCount} photos
        </span>
      ) : null}
    </div>
  );
}

/** Under the note box: what a change request holds back (F6: a pair's Story too). */
export function changeNoteHint(post: ReviewPostDTO): string {
  return post.alsoStory
    ? "This post and its Story will not go out until they are scheduled again."
    : "This post will not go out until it is scheduled again.";
}

function stateText(post: ReviewPostDTO): string | null {
  if (post.state === "approved") return "You approved this";
  if (post.state === "change_requested") return "Change requested";
  return null;
}

export function ReviewPostCard({
  post,
  token,
  onDecided,
  onStale,
  reloads,
  gone = false,
  onDismiss,
  limited = false,
  limitLine = null,
  onLimited,
  onPress,
}: {
  post: ReviewPostDTO;
  token: string;
  /** Saved: update this card from the answer (state, new version, stored note). */
  onDecided: (patch: Partial<ReviewPostDTO>) => void;
  /**
   * The post changed since the page loaded: show why above the list and reload
   * it; the reload's number when it worked, else null. `keep`: the card to
   * keep, shown gone, if the reloaded list no longer has it.
   */
  onStale: (message: string, keep?: ReviewPostDTO) => Promise<number | null>;
  /** How many list reloads have worked (shownCardLine). */
  reloads: number;
  /** R32 lead review: kept after the reloaded list dropped its post (cardsShown). */
  gone?: boolean;
  /** Removes a gone card. */
  onDismiss?: () => void;
  /**
   * R41 client-journey L2: a decision hit a limit that every card shares, so
   * no decision can work until it ends.
   */
  limited?: boolean;
  /** R41 review: the limit's line on the card whose press hit it (then the decisions-back line). */
  limitLine?: string | null;
  /** This card's decision hit a limit. */
  onLimited?: (limit: DecisionLimit) => void;
  /** A decision starts, so a decisions-back line has served its turn. */
  onPress?: () => void;
}) {
  const [asking, setAsking] = useState(false);
  // R41 review: a note kept for this tab comes back after a reload.
  const [note, setNote] = useState(() => keptNote(token, post.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CardLine | null>(null);
  const shownError = gone ? REVIEW_POST_GONE_MESSAGE : (limitLine ?? shownCardLine(error, reloads));
  const lineRef = useRef<HTMLParagraphElement>(null);
  // The number of the reload this card's own refusal started, once it worked.
  const [ownReload, setOwnReload] = useState<number | null>(null);
  // The card the person acted on just lost its post: the line says why, and takes focus.
  const focusLine = goneLineTakesFocus(gone, ownReload, reloads);
  useEffect(() => {
    if (focusLine) lineRef.current?.focus();
  }, [focusLine]);
  const stateRef = useRef<HTMLParagraphElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const state = stateText(post);
  // R30 lead review: one card of many, so only a change of its state is read out.
  useAnnounceOnShow(() => state ?? "", true, false);
  // Whole characters, as the server counts them (an emoji is one, not two).
  const noteLength = Array.from(note.trim()).length;
  const noteTooShort = noteLength === 0;
  const noteTooLong = noteLength > REVIEW_NOTE_MAX;

  /** `pressed`: the button the decision came from, which the answer disables or removes. */
  async function decide(
    body: { decision: "approve"; version: string } | { decision: "change"; note: string },
    pressed: HTMLElement | null,
  ) {
    setBusy(true);
    setError(null);
    onPress?.();
    try {
      const response = await fetchOrNoAnswer(
        `/api/review-link/${encodeURIComponent(token)}/posts/${encodeURIComponent(post.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data: unknown = await response.json().catch(() => null);
      const limit = decisionLimit(response, data);
      if (limit) {
        // The one limit view: the wait, and no decision left to press on any card.
        focusAfterPress(pressed, () => lineRef.current);
        onLimited?.(limit);
        return;
      }
      const outcome = reviewDecisionOutcome(response.status, data);
      if (outcome.kind === "saved") {
        focusAfterPress(pressed, () => stateRef.current);
        setAsking(false);
        // R41 second look: any decision that went settles the post, so its kept note goes too.
        keepNote(token, post.id, "");
        setNote("");
        onDecided(outcome.patch);
        // A change request that already stood: the post may have been edited since, so reload.
        if (alreadyStood(data)) onStale(REVIEW_CHANGE_ALREADY_SAVED_MESSAGE);
        return;
      }
      if (outcome.kind === "stands") {
        // Already approved: reload, so the card shows the text that was approved.
        setAsking(false);
        onStale(outcome.message);
        return;
      }
      // A refused decision always says why on its own card, at once.
      const start = cardRefusalStart(outcome, reloads);
      setError(start.line);
      if (start.reload) {
        void onStale(outcome.message, keepsCard(outcome.message) ? post : undefined).then((reloaded) => {
          if (reloaded !== null) setOwnReload(reloaded);
          setError((current) => (current === start.line ? cardLineAfterReload(start.line, outcome.message, reloaded) : current));
        });
      }
    } catch (error) {
      setError({
        text: isNoAnswer(error) ? REVIEW_DECISION_MAYBE_SAVED_MESSAGE : "Couldn't save that. Reload the page and try again.",
        clearAfter: null,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="overflow-hidden rounded-[var(--radius)] border border-border bg-card text-card-foreground shadow-sm">
      <PostMedia post={post} />
      <div className="space-y-3 p-4 sm:p-5">
        <div>
          <p className="text-sm font-medium">
            {/* R5-pages L6: a change request holds the post back, so its old time would mislead. */}
            {post.state === "change_requested" ? (
              "Not scheduled: waiting for your changes"
            ) : post.scheduledFor ? (
              <time dateTime={post.scheduledFor}>{formatWhen(post.scheduledFor)}</time>
            ) : (
              formatWhen(null)
            )}
          </p>
          {post.platforms.length > 0 ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{post.platforms.join(", ")}</p>
          ) : null}
          {post.alsoStory ? <p className="mt-0.5 text-sm text-muted-foreground">{post.alsoStory}</p> : null}
        </div>
        <p className="whitespace-pre-wrap break-words text-sm">{post.caption}</p>
        {post.platformCaptions.length > 0 ? (
          <ul className="space-y-2 rounded-[var(--radius)] border border-border bg-muted/40 p-3">
            {post.platformCaptions.map((entry) => (
              <li key={entry.label} className="whitespace-pre-wrap break-words text-sm">
                <span className="block text-xs font-medium text-muted-foreground">On {entry.label}</span>
                {entry.text}
              </li>
            ))}
          </ul>
        ) : null}

        {/* R27 MM3: a decision's new state is announced (useAnnounceOnShow above). */}
        {/* Visually hidden while empty, so it takes no room. */}
        <div className="empty:sr-only">
          {state ? (
            <p
              ref={stateRef}
              className={
                post.state === "approved"
                  ? "inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-sm font-medium text-emerald-700 dark:text-emerald-400"
                  : "inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-sm font-medium text-amber-700 dark:text-amber-400"
              }
            >
              <span aria-hidden>{post.state === "approved" ? "✓" : "✎"}</span>
              {state}
            </p>
          ) : null}
        </div>
        {post.state === "change_requested" && post.note ? (
          <p className="whitespace-pre-wrap break-words rounded-[var(--radius)] bg-muted/60 p-3 text-sm">
            {post.note}
          </p>
        ) : null}

        {post.state !== "change_requested" ? (
          asking ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (noteTooShort || noteTooLong) return;
                void decide({ decision: "change", note }, sendRef.current);
              }}
            >
              <Label htmlFor={`note-${post.id}`}>What would you like changed?</Label>
              <Textarea
                ref={noteRef}
                id={`note-${post.id}`}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                  keepNote(token, post.id, event.target.value);
                }}
                rows={3}
                required
                aria-invalid={noteTooLong || undefined}
                disabled={busy}
                // A gone card keeps the note to read and copy.
                readOnly={gone}
              />
              <p className={noteTooLong ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                {noteLength}/{REVIEW_NOTE_MAX}. {changeNoteHint(post)}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button ref={sendRef} type="submit" size="lg" className="w-full sm:w-auto" loading={busy} disabled={gone || limited || noteTooShort || noteTooLong}>
                  Send
                </Button>
                <Button
                  type="button"
                  size="lg"
                  className="w-full sm:w-auto"
                  variant="ghost"
                  disabled={gone || busy}
                  onClick={(event) => {
                    focusAfterPress(event.currentTarget, () => askRef.current);
                    setAsking(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                size="lg"
                className="w-full sm:w-auto"
                loading={busy}
                disabled={gone || limited || post.state === "approved"}
                onClick={(event) => void decide({ decision: "approve", version: post.version }, event.currentTarget)}
              >
                Looks good
              </Button>
              <Button
                type="button"
                size="lg"
                className="w-full sm:w-auto"
                variant="outline"
                ref={askRef}
                // R41 review: under a limit, a typed note can still be opened, to read and keep.
                disabled={gone || busy || (limited && noteTooShort)}
                onClick={(event) => {
                  // R27 MM3: the buttons are replaced by the form; focus goes to its note box.
                  focusAfterPress(event.currentTarget, () => noteRef.current);
                  setAsking(true);
                }}
              >
                Ask for a change
              </Button>
            </div>
          )
        ) : null}

        {shownError ? (
          <p ref={lineRef} role="alert" tabIndex={-1} className="text-sm text-destructive outline-none">
            {shownError}
          </p>
        ) : null}
        {gone ? (
          <Button
            type="button"
            variant="outline"
            size="md"
            onClick={(event) => {
              const pressed = event.currentTarget;
              const target = dismissFocusTarget(pressed.closest("li"), document);
              focusAfterPress(pressed, () => target);
              onDismiss?.();
            }}
          >
            Dismiss
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function ReviewLinkView({ token }: { token: string }) {
  const [posts, setPosts] = useState<ReviewPostDTO[] | null>(null);
  const [more, setMore] = useState(false);
  // A failed load: the server's sentence, or "" for no answer (network).
  const [error, setError] = useState<string | null>(null);
  // R40 client-journey L2: the error is the network limit's, which a press can't clear.
  const [limited, setLimited] = useState(false);
  // R41 client-journey L2 and its review: a card's decision hit a limit every
  // card shares. `cardId`: the card that pressed (null: a list reload was
  // refused, R42); `ended`: the hourly wait is over and the decisions are back on.
  const [decisionLimitShown, setDecisionLimitShown] = useState<
    (DecisionLimit & { cardId: string | null; ended: boolean }) | null
  >(null);
  const limitEndsAfterMs = decisionLimitShown && !decisionLimitShown.ended ? decisionLimitShown.endsAfterMs : null;
  useEffect(() => {
    if (limitEndsAfterMs === null) return;
    // At the wait the answer named, so never later than the rounded minutes the sentence says.
    const timer = window.setTimeout(
      () => setDecisionLimitShown((current) => (current ? { ...current, ended: true } : current)),
      limitEndsAfterMs,
    );
    return () => window.clearTimeout(timer);
  }, [limitEndsAfterMs, decisionLimitShown]);
  const decisionsLimited = decisionLimitShown !== null && !decisionLimitShown.ended;
  // R42 review: a limit no card pressed for (a refused list reload) is read
  // out by the page's own line, the one live region that carries it; when it
  // ends, that line says the decisions are back. A card's limit is read out by
  // the card, and the page line stays plain.
  const pageOwnsLimit = decisionLimitShown !== null && decisionLimitShown.cardId === null;
  const pageLimitText = pageOwnsLimit ? (decisionLimitShown.ended ? DECISIONS_BACK_MESSAGE : decisionLimitShown.sentence) : "";
  const pageLimitRef = useRef<HTMLParagraphElement>(null);
  const pageLimitShownRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        const line = pageLimitRef.current;
        return line && (line.textContent ?? "") !== "" ? line : null;
      },
    }),
    [],
  );
  const pageLimitStarts = pageOwnsLimit && decisionsLimited ? decisionLimitShown.sentence : null;
  useEffect(() => {
    if (pageLimitStarts === null) return;
    // The pressed button is now off, so focus would drop to the page body.
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || active.hasAttribute("disabled") || !active.isConnected) {
      if (pageLimitRef.current) focusFirstOf([pageLimitRef.current]);
    }
  }, [pageLimitStarts]);
  // Why the list was just reloaded (a post changed, or left the schedule).
  const [notice, setNotice] = useState<string | null>(null);
  // List reloads that worked; a card's line set before one can go (shownCardLine).
  const [reloads, setReloads] = useState(0);
  // R32 lead review: cards whose refusal reloaded the list; shown gone if it dropped them.
  const [kept, setKept] = useState<ReviewPostDTO[]>([]);
  // Numbers each reload that worked, so a card can tell its own from another's.
  const reloadCount = useRef(0);
  // Whether a list is on screen (set once one loads; the list never goes away).
  const listShown = useRef(false);

  /** The reload's number when the list was read again, else null. */
  const load = useCallback(async (): Promise<number | null> => {
    // R13-pages L2: Try again shows Loading (no posts yet) instead of the same failure.
    setError(null);
    setLimited(false);
    try {
      const response = await fetch(`/api/review-link/${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => null)) as
        | { posts?: ReviewPostDTO[]; more?: boolean; error?: string }
        | null;
      if (response.status === 429) {
        const wait = limitWaitSeconds(response, data);
        if (listShown.current) {
          // R42 client-journey L1: the list shares the network's hourly limit
          // with the decisions, so they would be refused too. They go off, and
          // one instruction, which lifts by itself, covers the whole page.
          // A limit already in force (a card's, or the day's) stands.
          setDecisionLimitShown((current) =>
            current && !current.ended
              ? current
              : {
                  sentence: sendAgainSentence(wait),
                  endsAfterMs: (wait ?? CLIENT_LINK_LIMIT_WINDOW_SECONDS) * 1000,
                  cardId: null,
                  ended: false,
                },
          );
          return null;
        }
        setLimited(true);
        setError(limitReachedSentence(wait));
        return null;
      }
      if (!response.ok || !data?.posts) {
        setError(data?.error ?? "");
        return null;
      }
      // R32 lead's second review: a kept card whose post is listed again is let go.
      const listed = data.posts;
      setKept((current) => keptAfterReload(current, listed));
      setPosts(data.posts);
      setMore(data.more === true);
      const count = ++reloadCount.current;
      setReloads(count);
      listShown.current = true;
      return count;
    } catch {
      setError("");
      return null;
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-mount, as queue-view.tsx
    void load();
  }, [load]);

  // The answer says what the card needs; no list reload that could fail and
  // hide a saved decision.
  const patch = useCallback((id: string, change: Partial<ReviewPostDTO>) => {
    setPosts((prev) => (prev ? prev.map((p) => (p.id === id ? { ...p, ...change } : p)) : prev));
  }, []);

  const stale = useCallback(
    (message: string, keep?: ReviewPostDTO) => {
      // Kept before the reload, so the card is never unmounted between the two renders.
      if (keep) setKept((current) => [...current.filter((p) => p.id !== keep.id), keep]);
      return load().then((reloaded) => {
        setNotice(staleNotice(message, reloaded !== null));
        return reloaded;
      });
    },
    [load],
  );
  const cards = posts === null ? [] : cardsShown(posts, kept);

  // R39 lead review: Try again and Reload the list go with the failure, so
  // focus goes to the loading line while the list is read, then to what it shows.
  const [retrying, setRetrying] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const failedRef = useRef<HTMLParagraphElement>(null);
  const refreshFailedRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  const retried = useRetryFocus(retrying, statusRef, [failedRef, refreshFailedRef, pageLimitShownRef, listRef, emptyRef]);
  const retry = () => {
    retried();
    setRetrying(true);
    void load().finally(() => setRetrying(false));
  };

  // R30 PP2: one return, so both status lines are on the page from the first
  // render and only their text changes.
  return (
    <div>
      <p ref={statusRef} role="status" className="text-sm text-muted-foreground outline-none empty:sr-only">
        {(posts === null && error === null) || retrying ? "Loading the posts…" : ""}
      </p>
      {error !== null && posts === null ? (
        <div className="space-y-3">
          <p ref={failedRef} role="alert" className="text-sm outline-none">
            {error || LOAD_FAILED_MESSAGE}
          </p>
          {limited ? null : (
            <Button type="button" variant="outline" size="md" onClick={retry}>
              Try again
            </Button>
          )}
        </div>
      ) : null}
      <div className="space-y-4">
        {posts !== null && error !== null ? (
          // A failed reload while the list is on screen: say so, and how to recover.
          <div
            ref={refreshFailedRef}
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-border bg-muted/60 p-3 outline-none"
          >
            <p className="text-sm">{error || REFRESH_FAILED_MESSAGE}</p>
            {limited ? null : (
              <Button type="button" variant="outline" size="md" onClick={retry}>
                Reload the list
              </Button>
            )}
          </div>
        ) : null}
        {/* R29 client-journey L5: on the list from its first render; only the text changes. */}
        <p role="status" className="empty:sr-only rounded-[var(--radius)] border border-border bg-muted/60 p-3 text-sm">
          {notice}
        </p>
        {/* R41 review: why every card's decisions are off, in sight of each. Plain, not live (second
            look): the pressed card's line is the one read out and focused. */}
        {decisionsLimited && !pageOwnsLimit ? (
          <p className="rounded-[var(--radius)] border border-border bg-muted/60 p-3 text-sm">{decisionLimitShown.sentence}</p>
        ) : null}
        {/* R42 review: on the page from its first render; only the text changes. */}
        <p
          ref={pageLimitRef}
          role="status"
          className="empty:sr-only rounded-[var(--radius)] border border-border bg-muted/60 p-3 text-sm outline-none"
        >
          {pageLimitText}
        </p>
        {posts === null ? null : cards.length === 0 ? (
          <p ref={emptyRef} className="text-sm text-muted-foreground outline-none">
            Nothing is scheduled for the next 60 days.
          </p>
        ) : (
          <ul ref={listRef} className="space-y-4 outline-none">
            {cards.map(({ post, gone }) => (
              // Keyed on the id only, so a card keeps its sentence across a reload.
              <ReviewPostCard
                key={post.id}
                post={post}
                token={token}
                onDecided={(change) => patch(post.id, change)}
                onStale={stale}
                reloads={reloads}
                gone={gone}
                onDismiss={() => setKept((current) => current.filter((p) => p.id !== post.id))}
                limited={decisionsLimited}
                limitLine={
                  decisionLimitShown?.cardId === post.id
                    ? decisionLimitShown.ended
                      ? DECISIONS_BACK_MESSAGE
                      : decisionLimitShown.sentence
                    : null
                }
                onLimited={(limit) => setDecisionLimitShown({ ...limit, cardId: post.id, ended: false })}
                onPress={() => setDecisionLimitShown((current) => (current?.ended ? null : current))}
              />
            ))}
          </ul>
        )}
        <ReviewListMore more={more} />
      </div>
    </div>
  );
}
