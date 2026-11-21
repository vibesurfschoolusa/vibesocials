"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CalendarClock, Copy, PlusCircle } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadError, LoadMoreButton } from "@/components/load-error";
import { buttonVariants } from "@/components/ui/buttonVariants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CONFIRM_FAILED_MESSAGE,
  CONFIRM_NOTHING_SENT_MESSAGE,
  ConfirmDialog,
  ConfirmFailureShown,
  confirmFailureText,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { fieldBaseClasses, Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { answerLostText } from "@/lib/answerLost";
import { AnnouncedText } from "@/components/ui/announcer";
import { clientLinkLoadTexts, readClientLinkCard } from "@/lib/clientLinkCardRead";
import { focusAfterPress } from "@/lib/focusAfter";
import { fetchOrNoAnswer, isNoAnswer, isNoConnection } from "@/lib/requestNoAnswer";
import { CaptionCounter } from "@/components/caption-counter";
import { ClientLinkPlanNotice } from "@/components/client-link-plan-notice";
import { PlatformCaptionEditor } from "@/components/composer/platform-caption-editor";
import { useConnections } from "@/hooks/useConnections";
import { loadMoreFailureText } from "@/hooks/usePostJobs";
import { ByName, isTextPost, TextPostTile } from "@/components/activity/post-job-card";
import { MediaThumb } from "@/components/media-thumb";
import { QueueCalendar } from "./queue-calendar";
import {
  cardRequest,
  changedJobIds,
  foldedPairLine,
  foldQueuePairs,
  otherHalfPatch,
  pairAwareFetch,
  pairDialogLine,
  pairEditNote,
  pairNeedsReload,
  takesOtherHalf,
  withPairNote,
  type QueueCard as QueueCardPost,
} from "./pairActions";
import { captionCounter, captionTooLongMessage } from "@/lib/captionLimits";
import { cn } from "@/lib/cn";
import { cardName, wasScheduledDraft } from "@/lib/queueLabelName";
import { APP_PAGE_CLASS } from "@/lib/pageLayout";
import type { CaptionFooterUser } from "@/lib/captionFooter";
import { queueOverridesToSend, type PlatformOverrides } from "@/lib/platformOverrides";
import {
  PLATFORM_CAPTIONS_HEADING,
  PLATFORM_ORDER,
  platformCaptionEntries,
  TIKTOK_PRIVACY_LABELS,
} from "@/lib/platforms";
import { googleQueueLabel } from "@/lib/googlePostOptions";
import { YOUTUBE_PRIVACY_LABELS } from "@/components/youtube-post-settings";
import type { PostJobDTO, PostsResponse } from "@/lib/postsDto";
import { queueEditorPlatforms, storyChoiceSuffix, storyListing } from "@/lib/storyPlacement";
import { appendJobsPage } from "@/lib/postsPagination";
import {
  applyJobPatch,
  approveHint,
  browserOnline,
  decisionButtonState,
  decisionOutcome,
  editDialogModel,
  editOutcome,
  editSaveLabel,
  editTimeToSend,
  getQueueCardActions,
  publishConfirmCopy,
  publishNeedsApproval,
  postActionRefusal,
  publishOutcome,
  queueStatusBadge,
  queueMayHaveGoneThroughText,
  queueNotSentText,
  sendActionRequest,
  seriesCancelToast,
  type JobPatch,
  type PostActionRefusal,
  type QueueViewer,
} from "@/lib/queueActions";
import { scheduleDraft } from "@/lib/scheduleDraft";
import { POST_CHANGED_CODE } from "@/lib/postMovedOn";
import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";
import { readWorkspaceRefusalText, withWorkspaceId } from "@/lib/workspaceChanged";
import {
  SCHEDULE_BUFFER_MS,
  localTimeZoneLabel,
  toDateTimeLocalValue,
} from "@/lib/scheduling";

/*
 * R28 NN2 (publishing L3, pages L1): Cancel and Delete may have gone through
 * when the answer is lost or a gateway answers 5xx. The Queue reloads, as
 * after a lost Publish (lib/queueActions.ts queueMayHaveGoneThroughText).
 */
export const QUEUE_CANCEL_MAYBE_MESSAGE = answerLostText(
  "the post may have been cancelled",
  "We're reloading the Queue: check it before you cancel again.",
);
export const QUEUE_CANCEL_SERIES_MAYBE_MESSAGE = answerLostText(
  "the posts may have been cancelled",
  "We're reloading the Queue: check it before you cancel again.",
);
export const QUEUE_DELETE_MAYBE_MESSAGE = answerLostText(
  "the draft may have been deleted",
  "We're reloading the Queue: check it before you delete again.",
);

/*
 * R28 NN2 (client-journey L1, pages L1): the route turns the old review link
 * off before it answers, so a lost answer may leave a new link, or none.
 */
export const REVIEW_LINK_MAYBE_MADE_MESSAGE = answerLostText(
  "a new review link may have been made, which turns any old one off",
  "Reload this page and copy the link before you send it.",
);
export const REVIEW_LINK_MAYBE_OFF_MESSAGE = answerLostText(
  "the review link may have been turned off",
  "Reload this page to see.",
);

/** A card patch from the edit dialog, which may also carry the saved per-platform captions. */
type EditPatch = JobPatch & Partial<Pick<PostJobDTO, "platformCaptions">>;

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A draft the client pulled out of the schedule through the review link. */
function hasClientChangeRequest(job: PostJobDTO): boolean {
  return job.status === "draft" && Boolean(job.clientChangeRequestedAt);
}

/**
 * Drafts the client asked to change first (the client is waiting on the owner:
 * oldest request on top), then posts awaiting approval (they block someone
 * else's work: oldest submission on top), then scheduled posts soonest-first
 * (next up), then drafts newest-first.
 */
export type QueueViewMode = "list" | "calendar";

const QUEUE_VIEW_KEY = "vibe.queueView";

type ViewStorage = Partial<Pick<Storage, "getItem" | "setItem">>;

/**
 * N3: the Queue view this browser last used. Storage can be missing, blocked
 * (reading `window.localStorage` itself throws in some private windows) or
 * hold anything, so every failure reads as List.
 */
export function readQueueView(getStorage: () => ViewStorage | null | undefined): QueueViewMode {
  try {
    return getStorage()?.getItem?.(QUEUE_VIEW_KEY) === "calendar" ? "calendar" : "list";
  } catch {
    return "list";
  }
}

/** Remembers the Queue view; a storage failure only means it is not remembered. */
export function saveQueueView(
  getStorage: () => ViewStorage | null | undefined,
  mode: QueueViewMode,
): void {
  try {
    getStorage()?.setItem?.(QUEUE_VIEW_KEY, mode);
  } catch {
    // Not remembered; the view still switches.
  }
}

export function sortQueue(jobs: PostJobDTO[]): PostJobDTO[] {
  const clientChanges = jobs
    .filter(hasClientChangeRequest)
    .sort((a, b) => (a.clientChangeRequestedAt ?? "").localeCompare(b.clientChangeRequestedAt ?? ""));
  const others = jobs.filter((j) => !hasClientChangeRequest(j));
  const pendingApproval = others
    .filter((j) => j.approvalState === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const rest = others.filter((j) => j.approvalState !== "pending");
  const scheduled = rest
    .filter((j) => j.status === "scheduled")
    .sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? ""));
  const drafts = rest
    .filter((j) => j.status === "draft")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...clientChanges, ...pendingApproval, ...scheduled, ...drafts];
}

/** V1: "Custom cover" for a post with a chosen video cover, else null. */
export function coverLabel(job: Pick<PostJobDTO, "hasCover">): string | null {
  return job.hasCover ? "Custom cover" : null;
}

/** V1: the edit dialog's line for a post with a chosen video cover (editing never changes it). */
export function coverEditNote(job: Pick<PostJobDTO, "hasCover">): string | null {
  return job.hasCover ? "Keeps its custom cover." : null;
}

/**
 * F6: the line on a half of a Feed and Story post that has a card of its own
 * (its other half already went out, or the two no longer agree). A pair that agrees
 * is one card with its own line (R3-client-journey M1, pairActions.ts).
 */
export function pairLabel(job: Pick<PostJobDTO, "storyOf" | "alsoAsStory">): string | null {
  if (job.storyOf) {
    return job.storyOf.scheduledFor
      ? `Story of the post on ${formatTimestamp(job.storyOf.scheduledFor)}`
      : "Story of a post with no time set";
  }
  return job.alsoAsStory ? "Also as a Story" : null;
}

