"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, PlusCircle } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
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
import { platformLabel, TIKTOK_PRIVACY_LABELS } from "@/lib/platforms";
import type { PostJobDTO, PostsResponse } from "@/lib/postsDto";
import { appendJobsPage } from "@/lib/postsPagination";
import {
  SCHEDULE_BUFFER_MS,
  localDateTimeToUtcIso,
  localTimeZoneLabel,
  toDateTimeLocalValue,
} from "@/lib/scheduling";

const QUEUE_STATUS_META: Record<
  "scheduled" | "draft",
  { variant: BadgeVariant; label: string }
> = {
  scheduled: { variant: "secondary", label: "Scheduled" },
  draft: { variant: "neutral", label: "Draft" },
};

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
  /** Approval workflow — only an owner gets Approve/Reject controls. */
  isOwner: boolean;
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
  isOwner,
  onEdit,
  onCancel,
  onPublish,
  onDelete,
  onDecide,
  deciding,
}: QueueCardProps) {
  const awaitingApproval = job.approvalState === "pending";
  const meta =
    job.status === "scheduled"
      ? QUEUE_STATUS_META.scheduled
      : QUEUE_STATUS_META.draft;
  const title = job.caption?.trim() || "Untitled post";

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
        </div>
        <Badge variant={awaitingApproval ? "warning" : meta.variant}>
          {awaitingApproval ? "Awaiting approval" : meta.label}
        </Badge>
      </div>

      {/* Approval workflow: a pending submission gets its own action row.
          Owners decide; the member who submitted just sees where it stands.
          The normal Edit/Publish/Delete row is suppressed so nobody can
          side-step review by publishing the draft directly. */}
      {awaitingApproval ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {isOwner ? (
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
                {job.scheduledFor
                  ? "Approving keeps its scheduled time."
                  : "Approving publishes it now."}
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
        <Button size="sm" variant="outline" aria-label={`Edit "${title}"`} onClick={() => onEdit(job)}>
          Edit
        </Button>
        <Button size="sm" variant="outline" aria-label={`Publish "${title}" now`} onClick={() => onPublish(job)}>
          Publish now
        </Button>
        {job.status === "scheduled" ? (
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
 * Scheduled jobs also edit their `scheduledFor`; drafts edit caption only (a
 * draft is scheduled by publishing it with a time).
 */
function QueueEditDialog({
  job,
  onClose,
  onSaved,
}: {
  job: PostJobDTO;
  onClose: () => void;
  onSaved: (patch: { caption: string; scheduledFor: string | null }) => void;
}) {
  const toast = useToast();
  const isScheduled = job.status === "scheduled";
  const [caption, setCaption] = useState(job.caption ?? "");
  const [scheduledForLocal, setScheduledForLocal] = useState(
    job.scheduledFor ? toDateTimeLocalValue(new Date(job.scheduledFor)) : "",
  );
  const [saving, setSaving] = useState(false);
  // Picker `min` (now + buffer). Lazy useState initializer computes it once at
  // mount, keeping impure `Date.now()` off the render path; submit-time
  // validation is the authoritative future-time check.
  const [minScheduleLocal] = useState(() =>
    toDateTimeLocalValue(new Date(Date.now() + SCHEDULE_BUFFER_MS)),
  );

  const handleSave = useCallback(async () => {
    if (!caption.trim()) {
      toast.error("Caption can't be empty.");
      return;
    }

    const body: {
      baseCaption: string;
      scheduledFor?: string;
    } = { baseCaption: caption.trim() };

    if (isScheduled) {
      const iso = localDateTimeToUtcIso(scheduledForLocal);
      if (!iso) {
        toast.error("Choose a valid date and time.");
        return;
      }
      if (new Date(iso).getTime() < Date.now() + SCHEDULE_BUFFER_MS) {
        toast.error("Scheduled time must be at least a minute in the future.");
        return;
      }
      body.scheduledFor = iso;
    }

    setSaving(true);
    try {
      const response = await fetch(`/api/posts/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(data?.error ?? "Couldn't save your changes.");
        setSaving(false);
        return;
      }
      toast.success("Changes saved.");
      onSaved({
        caption: body.baseCaption,
        scheduledFor: body.scheduledFor ?? job.scheduledFor,
      });
    } catch {
      toast.error("Couldn't save your changes.");
      setSaving(false);
    }
  }, [caption, isScheduled, scheduledForLocal, job.id, job.scheduledFor, onSaved, toast]);

  return (
    <Dialog open onOpenChange={(open) => (!open && !saving ? onClose() : undefined)}>
      <DialogHeader>
        <DialogTitle>{isScheduled ? "Edit scheduled post" : "Edit draft"}</DialogTitle>
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
        {isScheduled ? (
          <div className="space-y-1.5">
            <Label htmlFor="queue-edit-time">Publish at</Label>
            <input
              id="queue-edit-time"
              type="datetime-local"
              value={scheduledForLocal}
              min={minScheduleLocal || undefined}
              onChange={(event) => setScheduledForLocal(event.target.value)}
              className={cn(fieldBaseClasses, "h-10 px-3 py-2")}
            />
            <p className="text-xs text-muted-foreground">
              Times are in {localTimeZoneLabel()} (your browser&apos;s timezone).
            </p>
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} loading={saving}>
          Save changes
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

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/posts?status=scheduled,draft");
      if (!response.ok) {
        setError(
          response.status === 401
            ? "Please sign in to view your queue."
            : "Failed to load your queue.",
        );
        return;
      }
      const data: PostsResponse = await response.json();
      setJobs(sortQueue(data.jobs));
      setNextCursor(data.nextCursor);
      setWorkspaceMemberCount(data.workspaceMemberCount);
      setWorkspaceRole(data.workspaceRole);
    } catch {
      setError("Failed to load your queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  // Approval workflow — owner decides a pending submission. On approve the job
  // leaves the awaiting state (scheduled or publishing), on reject it's
  // cancelled; either way it drops out of this scheduled/draft-filtered list.
  const handleDecide = useCallback(
    async (job: PostJobDTO, decision: "approve" | "reject") => {
      if (decidingId) return;
      setDecidingId(job.id);
      try {
        const response = await fetch(`/api/posts/${job.id}/approval`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        });
        const data = (await response.json().catch(() => null)) as
          | { error?: string; status?: string }
          | null;
        if (!response.ok) {
          toast.error(
            data?.error ??
              (decision === "approve"
                ? "Couldn't approve this post."
                : "Couldn't reject this post."),
          );
          return;
        }
        removeJob(job.id);
        toast.success(
          decision === "reject"
            ? "Post rejected — the author has been notified."
            : data?.status === "scheduled"
              ? "Approved — it will publish at its scheduled time."
              : "Approved — publishing now.",
        );
      } catch {
        toast.error("Couldn't save that decision.");
      } finally {
        setDecidingId(null);
      }
    },
    [decidingId, removeJob, toast],
  );

  // Calendar drag-to-reschedule already PATCHed the server; mirror the change
  // into local state (and re-sort) so both views agree without a refetch.
  const applyReschedule = useCallback((id: string, scheduledFor: string) => {
    setJobs((prev) =>
      prev
        ? sortQueue(prev.map((j) => (j.id === id ? { ...j, scheduledFor } : j)))
        : prev,
    );
  }, []);

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

  const confirmPublish = useCallback(async () => {
    if (!publishTarget) return;
    const response = await fetch(`/api/posts/${publishTarget.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(data?.error ?? "Couldn't publish this post.");
      throw new Error("PUBLISH_FAILED");
    }
    removeJob(publishTarget.id);
    toast.success("Publishing now — track it in Activity.");
  }, [publishTarget, removeJob, toast]);

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
                    isOwner={workspaceRole === "owner"}
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
          onClose={() => setEditTarget(null)}
          onSaved={(patch) => {
            setJobs((prev) =>
              prev
                ? sortQueue(
                    prev.map((j) =>
                      j.id === editTarget.id
                        ? { ...j, caption: patch.caption, scheduledFor: patch.scheduledFor }
                        : j,
                    ),
                  )
                : prev,
            );
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
        title="Publish this post now?"
        description="It will be sent to your connected platforms right away instead of waiting."
        confirmText="Publish now"
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
