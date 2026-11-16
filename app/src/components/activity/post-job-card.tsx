"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { Platform, PostJobResultStatus, PostJobStatus } from "@prisma/client";

import { ExternalLink } from "@/components/external-link";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { MediaThumb } from "@/components/media-thumb";
import { cn } from "@/lib/cn";
import { PLATFORM_ORDER, platformLabel, SETTINGS_CONNECTIONS_HREF } from "@/lib/platforms";
import { platformPostUrl } from "@/lib/platformPostUrl";
import type { PostJobDTO } from "@/lib/postsDto";
import { PUBLISH_UNCONFIRMED_MESSAGE } from "@/lib/publishOutcomes";
import { dispatchFailedText } from "@/lib/composerSubmitOutcome";
import { sendActionRequest } from "@/lib/queueActions";
import { memberReconnectMessage, NOT_SENT_MESSAGE, sentenceForRecipient } from "@/lib/publishFailureText";
import { sendAgainTooOld, TOO_OLD_TO_SEND_MESSAGE } from "@/lib/sendAgain";
import { describeDeferral, selectDeferrals } from "@/lib/resultDeferral";
import { retryAllPlan, type LeftOut } from "@/lib/retryAll";
import { PlatformResultBadge } from "./platform-result";
import { DailyMetricStats, PostMetricStats } from "./post-metric-stats";

// Exhaustive over PostJobStatus — adding an enum member (Roadmap Phase 5 added
// draft/scheduled/cancelled) fails `tsc` here (TS2741) until it's listed, which
// is the intended tripwire the spec calls out.
const JOB_STATUS_META: Record<
  PostJobStatus,
  { variant: BadgeVariant; label: string }
> = {
  completed: { variant: "success", label: "Completed" },
  failed: { variant: "danger", label: "Failed" },
  in_progress: { variant: "warning", label: "In progress" },
  pending: { variant: "neutral", label: "Pending" },
  scheduled: { variant: "secondary", label: "Scheduled" },
  draft: { variant: "neutral", label: "Draft" },
  cancelled: { variant: "outline", label: "Cancelled" },
};

/** Shape of the retry endpoint's JSON error body (Roadmap Phase 3). */
interface RetryErrorBody {
  error?: string;
  code?: string;
  /** RECONNECT_REQUIRED: the first platform to reconnect. */
  platform?: Platform;
  /** R7 review: what Retry all failed left out, and why (on a 202 or a 409). */
  leftOut?: LeftOut[];
  /** On a 202: the sentence naming what was left out. */
  notice?: string;
}

