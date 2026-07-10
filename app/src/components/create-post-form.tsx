"use client";

import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { upload } from '@vercel/blob/client';
import { Sparkles } from "lucide-react";
import type { Platform } from "@prisma/client";
import { LocationAutocomplete } from "./location-autocomplete";
import { TikTokPostSettings } from "./tiktok-post-settings";
import { YouTubePostSettings } from "./youtube-post-settings";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { fieldBaseClasses } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import type { MediaItemDto } from "@/lib/mediaDto";
import {
  SCHEDULE_BUFFER_MS,
  localDateTimeToUtcIso,
  localTimeZoneLabel,
  toDateTimeLocalValue,
} from "@/lib/scheduling";
import type { TikTokPostMetadata, YouTubePostMetadata } from "@/server/platforms/types";

interface PostResponse {
  postJob: {
    id: string;
    status: string;
  };
}

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

// Request body posted to /api/posts. Metadata fields are added conditionally
// based on which platforms are connected.
interface CreatePostRequest extends DeferredPostFields {
  blobUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  baseCaption: string;
  location?: string;
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
}

// Roadmap Phase 2 — request body for the reuse path: an already-persisted
// MediaItem instead of a fresh blobUrl upload. Same optional metadata fields
// as CreatePostRequest; POST /api/posts branches on which of blobUrl /
// mediaItemId is present.
interface CreatePostReuseRequest extends DeferredPostFields {
  mediaItemId: string;
  baseCaption: string;
  location?: string;
  perPlatformOverrides?: Partial<Record<Platform, string>>;
  tiktokMetadata?: TikTokPostMetadata;
  youtubeMetadata?: YouTubePostMetadata;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(1)} ${sizes[i]}`;
}

function generateBlobKey(file: File): string {
  const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${random}-${safeName}`;
}

