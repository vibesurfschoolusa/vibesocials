"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, PlusCircle } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { fieldBaseClasses } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { MediaThumb } from "@/components/media-thumb";
import { QueueCalendar } from "./queue-calendar";
import { cn } from "@/lib/cn";
import {
  PLATFORM_CAPTIONS_HEADING,
  platformCaptionEntries,
  platformLabel,
  TIKTOK_PRIVACY_LABELS,
} from "@/lib/platforms";
import type { PostJobDTO, PostsResponse } from "@/lib/postsDto";
import { appendJobsPage } from "@/lib/postsPagination";
import {
  applyJobPatch,
  approveHint,
  checkScheduleTime,
  decisionOutcome,
  editDialogModel,
  editOutcome,
  editSaveLabel,
  getQueueCardActions,
  publishConfirmCopy,
  publishNeedsApproval,
  publishOutcome,
  queueStatusBadge,
  shouldRefetchAfterError,
  type JobPatch,
  type QueueViewer,
} from "@/lib/queueActions";
import { scheduleDraft } from "@/lib/scheduleDraft";
import {
  SCHEDULE_BUFFER_MS,
  localTimeZoneLabel,
  toDateTimeLocalValue,
} from "@/lib/scheduling";

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

/**
 * Posts awaiting approval first (they block someone else's work — oldest
 * submission on top), then scheduled posts soonest-first (next up), then drafts
 * newest-first.
 */
function sortQueue(jobs: PostJobDTO[]): PostJobDTO[] {
  const pendingApproval = jobs
    .filter((j) => j.approvalState === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const rest = jobs.filter((j) => j.approvalState !== "pending");
  const scheduled = rest
    .filter((j) => j.status === "scheduled")
    .sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? ""));
  const drafts = rest
    .filter((j) => j.status === "draft")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...pendingApproval, ...scheduled, ...drafts];
}

