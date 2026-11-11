"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { REVIEW_NOTE_MAX, type ReviewPostDTO } from "@/lib/reviewLink";

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
    <div className="relative overflow-hidden rounded-[var(--radius)] border border-border bg-muted">
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

function stateText(post: ReviewPostDTO): string | null {
  if (post.state === "approved") return "You approved this";
  if (post.state === "change_requested") return "Change requested";
  return null;
}

function ReviewPostCard({
  post,
  token,
  onDecided,
  onStale,
}: {
  post: ReviewPostDTO;
  token: string;
  /** Saved: take the new list (an approval changes the post's version). */
  onDecided: () => Promise<void>;
  /** 409: the post changed or left the schedule. Show why above the list and reload it. */
  onStale: (message: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = stateText(post);
  // Whole characters, as the server counts them (an emoji is one, not two).
  const noteLength = Array.from(note.trim()).length;
  const noteTooShort = noteLength === 0;
  const noteTooLong = noteLength > REVIEW_NOTE_MAX;

  async function decide(
    body: { decision: "approve"; version: string } | { decision: "change"; note: string },
  ) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/review-link/${encodeURIComponent(token)}/posts/${encodeURIComponent(post.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (response.status === 409) {
        onStale(data?.error ?? "This post can no longer be changed here.");
        return;
      }
      if (!response.ok) {
        setError(data?.error ?? "Couldn't save that. Try again.");
        return;
      }
      setAsking(false);
      await onDecided();
    } catch {
      setError("Couldn't save that. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-[var(--radius)] border border-border bg-card p-4 text-card-foreground sm:p-5">
      <div className="space-y-3">
        <PostMedia post={post} />
        <div>
          <p className="text-sm font-medium">
            {post.scheduledFor ? <time dateTime={post.scheduledFor}>{formatWhen(post.scheduledFor)}</time> : formatWhen(null)}
          </p>
          {post.platforms.length > 0 ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{post.platforms.join(", ")}</p>
          ) : null}
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

        {state ? <p className="text-sm font-medium">{state}</p> : null}
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
                void decide({ decision: "change", note });
              }}
            >
              <Label htmlFor={`note-${post.id}`}>What would you like changed?</Label>
              <Textarea
                id={`note-${post.id}`}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                required
                aria-invalid={noteTooLong || undefined}
                disabled={busy}
              />
              <p className={noteTooLong ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                {noteLength}/{REVIEW_NOTE_MAX}. This post will not go out until it is scheduled again.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={busy} disabled={noteTooShort || noteTooLong}>
                  Send
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                loading={busy}
                disabled={post.state === "approved"}
                onClick={() => void decide({ decision: "approve", version: post.version })}
              >
                Looks good
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setAsking(true)}>
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
  const [error, setError] = useState<string | null>(null);
  // Why the list was just reloaded (a post changed, or left the schedule).
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/review-link/${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => null)) as
        | { posts?: ReviewPostDTO[]; error?: string }
        | null;
      if (!response.ok || !data?.posts) {
        setError(data?.error ?? "Couldn't load the posts. Try again.");
        return;
      }
      setError(null);
      setPosts(data.posts);
    } catch {
      setError("Couldn't load the posts. Check your connection and try again.");
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-mount, as queue-view.tsx
    void load();
  }, [load]);

  const afterDecision = useCallback(async () => {
    setNotice(null);
    await load();
  }, [load]);

  const stale = useCallback(
    (message: string) => {
      setNotice(message);
      void load();
    },
    [load],
  );

  if (error && posts === null) {
    return (
      <div className="space-y-3">
        <p className="text-sm">{error}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }
  if (posts === null) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading the posts…
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {notice ? (
        <p role="status" className="rounded-[var(--radius)] border border-border bg-muted/60 p-3 text-sm">
          {notice}
        </p>
      ) : null}
      {posts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is scheduled for the next 60 days.</p>
      ) : (
        <ul className="space-y-4">
          {posts.map((post) => (
            // Keyed on the version too: a changed post gets a fresh card.
            <ReviewPostCard
              key={`${post.id}:${post.version}`}
              post={post}
              token={token}
              onDecided={afterDecision}
              onStale={stale}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
