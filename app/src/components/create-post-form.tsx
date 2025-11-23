"use client";

import { useEffect, useState } from "react";
import { LocationAutocomplete } from "./location-autocomplete";

type Mode = "upload" | "existing";

interface MediaItemDto {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

interface MediaListResponse {
  items: MediaItemDto[];
}

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
  const [mode, setMode] = useState<Mode>("upload");

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadCaption, setUploadCaption] = useState("");
  const [uploadLocation, setUploadLocation] = useState("");
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [existingItems, setExistingItems] = useState<MediaItemDto[]>([]);
  const [existingLoading, setExistingLoading] = useState(false);
  const [existingError, setExistingError] = useState<string | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<string>("");
  const [existingCaption, setExistingCaption] = useState("");
  const [existingLocation, setExistingLocation] = useState("");
  const [existingPosting, setExistingPosting] = useState(false);
  const [existingPostError, setExistingPostError] = useState<string | null>(null);

  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "existing") return;

    setExistingLoading(true);
    setExistingError(null);

    fetch("/api/media")
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as MediaListResponse | null;
        if (!response.ok) {
          setExistingError((data as any)?.error ?? "Failed to load media items.");
          setExistingLoading(false);
          return;
        }
        const items = Array.isArray(data?.items) ? data!.items : [];
        setExistingItems(items);
        setExistingLoading(false);
      })
      .catch(() => {
        setExistingError("Unexpected error while loading media items.");
        setExistingLoading(false);
      });
  }, [mode]);

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
      const formData = new FormData();
      formData.append("file", uploadFile);
      formData.append("baseCaption", uploadCaption);
      if (uploadLocation.trim()) {
        formData.append("location", uploadLocation.trim());
      }

      const response = await fetch("/api/posts", {
        method: "POST",
        body: formData,
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

  async function handleExistingSubmit(event: React.FormEvent) {
    event.preventDefault();
    setExistingPostError(null);
    setSuccessMessage(null);

    if (!selectedMediaId) {
      setExistingPostError("Please select a media item.");
      return;
    }

    if (!existingCaption.trim()) {
      setExistingPostError("Please enter a caption for this post.");
      return;
    }

    setExistingPosting(true);

    try {
      const response = await fetch("/api/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mediaItemId: selectedMediaId,
          baseCaption: existingCaption,
          location: existingLocation.trim() || undefined,
        }),
      });

      const data = (await response.json().catch(() => null)) as
        | PostResponse
        | { error?: string }
        | null;

      if (!response.ok) {
        setExistingPostError((data as any)?.error ?? "Failed to create post.");
        setExistingPosting(false);
        return;
      }

      const jobId = (data as PostResponse).postJob.id;
      setSuccessMessage(`Post created (job ${jobId}).`);
      setExistingPosting(false);
      setExistingCaption("");
      setExistingLocation("");
      setSelectedMediaId("");
    } catch (_err) {
      setExistingPostError("Unexpected error while creating post.");
      setExistingPosting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => setMode("upload")}
          className={`rounded px-3 py-1.5 font-medium ${mode === "upload" ? "bg-black text-white" : "bg-zinc-100 text-zinc-800"}`}
        >
          Upload new media
        </button>
        <button
          type="button"
          onClick={() => setMode("existing")}
          className={`rounded px-3 py-1.5 font-medium ${mode === "existing" ? "bg-black text-white" : "bg-zinc-100 text-zinc-800"}`}
        >
          Use existing media
        </button>
        {successMessage && (
          <span className="ml-auto text-xs text-emerald-700">{successMessage}</span>
        )}
      </div>

      {mode === "upload" && (
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
              Type to search for locations. Coordinates will be added automatically for YouTube.
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
      )}

      {mode === "existing" && (
        <form onSubmit={handleExistingSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-zinc-900">
              Choose media from your library
            </label>
            {existingLoading && (
              <p className="mt-1 text-xs text-zinc-500">Loading media items...</p>
            )}
            {existingError && (
              <p className="mt-1 text-xs text-red-600">{existingError}</p>
            )}
            {!existingLoading && !existingError && existingItems.length === 0 && (
              <p className="mt-1 text-xs text-zinc-600">
                No media found. Upload something first in the Media library.
              </p>
            )}
            {!existingLoading && !existingError && existingItems.length > 0 && (
              <select
                value={selectedMediaId}
                onChange={(event) => setSelectedMediaId(event.target.value)}
                className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-zinc-900"
              >
                <option value="">Select a media item</option>
                {existingItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.originalFilename} ({formatBytes(item.sizeBytes)})
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-900">
              Caption
            </label>
            <textarea
              value={existingCaption}
              onChange={(event) => setExistingCaption(event.target.value)}
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
              value={existingLocation}
              onChange={setExistingLocation}
              placeholder="Start typing a location..."
              className="mt-1 w-full rounded border border-zinc-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-zinc-900"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Type to search for locations. Coordinates will be added automatically for YouTube.
            </p>
          </div>
          <div className="flex items-center justify-between text-xs">
            <button
              type="submit"
              disabled={existingPosting}
              className="rounded bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-70"
            >
              {existingPosting ? "Creating post..." : "Create post"}
            </button>
            {existingPostError && (
              <span className="text-xs text-red-600">{existingPostError}</span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