function CreatePostFormInner() {
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

  // Local object-URL preview for the currently attached file. Created/revoked
  // by the effect below so we never leak object URLs.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // 0-100 while a Blob upload is in flight for the active file; null when idle.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

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

  const [hasTikTokConnection, setHasTikTokConnection] = useState(false);
  const [tiktokMetadata, setTiktokMetadata] = useState<TikTokPostMetadata>({
    privacyLevel: "",
    disableComment: true,
    disableDuet: true,
    disableStitch: true,
  });
  const [tiktokPrivacyError, setTiktokPrivacyError] = useState<string | null>(null);

  const [hasYouTubeConnection, setHasYouTubeConnection] = useState(false);
  const [youtubeMetadata, setYoutubeMetadata] = useState<YouTubePostMetadata>({
    privacyStatus: "unlisted",
  });

  useEffect(() => {
    checkTikTokConnection();
    checkYouTubeConnection();
  }, []);

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
      setTiktokPrivacyError(null);
    }
  }, [tiktokMetadata.privacyLevel]);

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

  async function checkTikTokConnection() {
    try {
      const response = await fetch("/api/tiktok/creator-info");
      setHasTikTokConnection(response.ok);
    } catch {
      setHasTikTokConnection(false);
    }
  }

  async function checkYouTubeConnection() {
    try {
      const response = await fetch("/api/connections/youtube");
      if (!response.ok) {
        setHasYouTubeConnection(false);
        return;
      }
      const data = (await response.json().catch(() => null)) as { connected?: boolean } | null;
      setHasYouTubeConnection(Boolean(data?.connected));
    } catch {
      setHasYouTubeConnection(false);
    }
  }

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

    const promise = upload(uploadKey, file, {
      access: "public",
      handleUploadUrl: "/api/upload",
      // Progress feedback only; does not change upload semantics. Guarded so a
      // stale in-flight upload for a swapped-out file never moves the bar.
      onUploadProgress: (event) => {
        if (activeUploadRef.current?.file === file) {
          setUploadProgress(event.percentage);
        }
      },
    }).then(
      (newBlob) => {
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

    // Roadmap Phase 5 — resolve the deferred (schedule/draft) fields once for
    // both the reuse and upload flows. TikTok privacy is only required for an
    // immediate post: scheduled/draft jobs don't persist per-post TikTok/YouTube
    // metadata, so they publish with each client's safe default.
    const deferred: DeferredPostFields = {};
    if (publishMode === "draft") {
      deferred.draft = true;
    } else if (publishMode === "schedule") {
      const iso = localDateTimeToUtcIso(scheduledForLocal);
      if (!iso) {
        setUploadError("Please choose a valid date and time to schedule this post.");
        return;
      }
      if (new Date(iso).getTime() < Date.now() + SCHEDULE_BUFFER_MS) {
        setUploadError("Scheduled time must be at least a minute in the future.");
        return;
      }
      deferred.scheduledFor = iso;
    }
    const requireTikTokPrivacy = publishMode === "now";

    setUploadLoading(true);

    try {
      let postData: CreatePostRequest | CreatePostReuseRequest;

      if (reuseItem) {
        // Roadmap Phase 2 — reuse: no upload, attach the existing MediaItem.
        if (requireTikTokPrivacy && hasTikTokConnection && !tiktokMetadata.privacyLevel) {
          setTiktokPrivacyError("Please select a privacy level for TikTok");
          toast.error("Please select a privacy level for TikTok");
          setUploadLoading(false);
          return;
        }

        const reuseData: CreatePostReuseRequest = {
          mediaItemId: reuseItem.id,
          baseCaption: uploadCaption,
          location: uploadLocation.trim() || undefined,
          ...deferred,
        };

        if (reusePerPlatformOverrides) {
          reuseData.perPlatformOverrides = reusePerPlatformOverrides;
        }
        if (hasTikTokConnection) {
          reuseData.tiktokMetadata = tiktokMetadata;
        }
        if (hasYouTubeConnection) {
          reuseData.youtubeMetadata = youtubeMetadata;
        }
        postData = reuseData;
      } else {
        // Unreachable given the guard above (this branch only runs when
        // reuseItem is falsy, and that guard already required
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
          ...deferred,
        };

        // Add TikTok-specific metadata if TikTok is connected. The privacy
        // level is only *required* for an immediate post (scheduled/draft
        // publish with the client's safe default).
        if (hasTikTokConnection) {
          if (requireTikTokPrivacy && !tiktokMetadata.privacyLevel) {
            setTiktokPrivacyError("Please select a privacy level for TikTok");
            toast.error("Please select a privacy level for TikTok");
            setUploadLoading(false);
            return;
          }
          blobData.tiktokMetadata = tiktokMetadata;
        }

        // Add YouTube-specific metadata if YouTube is connected
        if (hasYouTubeConnection) {
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

      const data = (await response.json().catch(() => null)) as
        | PostResponse
        | { error?: string }
        | null;

      if (!response.ok) {
        toast.error((data as { error?: string } | null)?.error ?? "Failed to create post.");
        setUploadLoading(false);
        return;
      }

      toast.success(
        publishMode === "draft"
          ? "Draft saved — find it in your Queue"
          : publishMode === "schedule"
            ? "Post scheduled — see it in your Queue"
            : "Post queued — track it in Activity",
      );
      setSubmittedMode(publishMode);
      setShowSuccess(true);
      setUploadCaption("");
      setUploadLocation("");
      // Detach the media after a successful post. For the reuse path this
      // prevents an accidental second submit from re-posting the same item;
      // for the upload path it clears the file state as before. Clearing
      // `reuseItem` returns the composer to the normal file-upload UI.
      setUploadFile(null);
      setUploadedBlob(null);
      activeUploadRef.current = null;
      setReuseItem(null);
      setReusePerPlatformOverrides(null);
      setPublishMode("now");
      setScheduledForLocal("");
      setTiktokMetadata({
        privacyLevel: "",
        disableComment: true,
        disableDuet: true,
        disableStitch: true,
      });
      setYoutubeMetadata({ privacyStatus: "unlisted" });
      setUploadLoading(false);
    } catch {
      toast.error("Unexpected error while creating post.");
      setUploadLoading(false);
    }
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

  // Drives the TikTok/YouTube settings gate below for BOTH the upload and
  // reuse flows: originally gated on `uploadFile` alone (a real File only
  // exists in the upload flow), so reuse mode needs the equivalent signal
  // from `reuseItem` instead.
  const activeMimeType = uploadFile?.type ?? reuseItem?.mimeType ?? null;

  return (
    <Card className="p-6">
      <form onSubmit={handleUploadSubmit} className="space-y-5">
        {showSuccess && (
          <Alert
            variant="success"
            title={
              submittedMode === "draft"
                ? "Draft saved"
                : submittedMode === "schedule"
                  ? "Post scheduled"
                  : "Post queued"
            }
          >
            <div className="flex flex-col items-start gap-2">
              <p>
                {submittedMode === "draft"
                  ? "Your draft is saved. Publish or schedule it any time from the Queue."
                  : submittedMode === "schedule"
                    ? "We'll publish this at the time you chose. Edit or cancel it from the Queue until then."
                    : "We're publishing to your connected platforms. Per-platform results appear in Activity."}
              </p>
              <Link
                href={submittedMode === "now" ? "/activity" : "/queue"}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {submittedMode === "now" ? "View activity" : "View queue"}
              </Link>
            </div>
          </Alert>
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
              <input
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
                className="block w-full cursor-pointer text-sm text-foreground file:mr-3 file:cursor-pointer file:rounded-[var(--radius)] file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
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
                <span>Auto-caption from media (on attach)</span>
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
                Auto Caption
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
                AI Enhance
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

        {hasTikTokConnection && activeMimeType && (
          <TikTokPostSettings
            metadata={tiktokMetadata}
            onChange={setTiktokMetadata}
            isVideo={activeMimeType.startsWith("video/")}
            privacyError={tiktokPrivacyError}
          />
        )}
        {hasYouTubeConnection && activeMimeType && (
          <YouTubePostSettings
            metadata={youtubeMetadata}
            onChange={setYoutubeMetadata}
          />
        )}

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
            <Button type="submit" loading={uploadLoading}>
              {uploadLoading
                ? publishMode === "draft"
                  ? "Saving…"
                  : publishMode === "schedule"
                    ? "Scheduling…"
                    : "Creating post…"
                : publishMode === "draft"
                  ? "Save draft"
                  : publishMode === "schedule"
                    ? "Schedule post"
                    : "Create post"}
            </Button>
          </div>
        </div>
      </form>
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

/**
 * `useSearchParams` (used by the reuse-mode fetch above) requires a Suspense
 * boundary around its consumer during static rendering; self-contained here
 * so the parent page (`app/posts/new/page.tsx`) doesn't need to know about
 * it — mirrors how `ConnectionsSection` wraps `LinkedInSetupDialog`.
 */
export function CreatePostForm() {
  return (
    <Suspense fallback={<CreatePostFormSkeleton />}>
      <CreatePostFormInner />
    </Suspense>
  );
}