/**
 * R56 pages-a L2: the card names YouTube privacy as the select and Create's
 * confirmation do; a value the map doesn't know shows as stored, as TikTok's does.
 */
export function youtubePrivacyNote(privacy: string | null | undefined): string {
  if (!privacy) return "";
  return ` · YouTube: ${YOUTUBE_PRIVACY_LABELS[privacy as keyof typeof YOUTUBE_PRIVACY_LABELS] ?? privacy}`;
}

/** "Repeats: 3 of 8" for a post created as part of a series (brief 11), else null. */
export function seriesLabel(job: PostJobDTO): string | null {
  if (!job.seriesId || !job.seriesPosition || !job.seriesCount) return null;
  return `Repeats: ${job.seriesPosition} of ${job.seriesCount}`;
}

export { isTextPost };

/** The refusal for saving an empty caption: a text post's text is the whole post. */
export function emptyCaptionMessage(job: Pick<PostJobDTO, "media" | "mediaCount">): string {
  return isTextPost(job) ? "A post without a photo needs text." : "Caption can't be empty.";
}

export type CancelScope = "one" | "rest";

/**
 * Which route a cancel uses: this post alone, or (for a post in a series) this
 * post and every later one of the series still scheduled or a draft. A Feed
 * and Story card's single cancel takes both halves (R3-client-journey M1).
 */
export function cancelRequest(
  card: QueueCardPost,
  scope: CancelScope,
  workspaceId: string | null,
): { url: string; series: boolean; init: ReturnType<typeof cardRequest> } {
  if (scope === "rest" && card.seriesId) {
    return { url: `/api/posts/${card.id}/cancel-series`, series: true, init: cardRequest({}, "POST", workspaceId) };
  }
  return { url: `/api/posts/${card.id}/cancel`, series: false, init: cardRequest(card, "POST", workspaceId) };
}

interface QueueCardProps {
  job: QueueCardPost;
  /** Team Workspaces (Task 7, design §7) — show `by {createdBy.name}` next to the timestamp. */
  showAttribution: boolean;
  /** Approval workflow — role + workspace setting decide which actions render (lib/queueActions.ts). */
  viewer: QueueViewer;
  /** Clock for the approve hint, refreshed on an interval (no impure Date in render). */
  nowMs: number;
  onEdit: (job: QueueCardPost) => void;
  onCancel: (job: QueueCardPost) => void;
  onPublish: (job: QueueCardPost) => void;
  onDelete: (job: QueueCardPost) => void;
  /** Approval workflow — decide a pending submission (owners only). */
  onDecide: (job: QueueCardPost, decision: "approve" | "reject", pressed: HTMLElement | null) => void;
  /** Approval workflow — the decision in flight for this job, if any. */
  deciding: "approve" | "reject" | null;
  /** R56 pages-a L5: why the last Approve on this card was refused, until the next press on it. */
  approveRefusal: string | null;
}

type CardTimeFacts = Pick<QueueCardPost, "status" | "approvalState" | "scheduledFor" | "createdAt">;

/**
 * The time the card shows under its caption: Proposed for, Scheduled for, Was
 * scheduled for (a draft that kept its time, R59 client-journey L1), else Saved.
 */
export function queueCardTime(job: CardTimeFacts): {
  label: "Proposed for" | "Scheduled for" | "Was scheduled for" | "Saved";
  iso: string;
} {
  if (job.scheduledFor) {
    if (job.approvalState === "pending") return { label: "Proposed for", iso: job.scheduledFor };
    if (job.status === "scheduled") return { label: "Scheduled for", iso: job.scheduledFor };
    if (wasScheduledDraft(job)) return { label: "Was scheduled for", iso: job.scheduledFor };
  }
  return { label: "Saved", iso: job.createdAt };
}

/** The card's name in its buttons: the caption and the time the card shows, through cardName. */
export function queueCardName(job: CardTimeFacts & Pick<QueueCardPost, "caption" | "storyOf" | "storyHalf">): string {
  const time = queueCardTime(job);
  return cardName(job.caption, time.iso, {
    storyHalf: Boolean(job.storyOf || job.storyHalf),
    was: time.label === "Was scheduled for",
  });
}

