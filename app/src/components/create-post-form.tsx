"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { upload } from '@vercel/blob/client';
import { Sparkles } from "lucide-react";
import { LocationAutocomplete } from "./location-autocomplete";
import { TikTokPostSettings } from "./tiktok-post-settings";
import { YouTubePostSettings } from "./youtube-post-settings";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { fieldBaseClasses } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
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

// Request body posted to /api/posts. Metadata fields are added conditionally
// based on which platforms are connected.
interface CreatePostRequest {
  blobUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  baseCaption: string;
  location?: string;
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

export function CreatePostForm() {
  const toast = useToast();

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

    if (!uploadFile) {
      setUploadError("Please choose a file to upload.");
      return;
    }

    if (!uploadCaption.trim()) {
      setUploadError("Please enter a caption for this post.");
      return;
    }

    setUploadLoading(true);

    try {
      // Reuses the attach-time upload when it already covers this exact
      // file; only uploads if it hasn't been (or needs to be re-) uploaded.
      const blob = await ensureUploaded(uploadFile);

      const postData: CreatePostRequest = {
        blobUrl: blob.url,
        filename: blob.filename,
        mimeType: blob.mimeType,
        sizeBytes: blob.sizeBytes,
        baseCaption: uploadCaption,
        location: uploadLocation.trim() || undefined,
      };

      // Add TikTok-specific metadata if TikTok is connected
      if (hasTikTokConnection) {
        if (!tiktokMetadata.privacyLevel) {
          setTiktokPrivacyError("Please select a privacy level for TikTok");
          toast.error("Please select a privacy level for TikTok");
          setUploadLoading(false);
          return;
        }
        postData.tiktokMetadata = tiktokMetadata;
      }

      // Add YouTube-specific metadata if YouTube is connected
      if (hasYouTubeConnection) {
        postData.youtubeMetadata = youtubeMetadata;
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

      toast.success("Post queued — track it in Activity");
      setShowSuccess(true);
      setUploadFile(null);
      setUploadCaption("");
      setUploadLocation("");
      setUploadedBlob(null);
      activeUploadRef.current = null;
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

  return (
    <Card className="p-6">
      <form onSubmit={handleUploadSubmit} className="space-y-5">
        {showSuccess && (
          <Alert variant="success" title="Post queued">
            <div className="flex flex-col items-start gap-2">
              <p>
                We&apos;re publishing to your connected platforms. Per-platform results appear in
                Activity.
              </p>
              <Link
                href="/activity"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                View activity
              </Link>
            </div>
          </Alert>
        )}

        {uploadError && <Alert variant="danger">{uploadError}</Alert>}

        <div className="space-y-1.5">
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

        {hasTikTokConnection && uploadFile && (
          <TikTokPostSettings
            metadata={tiktokMetadata}
            onChange={setTiktokMetadata}
            isVideo={uploadFile.type.startsWith("video/")}
            privacyError={tiktokPrivacyError}
          />
        )}
        {hasYouTubeConnection && uploadFile && (
          <YouTubePostSettings
            metadata={youtubeMetadata}
            onChange={setYoutubeMetadata}
          />
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button type="submit" loading={uploadLoading}>
            {uploadLoading ? "Creating post…" : "Create post"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
