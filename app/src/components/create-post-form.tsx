"use client";

import { useState, useEffect, useMemo, useRef, useCallback, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { upload } from '@vercel/blob/client';
import { PlugZap, Sparkles } from "lucide-react";
import type { Platform } from "@prisma/client";
import { PlatformPreviewList } from "./composer/platform-preview";
import { LocationAutocomplete } from "./location-autocomplete";
import { TikTokPostSettings } from "./tiktok-post-settings";
import { YouTubePostSettings } from "./youtube-post-settings";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { fieldBaseClasses, Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useConnections } from "@/hooks/useConnections";
import { generateBlobKey } from "@/lib/blobKey";
import type { CaptionFooterUser } from "@/lib/captionFooter";
import { cn } from "@/lib/cn";
import { composerPublishConfirmCopy } from "@/lib/composerConfirm";
import { deriveComposerGate } from "@/lib/composerGate";
import {
  COMPOSER_DISPATCH_FAILED_MESSAGE,
  composerSubmitOutcome,
} from "@/lib/composerSubmitOutcome";
import type { MediaItemDto } from "@/lib/mediaDto";
import { PLATFORM_ORDER, platformLabel, TIKTOK_PRIVACY_LABELS } from "@/lib/platforms";
import {
  deriveComposerPlatforms,
  isTikTokPrivacyMissing,
  TIKTOK_PRIVACY_REQUIRED_MESSAGE,
} from "@/lib/postTargets";
import {
  SCHEDULE_BUFFER_MS,
  localDateTimeToUtcIso,
  localTimeZoneLabel,
  toDateTimeLocalValue,
} from "@/lib/scheduling";
import type { TikTokPostMetadata, YouTubePostMetadata } from "@/server/platforms/types";

interface UploadedBlobInfo {
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

// Roadmap Phase 5 — how the composer wants to publish. `now` is the original
// immediate flow; `schedule` sends a `scheduledFor` (UTC ISO); `draft` sends
// `draft: true`. Both deferred modes create no results / send no event now.
type PublishMode = "now" | "schedule" | "draft";

// Fields shared by both create bodies for the deferred modes.
interface DeferredPostFields {
  /** Present + true → save as draft. */
  draft?: boolean;
  /** Present → schedule for this UTC ISO time. */
  scheduledFor?: string;
}

// 2026-11-01 audit (M3): the workspace this page was rendered for. The active
// workspace is a cookie shared by every tab, so the server compares this with
// the cookie's workspace and refuses (409 WORKSPACE_CHANGED) when they differ.
interface WorkspaceBoundFields {
  workspaceId?: string;
}

// Request body posted to /api/posts. Metadata fields are added conditionally
// based on which platforms are connected.
interface CreatePostRequest extends DeferredPostFields, WorkspaceBoundFields {
  blobUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  baseCaption: string;
  location?: string;
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
  /** Task 7 — chosen subset of connected platforms to publish to. */
  platforms?: Platform[];
}

// Roadmap Phase 2 — request body for the reuse path: an already-persisted
// MediaItem instead of a fresh blobUrl upload. Same optional metadata fields
// as CreatePostRequest; POST /api/posts branches on which of blobUrl /
// mediaItemId is present.
interface CreatePostReuseRequest extends DeferredPostFields, WorkspaceBoundFields {
  mediaItemId: string;
  baseCaption: string;
  location?: string;
  perPlatformOverrides?: Partial<Record<Platform, string>>;
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
  /** Task 7 — chosen subset of connected platforms to publish to. */
  platforms?: Platform[];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(1)} ${sizes[i]}`;
}

interface CreatePostFormInnerProps {
  /**
   * Roadmap Phase 7 — the posting user's footer settings (companyWebsite /
   * defaultHashtags), projected server-side (see app/posts/new/page.tsx) so
   * only these two display fields — never the full `User` row — reach this
   * client component. Optional: the live preview below still renders (minus
   * the footer) when this isn't provided.
   */
  footerSettings?: CaptionFooterUser;
  /**
   * 2026-11-01 audit — true for a member in a workspace that requires
   * approval: their publish-now is submitted for review, not published, so the
   * confirmation says so (see composerPublishConfirmCopy).
   */
  holdsForApproval?: boolean;
  /**
   * 2026-11-01 audit (M3) — the id of the workspace this page was rendered for
   * (app/posts/new/page.tsx). Sent with the create request so the server can
   * refuse when the active-workspace cookie was switched in another tab.
   */
  workspaceId?: string;
}

function CreatePostFormInner({
  footerSettings,
  holdsForApproval = false,
  workspaceId,
}: CreatePostFormInnerProps) {
  const toast = useToast();
  const searchParams = useSearchParams();

  // Roadmap Phase 2 — reuse mode. `?mediaItemId=` names an already-persisted
  // MediaItem (from the media library's "Use in new post" action) to attach
  // to a new post instead of uploading a fresh file. `reuseItem` (not the
  // presence of the query param) is the source of truth for whether the
  // reuse UI renders, so a failed fetch or an explicit "use a different file"
  // cleanly falls back to the normal upload flow below.
  const reuseMediaItemId = searchParams.get("mediaItemId");
  const [reuseItem, setReuseItem] = useState<MediaItemDto | null>(null);
  const [reuseLoading, setReuseLoading] = useState(() => Boolean(reuseMediaItemId));
  const [reusePerPlatformOverrides, setReusePerPlatformOverrides] = useState<Partial<
    Record<Platform, string>
  > | null>(null);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadCaption, setUploadCaption] = useState("");
  const [uploadLocation, setUploadLocation] = useState("");
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [enhancingCaption, setEnhancingCaption] = useState(false);

  const [autoCaptionEnabled, setAutoCaptionEnabled] = useState(true);
  const [autoCaptionLoading, setAutoCaptionLoading] = useState(false);
  const [uploadedBlob, setUploadedBlob] = useState<UploadedBlobInfo | null>(null);

  // Roadmap Phase 5 — publish timing. `scheduledForLocal` is the raw
  // datetime-local (browser-local wall time) string; it's converted to a UTC
  // ISO `scheduledFor` only at submit. Works for both the upload and reuse flows.
  const [publishMode, setPublishMode] = useState<PublishMode>("now");
  const [scheduledForLocal, setScheduledForLocal] = useState("");
  // Earliest schedulable datetime-local value (now + buffer) for the picker's
  // `min`. A lazy useState initializer computes it once at mount, keeping the
  // impure `Date.now()` off the render path; submit-time validation is the
  // authoritative future-time check.
  const [minScheduleLocal] = useState(() =>
    toDateTimeLocalValue(new Date(Date.now() + SCHEDULE_BUFFER_MS)),
  );
  // The mode that produced the current success banner (so it reads correctly
  // for now / schedule / draft).
  const [submittedMode, setSubmittedMode] = useState<PublishMode>("now");
  // Approval workflow — set from the create response so the success copy tells
  // the truth for a held post (nothing is queued or scheduled yet).
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  // Final review M3 — the post was saved but its publishing never started
  // (503 DISPATCH_FAILED): the banner points at Activity to retry it.
  const [dispatchFailed, setDispatchFailed] = useState(false);
  // Task 7 — publish-now confirmation dialog. Immediate publishes can't be
  // undone once sent, so `handleUploadSubmit` opens this instead of posting
  // directly when `publishMode === "now"`; schedule/draft submit right away.
  const [confirmPublishOpen, setConfirmPublishOpen] = useState(false);
  // Scrolled into view whenever the success banner appears (effect below) so
  // a submit from further down the form doesn't leave the confirmation
  // off-screen.
  const successRef = useRef<HTMLDivElement>(null);

  // Local object-URL preview for the currently attached file. Created/revoked
  // by the effect below so we never leak object URLs.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // 0-100 while a Blob upload is in flight for the active file; null when idle.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  // Bumped after a successful post so React remounts the (uncontrolled) file
  // input (2026-11-01 audit): clearing `uploadFile` state alone leaves the
  // browser showing the old filename, and re-choosing that same file then fires
  // no change event - so submit said "Please choose a file to upload." Same
  // technique as media-library.tsx's `fileInputKey`.
  const [fileInputKey, setFileInputKey] = useState(0);

  // Tracks the in-flight/most recent Blob upload for the CURRENT file, keyed
  // by File identity. This guarantees a given file is uploaded to Vercel
  // Blob at most once: both the attach-time auto-caption path and the
  // submit path call ensureUploaded() and share this same promise instead
  // of independently starting a second upload. Selecting a different (or
  // no) file resets this ref, which invalidates any stale in-flight upload
  // so its result is never applied to the newly selected file.
  const activeUploadRef = useRef<{
    file: File;
    promise: Promise<UploadedBlobInfo>;
  } | null>(null);

  const [tiktokMetadata, setTiktokMetadata] = useState<TikTokPostMetadata>({
    privacyLevel: "",
    disableComment: true,
    disableDuet: true,
    disableStitch: true,
  });
  const [tiktokPrivacyError, setTiktokPrivacyError] = useState<string | null>(null);
  const [tiktokCommercialEnabled, setTiktokCommercialEnabled] = useState(false);

  const [youtubeMetadata, setYoutubeMetadata] = useState<YouTubePostMetadata>({
    privacyStatus: "unlisted",
  });

  // Roadmap Phase 7 / Task 6 — single source of truth for connection state:
  // the same read-only `GET /api/connections` the dashboard's
  // connection-health widget calls (via this shared hook). `loading` feeds
  // deriveComposerGate below, which distinguishes "still loading" from
  // "loaded and empty" and from "failed"; TikTok/YouTube no longer run their
  // own ad-hoc fetches to determine connectedness.
  const {
    connections,
    loading: connectionsLoading,
    error: connectionsError,
    reload: reloadConnections,
  } = useConnections();

  // Roadmap Phase 7 — platforms to show a live preview card for: connected
  // platforms only, in the app's standard display order.
  const connectedPlatforms = useMemo(
    () =>
      PLATFORM_ORDER.filter((platform) =>
        connections?.some((c) => c.platform === platform && c.connected),
      ),
    [connections],
  );

  // Task 7 — per-post platform targeting. `deselected` tracks platforms the
  // user has explicitly opted OUT of for this post; `selectedPlatforms`
  // derives the chosen subset from it. Starting `deselected` empty means
  // everything defaults to selected, including a platform whose connection
  // finishes loading after mount (it simply appears in `connectedPlatforms`
  // later and, having never been deselected, is selected).
  const [deselected, setDeselected] = useState<Set<Platform>>(new Set());

  // Drives the TikTok/YouTube settings gate below and the per-platform media
  // compatibility, for BOTH the upload and reuse flows: originally gated on
  // `uploadFile` alone (a real File only exists in the upload flow), so reuse
  // mode needs the equivalent signal from `reuseItem` instead. `null` until
  // some media is chosen.
  const activeMimeType = uploadFile?.type ?? reuseItem?.mimeType ?? null;

  // 2026-11-01 audit: a platform whose client can't publish the chosen media
  // (YouTube/TikTok are video-only, Facebook Page images-only) is shown
  // disabled with a reason and left out of `selectedPlatforms`, so it is never
  // sent, previewed or given settings. Derived from `deselected` + the media -
  // not written into state - so picking different media restores the user's own
  // choices. See lib/postTargets.ts / PLATFORM_ACCEPTED_MEDIA.
  const { choices: platformChoices, selected: selectedPlatforms } = useMemo(
    () => deriveComposerPlatforms(connectedPlatforms, deselected, activeMimeType),
    [connectedPlatforms, deselected, activeMimeType],
  );
  const tiktokSelected = selectedPlatforms.includes("tiktok");
  const youtubeSelected = selectedPlatforms.includes("youtube");

  // Roadmap Phase 2 — load the reuse target, if any. Runs once per distinct
  // `reuseMediaItemId` (a fresh navigation from the media library always
  // remounts this component, so the realistic case of the param changing
  // while already mounted doesn't arise). Mirrors the MediaLibrary
  // fetch-effect convention: state starts pre-set via the `useState`
  // initializer above so nothing is set synchronously in the effect body
  // itself — every setState here happens after the `await`.
  useEffect(() => {
    if (!reuseMediaItemId) return;

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`/api/media/${encodeURIComponent(reuseMediaItemId)}`);
        const data = (await response.json().catch(() => null)) as
          | { item?: MediaItemDto; error?: string }
          | null;

        if (cancelled) return;

        if (!response.ok || !data?.item) {
          toast.error(
            data?.error ?? "Couldn't load that media item. Upload a new file instead.",
          );
          setReuseLoading(false);
          return;
        }

        const item = data.item;
        setReuseItem(item);
        setUploadCaption(item.baseCaption ?? "");
        setReusePerPlatformOverrides(
          (item.perPlatformOverrides as Partial<Record<Platform, string>> | null) ?? null,
        );
        setReuseLoading(false);
      } catch {
        if (cancelled) return;
        toast.error("Couldn't load that media item. Upload a new file instead.");
        setReuseLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reuseMediaItemId, toast]);

  // Build (and clean up) an object URL for the attached file so we can render
  // an inline media preview without touching the upload flow.
  useEffect(() => {
    if (!uploadFile) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs derived preview state with the attached file; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
      setPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(uploadFile);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [uploadFile]);

  // Clear the inline TikTok privacy validation once a level is chosen.
  useEffect(() => {
    if (tiktokMetadata.privacyLevel) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears validation once a level is chosen; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
      setTiktokPrivacyError(null);
    }
  }, [tiktokMetadata.privacyLevel]);

  // Scroll the success banner into view on submit — the form can be tall
  // enough that a submit from near the bottom leaves the confirmation
  // off-screen otherwise. Respects the user's reduced-motion preference.
  useEffect(() => {
    if (!showSuccess) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    successRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [showSuccess]);

  // Roadmap Phase 2 — leave reuse mode and fall back to the normal upload
  // flow. The `?mediaItemId` query param stays in the URL (harmless; the
  // fetch effect above only re-runs if that param's VALUE changes), but
  // clearing `reuseItem` is what actually drives the UI back to the file
  // input.
  const handleDismissReuse = useCallback(() => {
    setReuseItem(null);
    setReusePerPlatformOverrides(null);
    setUploadCaption("");
  }, []);

  // Uploads `file` to Vercel Blob at most once. Concurrent/subsequent calls
  // for the SAME file (by reference) reuse the in-flight or already-resolved
  // upload instead of starting a new one, so the attach-time auto-caption
  // path and the submit path never double-upload. If the upload fails, the
  // cache entry is cleared so a later retry with the same file can try
  // again.
  function ensureUploaded(file: File): Promise<UploadedBlobInfo> {
    if (activeUploadRef.current && activeUploadRef.current.file === file) {
      return activeUploadRef.current.promise;
    }

    const uploadKey = generateBlobKey(file);

    setUploadProgress(0);

    // Set once this upload has settled. A final progress event can be delivered
    // AFTER the promise resolves; without this it re-showed "Uploading... 100%"
    // right after the bar had been cleared (2026-11-01 audit).
    let settled = false;

    const promise = upload(uploadKey, file, {
      access: "public",
      handleUploadUrl: "/api/upload",
      // Progress feedback only; does not change upload semantics. Guarded so a
      // stale in-flight upload for a swapped-out file never moves the bar.
      onUploadProgress: (event) => {
        if (!settled && activeUploadRef.current?.file === file) {
          setUploadProgress(event.percentage);
        }
      },
    }).then(
      (newBlob) => {
        settled = true;
        const blobInfo: UploadedBlobInfo = {
          url: newBlob.url,
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        };

        // Only commit to state if this upload is still the active one for
        // the currently selected file (the user may have swapped files
        // while this upload was in flight).
        if (activeUploadRef.current?.file === file) {
          setUploadedBlob(blobInfo);
          setUploadProgress(null);
        }

        return blobInfo;
      },
      (err: unknown) => {
        settled = true;
        if (activeUploadRef.current?.file === file) {
          activeUploadRef.current = null;
          setUploadProgress(null);
        }
        throw err;
      },
    );

    activeUploadRef.current = { file, promise };

    return promise;
  }

  async function runAutoCaptionFromMedia(options: {
    overwrite: boolean;
    blobOverride?: UploadedBlobInfo;
  }) {
    const blob = options.blobOverride ?? uploadedBlob;

    if (!blob) {
      setUploadError(
        "Please upload a media file first before generating a caption.",
      );
      return;
    }

    try {
      setAutoCaptionLoading(true);
      setUploadError(null);

      const response = await fetch("/api/posts/auto-caption", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          blobUrl: blob.url,
          mimeType: blob.mimeType,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        const message =
          (errorData as { error?: string } | null)?.error ||
          "Failed to generate caption from media";
        throw new Error(message);
      }

      const data = await response.json();
      const caption = (data as { caption?: string })?.caption;

      if (typeof caption !== "string" || !caption.trim()) {
        throw new Error("AI returned an empty caption from media");
      }

      setUploadCaption((prev) => {
        if (!options.overwrite && prev.trim()) {
          return prev;
        }
        return caption;
      });
    } catch (err: unknown) {
      console.error("Error generating caption from media:", err);
      toast.error((err as Error).message || "Failed to generate caption from media");
    } finally {
      setAutoCaptionLoading(false);
    }
  }

  // Extracted from handleUploadSubmit below (Task 7 / Step 5) so it can run
  // either directly (schedule/draft — no confirmation needed) or via the
  // publish-now confirmation dialog's onConfirm (immediate publish). Every
  // blocking validation (file/caption/platforms/schedule/tiktok privacy)
  // already ran in handleUploadSubmit before either path reaches here, so
  // this only builds the request and submits it. Handles its own
  // loading/toast/error state and never throws — ConfirmDialog always closes
  // after this resolves; failures surface via toast, same as before this task.
  async function performSubmit() {
    setUploadLoading(true);

    // Deferred (schedule/draft) jobs persist tiktok/youtube metadata on the
    // job (PostJob.publishMetadata) and replay it at publish — see
    // server/jobs/posting.ts. The schedule time was already validated in
    // handleUploadSubmit before it called (or deferred calling) this
    // function, so re-deriving it here from the same unchanged state is safe.
    const deferred: DeferredPostFields = {};
    if (publishMode === "draft") {
      deferred.draft = true;
    } else if (publishMode === "schedule") {
      const iso = localDateTimeToUtcIso(scheduledForLocal);
      if (iso) {
        deferred.scheduledFor = iso;
      }
    }

    try {
      let postData: CreatePostRequest | CreatePostReuseRequest;

      if (reuseItem) {
        // Roadmap Phase 2 — reuse: no upload, attach the existing MediaItem.
        const reuseData: CreatePostReuseRequest = {
          mediaItemId: reuseItem.id,
          baseCaption: uploadCaption,
          location: uploadLocation.trim() || undefined,
          // Task 7 — chosen platform subset for this post.
          platforms: selectedPlatforms,
          ...deferred,
          workspaceId,
        };

        if (reusePerPlatformOverrides) {
          reuseData.perPlatformOverrides = reusePerPlatformOverrides;
        }
        // Task 7 — only attach metadata for a platform still selected for
        // this post; a deselected TikTok/YouTube isn't published to.
        if (tiktokSelected) {
          reuseData.tiktokMetadata = tiktokMetadata;
        }
        if (youtubeSelected) {
          reuseData.youtubeMetadata = youtubeMetadata;
        }
        postData = reuseData;
      } else {
        // Unreachable given the guard in handleUploadSubmit (this branch only
        // runs when reuseItem is falsy, and that guard already required
        // reuseItem || uploadFile), but narrows `uploadFile` to `File` for
        // TypeScript without a non-null assertion.
        if (!uploadFile) {
          setUploadError("Please choose a file to upload.");
          setUploadLoading(false);
          return;
        }

        // Reuses the attach-time upload when it already covers this exact
        // file; only uploads if it hasn't been (or needs to be re-) uploaded.
        const blob = await ensureUploaded(uploadFile);

        const blobData: CreatePostRequest = {
          blobUrl: blob.url,
          filename: blob.filename,
          mimeType: blob.mimeType,
          sizeBytes: blob.sizeBytes,
          baseCaption: uploadCaption,
          location: uploadLocation.trim() || undefined,
          // Task 7 — chosen platform subset for this post.
          platforms: selectedPlatforms,
          ...deferred,
          workspaceId,
        };

        // Task 7 — only attach metadata for a platform still selected for
        // this post; a deselected TikTok/YouTube isn't published to.
        if (tiktokSelected) {
          blobData.tiktokMetadata = tiktokMetadata;
        }
        if (youtubeSelected) {
          blobData.youtubeMetadata = youtubeMetadata;
        }
        postData = blobData;
      }

      const response = await fetch("/api/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(postData),
      });

      const data: unknown = await response.json().catch(() => null);

      // Response → what the composer does (lib/composerSubmitOutcome.ts).
      const outcome = composerSubmitOutcome({ ok: response.ok, body: data, mode: publishMode });

      // Nothing was created: keep the form so the user can fix and resend.
      if (!outcome.resetForm) {
        toast.error(outcome.toast);
        // 2026-11-01 audit (M3): the workspace was switched in another tab, so
        // pressing Post again can only 409 again until the page is reloaded.
        // A toast fades; pin the server's message in the form's error banner.
        // The form itself is left exactly as it is (file, caption, platforms).
        if (outcome.kind === "workspace_changed") {
          setUploadError(outcome.toast);
        }
        setUploadLoading(false);
        return;
      }

      // The post exists — created, or (DISPATCH_FAILED, final review M3) saved
      // but its publishing never started, so it already sits `failed` in
      // Activity. Either way the form resets: pressing Post again would create
      // a second job, and retrying the first later would publish it twice.
      if (outcome.kind === "dispatch_failed") {
        toast.error(outcome.toast);
      } else {
        toast.success(outcome.toast);
      }
      setDispatchFailed(outcome.kind === "dispatch_failed");
      setAwaitingApproval(outcome.kind === "success" && outcome.heldForApproval);
      setSubmittedMode(publishMode);
      setShowSuccess(true);
      setUploadCaption("");
      setUploadLocation("");
      // Detach the media once the post is saved. For the reuse path this
      // prevents an accidental second submit from re-posting the same item;
      // for the upload path it clears the file state as before. Clearing
      // `reuseItem` returns the composer to the normal file-upload UI.
      setUploadFile(null);
      setUploadedBlob(null);
      activeUploadRef.current = null;
      // Clear the finished upload's bar and remount the file input, so the old
      // filename is gone and choosing the same file again fires a change event.
      setUploadProgress(null);
      setFileInputKey((key) => key + 1);
      setReuseItem(null);
      setReusePerPlatformOverrides(null);
      setPublishMode("now");
      setScheduledForLocal("");
      // Task 7 — every connected platform defaults back to selected for the
      // next post.
      setDeselected(new Set());
      setTiktokMetadata({
        privacyLevel: "",
        disableComment: true,
        disableDuet: true,
        disableStitch: true,
      });
      setTiktokCommercialEnabled(false);
      setYoutubeMetadata({ privacyStatus: "unlisted" });
      setUploadLoading(false);
    } catch {
      toast.error("Unexpected error while creating post.");
      setUploadLoading(false);
    }
  }

  async function handleUploadSubmit(event: React.FormEvent) {
    event.preventDefault();
    setUploadError(null);
    setShowSuccess(false);

    if (!reuseItem && !uploadFile) {
      setUploadError("Please choose a file to upload.");
      return;
    }

    if (!uploadCaption.trim()) {
      setUploadError("Please enter a caption for this post.");
      return;
    }

    // Task 7 — at least one target platform must stay selected.
    if (selectedPlatforms.length === 0) {
      setUploadError(
        platformChoices.every((choice) => choice.disabledReason !== null)
          ? "None of your connected platforms can publish this media. Choose a different file."
          : "Select at least one platform to publish to.",
      );
      return;
    }

    const tiktokCommercialBlocked =
      tiktokSelected &&
      tiktokCommercialEnabled &&
      !tiktokMetadata.brandedContent &&
      !tiktokMetadata.brandOrganic;
    if (tiktokCommercialBlocked) {
      setUploadError(
        'Select "Your brand" or "Branded content" (or turn off the promotional toggle) before posting to TikTok.',
      );
      return;
    }

    if (publishMode === "schedule") {
      const iso = localDateTimeToUtcIso(scheduledForLocal);
      if (!iso) {
        setUploadError("Please choose a valid date and time to schedule this post.");
        return;
      }
      if (new Date(iso).getTime() < Date.now() + SCHEDULE_BUFFER_MS) {
        setUploadError("Scheduled time must be at least a minute in the future.");
        return;
      }
    }

    // Ruling R5 (2026-11-01 audit): a TikTok privacy level is required whenever
    // TikTok is a SELECTED target, for EVERY intent. It used to be asked for only
    // on "Publish now", so a scheduled or draft TikTok post silently went out
    // as SELF_ONLY. A deselected (or media-incompatible) TikTok isn't published
    // to, so it needs none. POST /api/posts enforces the same rule. Runs BEFORE
    // the publish-now confirmation dialog below so the dialog only ever opens
    // on an already-valid form.
    if (isTikTokPrivacyMissing(selectedPlatforms, tiktokMetadata)) {
      setTiktokPrivacyError(TIKTOK_PRIVACY_REQUIRED_MESSAGE);
      toast.error(TIKTOK_PRIVACY_REQUIRED_MESSAGE);
      return;
    }

    // Immediate publishes can't be undone once sent — confirm first. Deferred
    // modes (schedule/draft) submit directly, same as before this task.
    if (publishMode === "now") {
      setConfirmPublishOpen(true);
      return;
    }
    await performSubmit();
  }

  async function handleEnhanceCaption() {
    if (!uploadCaption.trim()) {
      setUploadError("Please enter some text first to enhance.");
      return;
    }

    try {
      setEnhancingCaption(true);
      setUploadError(null);

      const response = await fetch("/api/posts/enhance-caption", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          caption: uploadCaption,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to enhance caption");
      }

      const data = await response.json();
      const enhancedCaption = data.enhancedCaption;

      // Set the enhanced caption in the textarea
      setUploadCaption(enhancedCaption);
    } catch (err: unknown) {
      console.error("Error enhancing caption:", err);
      toast.error((err as Error).message || "Failed to enhance caption");
    } finally {
      setEnhancingCaption(false);
    }
  }

  const isImagePreview = uploadFile?.type.startsWith("image/") ?? false;
  const isVideoPreview = uploadFile?.type.startsWith("video/") ?? false;

  // Roadmap Phase 7 — same media the sections above already preview, reused
  // (never re-uploaded) for the per-platform preview cards: the reused
  // MediaItem's public blob URL in reuse mode, else the local object-URL
  // preview of the freshly attached file.
  const activeMediaUrl = reuseItem ? reuseItem.storageLocation : previewUrl;

  // What to render while connections load, resolve, or fail — pure rule in
  // lib/composerGate.ts. The `loading` branch exists because rendering the
  // full form during the first fetch let the user attach a file (the blob
  // upload even ran) that the zero-connection CTA below then silently
  // discarded when the fetch resolved. Both early returns sit after every
  // hook, so hook order is unaffected.
  const composerGate = deriveComposerGate(connections, connectionsLoading);

  if (composerGate === "loading") {
    // Same placeholder the Suspense boundary below shows, so first paint and
    // connections-loading are visually indistinguishable.
    return <CreatePostFormSkeleton />;
  }

  // The connections request failed (2026-11-01 audit). The form can't help
  // here: with no platforms known it would render empty and every submit would
  // fail "Select at least one platform". Say what happened and let the user
  // retry; a retry flips the gate back to the loading skeleton.
  if (composerGate === "error") {
    return (
      <Card className="p-6">
        <Alert variant="danger" title="Couldn't load your connections">
          <div className="flex flex-col items-start gap-3">
            <p>
              {connectionsError ?? "Failed to load connections."} We need them to know which
              platforms you can post to.
            </p>
            <Button size="sm" variant="outline" onClick={reloadConnections}>
              Retry
            </Button>
          </div>
        </Alert>
      </Card>
    );
  }

  // With nothing connected there is no submit path at all — publish, schedule
  // and save-draft are each disabled — so rendering the form underneath the
  // connect CTA only invites the user to fill in a post that can never go
  // anywhere. Show the CTA on its own instead. It also covers the reuse flow
  // (arriving from Media -> "Use in new post"), where posting is equally
  // impossible.
  if (composerGate === "connect") {
    return (
      <Card className="p-6">
        <EmptyState
          icon={<PlugZap />}
          title="Connect a platform to start posting"
          description="Vibe Socials publishes to the platforms you've connected. Connect at least one in Settings, then come back here."
          action={
            <Link href="/settings" className={buttonVariants({ variant: "primary" })}>
              Go to connections
            </Link>
          }
        />
      </Card>
    );
  }

  // Publish-now confirmation copy — a held member's post is submitted for
  // review, not published (lib/composerConfirm.ts).
  const confirmCopy = composerPublishConfirmCopy({
    holdsForApproval,
    platforms: selectedPlatforms.map(platformLabel),
  });

  return (
    <Card className="p-6">
      <form onSubmit={handleUploadSubmit} className="space-y-5">
        {showSuccess && dispatchFailed && (
          <div ref={successRef}>
            <Alert variant="warning" title="Publishing didn't start">
              <div className="flex flex-col items-start gap-2">
                <p>{COMPOSER_DISPATCH_FAILED_MESSAGE}</p>
                <Link
                  href="/activity"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  View activity
                </Link>
              </div>
            </Alert>
          </div>
        )}

        {showSuccess && !dispatchFailed && (
          <div ref={successRef}>
            <Alert
              variant="success"
              title={
                awaitingApproval
                  ? "Sent for approval"
                  : submittedMode === "draft"
                    ? "Draft saved"
                    : submittedMode === "schedule"
                      ? "Post scheduled"
                      : "Post queued"
              }
            >
              <div className="flex flex-col items-start gap-2">
                <p>
                  {awaitingApproval
                    ? "An owner will review it before anything publishes. You can follow its status in the Queue."
                    : submittedMode === "draft"
                      ? "Your draft is saved. Publish or schedule it any time from the Queue."
                      : submittedMode === "schedule"
                        ? "We'll publish this at the time you chose. Edit or cancel it from the Queue until then."
                        : "We're publishing to your connected platforms. Per-platform results appear in Activity."}
                </p>
                <Link
                  href={!awaitingApproval && submittedMode === "now" ? "/activity" : "/queue"}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {!awaitingApproval && submittedMode === "now"
                    ? "View activity"
                    : "View queue"}
                </Link>
              </div>
            </Alert>
          </div>
        )}

        {uploadError && <Alert variant="danger">{uploadError}</Alert>}

        <div className="space-y-1.5">
          {reuseItem ? (
            // Roadmap Phase 2 — reuse mode: preview the already-persisted
            // MediaItem from its storageLocation and skip the upload UI
            // entirely (no `id="post-media"` control exists in this branch,
            // so this uses a plain label-styled <p>, not <Label htmlFor>).
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-foreground">Media</p>
                <button
                  type="button"
                  onClick={handleDismissReuse}
                  className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                >
                  Use a different file instead
                </button>
              </div>
              {reuseItem.mimeType.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element -- remote (already-public) Vercel Blob URL preview; same bounded-size pattern as the local object-URL preview below
                <img
                  src={reuseItem.storageLocation}
                  alt={`Preview of ${reuseItem.originalFilename}`}
                  className="max-h-64 w-auto rounded-[var(--radius)] border border-border object-contain"
                />
              ) : reuseItem.mimeType.startsWith("video/") ? (
                <video
                  src={reuseItem.storageLocation}
                  controls
                  className="max-h-64 w-full rounded-[var(--radius)] border border-border"
                />
              ) : null}
              <p className="text-xs text-muted-foreground">
                {reuseItem.originalFilename} &middot; {formatBytes(reuseItem.sizeBytes)}
              </p>
            </div>
          ) : reuseLoading ? (
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-48 w-full max-w-sm" />
            </div>
          ) : (
            <>
              <Label htmlFor="post-media">Media file (image or video)</Label>
              <Input
                key={fileInputKey}
                id="post-media"
                type="file"
                accept="video/*,image/*"
                onChange={async (event) => {
                  const nextFile = event.target.files?.[0] ?? null;
                  setUploadFile(nextFile);
                  setUploadedBlob(null);
                  setShowSuccess(false);
                  // Changing (or clearing) the file invalidates any
                  // in-flight/completed upload for the previous file so it
                  // can never be applied to this new selection.
                  activeUploadRef.current = null;

                  if (!nextFile) {
                    return;
                  }

                  try {
                    setAutoCaptionLoading(true);
                    setUploadError(null);

                    const blobInfo = await ensureUploaded(nextFile);

                    if (autoCaptionEnabled) {
                      await runAutoCaptionFromMedia({
                        overwrite: false,
                        blobOverride: blobInfo,
                      });
                    }
                  } catch (err: unknown) {
                    console.error(
                      "Error uploading media for auto-caption:",
                      err,
                    );
                    toast.error(
                      (err as Error).message ||
                        "Failed to prepare media for posting. Please try again.",
                    );
                  } finally {
                    setAutoCaptionLoading(false);
                  }
                }}
                className="cursor-pointer"
              />

              {uploadFile && previewUrl && (
                <div className="mt-2 space-y-2">
                  {isImagePreview ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local object-URL preview; next/image would need remote host config
                    <img
                      src={previewUrl}
                      alt={`Preview of ${uploadFile.name}`}
                      className="max-h-64 w-auto rounded-[var(--radius)] border border-border object-contain"
                    />
                  ) : isVideoPreview ? (
                    <video
                      src={previewUrl}
                      controls
                      className="max-h-64 w-full rounded-[var(--radius)] border border-border"
                    />
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {uploadFile.name} &middot; {formatBytes(uploadFile.size)}
                  </p>
                </div>
              )}

              {uploadProgress !== null && (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Uploading&hellip;</span>
                    <span>{Math.round(uploadProgress)}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label="Upload progress"
                    aria-valuenow={Math.round(uploadProgress)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-2 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-200"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="post-caption">Caption</Label>
              <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-input accent-[var(--primary)]"
                  checked={autoCaptionEnabled}
                  onChange={(event) => setAutoCaptionEnabled(event.target.checked)}
                />
                <span>Generate a caption when media is added</span>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => runAutoCaptionFromMedia({ overwrite: true })}
                loading={autoCaptionLoading}
                disabled={autoCaptionLoading || !uploadedBlob}
              >
                {!autoCaptionLoading && <Sparkles className="h-4 w-4" aria-hidden />}
                Caption from media
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleEnhanceCaption}
                loading={enhancingCaption}
                disabled={enhancingCaption || !uploadCaption.trim()}
              >
                {!enhancingCaption && <Sparkles className="h-4 w-4" aria-hidden />}
                Enhance caption
              </Button>
            </div>
          </div>
          <Textarea
            id="post-caption"
            value={uploadCaption}
            onChange={(event) => setUploadCaption(event.target.value)}
            rows={3}
            placeholder="What do you want to say with this post?"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="post-location">
            Location <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <LocationAutocomplete
            id="post-location"
            value={uploadLocation}
            onChange={setUploadLocation}
            placeholder="Start typing a location..."
            className={cn(fieldBaseClasses, "h-10 px-3 py-2")}
          />
          <p className="text-xs text-muted-foreground">
            Type to search for locations. Will be added to Instagram, TikTok, and X posts. (YouTube
            requires manual location setting via Studio)
          </p>
        </div>

        {tiktokSelected && activeMimeType && (
          <TikTokPostSettings
            metadata={tiktokMetadata}
            onChange={setTiktokMetadata}
            isVideo={activeMimeType.startsWith("video/")}
            privacyError={tiktokPrivacyError}
            commercialContentEnabled={tiktokCommercialEnabled}
            onCommercialContentEnabledChange={setTiktokCommercialEnabled}
          />
        )}
        {youtubeSelected && activeMimeType && (
          <YouTubePostSettings
            metadata={youtubeMetadata}
            onChange={setYoutubeMetadata}
          />
        )}

        {/* Task 7 — per-post platform targeting: defaults to every connected
            platform selected; unchecking one excludes it from the preview
            below, the TikTok/YouTube settings panels above, and the publish
            request. */}
        {connectedPlatforms.length > 0 ? (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-foreground">Publish to</legend>
            <div className="flex flex-wrap gap-2">
              {platformChoices.map(({ platform, checked, disabledReason }) => {
                const disabled = disabledReason !== null;
                const reasonId = `post-platform-${platform}-reason`;
                return (
                  <label
                    key={platform}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors",
                      disabled
                        ? "cursor-not-allowed border-input text-muted-foreground opacity-60"
                        : checked
                          ? "cursor-pointer border-primary/40 bg-primary/10 text-foreground"
                          : "cursor-pointer border-input text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-input accent-[var(--primary)]"
                      checked={checked}
                      disabled={disabled}
                      aria-describedby={disabled ? reasonId : undefined}
                      onChange={(event) => {
                        setDeselected((prev) => {
                          const next = new Set(prev);
                          if (event.target.checked) next.delete(platform);
                          else next.add(platform);
                          return next;
                        });
                      }}
                    />
                    {platformLabel(platform)}
                    {disabled ? (
                      <span id={reasonId} className="text-xs">
                        ({disabledReason})
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            {selectedPlatforms.length === 0 ? (
              <p className="text-xs text-destructive" role="alert">
                {platformChoices.every((choice) => choice.disabledReason !== null)
                  ? "None of your connected platforms can publish this media."
                  : "Select at least one platform."}
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {/* Roadmap Phase 7 — live per-platform preview (spec §7.1): caption
            with footer, media thumbnail, and char-limit feedback for every
            SELECTED platform (Task 7 — narrowed from every connected platform
            to the chosen subset). Recomputed on every render, so it updates
            as the user types. */}
        <PlatformPreviewList
          platforms={selectedPlatforms}
          caption={uploadCaption}
          overrides={reusePerPlatformOverrides}
          user={footerSettings}
          mediaUrl={activeMediaUrl}
          mediaMimeType={activeMimeType}
        />

        {/* Roadmap Phase 5 — publish timing: now / schedule / draft. */}
        <div className="space-y-3 pt-1">
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-foreground">
              When to publish
            </span>
            <div
              role="group"
              aria-label="When to publish"
              className="inline-flex flex-wrap gap-0.5 rounded-[var(--radius)] border border-input p-0.5"
            >
              {(
                [
                  ["now", "Publish now"],
                  ["schedule", "Schedule"],
                  ["draft", "Save draft"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={publishMode === mode}
                  onClick={() => setPublishMode(mode)}
                  className={cn(
                    "rounded-[calc(var(--radius)-0.125rem)] px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    publishMode === mode
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {publishMode === "schedule" && (
            <div className="space-y-1.5">
              <Label htmlFor="post-schedule">Publish at</Label>
              <input
                id="post-schedule"
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
          )}

          <div className="flex items-center gap-3">
            {/* No `disabled` for the zero-connection case: the gate above
                returns early, so the form only renders once at least one
                platform is connected. */}
            <Button type="submit" loading={uploadLoading}>
              {uploadLoading
                ? publishMode === "draft"
                  ? "Saving…"
                  : publishMode === "schedule"
                    ? "Scheduling…"
                    : "Publishing…"
                : publishMode === "draft"
                  ? "Save draft"
                  : publishMode === "schedule"
                    ? "Schedule post"
                    : "Publish post"}
            </Button>
          </div>
        </div>
      </form>

      {/* Task 7 — publish-now confirmation: immediate posts publish right
          away and can't be undone here, so confirm the target platforms
          (and any per-platform privacy) before performSubmit actually
          fires. Schedule/draft submit directly without this dialog. */}
      <ConfirmDialog
        open={confirmPublishOpen}
        onOpenChange={setConfirmPublishOpen}
        title={confirmCopy.title}
        description={
          <span className="block space-y-1">
            <span className="block">{confirmCopy.lead}</span>
            {selectedPlatforms.includes("youtube") ? (
              <span className="block">YouTube privacy: {youtubeMetadata.privacyStatus}</span>
            ) : null}
            {selectedPlatforms.includes("tiktok") && tiktokMetadata.privacyLevel ? (
              <span className="block">TikTok privacy: {TIKTOK_PRIVACY_LABELS[tiktokMetadata.privacyLevel] ?? tiktokMetadata.privacyLevel}</span>
            ) : null}
            {confirmCopy.trail ? <span className="block">{confirmCopy.trail}</span> : null}
          </span>
        }
        confirmText={confirmCopy.confirmText}
        onConfirm={performSubmit}
      />
    </Card>
  );
}

/** Lightweight placeholder for the Suspense boundary `useSearchParams`
 * requires — resolves near-instantly since this route is already dynamic
 * (the page reads the session via `getCurrentUser`), so this is rarely, if
 * ever, actually seen. */
function CreatePostFormSkeleton() {
  return (
    <Card className="space-y-5 p-6">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-10 w-32" />
    </Card>
  );
}

export interface CreatePostFormProps {
  /**
   * Roadmap Phase 7 — footer settings for the Preview section, projected
   * server-side by `app/posts/new/page.tsx` (SEC-1: only companyWebsite /
   * defaultHashtags, never the full `User` row). Optional so existing/other
   * callers of `CreatePostForm` keep working unchanged.
   */
  footerSettings?: CaptionFooterUser;
  /**
   * 2026-11-01 audit — a member in a workspace that requires approval:
   * publish-now is submitted for an owner's review rather than published, so
   * the confirmation dialog says "Submit for approval". Optional; defaults to
   * the original publish-now confirmation.
   */
  holdsForApproval?: boolean;
  /**
   * 2026-11-01 audit (M3) — id of the workspace the page was rendered for,
   * sent with the create request so a workspace switched in another tab is
   * refused (409) rather than posted into. Optional; absent keeps the old
   * cookie-only behaviour.
   */
  workspaceId?: string;
}

/**
 * `useSearchParams` (used by the reuse-mode fetch above) requires a Suspense
 * boundary around its consumer during static rendering; self-contained here
 * so the parent page (`app/posts/new/page.tsx`) doesn't need to know about
 * it — mirrors how `ConnectionsSection` wraps `LinkedInSetupDialog`.
 */
export function CreatePostForm({
  footerSettings,
  holdsForApproval,
  workspaceId,
}: CreatePostFormProps) {
  return (
    <Suspense fallback={<CreatePostFormSkeleton />}>
      <CreatePostFormInner
        footerSettings={footerSettings}
        holdsForApproval={holdsForApproval}
        workspaceId={workspaceId}
      />
    </Suspense>
  );
}