function QueueCard({
  job,
  showAttribution,
  viewer,
  nowMs,
  onEdit,
  onCancel,
  onPublish,
  onDelete,
  onDecide,
  deciding,
  approveRefusal,
}: QueueCardProps) {
  const actions = getQueueCardActions(job, viewer);
  const badge = queueStatusBadge(job);
  const title = job.caption?.trim() || "Untitled post";
  const time = queueCardTime(job);
  const name = queueCardName(job);
  // 2026-11-01 audit (M1): the per-platform texts that REPLACE the base caption
  // on publish. Shown on every card that has them, most importantly to the owner
  // deciding on a pending post - approving means approving these too.
  const stories = job.storyPlatforms ?? [];
  const targets = job.publish?.targetPlatforms ?? [];
  const listing = storyListing(targets, job.platformCaptions, stories);
  const platformCaptions = platformCaptionEntries(listing.platformCaptions);
  // 2026-11-10: "Offer", "Book button"; null for a plain Google update.
  const googleLabel = googleQueueLabel(job.publish?.googlePostType ?? null, job.publish?.googleButton ?? null);
  const repeats = seriesLabel(job);
  const cover = coverLabel(job);
  // R3-client-journey M1: "Feed and Story" with each half's platforms on a folded card.
  const pair = foldedPairLine(job, listing.platformLabels) ?? pairLabel(job);

  return (
    <Card className="p-4 sm:p-5">
      {/* Client review link: the client pulled this post out of the schedule. */}
      {job.status === "draft" && job.clientChangeRequestedAt ? (
        <div className="mb-3 rounded-md border border-border bg-muted/40 p-2.5">
          <p className="text-xs font-medium text-foreground">Your client asked for a change</p>
          {job.clientNote ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {job.clientNote}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-start justify-between gap-3">
        {isTextPost(job) ? <TextPostTile /> : <MediaThumb media={job.media} count={job.mediaCount} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          {/* A post awaiting approval is technically a draft, but it may carry
              the time its author chose — show that, or the owner is asked to
              approve a schedule they can't see. */}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {time.label}{" "}
            <time dateTime={time.iso}>{formatTimestamp(time.iso)}</time>
            {showAttribution && job.createdBy ? <> · by <ByName name={job.createdBy.name} /></> : null}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {job.publish?.targetPlatforms?.length
              ? `Publishing to ${listing.platformLabels.join(", ")}`
              : `Publishing to all platforms connected at publish time${storyChoiceSuffix(stories)}`}
            {youtubePrivacyNote(job.publish?.youtubePrivacy)}
            {job.publish?.tiktokPrivacy ? ` · TikTok: ${TIKTOK_PRIVACY_LABELS[job.publish.tiktokPrivacy] ?? job.publish.tiktokPrivacy}` : ""}
            {googleLabel ? ` · Google: ${googleLabel}` : ""}
          </p>
          {listing.storyOnlyNote ? (
            <p className="mt-1 text-xs text-muted-foreground">{listing.storyOnlyNote}</p>
          ) : null}
          {pair ? <p className="mt-1 text-xs text-muted-foreground">{pair}</p> : null}
          {repeats ? <p className="mt-1 text-xs text-muted-foreground">{repeats}</p> : null}
          {cover ? <p className="mt-1 text-xs text-muted-foreground">{cover}</p> : null}
          {platformCaptions.length > 0 ? (
            <div className="mt-2 rounded-md border border-border bg-muted/40 p-2.5">
              <p className="text-xs font-medium text-foreground">{PLATFORM_CAPTIONS_HEADING}</p>
              <ul className="mt-1 space-y-1">
                {platformCaptions.map((entry) => (
                  <li
                    key={entry.platform}
                    className="whitespace-pre-wrap break-words text-xs text-muted-foreground"
                  >
                    <span className="font-medium text-foreground">{entry.label}:</span> {entry.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant={badge.tone}>{badge.label}</Badge>
          {job.status === "scheduled" && job.clientApprovedAt ? (
            <Badge variant="success">Client approved</Badge>
          ) : null}
        </div>
      </div>

      {/* Approval workflow: a pending submission gets its own action row.
          Owners decide; the member who submitted just sees where it stands.
          The normal Edit/Publish/Delete row is suppressed so nobody can
          side-step review by publishing the draft directly. */}
      {actions.decide || actions.awaitingNote ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {actions.decide ? (
            <>
              <Button
                size="sm"
                {...decisionButtonState(deciding, "approve")}
                aria-label={`Approve "${name}"`}
                onClick={(event) => onDecide(job, "approve", event.currentTarget)}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                {...decisionButtonState(deciding, "reject")}
                aria-label={`Reject "${name}"`}
                onClick={(event) => onDecide(job, "reject", event.currentTarget)}
              >
                Reject
              </Button>
              <span className="text-xs text-muted-foreground">
                {approveHint(job, new Date(nowMs), SCHEDULE_BUFFER_MS, formatTimestamp)}
              </span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              Waiting for an owner to approve. It won&apos;t publish until then.
            </span>
          )}
          {/* R56 pages-a L5: a limit refusal runs to 68 words; the toast closes
              after 8 s, so the card keeps the sentence. */}
          {actions.decide && approveRefusal ? (
            <p role="alert" className="basis-full text-sm text-destructive">
              {approveRefusal}
            </p>
          ) : null}
        </div>
      ) : (
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {actions.edit ? (
          <Button size="sm" variant="outline" aria-label={`Edit "${name}"`} onClick={() => onEdit(job)}>
            Edit
          </Button>
        ) : null}
        {actions.primary ? (
          <Button
            size="sm"
            variant="outline"
            aria-label={
              actions.primary.kind === "submit"
                ? `Submit "${name}" for approval`
                : `Publish "${name}" now`
            }
            onClick={() => onPublish(job)}
          >
            {actions.primary.label}
          </Button>
        ) : null}
        {actions.secondary === "cancel" ? (
          <Button size="sm" variant="ghost" aria-label={`Cancel "${name}"`} onClick={() => onCancel(job)}>
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Delete "${name}"`}
            onClick={() => onDelete(job)}
          >
            Delete
          </Button>
        )}
      </div>
      )}
    </Card>
  );
}

/** R30 publishing L1: the Edit dialog's line after a 409 or 404, so nothing typed is lost. */
export const EDIT_COPY_YOUR_TEXT = "Copy your text if you want to keep it, then press Cancel.";
const EDIT_MOVED_ON_FALLBACK = "This post can no longer be edited.";

/**
 * Lead review: the refusal (postActionRefusal's text) as a sentence, then the
 * copy step. Any text without a closing full stop gets one, so the two never
 * run together.
 */
export function editMovedOnText(refusal: string | undefined): string {
  const said = refusal?.trim() || EDIT_MOVED_ON_FALLBACK;
  const sentence = /[.!?]$/.test(said) ? said : `${said}.`;
  return `${sentence} ${EDIT_COPY_YOUR_TEXT}`;
}

/**
 * R60 publishing-flow L1 = pages-a L1: a lost race (POST_CHANGED) can be tried
 * again, but not from this dialog, whose Save is off: Cancel and open Edit
 * again, which reads the post as it is now. Once the caption is saved there is
 * nothing to copy.
 */
export function editChangedText(captionSaved: boolean): string {
  return captionSaved
    ? "This post changed in the meantime. Your caption changes were saved. Press Cancel, then open Edit again."
    : "This post changed in the meantime. Copy your text, press Cancel, then open Edit again.";
}

/** The `code` of a route's answer, or null. */
function answerCode(data: unknown): unknown {
  return data !== null && typeof data === "object" ? (data as { code?: unknown }).code ?? null : null;
}

type DialogFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * The Edit dialog's fetch for lib/scheduleDraft.ts, keeping the code of the
 * last answer read, so the dialog words a lost race by its code.
 */
function keepingLastCode(fetchImpl: DialogFetch): { fetchFn: DialogFetch; lastCode: () => unknown } {
  let last: unknown = null;
  const fetchFn: DialogFetch = async (url, init) => {
    const response = await fetchImpl(url, init);
    return {
      ok: response.ok,
      status: response.status,
      json: async () => {
        const data = await response.json();
        last = answerCode(data);
        return data;
      },
    };
  };
  return { fetchFn, lastCode: () => last };
}

/**
 * Edit dialog for a scheduled/draft post. Remounted per target (keyed by job
 * id) so its local caption/time state always initializes from the current job.
 * A scheduled job edits its caption + `scheduledFor` in one PATCH. A draft edits
 * its caption and may be given a time ("Schedule for"): `scheduleDraft`
 * (lib/scheduleDraft.ts) PATCHes the caption only if it changed, then promotes
 * the draft with `POST …/publish { scheduledFor }` — which, for a member in an
 * approval workspace, SUBMITS it for approval.
 */
function QueueEditDialog({
  job,
  viewer,
  workspaceId,
  onClose,
  onSaved,
  onPartialSave,
  onStale,
  footerSettings,
}: {
  job: QueueCardPost;
  viewer: QueueViewer;
  /** R31 pages L2: the workspace the Queue was drawn for, sent with each save. */
  workspaceId: string | null;
  /** The workspace footer appended at publish time (same data the Create page gets). */
  footerSettings?: CaptionFooterUser;
  onClose: () => void;
  /** The save is complete: patch the card (from the server's answer) and close the dialog. */
  onSaved: (patch: EditPatch, answer: unknown) => void;
  /** Part of the save landed (caption) but the dialog stays open: patch the card only. */
  onPartialSave: (patch: EditPatch, answer: unknown) => void;
  /** The server's state for this post is unknown (unreadable reply): re-sync the list. */
  onStale: () => void;
}) {
  const toast = useToast();
  const isScheduled = job.status === "scheduled";
  const model = editDialogModel(job, viewer);
  const [caption, setCaption] = useState(job.caption ?? "");
  // Per-platform captions as typed, and as last persisted (so a retry or an
  // untouched editor never rewrites them).
  const [platformOverrides, setPlatformOverrides] = useState<PlatformOverrides | null>(
    job.platformCaptions,
  );
  const [savedOverrides, setSavedOverrides] = useState<PlatformOverrides | null>(
    job.platformCaptions,
  );
  // The post's platforms: its chosen targets, or (no targets = every platform
  // connected at publish time) the connected ones plus any that already have a
  // caption, so a saved caption is never hidden while connections load.
  const { connections } = useConnections(workspaceId);
  const targetPlatforms = job.publish?.targetPlatforms ?? null;
  // A Story has no caption to edit, so it gets no own-caption editor, but its
  // stored caption must still be sent back with the others.
  const storyPlatforms = job.storyPlatforms ?? [];
  const allPlatforms = (
    targetPlatforms ??
    PLATFORM_ORDER.filter(
      (platform) =>
        typeof job.platformCaptions?.[platform] === "string" ||
        connections?.some((c) => c.platform === platform && c.connected),
    )
  );
  const editorPlatforms = queueEditorPlatforms(allPlatforms, storyPlatforms);
  // Whether the post has a caption of its own. The list's `caption` and
  // `platformCaptions` fall back to the media item's for an older post that
  // has none (resolvePostCaptionSource); only the single-post read says which.
  // Unknown (still loading, or the read failed) counts as "none", which sends
  // the shown captions with the caption: the safe side.
  const [hasOwnCaption, setHasOwnCaption] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(withWorkspaceId(`/api/posts/${encodeURIComponent(job.id)}`, workspaceId));
        const data = (await response.json().catch(() => null)) as
          | { postJob?: { baseCaption?: unknown } }
          | null;
        if (!cancelled && response.ok && typeof data?.postJob?.baseCaption === "string") {
          setHasOwnCaption(true);
        }
      } catch {
        // Stays "none": the shown captions are sent with the caption.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [job.id, workspaceId]);
  // 2026-11-01 scale audit (jobs, event size): over the 10,000-character cap, which
  // PATCH /api/posts/[id] rejects - blocks Save (lib/captionLimits.ts).
  const captionOver = captionCounter(caption).over;
  // The caption as last persisted — a draft whose caption PATCH succeeded but
  // whose scheduling call failed must not re-PATCH an unchanged caption on retry.
  const [savedCaption, setSavedCaption] = useState(job.caption);
  const [scheduledForLocal, setScheduledForLocal] = useState(
    isScheduled && job.scheduledFor ? toDateTimeLocalValue(new Date(job.scheduledFor)) : "",
  );
  const [saving, setSaving] = useState(false);
  // R30 publishing L1: why this post can't be edited any more (the route's 409), or null.
  const [movedOn, setMovedOn] = useState<string | null>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const movedOnRef = useRef<HTMLDivElement>(null);
  // Picker `min` (now + buffer). Lazy useState initializer computes it once at
  // mount, keeping impure `Date.now()` off the render path; submit-time
  // validation is the authoritative future-time check.
  const [minScheduleLocal] = useState(() =>
    toDateTimeLocalValue(new Date(Date.now() + SCHEDULE_BUFFER_MS)),
  );

  const handleSave = async () => {
    const trimmed = caption.trim();
    if (!trimmed) {
      toast.error(emptyCaptionMessage(job));
      return;
    }
    if (captionOver) {
      toast.error(captionTooLongMessage("Caption"));
      return;
    }

    // A scheduled post sends its time only when it changed; a draft only when one was chosen.
    const timeCheck = editTimeToSend({
      scheduled: isScheduled,
      field: scheduledForLocal,
      savedScheduledFor: job.scheduledFor,
      nowMs: Date.now(),
      bufferMs: SCHEDULE_BUFFER_MS,
    });
    if (!timeCheck.ok) {
      toast.error(timeCheck.error);
      return;
    }
    const scheduledIso = timeCheck.iso;

    // undefined = leave them out; `null` removes the last one (lib/platformOverrides.ts).
    const overridesToSend = queueOverridesToSend({
      current: platformOverrides,
      saved: savedOverrides,
      mainCaption: trimmed,
      platforms: editorPlatforms.sent,
      hasOwnCaption,
    });
    const overridesEdited = overridesToSend !== undefined;
    const overridesPatch: EditPatch = overridesEdited ? { platformCaptions: overridesToSend } : {};

    setSaving(true);
    try {
      if (isScheduled || scheduledIso === null) {
        // Plain save: scheduled posts send caption + time, drafts just the caption.
        const answer = await sendActionRequest(
          `/api/posts/${job.id}`,
          cardRequest(job, "PATCH", workspaceId, {
            baseCaption: trimmed,
            ...(scheduledIso ? { scheduledFor: scheduledIso } : {}),
            ...(overridesEdited ? { perPlatformOverrides: overridesToSend } : {}),
          }),
        );
        if (answer.kind === "not_sent") {
          toast.error(queueNotSentText("edit"));
          setSaving(false);
          return;
        }
        if (answer.kind === "no_answer") {
          // R27 pages L10: the save may stand. The dialog keeps what was typed.
          onStale();
          toast.error(queueMayHaveGoneThroughText("edit"));
          setSaving(false);
          return;
        }
        const { response } = answer;
        if (!response.ok) {
          const errorData = (await response.json().catch(() => null)) as unknown;
          setSaving(false);
          const refusal = postActionRefusal(response.status, errorData, "Couldn't save your changes.");
          if (refusal.movedOn) {
            // R30 publishing L1, R31: the post moved on (or the page is for another workspace).
            // The dialog stays open with the route's sentence and Save off, so what was typed
            // can be copied; the list reloads behind it when the rule says so.
            focusAfterPress(saveRef.current, () => movedOnRef.current);
            setMovedOn(answerCode(errorData) === POST_CHANGED_CODE ? editChangedText(false) : editMovedOnText(refusal.text));
            if (refusal.reload) onStale();
            return;
          }
          toast.error(refusal.text);
          return;
        }
        const data = await response.json().catch(() => null);
        const outcome = editOutcome(data);
        toast.success(withPairNote(outcome.message, data));
        onSaved(
          {
            caption: trimmed,
            ...(scheduledIso ? { scheduledFor: scheduledIso } : {}),
            ...overridesPatch,
            ...outcome.patch,
          },
          data,
        );
        return;
      }

      // Schedule a draft (lib/scheduleDraft.ts owns the sequence and its tests).
      // A Feed and Story card's two requests both ask for the Story too.
      if (!browserOnline()) {
        toast.error(queueNotSentText(publishNeedsApproval(job, viewer) ? "submit" : "schedule"));
        setSaving(false);
        return;
      }
      const answers = keepingLastCode((url, init) => fetchOrNoAnswer(url, init));
      const pairFetch = pairAwareFetch(job, answers.fetchFn);
      const result = await scheduleDraft({
        fetchFn: pairFetch.fetchFn,
        jobId: job.id,
        caption: trimmed,
        originalCaption: savedCaption,
        scheduledForIso: scheduledIso,
        submitsForApproval: publishNeedsApproval(job, viewer),
        perPlatformOverrides: overridesToSend,
        workspaceId,
      });
      if (result.kind === "failed") {
        // Keep the dialog open with the user's input; the server says why. If
        // the caption PATCH landed, reflect it on the card and remember it so a
        // retry doesn't re-PATCH an unchanged caption.
        if (result.captionSaved) {
          setSavedCaption(trimmed);
          // The post now has its own caption, and these captions as stored.
          setHasOwnCaption(true);
          if (overridesEdited) {
            setSavedOverrides(overridesToSend);
            setPlatformOverrides(overridesToSend);
          }
          onPartialSave({ caption: trimmed, ...overridesPatch }, pairFetch.lastAnswer());
        }
        if (result.movedOn) {
          // R31 publishing L3: the same rule as a scheduled post's save, above. Once the
          // caption is saved there is nothing to copy (lead review).
          focusAfterPress(saveRef.current, () => movedOnRef.current);
          setMovedOn(
            answers.lastCode() === POST_CHANGED_CODE
              ? editChangedText(result.captionSaved)
              : result.captionSaved
                ? result.error
                : editMovedOnText(result.error),
          );
          if (result.movedOn.reload) onStale();
          setSaving(false);
          return;
        }
        toast.error(result.error);
        // R27 MM4 review: a lost answer may have scheduled it, so the Queue is read again too.
        if (result.reason === "unreadable_response" || result.reason === "no_answer") onStale();
        setSaving(false);
        return;
      }
      toast.success(withPairNote(result.message, pairFetch.lastAnswer()));
      onSaved({ ...result.patch, ...overridesPatch }, pairFetch.lastAnswer());
    } catch {
      // scheduleDraft words a lost answer itself; this is an unexpected failure, which may follow a save.
      toast.error(CONFIRM_FAILED_MESSAGE);
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !saving ? onClose() : undefined)}>
      <DialogHeader>
        <DialogTitle>{model.title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="queue-edit-caption">Caption</Label>
          <Textarea
            id="queue-edit-caption"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            rows={4}
            aria-invalid={captionOver || undefined}
            aria-describedby="queue-edit-caption-count"
          />
          <CaptionCounter id="queue-edit-caption-count" text={caption} />
        </div>
        <PlatformCaptionEditor
          idPrefix="queue-edit-platform-caption"
          platforms={editorPlatforms.shown}
          caption={caption}
          overrides={platformOverrides}
          onChange={setPlatformOverrides}
          footer={footerSettings}
          disabled={saving}
          workspaceId={workspaceId}
        />
        <div className="space-y-1.5">
          <Label htmlFor="queue-edit-time">{model.scheduleLabel}</Label>
          <input
            id="queue-edit-time"
            type="datetime-local"
            value={scheduledForLocal}
            min={minScheduleLocal || undefined}
            required={model.scheduleRequired}
            onChange={(event) => setScheduledForLocal(event.target.value)}
            className={cn(fieldBaseClasses, "h-10 px-3 py-2")}
          />
          <p className="text-xs text-muted-foreground">
            Times are in {localTimeZoneLabel()} (your browser&apos;s timezone).
          </p>
          {pairEditNote(job) ? <p className="text-xs text-muted-foreground">{pairEditNote(job)}</p> : null}
        </div>
        {coverEditNote(job) ? <p className="text-sm text-muted-foreground">{coverEditNote(job)}</p> : null}
        {model.notice ? <p className="text-sm text-muted-foreground">{model.notice}</p> : null}
        {movedOn ? (
          <Alert ref={movedOnRef} tabIndex={-1} variant="danger" className="outline-none">
            {movedOn}
          </Alert>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button ref={saveRef} onClick={handleSave} loading={saving} disabled={captionOver || movedOn !== null}>
          {editSaveLabel(job, viewer, scheduledForLocal !== "")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

interface ReviewLinkDto {
  /** null when the stored token cannot be opened; Replace makes a new one. */
  url: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

const REVIEW_LINK_LOAD_TEXTS = clientLinkLoadTexts("client review link");

type ReviewLinkAnswer = { link: ReviewLinkDto | null; pausedByPlan?: boolean; workspaceBlocked?: string };

function isReviewLinkAnswer(data: unknown): data is ReviewLinkAnswer {
  return typeof data === "object" && data !== null && "link" in data;
}

/**
 * Client review link (2026-11-10): owners make, copy, replace or turn off the
 * workspace's link here, as the upload link's panel on the Media page. Every
 * call carries the workspace whose posts this page shows: if another tab
 * switched workspace, the routes answer 409 and the panel shows their sentence.
 * R42 pages-b L1 and its review: it never hides. The Queue draws it only for
 * owners, so a failed read says what happened, with Retry, and a workspace
 * refusal or a 403 (the role changed) asks for a reload (readClientLinkCard).
 */
export function ReviewLinkPanel({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [state, setState] = useState<"loading" | "ready" | "changed" | "failed">("loading");
  const [changedMessage, setChangedMessage] = useState("");
  const [loadError, setLoadError] = useState(REVIEW_LINK_LOAD_TEXTS.failed);
  // Bumped by Retry, so the read runs again.
  const [attempt, setAttempt] = useState(0);
  const [pausedByPlan, setPausedByPlan] = useState(false);
  const [workspaceBlocked, setWorkspaceBlocked] = useState<string | null>(null);
  const [link, setLink] = useState<ReviewLinkDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"replace" | "off" | null>(null);
  const copyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const read = await readClientLinkCard(
        `/api/workspaces/review-link?workspaceId=${encodeURIComponent(workspaceId)}`,
        REVIEW_LINK_LOAD_TEXTS,
        isReviewLinkAnswer,
      );
      if (cancelled) return;
      if (read.kind === "changed") {
        setChangedMessage(read.message);
        setState("changed");
      } else if (read.kind === "failed") {
        setLoadError(read.message);
        setState("failed");
      } else {
        const data = read.data;
        setLink(data.link ?? null);
        setPausedByPlan(data.pausedByPlan === true);
        setWorkspaceBlocked(typeof data.workspaceBlocked === "string" ? data.workspaceBlocked : null);
        setState("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, attempt]);

  // client-journey L1: after a lost answer the panel reads the link again, so
  // it shows the one that works. A failed read keeps what is shown; the
  // sentence says to reload.
  const readLink = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/review-link?workspaceId=${encodeURIComponent(workspaceId)}`);
      const data = (await response.json().catch(() => null)) as { link?: ReviewLinkDto | null } | null;
      if (response.ok && data && "link" in data) setLink(data.link ?? null);
    } catch {
      // Still no connection: the sentence already says to reload.
    }
  }, [workspaceId]);

  // Create and Replace are the same call: the server revokes any old link.
  const makeLink = useCallback(async () => {
    let response: Response;
    try {
      response = await fetchOrNoAnswer("/api/workspaces/review-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
    } catch (error) {
      if (isNoAnswer(error)) void readLink();
      throw error;
    }
    const data = (await response.json().catch(() => null)) as
      | { link?: ReviewLinkDto; error?: string }
      | null;
    if (!response.ok || !data?.link) {
      if (data?.error) {
        toast.error(data.error);
      } else if (response.status >= 500 || response.ok) {
        toast.error(REVIEW_LINK_MAYBE_MADE_MESSAGE);
        void readLink();
      } else {
        toast.error("Couldn't make the link. Try again.");
      }
      throw new ConfirmFailureShown("CREATE_FAILED");
    }
    setLink(data.link);
    toast.success("New link ready. Copy it and send it to your client.");
  }, [readLink, toast, workspaceId]);

  const turnOff = useCallback(async () => {
    let response: Response;
    try {
      response = await fetchOrNoAnswer("/api/workspaces/review-link", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
    } catch (error) {
      if (isNoAnswer(error)) void readLink();
      throw error;
    }
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      // A 409 carries the library's "switched workspace" sentence: shown as is.
      if (data?.error) {
        toast.error(data.error);
      } else if (response.status >= 500) {
        toast.error(REVIEW_LINK_MAYBE_OFF_MESSAGE);
        void readLink();
      } else {
        toast.error("Couldn't turn the link off. Try again.");
      }
      throw new ConfirmFailureShown("REVOKE_FAILED");
    }
    setLink(null);
    toast.success("The link is off. It no longer works.");
  }, [readLink, toast, workspaceId]);

  async function handleCreate(event?: React.MouseEvent<HTMLButtonElement>) {
    const pressed = event?.currentTarget ?? null;
    setBusy(true);
    try {
      await makeLink();
      // R27 MM4 (pages L1): Create link is replaced by the new link; focus goes to its Copy button.
      focusAfterPress(pressed, () => copyRef.current);
    } catch (error) {
      const text = confirmFailureText(error, REVIEW_LINK_MAYBE_MADE_MESSAGE);
      if (text) toast.error(text);
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    if (!link?.url) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success("Link copied.");
    } catch {
      toast.error("Couldn't copy the link. Copy it by hand instead.");
    }
  }

  if (state === "changed") {
    return (
      <Alert variant="warning" title="Client review link">
        {/* A refusal: LoadError offers Reload page, never Retry. */}
        <LoadError message={changedMessage} onRetry={() => window.location.reload()} />
      </Alert>
    );
  }
  if (state === "failed") {
    return (
      <Alert variant="danger" title="Couldn't load the client review link">
        <LoadError
          message={loadError}
          onRetry={() => {
            setState("loading");
            setAttempt((count) => count + 1);
          }}
        />
      </Alert>
    );
  }
  // After Retry, a line in the card's place says it is loading, and takes focus (LoadError).
  // AnnouncedText, as the upload-link card's, since this view comes and goes.
  if (state === "loading" && attempt > 0) {
    return <AnnouncedText className="sr-only" text="Loading the client review link…" />;
  }
  if (state !== "ready") return null;

  return (
    <ReviewLinkPanelView
      link={link}
      busy={busy}
      onCreate={handleCreate}
      onCopy={copyUrl}
      copyRef={copyRef}
      onReplace={() => setConfirm("replace")}
      onTurnOff={() => setConfirm("off")}
      pausedByPlan={pausedByPlan}
      workspaceBlocked={workspaceBlocked}
      dialog={
        <ConfirmDialog
          open={confirm !== null}
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
          title={confirm === "replace" ? "Replace the client review link?" : "Turn off the client review link?"}
          description={
            confirm === "replace"
              ? "The old link stops working. Your client will need the new one."
              : "The old link stops working. Decisions your client already made stay as they are."
          }
          confirmText={confirm === "replace" ? "Replace link" : "Turn off"}
          destructive
          onConfirm={confirm === "replace" ? makeLink : turnOff}
          unreachableText={confirm === "replace" ? REVIEW_LINK_MAYBE_MADE_MESSAGE : REVIEW_LINK_MAYBE_OFF_MESSAGE}
        />
      }
    />
  );
}

export interface ReviewLinkPanelViewProps {
  link: ReviewLinkDto | null;
  busy: boolean;
  onCreate: (event?: React.MouseEvent<HTMLButtonElement>) => void;
  onCopy: () => void;
  /** The new link's Copy button, which takes focus after Create link. */
  copyRef?: React.Ref<HTMLButtonElement>;
  onReplace: () => void;
  onTurnOff: () => void;
  /** The confirm dialog, rendered inside the card. */
  dialog?: React.ReactNode;
  /** P1: the owner GET's pausedByPlan: the plan does not include client links. */
  pausedByPlan?: boolean;
  /** R21: the owner GET's sentence when the workspace is paused or its plan has ended. */
  workspaceBlocked?: string | null;
}

/** The panel as it renders, from its state (P1 fix round 1: testable without a browser). */
export function ReviewLinkPanelView({
  link,
  busy,
  onCreate,
  onCopy,
  copyRef,
  onReplace,
  onTurnOff,
  dialog = null,
  pausedByPlan = false,
  workspaceBlocked = null,
}: ReviewLinkPanelViewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Client review link</CardTitle>
        <CardDescription>
          Give this link to a client. Without an account, they see the posts scheduled for the
          next 60 days and can approve each one or ask for a change. A change request takes the
          post out of the schedule and emails the owners.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {link === null ? (
          workspaceBlocked ? (
            <p className="text-sm text-muted-foreground">{workspaceBlocked}</p>
          ) : pausedByPlan ? (
            <ClientLinkPlanNotice paused={false} />
          ) : (
            <Button type="button" loading={busy} onClick={onCreate}>
              Create link
            </Button>
          )
        ) : (
          <>
            {/* P1 and R21: a paused link's address answers "not active", so it is not offered to copy. */}
            {workspaceBlocked ? (
              <p className="text-sm text-muted-foreground">{workspaceBlocked}</p>
            ) : pausedByPlan ? (
              <ClientLinkPlanNotice paused />
            ) : link.url ? (
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={link.url}
                  aria-label="Client review link"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button ref={copyRef} type="button" variant="outline" onClick={onCopy}>
                  <Copy className="h-4 w-4" aria-hidden />
                  Copy
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                This link can&apos;t be shown again. Replace it to get a new one.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {workspaceBlocked || pausedByPlan ? null : (
                <Button type="button" variant="outline" size="sm" onClick={onReplace}>
                  Replace link
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={onTurnOff}>
                Turn off
              </Button>
            </div>
          </>
        )}
      </CardContent>
      {dialog}
    </Card>
  );
}

/**
 * The Queue's list address: page 1 (with every draft the client asked to
 * change, however old) or the page after `cursor`, for the workspace the page
 * was drawn for (R32: a tab left on it after another tab switched is refused,
 * never shown the other workspace's posts).
 */
export function queueListUrl(workspaceId: string | null, cursor?: string): string {
  const params = new URLSearchParams({ status: "scheduled,draft" });
  if (cursor) params.set("cursor", cursor);
  else params.set("clientChangesFirst", "1");
  return withWorkspaceId(`/api/posts?${params.toString()}`, workspaceId);
}

/**
 * R42 pages-a L1: what the Queue says when it cannot load, the same rule as
 * usePostJobs: no answer at all, or anything else the page couldn't use. A
 * 401 is the shared signed-out sentence (R21 pages L3), and a workspace
 * refusal keeps the shared switch sentence, whose step LoadError makes
 * Reload page.
 */
export const QUEUE_OFFLINE_TEXT =
  "We couldn't reach Vibe Socials to load your queue. Check your connection and try again.";
export const QUEUE_FAILED_TEXT = "We couldn't load your queue. Try again in a moment.";

/** Reads the Queue's first page, or the sentence that says why it couldn't. */
export async function readQueuePage(
  workspaceId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; data: PostsResponse } | { ok: false; error: string }> {
  try {
    // clientChangesFirst: the first page also carries every draft the client
    // asked to change (up to 20), however old, so none hides behind Load more.
    const response = await fetchOrNoAnswer(queueListUrl(workspaceId), { method: "GET" }, fetchImpl);
    const refusal = await readWorkspaceRefusalText(response);
    if (refusal) return { ok: false, error: refusal };
    if (!response.ok) return { ok: false, error: response.status === 401 ? SIGNED_OUT_ERROR : QUEUE_FAILED_TEXT };
    const data = (await response.json()) as PostsResponse | null;
    if (!data || !Array.isArray(data.jobs)) return { ok: false, error: QUEUE_FAILED_TEXT };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: isNoConnection(error) ? QUEUE_OFFLINE_TEXT : QUEUE_FAILED_TEXT };
  }
}

/** Client-rendered Queue: scheduled + draft posts with edit/cancel/publish/delete. */
/**
 * The empty Queue's buttons. R5-new-customer L6: Add many only when the plan
 * includes it (always with billing off); absent means included, as before.
 */
export function QueueEmptyActions({ addManyIncluded = true }: { addManyIncluded?: boolean }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      <Link href="/posts/new" className={buttonVariants({ variant: "primary" })}>
        Create a post
      </Link>
      {addManyIncluded ? (
        <Link href="/posts/bulk" className={buttonVariants({ variant: "outline" })}>
          Add many
        </Link>
      ) : null}
    </div>
  );
}

export function QueueView({
  workspaceId: pageWorkspaceId = null,
  footerSettings,
  addManyIncluded = true,
}: { workspaceId?: string | null; footerSettings?: CaptionFooterUser; addManyIncluded?: boolean } = {}) {
  const toast = useToast();
  const [jobs, setJobs] = useState<PostJobDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Team Workspaces (Task 7) — this view fetches independently of
  // usePostJobs (its own status filter), so it tracks
  // PostsResponse.workspaceMemberCount itself to gate QueueCard attribution.
  const [workspaceMemberCount, setWorkspaceMemberCount] = useState<number | null>(null);
  // Approval workflow — the caller's role decides whether Approve/Reject render.
  const [workspaceRole, setWorkspaceRole] = useState<"owner" | "member" | null>(null);
  // ...and whether the workspace requires owner approval, which decides what a
  // member's Publish / Edit actually does (lib/queueActions.ts).
  const [workspaceRequireApproval, setWorkspaceRequireApproval] = useState(false);
  // R32: the workspace the page was drawn for. Every read and action sends it,
  // so a switch in another tab answers 409 instead of reading or acting there.
  const workspaceId = pageWorkspaceId;
  // Clock for the owner's approve hint (does the proposed time still hold?).
  // Refreshed on an interval so the hint can't promise a time that has since
  // passed, and kept out of render so the component stays pure.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [deciding, setDeciding] = useState<{ id: string; decision: "approve" | "reject" } | null>(null);
  // R56 pages-a L5: per card, the sentence of its last refused Approve.
  const [approveRefusals, setApproveRefusals] = useState<Record<string, string>>({});
  // Activity pagination (Task C2) — the Queue fetches independently (its own
  // ?status= filter), so it tracks the cursor locally rather than via
  // usePostJobs. nextCursor is the next (older) page's ?cursor= token from the
  // last load (null = last page → hides Load more); loadingMore guards + spins
  // the button. The Queue has no background poll, so no page-1 merge is needed.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // R26 LL3: why the last Load more failed, said under the button.
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<QueueCardPost | null>(null);
  const [cancelTarget, setCancelTarget] = useState<QueueCardPost | null>(null);
  // For a post in a series: cancel it alone, or it and the later ones.
  const [cancelScope, setCancelScope] = useState<CancelScope>("one");
  const [publishTarget, setPublishTarget] = useState<QueueCardPost | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<QueueCardPost | null>(null);
  // R3-client-journey M1: the cards, a Feed and Story pair folded into one.
  const cards = useMemo(() => (jobs ? foldQueuePairs(jobs) : null), [jobs]);
  // List stays the default; the calendar is an alternate lens on the SAME
  // fetched jobs. N3: the choice is remembered per browser. It is read after
  // mount, not in the initializer, so the server render and the first client
  // render agree.
  const [view, setViewState] = useState<QueueViewMode>("list");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads browser storage once after hydration
    setViewState(readQueueView(() => window.localStorage));
  }, []);
  const setView = useCallback((mode: QueueViewMode) => {
    setViewState(mode);
    saveQueueView(() => window.localStorage, mode);
  }, []);

  // `silent` is the background re-sync after a stale-card error (409/503/404):
  // a failed silent refresh keeps the list on screen instead of replacing it
  // with the full-width error state.
  const load = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    try {
      const read = await readQueuePage(workspaceId);
      if (!read.ok) {
        if (!silent) setError(read.error);
        return;
      }
      const data = read.data;
      setJobs(sortQueue(data.jobs));
      setNextCursor(data.nextCursor);
      setLoadMoreError(null);
      setWorkspaceMemberCount(data.workspaceMemberCount);
      setWorkspaceRole(data.workspaceRole);
      setWorkspaceRequireApproval(data.workspaceRequireApproval);
      setNowMs(Date.now());
    } catch {
      if (!silent) setError(QUEUE_FAILED_TEXT);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-mount effect; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
    void load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // R28 NN2: the calendar reads the Queue again after a lost answer.
  const reloadSilently = useCallback(() => void load({ silent: true }), [load]);

  // R31 publishing L3-L5, pages L2: every refused post action, by the one rule
  // (postActionRefusal): the route's sentence, and a quiet reload unless the
  // page is for another workspace.
  const showRefusal = useCallback(
    (refusal: PostActionRefusal) => {
      toast.error(refusal.text);
      if (refusal.reload) void load({ silent: true });
      return refusal;
    },
    [load, toast],
  );

  const handleReload = useCallback(() => {
    setLoading(true);
    setError(null);
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    // Guard: nothing older to fetch, or a page is already in flight. The Button
    // is `disabled` while loadingMore is true; deps refresh this callback when
    // either value changes.
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await fetchOrNoAnswer(queueListUrl(workspaceId, nextCursor));
      const refusal = await readWorkspaceRefusalText(response);
      if (refusal) {
        setLoadMoreError(refusal);
        return;
      }
      if (!response.ok) {
        // The full-width error state belongs to the initial load / Retry only;
        // R26 LL3: a line under the button says why. nextCursor stays, so the
        // next press asks for the same page.
        setLoadMoreError(loadMoreFailureText(response.status));
        return;
      }
      const data: PostsResponse = await response.json();
      // Append the older page (de-duped by id), then re-apply the Queue's
      // scheduled-then-drafts ordering over the union. Keyset paging is by
      // (createdAt, id); sortQueue owns DISPLAY order, so an appended row can
      // land mid-list at its scheduledFor position — expected for the Queue.
      setJobs((prev) => (prev ? sortQueue(appendJobsPage(prev, data.jobs)) : sortQueue(data.jobs)));
      setNextCursor(data.nextCursor);
    } catch (error) {
      // Keep the loaded list + cursor for a retry.
      setLoadMoreError(loadMoreFailureText(isNoConnection(error) ? "offline" : 0));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, workspaceId]);

  const removeJobs = useCallback((ids: readonly string[]) => {
    setJobs((prev) => (prev ? prev.filter((j) => !ids.includes(j.id)) : prev));
  }, []);

  // Update cards in place from a server response (and re-sort: an approved
  // post moves from the pending group to its scheduled slot).
  const patchJobs = useCallback((ids: readonly string[], patch: EditPatch) => {
    setJobs((prev) =>
      prev ? sortQueue(prev.map((j) => (ids.includes(j.id) ? applyJobPatch(j, patch) : j))) : prev,
    );
  }, []);

  // R3-client-journey M1: what a successful answer does to a card's posts. On
  // a Feed and Story card it reaches both halves when the answer says the
  // other half changed too; when that half was left alone (or is gone), the
  // Queue is read again so it shows as it is.
  const applyAnswer = useCallback(
    (card: QueueCardPost, data: unknown, change: { kind: "remove" } | { kind: "update"; patch: EditPatch }) => {
      const [own, ...others] = changedJobIds(card, data);
      if (change.kind === "remove") removeJobs([own, ...others]);
      else {
        patchJobs([own], change.patch);
        // R4 lows, item 2: the Story keeps its own per-platform captions.
        if (others.length > 0) patchJobs(others, otherHalfPatch(change.patch));
      }
      if (pairNeedsReload(card, data)) void load({ silent: true });
    },
    [load, patchJobs, removeJobs],
  );

  // Approval workflow — owner decides a pending submission. The response says
  // what happened (decisionOutcome): approving a future-dated post keeps it in
  // the list as approved + scheduled; publishing-now and rejecting both leave
  // this scheduled/draft-filtered list. `reviewedUpdatedAt` pins the decision
  // to the version the owner is looking at (409 CHANGED_SINCE_REVIEW otherwise).
  const handleDecide = useCallback(
    async (job: QueueCardPost, decision: "approve" | "reject", pressed: HTMLElement | null) => {
      if (deciding) return;
      setDeciding({ id: job.id, decision });
      setApproveRefusals((current) => {
        if (!(job.id in current)) return current;
        const rest = { ...current };
        delete rest[job.id];
        return rest;
      });
      try {
        const answer = await sendActionRequest(
          `/api/posts/${job.id}/approval`,
          cardRequest(job, "POST", workspaceId, { decision, reviewedUpdatedAt: job.updatedAt }),
        );
        // R27 MM4: whatever comes next can remove the card or its decision row; focus moves on, never to the body.
        focusAfterPress(pressed);
        if (answer.kind === "not_sent") {
          toast.error(queueNotSentText(decision));
          return;
        }
        if (answer.kind === "no_answer") {
          // R27 publishing-flow L3: the decision may stand; show the Queue as it is.
          void load({ silent: true });
          toast.error(queueMayHaveGoneThroughText(decision));
          return;
        }
        const { response } = answer;
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) {
          // Stale card (already decided, changed since review, publish couldn't
          // start, gone): re-sync so no dead Approve/Reject buttons remain.
          const refusal = postActionRefusal(
            response.status,
            data,
            decision === "approve" ? "Couldn't approve this post." : "Couldn't reject this post.",
            "Approve",
          );
          // R57 pages-a L3: both are alerts, so a refusal is shown once. An
          // Approve refusal that leaves the card as it is stays as the card's
          // line; one that reloads the Queue may take the card away, so it toasts.
          if (decision === "approve" && !refusal.reload) {
            setApproveRefusals((current) => ({ ...current, [job.id]: refusal.text }));
            return;
          }
          showRefusal(refusal);
          return;
        }
        const outcome = decisionOutcome(decision, data);
        applyAnswer(job, data, outcome.kind === "remove" ? { kind: "remove" } : { kind: "update", patch: outcome.patch });
        toast.success(withPairNote(outcome.message, data));
      } catch {
        toast.error("Couldn't save that decision.");
      } finally {
        setDeciding(null);
      }
    },
    [applyAnswer, deciding, load, showRefusal, toast, workspaceId],
  );

  // Calendar drag-to-reschedule already PATCHed the server; mirror the change
  // into local state (and re-sort) so both views agree without a refetch. The
  // patch also carries a member's re-hold (scheduled -> pending).
  const applyReschedule = useCallback(
    (card: QueueCardPost, patch: JobPatch, data: unknown) => applyAnswer(card, data, { kind: "update", patch }),
    [applyAnswer],
  );

  // Cancel a scheduled post (ConfirmDialog onConfirm: a refusal it toasted is
  // thrown as ConfirmFailureShown, which keeps the dialog open; a request that
  // never left is said by the dialog).
  const confirmCancel = useCallback(async () => {
    if (!cancelTarget) return;
    const request = cancelRequest(cancelTarget, cancelScope, workspaceId);
    const answer = await sendActionRequest(request.url, request.init);
    if (answer.kind === "not_sent") {
      toast.error(CONFIRM_NOTHING_SENT_MESSAGE);
      throw new ConfirmFailureShown("CANCEL_NOT_SENT");
    }
    if (answer.kind === "no_answer") {
      void load({ silent: true });
      toast.error(request.series ? QUEUE_CANCEL_SERIES_MAYBE_MESSAGE : QUEUE_CANCEL_MAYBE_MESSAGE);
      return;
    }
    const { response } = answer;
    const data = (await response.json().catch(() => null)) as
      | { error?: string; cancelled?: number; notCancelled?: number; changed?: number }
      | null;
    if (!response.ok) {
      const refusal = postActionRefusal(response.status, data, "Couldn't cancel this post.");
      showRefusal(refusal);
      // R30 publishing L1: the card is stale (it started publishing or went out): close.
      if (refusal.movedOn) return;
      throw new ConfirmFailureShown("CANCEL_FAILED");
    }
    if (!request.series) {
      applyAnswer(cancelTarget, data, { kind: "remove" });
      toast.success(withPairNote("Scheduled post cancelled.", data));
      return;
    }
    // Several cards went; read the Queue again rather than guess which.
    void load({ silent: true });
    toast.success(seriesCancelToast(data));
  }, [applyAnswer, cancelScope, cancelTarget, load, showRefusal, toast, workspaceId]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const answer = await sendActionRequest(`/api/posts/${deleteTarget.id}`, cardRequest(deleteTarget, "DELETE", workspaceId));
    if (answer.kind === "not_sent") {
      toast.error(CONFIRM_NOTHING_SENT_MESSAGE);
      throw new ConfirmFailureShown("DELETE_NOT_SENT");
    }
    if (answer.kind === "no_answer") {
      void load({ silent: true });
      toast.error(QUEUE_DELETE_MAYBE_MESSAGE);
      return;
    }
    const { response } = answer;
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      const refusal = postActionRefusal(response.status, data, "Couldn't delete this draft.");
      showRefusal(refusal);
      // R31 publishing L3: a draft that was scheduled, published or deleted meanwhile: close.
      if (refusal.movedOn) return;
      throw new ConfirmFailureShown("DELETE_FAILED");
    }
    applyAnswer(deleteTarget, data, { kind: "remove" });
    toast.success(withPairNote("Draft deleted.", data));
  }, [applyAnswer, deleteTarget, load, showRefusal, toast, workspaceId]);

  const viewer: QueueViewer = {
    role: workspaceRole,
    requireApproval: workspaceRequireApproval,
  };
  const publishKind =
    publishTarget && getQueueCardActions(publishTarget, viewer).primary?.kind === "submit" ? "submit" : "publish";

  // "Publish now" - or, for a member under approval, "Submit for approval"
  // (same endpoint; the server decides). publishOutcome reads the answer: a
  // submission keeps the card as a pending draft, publishing removes it.
  const confirmPublish = useCallback(async () => {
    if (!publishTarget) return;
    const answer = await sendActionRequest(
      `/api/posts/${publishTarget.id}/publish`,
      cardRequest(publishTarget, "POST", workspaceId),
    );
    if (answer.kind === "not_sent") {
      toast.error(queueNotSentText(publishKind));
      throw new ConfirmFailureShown("PUBLISH_NOT_SENT");
    }
    if (answer.kind === "no_answer") {
      // R27 publishing-flow L3: it may have started; close and show the Queue as it is.
      void load({ silent: true });
      toast.error(queueMayHaveGoneThroughText(publishKind));
      return;
    }
    const { response } = answer;
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      const refusal = postActionRefusal(response.status, data, "Couldn't publish this post.", "Publish");
      showRefusal(refusal);
      // The card is stale (already awaiting approval, changed, gone, or the
      // dispatch failed): close rather than offer a dead retry.
      if (refusal.movedOn) return;
      throw new ConfirmFailureShown("PUBLISH_FAILED");
    }
    const outcome = publishOutcome(data);
    applyAnswer(publishTarget, data, outcome.kind === "remove" ? { kind: "remove" } : { kind: "update", patch: outcome.patch });
    toast.success(withPairNote(outcome.message, data));
  }, [applyAnswer, load, publishKind, publishTarget, showRefusal, toast, workspaceId]);

  const publishCopy = publishConfirmCopy(
    publishKind,
    publishTarget?.status ?? "draft",
    publishTarget?.publish?.targetPlatforms ?? null,
    publishTarget?.storyPlatforms ?? [],
  );
  // R3-client-journey M1: on a Feed and Story card the Story goes with it.
  const publishLine = publishTarget ? pairDialogLine(publishTarget, publishKind) : null;

  return (
    <div className={APP_PAGE_CLASS}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Queue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your scheduled posts and saved drafts. Edit, publish, or cancel them any time.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Same segmented-toggle pattern as the composer's "When to publish". */}
          <div
            role="group"
            aria-label="Queue view"
            className="inline-flex gap-0.5 rounded-[var(--radius)] border border-input p-0.5"
          >
            {(
              [
                ["list", "List"],
                ["calendar", "Calendar"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
                className={cn(
                  "rounded-[calc(var(--radius)-0.125rem)] px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  view === mode
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <Link
            href="/posts/new"
            className={buttonVariants({ variant: "primary", className: "gap-2" })}
          >
            <PlusCircle aria-hidden className="h-4 w-4" />
            Create post
          </Link>
        </div>
      </div>

      {workspaceRole === "owner" && workspaceId ? (
        <div className="mt-6">
          <ReviewLinkPanel workspaceId={workspaceId} />
        </div>
      ) : null}

      <div className="mt-8">
        {/* R30 PP2: status lines stay on the page from the first render; only their text changes. */}
        <p role="status" className="sr-only">{loading ? "Loading queue…" : ""}</p>
        {loading ? (
          <>
            <div className="space-y-3" aria-hidden>
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-28 w-full" />
              ))}
            </div>
          </>
        ) : error ? (
          <Alert variant="danger" title="Couldn't load your queue">
            <LoadError message={error} onRetry={handleReload} />
          </Alert>
        ) : (!jobs || jobs.length === 0) && nextCursor === null && view === "list" ? (
          // R60 client-journey-2 L1: only on the last page. Cancel, Delete and
          // the like remove cards locally, so an emptied first page may still
          // have older posts after it (Media's rule).
          <EmptyState
            icon={<CalendarClock />}
            title="Nothing queued"
            description="Schedule a post or save a draft from the composer and it'll show up here."
            action={<QueueEmptyActions addManyIncluded={addManyIncluded} />}
          />
        ) : (!jobs || jobs.length === 0) && nextCursor === null ? (
          // N3: an empty Queue's calendar still shows the month to plan in.
          <QueueCalendar
            jobs={[]}
            onShowList={() => setView("list")}
            onEdit={setEditTarget}
            onRescheduled={applyReschedule}
            onReload={reloadSilently}
            workspaceId={workspaceId}
          />
        ) : (
          <>
            {view === "calendar" ? (
              <QueueCalendar
                jobs={cards ?? []}
                onShowList={() => setView("list")}
                onEdit={setEditTarget}
                onRescheduled={applyReschedule}
                onReload={reloadSilently}
                workspaceId={workspaceId}
                moreToLoad={nextCursor !== null}
              />
            ) : (cards ?? []).length === 0 ? (
              // R60 client-journey-2 L1: every card on this page was removed; Load more is below.
              <p className="text-center text-sm text-muted-foreground">Older posts may be on the next page.</p>
            ) : (
              <div className="space-y-3">
                {(cards ?? []).map((card) => (
                  <QueueCard
                    key={card.id}
                    job={card}
                    showAttribution={(workspaceMemberCount ?? 0) > 1}
                    viewer={viewer}
                    nowMs={nowMs}
                    onEdit={setEditTarget}
                    onCancel={(target) => {
                      setCancelScope("one");
                      setCancelTarget(target);
                    }}
                    onPublish={setPublishTarget}
                    onDelete={setDeleteTarget}
                    onDecide={handleDecide}
                    deciding={deciding?.id === card.id ? deciding.decision : null}
                    approveRefusal={approveRefusals[card.id] ?? null}
                  />
                ))}
              </div>
            )}
            {/* Older pages may hold scheduled posts too — keep Load more in
                BOTH views. */}
            {nextCursor !== null ? (
              <div className="mt-4 flex flex-col items-center gap-2">
                <LoadMoreButton error={loadMoreError} loading={loadingMore} onLoadMore={loadMore} />
              </div>
            ) : null}
          </>
        )}
        <p role="status" className="mt-2 text-center text-sm text-destructive empty:sr-only">{loadMoreError}</p>
      </div>

      {editTarget ? (
        <QueueEditDialog
          key={editTarget.id}
          job={editTarget}
          viewer={viewer}
          workspaceId={workspaceId}
          footerSettings={footerSettings}
          onClose={() => setEditTarget(null)}
          onPartialSave={(patch, answer) => applyAnswer(editTarget, answer, { kind: "update", patch })}
          onStale={() => void load({ silent: true })}
          onSaved={(patch, answer) => {
            applyAnswer(editTarget, answer, { kind: "update", patch });
            setEditTarget(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
        title="Cancel this scheduled post?"
        description={
          <span className="block space-y-2">
            {cancelTarget?.seriesId ? (
              <>
                <span className="block">This post repeats. Cancelled posts won&apos;t be published.</span>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="cancel-scope"
                    checked={cancelScope === "one"}
                    onChange={() => setCancelScope("one")}
                  />
                  Cancel this post
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="cancel-scope"
                    checked={cancelScope === "rest"}
                    onChange={() => setCancelScope("rest")}
                  />
                  Cancel this and all later posts in the series
                </label>
              </>
            ) : (
              <span className="block">It won&apos;t be published. You can recreate it later from the composer.</span>
            )}
            {cancelTarget && pairDialogLine(cancelTarget, "cancel") ? (
              <span className="block">{pairDialogLine(cancelTarget, "cancel")}</span>
            ) : null}
          </span>
        }
        confirmText={
          cancelScope === "rest" && cancelTarget?.seriesId
            ? "Cancel posts"
            : cancelTarget && takesOtherHalf(cancelTarget)
              ? "Cancel both"
              : "Cancel post"
        }
        cancelText="Keep it"
        destructive
        onConfirm={confirmCancel}
      />

      <ConfirmDialog
        open={publishTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPublishTarget(null);
        }}
        title={publishCopy.title}
        description={publishLine ? `${publishCopy.description} ${publishLine}` : publishCopy.description}
        confirmText={publishCopy.confirmText}
        onConfirm={confirmPublish}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete this draft?"
        description={
          <span className="block space-y-2">
            <span className="block">This can&apos;t be undone. Your uploaded media stays in your library.</span>
            {deleteTarget && pairDialogLine(deleteTarget, "delete") ? (
              <span className="block">{pairDialogLine(deleteTarget, "delete")}</span>
            ) : null}
          </span>
        }
        confirmText={deleteTarget && takesOtherHalf(deleteTarget) ? "Delete both" : undefined}
        destructive
        onConfirm={confirmDelete}
      />
    </div>
  );
}
