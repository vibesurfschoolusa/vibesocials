"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAnnounceOnShow } from "@/components/ui/announcer";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { focusAfterPress } from "@/lib/focusAfter";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";
import {
  REVIEW_ALREADY_APPROVED_MESSAGE,
  REVIEW_LIST_MAX,
  REVIEW_DECISION_MAYBE_SAVED_MESSAGE,
  REVIEW_POST_CHANGED_MESSAGE,
  REVIEW_NOTE_MAX,
  reviewDecisionOutcome,
} from "@/lib/reviewLink";
// Types only (erased): the card a Feed and Story post folds into (F6).
import type { ReviewCardDTO as ReviewPostDTO } from "@/server/reviewLink";

/** Shown over a list on screen when reloading it failed. */
const REFRESH_FAILED_MESSAGE = "Couldn't refresh the list. Check your connection and reload the page.";
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
};

/**
 * R31 client-journey L1: the card's sentence when the reload failed. The old
 * version is still on the card, so the step is a reload; the notice above the
 * list leaves that step to the refresh alert, so it is said once.
 */
const CARD_CHANGED_NOT_RELOADED = "This post may have changed. Reload the page to see it.";

export function staleNotice(message: string, reloaded: boolean): string {
  return reloaded ? message : (NOT_RELOADED[message] ?? message);
}

/**
 * The card's sentence for a refused decision. A post changed since the page
 * loaded reloads the list first, and the sentence follows that reload's
 * result (R31 client-journey L1).
 */
export async function cardRefusal(
  outcome: { kind: string; message: string },
  onStale: (message: string) => Promise<boolean>,
): Promise<string> {
  if (outcome.kind !== "changed") return outcome.message;
  return (await onStale(outcome.message)) ? outcome.message : CARD_CHANGED_NOT_RELOADED;
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
}: {
  post: ReviewPostDTO;
  token: string;
  /** Saved: update this card from the answer (state, new version, stored note). */
  onDecided: (patch: Partial<ReviewPostDTO>) => void;
  /** The post changed since the page loaded: show why above the list and reload it; true when it reloaded. */
  onStale: (message: string) => Promise<boolean>;
}) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      const outcome = reviewDecisionOutcome(response.status, data);
      if (outcome.kind === "saved") {
        focusAfterPress(pressed, () => stateRef.current);
        setAsking(false);
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
      // A refused decision always says why on its own card.
      setError(await cardRefusal(outcome, onStale));
    } catch (error) {
      setError(isNoAnswer(error) ? REVIEW_DECISION_MAYBE_SAVED_MESSAGE : "Couldn't save that. Reload the page and try again.");
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
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                required
                aria-invalid={noteTooLong || undefined}
                disabled={busy}
              />
              <p className={noteTooLong ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                {noteLength}/{REVIEW_NOTE_MAX}. {changeNoteHint(post)}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button ref={sendRef} type="submit" size="lg" className="w-full sm:w-auto" loading={busy} disabled={noteTooShort || noteTooLong}>
                  Send
                </Button>
                <Button
                  type="button"
                  size="lg"
                  className="w-full sm:w-auto"
                  variant="ghost"
                  disabled={busy}
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
                disabled={post.state === "approved"}
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
                disabled={busy}
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

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
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
  // Why the list was just reloaded (a post changed, or left the schedule).
  const [notice, setNotice] = useState<string | null>(null);

  /** True when the list was read again. */
  const load = useCallback(async (): Promise<boolean> => {
    // R13-pages L2: Try again shows Loading (no posts yet) instead of the same failure.
    setError(null);
    try {
      const response = await fetch(`/api/review-link/${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => null)) as
        | { posts?: ReviewPostDTO[]; more?: boolean; error?: string }
        | null;
      if (!response.ok || !data?.posts) {
        setError(data?.error ?? "");
        return false;
      }
      setPosts(data.posts);
      setMore(data.more === true);
      return true;
    } catch {
      setError("");
      return false;
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
    (message: string) =>
      load().then((reloaded) => {
        setNotice(staleNotice(message, reloaded));
        return reloaded;
      }),
    [load],
  );

  // R30 PP2: one return, so both status lines are on the page from the first
  // render and only their text changes.
  return (
    <div>
      <p role="status" className="text-sm text-muted-foreground empty:sr-only">
        {posts === null && error === null ? "Loading the posts…" : ""}
      </p>
      {error !== null && posts === null ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm">
            {error || LOAD_FAILED_MESSAGE}
          </p>
          <Button type="button" variant="outline" size="md" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}
      <div className="space-y-4">
        {posts !== null && error !== null ? (
          // A failed reload while the list is on screen: say so, and how to recover.
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-border bg-muted/60 p-3">
            <p className="text-sm">{error || REFRESH_FAILED_MESSAGE}</p>
            <Button type="button" variant="outline" size="md" onClick={() => void load()}>
              Reload the list
            </Button>
          </div>
        ) : null}
        {/* R29 client-journey L5: on the list from its first render; only the text changes. */}
        <p role="status" className="empty:sr-only rounded-[var(--radius)] border border-border bg-muted/60 p-3 text-sm">
          {notice}
        </p>
        {posts === null ? null : posts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is scheduled for the next 60 days.</p>
        ) : (
          <ul className="space-y-4">
            {posts.map((post) => (
              // Keyed on the id only, so a card keeps its sentence across a reload.
              <ReviewPostCard
                key={post.id}
                post={post}
                token={token}
                onDecided={(change) => patch(post.id, change)}
                onStale={stale}
              />
            ))}
          </ul>
        )}
        <ReviewListMore more={more} />
      </div>
    </div>
  );
}
