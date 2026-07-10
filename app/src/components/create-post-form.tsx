"use client";

import { useState, useEffect, useRef } from "react";
import { upload } from '@vercel/blob/client';
import { LocationAutocomplete } from "./location-autocomplete";
import { TikTokPostSettings } from "./tiktok-post-settings";
import { YouTubePostSettings } from "./youtube-post-settings";
import { Sparkles, Loader2 } from "lucide-react";
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
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadCaption, setUploadCaption] = useState("");
  const [uploadLocation, setUploadLocation] = useState("");
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [enhancingCaption, setEnhancingCaption] = useState(false);

  const [autoCaptionEnabled, setAutoCaptionEnabled] = useState(true);
  const [autoCaptionLoading, setAutoCaptionLoading] = useState(false);
  const [uploadedBlob, setUploadedBlob] = useState<UploadedBlobInfo | null>(null);

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

  const [hasYouTubeConnection, setHasYouTubeConnection] = useState(false);
  const [youtubeMetadata, setYoutubeMetadata] = useState<YouTubePostMetadata>({
    privacyStatus: "unlisted",
  });

  useEffect(() => {
    checkTikTokConnection();
    checkYouTubeConnection();
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

    const promise = upload(uploadKey, file, {
      access: "public",
      handleUploadUrl: "/api/upload",
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
        }

        return blobInfo;
      },
      (err: unknown) => {
        if (activeUploadRef.current?.file === file) {
          activeUploadRef.current = null;
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
      setUploadError((err as Error).message || "Failed to generate caption from media");
    } finally {
      setAutoCaptionLoading(false);
    }
  }

  async function handleUploadSubmit(event: React.FormEvent) {
    event.preventDefault();
    setUploadError(null);
    setSuccessMessage(null);

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
          setUploadError("Please select a privacy level for TikTok");
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
        setUploadError((data as { error?: string } | null)?.error ?? "Failed to create post.");
        setUploadLoading(false);
        return;
      }

      const jobId = (data as PostResponse).postJob.id;
      setSuccessMessage(`Post created (job ${jobId}).`);
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
    } catch (_err) {
      setUploadError("Unexpected error while creating post.");
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
      setUploadError((err as Error).message || "Failed to enhance caption");
    } finally {
      setEnhancingCaption(false);
    }
  }

  return (
    <div className="space-y-6">
      {successMessage && (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
          {successMessage}
        </div>
      )}

      <form onSubmit={handleUploadSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-zinc-900">
              Media file (image or video)
            </label>
            <input
              type="file"
              accept="video/*,image/*"
              onChange={async (event) => {
                const nextFile = event.target.files?.[0] ?? null;
                setUploadFile(nextFile);
                setUploadedBlob(null);
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
                  setUploadError(
                    (err as Error).message ||
                      "Failed to prepare media for posting. Please try again.",
                  );
                } finally {
                  setAutoCaptionLoading(false);
                }
              }}
              className="mt-1 block w-full text-sm text-zinc-900 file:mr-3 file:rounded file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-800"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="flex flex-col gap-1">
                <label className="block text-sm font-medium text-zinc-900">
                  Caption
                </label>
                <label className="inline-flex items-center gap-1 text-xs text-zinc-600">
                  <input
                    type="checkbox"
                    className="h-3 w-3"
                    checked={autoCaptionEnabled}
                    onChange={(event) =>
                      setAutoCaptionEnabled(event.target.checked)
                    }
                  />
                  <span>Auto-caption from media (on attach)</span>
                </label>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    runAutoCaptionFromMedia({ overwrite: true })
                  }
                  disabled={autoCaptionLoading || !uploadedBlob}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {autoCaptionLoading ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Auto caption...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3 w-3 fill-blue-600" />
                      Auto Caption
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleEnhanceCaption}
                  disabled={enhancingCaption || !uploadCaption.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-3 py-1 text-xs font-semibold text-purple-700 hover:bg-purple-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {enhancingCaption ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Enhancing...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3 w-3 fill-purple-600" />
                      AI Enhance Caption
                    </>
                  )}
                </button>
              </div>
            </div>
            <textarea
              value={uploadCaption}
              onChange={(event) => setUploadCaption(event.target.value)}
              rows={3}
              className="mt-1 w-full rounded border border-zinc-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-zinc-900"
              placeholder="What do you want to say with this post?"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-900">
              Location <span className="text-xs text-zinc-500">(optional)</span>
            </label>
            <LocationAutocomplete
              value={uploadLocation}
              onChange={setUploadLocation}
              placeholder="Start typing a location..."
              className="mt-1 w-full rounded border border-zinc-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-zinc-900"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Type to search for locations. Will be added to Instagram, TikTok, and X posts. (YouTube requires manual location setting via Studio)
            </p>
          </div>
          {hasTikTokConnection && uploadFile && (
            <TikTokPostSettings
              metadata={tiktokMetadata}
              onChange={setTiktokMetadata}
              isVideo={uploadFile.type.startsWith("video/")}
            />
          )}
          {hasYouTubeConnection && uploadFile && (
            <YouTubePostSettings
              metadata={youtubeMetadata}
              onChange={setYoutubeMetadata}
            />
          )}
          <div className="flex items-center justify-between text-xs">
            <button
              type="submit"
              disabled={uploadLoading}
              className="rounded bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-70"
            >
              {uploadLoading ? "Creating post..." : "Create post"}
            </button>
            {uploadError && <span className="text-xs text-red-600">{uploadError}</span>}
          </div>
        </form>
    </div>
  );
}