/** "X", "X and YouTube", "X, YouTube and Instagram". */
function platformList(platforms: readonly Platform[]): string {
  const labels = platforms.map(platformLabel);
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** R7 review, points 1 and 2: what Retry all failed says once the server took it. */
export function retryAllToast(retrying: readonly Platform[], notice: string | undefined): string {
  return notice ? `Retrying ${platformList(retrying)}. ${notice}` : `Retrying ${platformList(retrying)}.`;
}

/** Who reads the card: only an owner can reconnect (R10-client-journey L1). */
export type ViewerRole = "owner" | "member";

/** A failure's stored sentence as the viewer should read it. */
export function failureSentence(result: Pick<PostJobDTO["results"][number], "errorMessage" | "platform">, role: ViewerRole): string | null {
  return sentenceForRecipient(result.errorMessage, result.platform, role);
}

/** What a retry refused for reconnecting says: the server words it for the viewer; this is the fallback. */
export function reconnectRefusalToast(
  role: ViewerRole,
  dead: readonly Platform[],
  label: string,
  serverError: string | undefined,
): string {
  if (serverError) return serverError;
  const which = dead.length > 0 ? platformList(dead) : label;
  return role === "member"
    ? `The workspace owner can reconnect ${which}; then retry.`
    : `Reconnect ${which} in Settings before retrying.`;
}

/** In place of a failed platform's Retry once the server said it needs reconnecting. */
export function ReconnectStep({ platform, role }: { platform: Platform; role: ViewerRole }) {
  const className =
    "inline-flex items-center gap-1 rounded-[var(--radius)] border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs text-foreground";
  if (role === "member") return <span className={className}>{memberReconnectMessage(platform)}</span>;
  return (
    <span className={className}>
      Reconnect {platformLabel(platform)} in{" "}
      <Link
        href={SETTINGS_CONNECTIONS_HREF}
        className="font-medium text-primary underline underline-offset-2 hover:no-underline"
      >
        Settings
      </Link>
    </span>
  );
}

/** One platform, or (R7-security L1) every failed platform of the post in one request. */
export type RetryTarget = Platform | "all";

/** The retry route's body for a target. */
export function retryRequestBody(target: RetryTarget): { platform: Platform } | { retryAllFailed: true } {
  return target === "all" ? { retryAllFailed: true } : { platform: target };
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A deferral's wake-up instant in the viewer's locale: "Nov 2, 12:05 AM". */
function formatDeferralTime(date: Date): string {
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function orderResults(results: PostJobDTO["results"]): PostJobDTO["results"] {
  return [...results].sort(
    (a, b) =>
      PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform),
  );
}

/**
 * A single post job: caption preview, timestamp, overall status, and per-platform
 * result pills. Sanitized failure messages are collapsed behind a toggle.
 *
 * Roadmap Phase 3: each failed platform gets a Retry button that re-publishes
 * just that platform (`POST /api/posts/[id]/retry`). The result is optimistically
 * shown as pending; a `RECONNECT_REQUIRED` response swaps the button for a
 * "Reconnect … in Settings" link.
 *
 * Team Workspaces (Task 7) — `showAttribution` (default off, so existing
 * single-member callers are unchanged) shows `by {createdBy.name}` next to
 * the timestamp when the job carries a creator. Callers gate this on
 * `workspaceMemberCount > 1` (design doc §7) before passing it down.
 *
 * 2026-11-01 audit — `onRetryAccepted` is called once the server has accepted a
 * retry request. The owner of the job list (`usePostJobs().watchRetry`) then
 * refetches and polls until the job settles; the optimistic "Retrying…" state
 * below is replaced by that server data (it is reset whenever a fresh `job`
 * arrives), so it can no longer outlive the retry.
 */
/**
 * A post without a file (2026-11-10): the list says so with no media and no
 * files. A post whose file row is gone still counts one, so it is not one.
 */
/**
 * The card's time line. A post that was scheduled always reads "Scheduled for
 * <time>", next to whatever its badge says (waiting, completed, failed,
 * retried or cancelled), never just its creation time, which could be days
 * earlier. Drafts and posts published straight away show when they were made.
 */
export function cardTime(job: {
  status: string;
  createdAt: string | null;
  scheduledFor: string | null;
}): { label: "Scheduled for" | null; iso: string } | null {
  if (job.scheduledFor && job.status !== "draft") return { label: "Scheduled for", iso: job.scheduledFor };
  return job.createdAt ? { label: null, iso: job.createdAt } : null;
}

/** What Send again says when the server refused without a sentence. */
export const SEND_AGAIN_FAILED = "Couldn't send this post again. Please try again.";
/** R27 publishing-flow L1: offline, so the request never left. */
export const SEND_AGAIN_NOT_SENT =
  "We couldn't reach Vibe Socials, so the post wasn't sent. Check your connection and press Send again.";
/** R27 publishing-flow L1: no answer, or a gateway's page; the server may have taken it. */
export const SEND_AGAIN_NO_ANSWER =
  "We didn't get an answer, so the post may have started sending. Wait for this card to update and check it before you press Send again.";

/**
 * The answer to one press of Send again; `null` when a press is already under
 * way or done. `refetch`: the post may have changed, so the list is read again.
 */
export type SendAgainOutcome = { ok: true } | { ok: false; error: string; refetch?: true } | null;

/**
 * F1 follow-up: Send again on a failed post that no platform was tried for
 * (no results; the publish route accepts exactly that). A press while one is
 * in flight, or after the server took the post, does nothing, so a double
 * press can never send it twice; a refusal lets the user press again.
 * R27 publishing-flow L1: a DISPATCH_FAILED 503 is read by the shared rule
 * (dispatchFailedText); the post then has failed results or shows as
 * publishing, so this card's press stays used up and the list is read again.
 */
export function createSendAgain(
  postJobId: string,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
  online?: () => boolean,
): () => Promise<SendAgainOutcome> {
  let locked = false;
  return async () => {
    if (locked) return null;
    locked = true;
    const answer = await sendActionRequest(`/api/posts/${postJobId}/publish`, { method: "POST" }, {
      fetchImpl: fetcher as typeof fetch,
      ...(online ? { online } : {}),
    });
    if (answer.kind === "not_sent") {
      locked = false;
      return { ok: false, error: SEND_AGAIN_NOT_SENT };
    }
    if (answer.kind === "no_answer") {
      locked = false;
      return { ok: false, error: SEND_AGAIN_NO_ANSWER, refetch: true };
    }
    const { response } = answer;
    if (response.ok) return { ok: true };
    let body: { error?: unknown; code?: unknown } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Not JSON: the generic sentence below.
    }
    if (body.code === "DISPATCH_FAILED") return { ok: false, error: dispatchFailedText(body, "Send again"), refetch: true };
    locked = false;
    return { ok: false, error: typeof body.error === "string" && body.error ? body.error : SEND_AGAIN_FAILED };
  };
}

/** A failed post the server took again reads In progress until fresh data arrives. */
export function displayedJobStatus(status: PostJobStatus, sentAgain: boolean): PostJobStatus {
  return sentAgain && status === "failed" ? "in_progress" : status;
}

export function isTextPost(job: Pick<PostJobDTO, "media" | "mediaCount">): boolean {
  return job.media === null && job.mediaCount === 0;
}

/**
 * The author in a card's "by" line (Activity, dashboard, Queue). R16-pages L4:
 * owners see a full address, which on a phone is wider than the column, so it
 * wraps instead of running over the status badge.
 */
export function ByName({ name }: { name: string }) {
  return <span className="break-words">{name}</span>;
}

/** The small tile a text post shows where a photo's thumbnail would be (Activity and Queue). */
export function TextPostTile() {
  return (
    <span
      aria-label="Text post, no photo"
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius)] border border-border bg-muted text-[11px] font-medium text-muted-foreground"
    >
      Text
    </span>
  );
}

