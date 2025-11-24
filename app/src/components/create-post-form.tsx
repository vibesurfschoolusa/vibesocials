"use client";

import { useState } from "react";
import { upload } from '@vercel/blob/client';
import { LocationAutocomplete } from "./location-autocomplete";

interface PostResponse {
  postJob: {
    id: string;
    status: string;
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(1)} ${sizes[i]}`;
}

export function CreatePostForm() {
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadCaption, setUploadCaption] = useState("");
  const [uploadLocation, setUploadLocation] = useState("");
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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
      console.log('[Upload] Starting client-side upload to Vercel Blob', {
        filename: uploadFile.name,
        size: uploadFile.size,
        type: uploadFile.type,
      });

      // Step 1: Upload directly to Vercel Blob from browser (bypasses 4.5MB limit!)
      const newBlob = await upload(uploadFile.name, uploadFile, {
        access: 'public',
        handleUploadUrl: '/api/upload',
      });

      console.log('[Upload] Blob uploaded successfully', { url: newBlob.url });

      // Step 2: Create post using the blob URL
      const response = await fetch("/api/posts", {
        method: "POST",
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          blobUrl: newBlob.url,
          filename: uploadFile.name,
          mimeType: uploadFile.type,
          sizeBytes: uploadFile.size,
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
      setUploadLoading(false);
    } catch (_err) {
      setUploadError("Unexpected error while creating post.");
      setUploadLoading(false);
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
              onChange={(event) => {
                const nextFile = event.target.files?.[0] ?? null;
                setUploadFile(nextFile);
              }}
              className="mt-1 block w-full text-sm text-zinc-900 file:mr-3 file:rounded file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-800"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-900">
              Caption
            </label>
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