interface QueueCardProps {
  job: PostJobDTO;
  /** Team Workspaces (Task 7, design §7) — show `by {createdBy.name}` next to the timestamp. */
  showAttribution: boolean;
  /** Approval workflow — role + workspace setting decide which actions render (lib/queueActions.ts). */
  viewer: QueueViewer;
  /** Clock for the approve hint, refreshed on an interval (no impure Date in render). */
  nowMs: number;
  onEdit: (job: PostJobDTO) => void;
  onCancel: (job: PostJobDTO) => void;
  onPublish: (job: PostJobDTO) => void;
  onDelete: (job: PostJobDTO) => void;
  /** Approval workflow — decide a pending submission (owners only). */
  onDecide: (job: PostJobDTO, decision: "approve" | "reject") => void;
  /** Approval workflow — a decision is in flight for this job. */
  deciding: boolean;
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
}: QueueCardProps) {
  const awaitingApproval = job.approvalState === "pending";
  const actions = getQueueCardActions(job, viewer);
  const badge = queueStatusBadge(job);
  const title = job.caption?.trim() || "Untitled post";
  // 2026-11-01 audit (M1): the per-platform texts that REPLACE the base caption
  // on publish. Shown on every card that has them, most importantly to the owner
  // deciding on a pending post - approving means approving these too.
  const platformCaptions = platformCaptionEntries(job.platformCaptions);

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <MediaThumb media={job.media} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          {/* A post awaiting approval is technically a draft, but it may carry
              the time its author chose — show that, or the owner is asked to
              approve a schedule they can't see. */}
          {awaitingApproval && job.scheduledFor ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Proposed for{" "}
              <time dateTime={job.scheduledFor}>
                {formatTimestamp(job.scheduledFor)}
              </time>
              {showAttribution && job.createdBy ? <> · by {job.createdBy.name}</> : null}
            </p>
          ) : job.status === "scheduled" && job.scheduledFor ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Scheduled for{" "}
              <time dateTime={job.scheduledFor}>
                {formatTimestamp(job.scheduledFor)}
              </time>
              {showAttribution && job.createdBy ? <> · by {job.createdBy.name}</> : null}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Saved{" "}
              <time dateTime={job.createdAt}>{formatTimestamp(job.createdAt)}</time>
              {showAttribution && job.createdBy ? <> · by {job.createdBy.name}</> : null}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {job.publish?.targetPlatforms?.length
              ? `Publishing to ${job.publish.targetPlatforms.map(platformLabel).join(", ")}`
              : "Publishing to all platforms connected at publish time"}
            {job.publish?.youtubePrivacy ? ` · YouTube: ${job.publish.youtubePrivacy}` : ""}
            {job.publish?.tiktokPrivacy ? ` · TikTok: ${TIKTOK_PRIVACY_LABELS[job.publish.tiktokPrivacy] ?? job.publish.tiktokPrivacy}` : ""}
          </p>
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
        <Badge variant={badge.tone}>{badge.label}</Badge>
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
                loading={deciding}
                aria-label={`Approve "${title}"`}
                onClick={() => onDecide(job, "approve")}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={deciding}
                aria-label={`Reject "${title}"`}
                onClick={() => onDecide(job, "reject")}
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
        </div>
      ) : (
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {actions.edit ? (
          <Button size="sm" variant="outline" aria-label={`Edit "${title}"`} onClick={() => onEdit(job)}>
            Edit
          </Button>
        ) : null}
        {actions.primary ? (
          <Button
            size="sm"
            variant="outline"
            aria-label={
              actions.primary.kind === "submit"
                ? `Submit "${title}" for approval`
                : `Publish "${title}" now`
            }
            onClick={() => onPublish(job)}
          >
            {actions.primary.label}
          </Button>
        ) : null}
        {actions.secondary === "cancel" ? (
          <Button size="sm" variant="ghost" aria-label={`Cancel "${title}"`} onClick={() => onCancel(job)}>
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Delete "${title}"`}
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
  onClose,
  onSaved,
  onPartialSave,
  onStale,
}: {
  job: PostJobDTO;
  viewer: QueueViewer;
  onClose: () => void;
  /** The save is complete: patch the card and close the dialog. */
  onSaved: (patch: JobPatch) => void;
  /** Part of the save landed (caption) but the dialog stays open: patch the card only. */
  onPartialSave: (patch: JobPatch) => void;
  /** The server's state for this post is unknown (unreadable reply): re-sync the list. */
  onStale: () => void;
}) {
  const toast = useToast();
  const isScheduled = job.status === "scheduled";
  const model = editDialogModel(job, viewer);
  const [caption, setCaption] = useState(job.caption ?? "");
  // The caption as last persisted — a draft whose caption PATCH succeeded but
  // whose scheduling call failed must not re-PATCH an unchanged caption on retry.
  const [savedCaption, setSavedCaption] = useState(job.caption);
  const [scheduledForLocal, setScheduledForLocal] = useState(
    isScheduled && job.scheduledFor ? toDateTimeLocalValue(new Date(job.scheduledFor)) : "",
  );
  const [saving, setSaving] = useState(false);
  // Picker `min` (now + buffer). Lazy useState initializer computes it once at
  // mount, keeping impure `Date.now()` off the render path; submit-time
  // validation is the authoritative future-time check.
  const [minScheduleLocal] = useState(() =>
    toDateTimeLocalValue(new Date(Date.now() + SCHEDULE_BUFFER_MS)),
  );

  const handleSave = async () => {
    const trimmed = caption.trim();
    if (!trimmed) {
      toast.error("Caption can't be empty.");
      return;
    }

    // A scheduled post always carries a time; a draft only when one was chosen.
    let scheduledIso: string | null = null;
    if (isScheduled || scheduledForLocal) {
      const check = checkScheduleTime(scheduledForLocal, Date.now(), SCHEDULE_BUFFER_MS);
      if (!check.ok) {
        toast.error(check.error);
        return;
      }
      scheduledIso = check.iso;
    }

    setSaving(true);
    try {
      if (isScheduled || scheduledIso === null) {
        // Plain save: scheduled posts send caption + time, drafts just the caption.
        const response = await fetch(`/api/posts/${job.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseCaption: trimmed,
            ...(scheduledIso ? { scheduledFor: scheduledIso } : {}),
          }),
        });
        if (!response.ok) {
          const errorData = (await response.json().catch(() => null)) as { error?: string } | null;
          toast.error(errorData?.error ?? "Couldn't save your changes.");
          setSaving(false);
          return;
        }
        const data = await response.json().catch(() => null);
        const outcome = editOutcome(data);
        toast.success(outcome.message);
        onSaved({
          caption: trimmed,
          ...(scheduledIso ? { scheduledFor: scheduledIso } : {}),
          ...outcome.patch,
        });
        return;
      }

      // Schedule a draft (lib/scheduleDraft.ts owns the sequence and its tests).
      const result = await scheduleDraft({
        fetchFn: (url, init) => fetch(url, init),
        jobId: job.id,
        caption: trimmed,
        originalCaption: savedCaption,
        scheduledForIso: scheduledIso,
        submitsForApproval: publishNeedsApproval(job, viewer),
      });
      if (result.kind === "failed") {
        // Keep the dialog open with the user's input; the server says why. If
        // the caption PATCH landed, reflect it on the card and remember it so a
        // retry doesn't re-PATCH an unchanged caption.
        if (result.captionSaved) {
          setSavedCaption(trimmed);
          onPartialSave({ caption: trimmed });
        }
        toast.error(result.error);
        if (result.reason === "unreadable_response") onStale();
        setSaving(false);
        return;
      }
      toast.success(result.message);
      onSaved(result.patch);
    } catch {
      toast.error("Couldn't save your changes.");
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
          />
        </div>
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
        </div>
        {model.notice ? <p className="text-sm text-muted-foreground">{model.notice}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} loading={saving}>
          {editSaveLabel(job, viewer, scheduledForLocal !== "")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Client-rendered Queue: scheduled + draft posts with edit/cancel/publish/delete. */
export function QueueView() {
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
  // Clock for the owner's approve hint (does the proposed time still hold?).
  // Refreshed on an interval so the hint can't promise a time that has since
  // passed, and kept out of render so the component stays pure.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [decidingId, setDecidingId] = useState<string | null>(null);
  // Activity pagination (Task C2) — the Queue fetches independently (its own
  // ?status= filter), so it tracks the cursor locally rather than via
  // usePostJobs. nextCursor is the next (older) page's ?cursor= token from the
  // last load (null = last page → hides Load more); loadingMore guards + spins
  // the button. The Queue has no background poll, so no page-1 merge is needed.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [editTarget, setEditTarget] = useState<PostJobDTO | null>(null);
  const [cancelTarget, setCancelTarget] = useState<PostJobDTO | null>(null);
  const [publishTarget, setPublishTarget] = useState<PostJobDTO | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PostJobDTO | null>(null);
  // List stays the default; the calendar is an alternate lens on the SAME
  // fetched jobs. Deliberately not persisted (YAGNI).
  const [view, setView] = useState<"list" | "calendar">("list");

  // `silent` is the background re-sync after a stale-card error (409/503/404):
  // a failed silent refresh keeps the list on screen instead of replacing it
  // with the full-width error state.
  const load = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    try {
      const response = await fetch("/api/posts?status=scheduled,draft");
      if (!response.ok) {
        if (!silent) {
          setError(
            response.status === 401
              ? "Please sign in to view your queue."
              : "Failed to load your queue.",
          );
        }
        return;
      }
      const data: PostsResponse = await response.json();
      setJobs(sortQueue(data.jobs));
      setNextCursor(data.nextCursor);
      setWorkspaceMemberCount(data.workspaceMemberCount);
      setWorkspaceRole(data.workspaceRole);
      setWorkspaceRequireApproval(data.workspaceRequireApproval);
      setNowMs(Date.now());
    } catch {
      if (!silent) setError("Failed to load your queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-mount effect; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
    void load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

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
    try {
      const response = await fetch(
        `/api/posts?status=scheduled,draft&cursor=${encodeURIComponent(nextCursor)}`,
      );
      if (!response.ok) {
        // Silent — the full-width error state belongs to the initial load /
        // Retry only. Leave nextCursor intact so the button stays for a retry.
        return;
      }
      const data: PostsResponse = await response.json();
      // Append the older page (de-duped by id), then re-apply the Queue's
      // scheduled-then-drafts ordering over the union. Keyset paging is by
      // (createdAt, id); sortQueue owns DISPLAY order, so an appended row can
      // land mid-list at its scheduledFor position — expected for the Queue.
      setJobs((prev) => (prev ? sortQueue(appendJobsPage(prev, data.jobs)) : sortQueue(data.jobs)));
      setNextCursor(data.nextCursor);
    } catch {
      // Keep the loaded list + cursor for a retry.
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  const removeJob = useCallback((id: string) => {
    setJobs((prev) => (prev ? prev.filter((j) => j.id !== id) : prev));
  }, []);

  // Update one card in place from a server response (and re-sort: an approved
  // post moves from the pending group to its scheduled slot).
  const patchJob = useCallback((id: string, patch: JobPatch) => {
    setJobs((prev) =>
      prev ? sortQueue(prev.map((j) => (j.id === id ? applyJobPatch(j, patch) : j))) : prev,
    );
  }, []);

  // Approval workflow — owner decides a pending submission. The response says
  // what happened (decisionOutcome): approving a future-dated post keeps it in
  // the list as approved + scheduled; publishing-now and rejecting both leave
  // this scheduled/draft-filtered list. `reviewedUpdatedAt` pins the decision
  // to the version the owner is looking at (409 CHANGED_SINCE_REVIEW otherwise).
  const handleDecide = useCallback(
    async (job: PostJobDTO, decision: "approve" | "reject") => {
      if (decidingId) return;
      setDecidingId(job.id);
      try {
        const response = await fetch(`/api/posts/${job.id}/approval`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, reviewedUpdatedAt: job.updatedAt }),
        });
        const data = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        if (!response.ok) {
          toast.error(
            data?.error ??
              (decision === "approve"
                ? "Couldn't approve this post."
                : "Couldn't reject this post."),
          );
          // Stale card (already decided, changed since review, publish couldn't
          // start, gone): re-sync so no dead Approve/Reject buttons remain.
          if (shouldRefetchAfterError(response.status)) void load({ silent: true });
          return;
        }
        const outcome = decisionOutcome(decision, data);
        if (outcome.kind === "remove") removeJob(job.id);
        else patchJob(job.id, outcome.patch);
        toast.success(outcome.message);
      } catch {
        toast.error("Couldn't save that decision.");
      } finally {
        setDecidingId(null);
      }
    },
    [decidingId, load, patchJob, removeJob, toast],
  );

  // Calendar drag-to-reschedule already PATCHed the server; mirror the change
  // into local state (and re-sort) so both views agree without a refetch. The
  // patch also carries a member's re-hold (scheduled -> pending).
  const applyReschedule = useCallback(
    (id: string, patch: JobPatch) => patchJob(id, patch),
    [patchJob],
  );

  // Cancel a scheduled post (ConfirmDialog onConfirm: throw to keep it open on
  // failure, per the dialog's contract).
  const confirmCancel = useCallback(async () => {
    if (!cancelTarget) return;
    const response = await fetch(`/api/posts/${cancelTarget.id}/cancel`, {
      method: "POST",
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? "Couldn't cancel this post.");
      throw new Error("CANCEL_FAILED");
    }
    removeJob(cancelTarget.id);
    toast.success("Scheduled post cancelled.");
  }, [cancelTarget, removeJob, toast]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const response = await fetch(`/api/posts/${deleteTarget.id}`, { method: "DELETE" });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? "Couldn't delete this draft.");
      throw new Error("DELETE_FAILED");
    }
    removeJob(deleteTarget.id);
    toast.success("Draft deleted.");
  }, [deleteTarget, removeJob, toast]);

  // "Publish now" - or, for a member under approval, "Submit for approval"
  // (same endpoint; the server decides). publishOutcome reads the answer: a
  // submission keeps the card as a pending draft, publishing removes it.
  const confirmPublish = useCallback(async () => {
    if (!publishTarget) return;
    const response = await fetch(`/api/posts/${publishTarget.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      toast.error(data?.error ?? "Couldn't publish this post.");
      if (shouldRefetchAfterError(response.status)) {
        // The card is stale (already awaiting approval, changed, gone, or the
        // dispatch failed): re-sync and close rather than offer a dead retry.
        void load({ silent: true });
        return;
      }
      throw new Error("PUBLISH_FAILED");
    }
    const outcome = publishOutcome(data);
    if (outcome.kind === "remove") removeJob(publishTarget.id);
    else patchJob(publishTarget.id, outcome.patch);
    toast.success(outcome.message);
  }, [load, patchJob, publishTarget, removeJob, toast]);

  const viewer: QueueViewer = {
    role: workspaceRole,
    requireApproval: workspaceRequireApproval,
  };
  const publishCopy = publishConfirmCopy(
    publishTarget && getQueueCardActions(publishTarget, viewer).primary?.kind === "submit"
      ? "submit"
      : "publish",
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
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

      <div className="mt-8">
        {loading ? (
          <>
            <p role="status" className="sr-only">Loading queue…</p>
            <div className="space-y-3" aria-hidden>
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-28 w-full" />
              ))}
            </div>
          </>
        ) : error ? (
          <Alert variant="danger" title="Couldn't load your queue">
            <div className="flex flex-col items-start gap-3">
              <p>{error}</p>
              <Button size="sm" variant="outline" onClick={handleReload}>
                Retry
              </Button>
            </div>
          </Alert>
        ) : !jobs || jobs.length === 0 ? (
          <EmptyState
            icon={<CalendarClock />}
            title="Nothing queued"
            description="Schedule a post or save a draft from the composer and it'll show up here."
            action={
              <Link
                href="/posts/new"
                className={buttonVariants({ variant: "primary" })}
              >
                Create a post
              </Link>
            }
          />
        ) : (
          <>
            {view === "calendar" ? (
              <QueueCalendar
                jobs={jobs}
                onEdit={setEditTarget}
                onRescheduled={applyReschedule}
              />
            ) : (
              <div className="space-y-3">
                {jobs.map((job) => (
                  <QueueCard
                    key={job.id}
                    job={job}
                    showAttribution={(workspaceMemberCount ?? 0) > 1}
                    viewer={viewer}
                    nowMs={nowMs}
                    onEdit={setEditTarget}
                    onCancel={setCancelTarget}
                    onPublish={setPublishTarget}
                    onDelete={setDeleteTarget}
                    onDecide={handleDecide}
                    deciding={decidingId === job.id}
                  />
                ))}
              </div>
            )}
            {/* Older pages may hold scheduled posts too — keep Load more in
                BOTH views. */}
            {nextCursor !== null ? (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" size="sm" loading={loadingMore} onClick={loadMore}>
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {editTarget ? (
        <QueueEditDialog
          key={editTarget.id}
          job={editTarget}
          viewer={viewer}
          onClose={() => setEditTarget(null)}
          onPartialSave={(patch) => patchJob(editTarget.id, patch)}
          onStale={() => void load({ silent: true })}
          onSaved={(patch) => {
            patchJob(editTarget.id, patch);
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
        description="It won't be published. You can recreate it later from the composer."
        confirmText="Cancel post"
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
        description={publishCopy.description}
        confirmText={publishCopy.confirmText}
        onConfirm={confirmPublish}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete this draft?"
        description="This can't be undone. Your uploaded media stays in your library."
        destructive
        onConfirm={confirmDelete}
      />
    </div>
  );
}