export function PostJobCard({
  job,
  showAttribution = false,
  viewerRole = "owner",
  onRetryAccepted,
}: {
  job: PostJobDTO;
  showAttribution?: boolean;
  /** From the posts list answer (usePostJobs); a member gets the owner's step instead of Settings. */
  viewerRole?: ViewerRole;
  onRetryAccepted: (jobId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Platforms whose retry is in flight (optimistic pending) and platforms the
  // server told us to reconnect. Both are keyed by Platform.
  const [pending, setPending] = useState<Set<Platform>>(new Set());
  const [reconnect, setReconnect] = useState<Set<Platform>>(new Set());
  const toast = useToast();

  // Task 8 — polling (usePostJobs) delivers a fresh `job` object identity
  // every 10s. Reset ONLY the optimistic `pending` set when that happens: the
  // server has already flipped a claimed retry to `pending` by the time its
  // response resolves (see retry/route.ts's atomic updateMany), so
  // `result.status` takes over as the truthful source and the UI still reads
  // "pending" until it resolves to success/failed. `reconnect` is
  // server-derived (from a RECONNECT_REQUIRED response), not optimism, so
  // it's left untouched here.
  //
  // Adjusted during render — React's documented pattern for resetting state
  // when a prop changes ("Storing information from previous renders" in the
  // React docs) — rather than in a useEffect: an unconditional setState at
  // the top of an effect body is the derived-state anti-pattern this repo's
  // lint config blocks (react-hooks/set-state-in-effect; see the analogous
  // note in media-library.tsx's fetchItems).
  // Send again (F1 follow-up): busy while the request runs; `sentAgain` once the
  // server took the post, until the refetch it triggers brings the real status.
  const [sendingAgain, setSendingAgain] = useState(false);
  const [sentAgain, setSentAgain] = useState(false);
  const pressSendAgain = useMemo(() => createSendAgain(job.id), [job.id]);

  const [prevJob, setPrevJob] = useState(job);
  if (job !== prevJob) {
    setPrevJob(job);
    setPending(new Set());
    setSentAgain(false);
  }

  const status = JOB_STATUS_META[displayedJobStatus(job.status, sentAgain)];
  const results = orderResults(job.results);
  const time = cardTime(job);
  // 2026-11-10: platforms this post went to as a Story (labelled, and no link built from the id).
  const isStory = (platform: Platform) => job.storyPlatforms?.includes(platform) ?? false;
  const postUrl = (result: PostJobDTO["results"][number]) =>
    result.status === "success"
      ? platformPostUrl(result.platform, result.externalPostId, result.externalPostUrl, {
          story: isStory(result.platform),
        })
      : null;

  // Roadmap Phase 8: a job fans out to one result per platform, so there is at
  // most one YouTube result. Show its engagement stats once it succeeded (only
  // then does it carry the externalPostId the metric is keyed on); the row shows
  // "—" until the hourly sync cron fetches the counts.
  const youtubeResult = results.find(
    (result) =>
      result.platform === "youtube" &&
      result.status === "success" &&
      Boolean(result.externalPostId),
  );

  // A platform mid-retry displays as pending even though its stored result is
  // still `failed` until the background job finishes.
  const displayStatus = (
    result: PostJobDTO["results"][number],
  ): PostJobResultStatus =>
    pending.has(result.platform) ? "pending" : result.status;

  // Platform limits (2026-11-01 scale audit): a pending result that is waiting out
  // a rate limit or quota says why and until when. Server-derived, so it follows
  // the polled `job`; a result being retried optimistically shows none. A payload
  // that lacks the field (`undefined`) shows none too instead of crashing the card
  // (final review F3).
  const deferrals = selectDeferrals(results, pending);

  const failedPlatforms = results
    .filter((result) => result.status === "failed")
    .map((result) => result.platform);

  // 2026-11-01 scale audit (jobs H6): a failed result whose commit call could not
  // be confirmed may already be live. Its warning is shown inline, ahead of the
  // Retry button, not inside the collapsed "Show errors" list below — a retry
  // can post it a second time. Hidden while that retry is in flight, like errors.
  const unconfirmed = results.filter(
    (result) =>
      result.status === "failed" &&
      result.unconfirmed &&
      !pending.has(result.platform),
  );

  // Hide a failure's stored error message while it's being retried (we've
  // optimistically cleared it). Unconfirmed results are listed above instead.
  const failures = results.filter(
    (result) =>
      result.status === "failed" &&
      result.errorMessage &&
      !result.unconfirmed &&
      !pending.has(result.platform),
  );

  const unsent = job.status === "failed" && results.length === 0;
  // A post from weeks ago is not sent again (lib/sendAgain.ts): it says why.
  // The time is read once, when the card first appears: a week-old limit does
  // not need a ticking clock, and render must stay pure.
  const [openedAt] = useState(() => Date.now());
  const tooOldToSend = unsent && sendAgainTooOld(job, openedAt);
  const canSendAgain = unsent && !tooOldToSend && !sentAgain;

  const sendAgain = useCallback(async () => {
    setSendingAgain(true);
    const outcome = await pressSendAgain();
    setSendingAgain(false);
    if (outcome === null) return;
    if (outcome.ok) {
      setSentAgain(true);
      toast.success("Sending this post again…");
      onRetryAccepted(job.id);
      return;
    }
    toast.error(outcome.error);
    if (outcome.refetch) onRetryAccepted(job.id);
  }, [job.id, onRetryAccepted, pressSendAgain, toast]);

  // R7-security L1 and its review: what "Retry all failed" sends, by the rule
  // the retry route uses too (lib/retryAll.ts): never a platform that may
  // already be live, nor one the server said needs reconnecting. Shown only
  // when the rule covers 2 or more platforms (R8-pages L6): with one, that
  // platform's own Retry button is the same request.
  const retryAllPlatforms = retryAllPlan(results, (platform) => reconnect.has(platform)).included;

  const retry = useCallback(
    // `all`: the platforms it sends, for the optimistic state.
    async (target: RetryTarget, all: readonly Platform[] = []) => {
      const platforms = target === "all" ? all : [target];
      const label = target === "all" ? "the failed platforms" : platformLabel(target);
      setReconnect((prev) => {
        if (!platforms.some((platform) => prev.has(platform))) return prev;
        const next = new Set(prev);
        for (const platform of platforms) next.delete(platform);
        return next;
      });
      setPending((prev) => new Set([...prev, ...platforms]));
      const rollBack = () =>
        setPending((prev) => {
          const next = new Set(prev);
          for (const platform of platforms) next.delete(platform);
          return next;
        });

      try {
        const response = await fetch(`/api/posts/${job.id}/retry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(retryRequestBody(target)),
        });

        if (response.ok) {
          if (target === "all") {
            let body: RetryErrorBody & { retrying?: Platform[] } = {};
            try {
              body = (await response.json()) as typeof body;
            } catch {
              // An answer without a body still means it started.
            }
            const leftOut = body.leftOut ?? [];
            // What the server left out is not retrying: it shows as it was.
            setPending((prev) => {
              const next = new Set(prev);
              for (const entry of leftOut) next.delete(entry.platform);
              return next;
            });
            const dead = leftOut.filter((entry) => entry.reason === "reconnect").map((entry) => entry.platform);
            if (dead.length > 0) setReconnect((prev) => new Set([...prev, ...dead]));
            toast.success(retryAllToast(body.retrying ?? platforms, body.notice));
          } else {
            toast.success(`Retrying ${label}…`);
          }
          // Keep the optimistic pending state until the refetch this triggers
          // delivers the server's view of the job.
          onRetryAccepted(job.id);
          return;
        }

        let body: RetryErrorBody = {};
        try {
          body = (await response.json()) as RetryErrorBody;
        } catch {
          // Non-JSON error — fall through to the generic message below.
        }

        // Roll back the optimistic pending state: the retry never started.
        rollBack();

        if (body.code === "RECONNECT_REQUIRED") {
          const dead =
            target === "all"
              ? (body.leftOut ?? []).filter((entry) => entry.reason === "reconnect").map((entry) => entry.platform)
              : [target];
          if (dead.length > 0) setReconnect((prev) => new Set([...prev, ...dead]));
          toast.error(reconnectRefusalToast(viewerRole, dead, label, body.error));
          return;
        }

        toast.error(body.error ?? `Couldn't retry ${label}. Please try again.`);
      } catch {
        rollBack();
        toast.error(`Couldn't retry ${label}. Please try again.`);
      }
    },
    [job.id, onRetryAccepted, toast, viewerRole],
  );

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        {isTextPost(job) ? <TextPostTile /> : <MediaThumb media={job.media} count={job.mediaCount} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {job.caption?.trim() || "Untitled post"}
          </p>
          {time ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {time.label ? <>{time.label} </> : null}
              <time dateTime={time.iso}>{formatTimestamp(time.iso)}</time>
              {showAttribution && job.createdBy ? <> · by <ByName name={job.createdBy.name} /></> : null}
            </p>
          ) : null}
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>

      {results.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {results.map((result) =>
            isStory(result.platform) ? (
              <span key={result.platform} className="inline-flex items-center gap-1">
                <PlatformResultBadge platform={result.platform} status={displayStatus(result)} />
                <span className="text-xs text-muted-foreground">Story</span>
              </span>
            ) : (
              <PlatformResultBadge
                key={result.platform}
                platform={result.platform}
                status={displayStatus(result)}
              />
            ),
          )}
        </div>
      ) : null}

      {/* A platform that took the post but not something with it (a video's cover) says so here. */}
      {results.some((result) => result.note) ? (
        <ul className="mt-2 space-y-0.5">
          {results.map((result) =>
            result.note ? (
              <li key={result.platform} className="text-xs text-muted-foreground">
                {platformLabel(result.platform)}: {result.note}
              </li>
            ) : null,
          )}
        </ul>
      ) : null}

      {deferrals.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {deferrals.map((result) => (
            <li key={result.platform} className="text-xs text-muted-foreground">
              {describeDeferral(
                platformLabel(result.platform),
                result.deferral.kind,
                new Date(result.deferral.until),
                formatDeferralTime,
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {/* F1 H3: a failed post with no results was never sent; the job does not
          record why, so one sentence that is true for every cause. */}
      {canSendAgain || tooOldToSend ? (
        <p className="mt-3 rounded-[var(--radius)] border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-foreground">
          {tooOldToSend ? TOO_OLD_TO_SEND_MESSAGE : NOT_SENT_MESSAGE}
        </p>
      ) : null}

      {canSendAgain ? (
        <div className="mt-3">
          <Button size="sm" variant="outline" loading={sendingAgain} onClick={() => void sendAgain()}>
            Send again
          </Button>
        </div>
      ) : null}

      {results.some((r) => postUrl(r)) ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {results.map((result) => {
            const url = postUrl(result);
            if (!url) return null;
            return (
              <ExternalLink
                key={result.platform}
                href={url}
                className="rounded text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                View on {platformLabel(result.platform)}
              </ExternalLink>
            );
          })}
        </div>
      ) : null}

      {youtubeResult ? <PostMetricStats metric={youtubeResult.metric} /> : null}

      {/* Instagram, Facebook, LinkedIn and Pinterest numbers, read once a day. */}
      <DailyMetricStats results={results} storyPlatforms={job.storyPlatforms ?? []} />

      {unconfirmed.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {unconfirmed.map((result) => (
            <li
              key={result.platform}
              className="rounded-[var(--radius)] border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-foreground"
            >
              <span className="font-semibold">{platformLabel(result.platform)}:</span>{" "}
              {PUBLISH_UNCONFIRMED_MESSAGE}
            </li>
          ))}
        </ul>
      ) : null}

      {failedPlatforms.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {failedPlatforms.map((platform) =>
            reconnect.has(platform) ? (
              <ReconnectStep key={platform} platform={platform} role={viewerRole} />
            ) : (
              <Button
                key={platform}
                size="sm"
                variant="outline"
                loading={pending.has(platform)}
                onClick={() => retry(platform)}
              >
                {pending.has(platform) ? "Retrying" : "Retry"}{" "}
                {platformLabel(platform)}
              </Button>
            ),
          )}
          {retryAllPlatforms.length >= 2 ? (
            <Button
              size="sm"
              variant="outline"
              loading={retryAllPlatforms.some((platform) => pending.has(platform))}
              onClick={() => retry("all", retryAllPlatforms)}
            >
              Retry all failed
            </Button>
          ) : null}
        </div>
      ) : null}

      {failures.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                expanded && "rotate-180",
              )}
            />
            {expanded ? "Hide" : "Show"} {failures.length}{" "}
            {failures.length === 1 ? "error" : "errors"}
          </button>
          {expanded ? (
            <ul className="mt-2 space-y-1.5">
              {failures.map((result) => (
                <li
                  key={result.platform}
                  className="rounded-[var(--radius)] border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-foreground"
                >
                  <span className="font-semibold">
                    {platformLabel(result.platform)}:
                  </span>{" "}
                  {failureSentence(result, viewerRole)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
