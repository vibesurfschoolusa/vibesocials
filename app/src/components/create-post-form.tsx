"use client";

import { useState } from "react";
import { upload } from '@vercel/blob/client';
import { LocationAutocomplete } from "./location-autocomplete";
import { Sparkles, Loader2 } from "lucide-react";

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
          (errorData as any)?.error ||
          "Failed to generate caption from media";
        throw new Error(message);
      }

      const data = await response.json();
      const caption = (data as any)?.caption;

      if (typeof caption !== "string" || !caption.trim()) {
        throw new Error("AI returned an empty caption from media");
      }

      setUploadCaption((prev) => {
        if (!options.overwrite && prev.trim()) {
          return prev;
        }
        return caption;
      });
    } catch (err: any) {
      console.error("Error generating caption from media:", err);
      setUploadError(err.message || "Failed to generate caption from media");
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
      let blob: UploadedBlobInfo | null = uploadedBlob;

      if (!blob) {
        console.log("[Upload] Starting client-side upload to Vercel Blob", {
          filename: uploadFile.name,
          size: uploadFile.size,
          type: uploadFile.type,
        });

        const uploadKey = generateBlobKey(uploadFile);

        const newBlob = await upload(uploadKey, uploadFile, {
          access: "public",
          handleUploadUrl: "/api/upload",
        });

        console.log("[Upload] Blob uploaded successfully", {
          url: newBlob.url,
        });

        blob = {
          url: newBlob.url,
          filename: uploadFile.name,
          mimeType: uploadFile.type,
          sizeBytes: uploadFile.size,
        };

        setUploadedBlob(blob);
      }

      const response = await fetch("/api/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          blobUrl: blob.url,
          filename: blob.filename,
          mimeType: blob.mimeType,
          sizeBytes: blob.sizeBytes,
          baseCaption: uploadCaption,
          location: uploadLocation.trim() || undefined,
        }),
      });

      const data = (await response.json().catch(() => null)) as
        | PostResponse
        | { error?: string }
        | null;

      if (!response.ok) {
        setUploadError((data as any)?.error ?? "Failed to create post.");
        setUploadLoading(false);
        return;
      }

      const jobId = (data as PostResponse).postJob.id;
      setSuccessMessage(`Post created (job ${jobId}).`);
      setUploadFile(null);
      setUploadCaption("");
      setUploadLocation("");
      setUploadedBlob(null);
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
    } catch (err: any) {
      console.error("Error enhancing caption:", err);
      setUploadError(err.message || "Failed to enhance caption");
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

                if (!nextFile) {
                  return;
                }

                try {
                  setAutoCaptionLoading(true);
                  setUploadError(null);

                  const uploadKey = generateBlobKey(nextFile);

                  const newBlob = await upload(uploadKey, nextFile, {
                    access: "public",
                    handleUploadUrl: "/api/upload",
                  });

                  const blobInfo: UploadedBlobInfo = {
                    url: newBlob.url,
                    filename: nextFile.name,
                    mimeType: nextFile.type,
                    sizeBytes: nextFile.size,
                  };

                  setUploadedBlob(blobInfo);

                  if (autoCaptionEnabled) {
                    await runAutoCaptionFromMedia({
                      overwrite: false,
                      blobOverride: blobInfo,
                    });
                  }
                } catch (err: any) {
                  console.error(
                    "Error uploading media for auto-caption:",
                    err,
                  );
                  setUploadError(
                    err.message ||
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
