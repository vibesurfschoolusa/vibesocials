"use client";

import { useEffect, useState } from "react";

interface MediaItemDto {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  baseCaption: string;
  createdAt: string;
}

interface ListResponse {
  items: MediaItemDto[];
}

interface CreateResponse {
  mediaItem: MediaItemDto;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(1)} ${sizes[i]}`;
}

export function MediaLibrary() {
  const [items, setItems] = useState<MediaItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [baseCaption, setBaseCaption] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);

  async function loadItems() {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/media");
      const data = (await response.json().catch(() => null)) as ListResponse | null;

      if (!response.ok) {
        setError((data as any)?.error ?? "Failed to load media items.");
        setLoading(false);
        return;
      }

      const list = Array.isArray(data?.items) ? data!.items : [];
      setItems(list);
      setLoading(false);
    } catch (_err) {
      setError("Unexpected error while loading media items.");
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadItems();
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setUploadError(null);
    setUploadMessage(null);

    if (!file) {
      setUploadError("Please choose a file to upload.");
      return;
    }

    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("baseCaption", baseCaption);

      const response = await fetch("/api/media", {
        method: "POST",
        body: formData,
      });

      const data = (await response.json().catch(() => null)) as
        | CreateResponse
        | { error?: string }
        | null;

      if (!response.ok) {
        setUploadError((data as any)?.error ?? "Failed to upload media.");
        setUploading(false);
        return;
      }

      const created = (data as CreateResponse).mediaItem;
      setItems((prev) => [created, ...prev]);
      setFile(null);
      setBaseCaption("");
      setUploadMessage("Media uploaded successfully.");
      setUploading(false);
    } catch (_err) {
      setUploadError("Unexpected error while uploading media.");
      setUploading(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-zinc-900">
            Upload new media
          </label>
          <input
            type="file"
            accept="video/*,image/*"
            onChange={(event) => {
              const nextFile = event.target.files?.[0] ?? null;
              setFile(nextFile);
            }}
            className="mt-1 block w-full text-sm text-zinc-900 file:mr-3 file:rounded file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-800"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-900">
            Base caption
          </label>
          <textarea
            value={baseCaption}
            onChange={(event) => setBaseCaption(event.target.value)}
            rows={3}
            className="mt-1 w-full rounded border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-zinc-900"
            placeholder="Optional base caption to reuse across posts"
          />
        </div>
        <div className="flex items-center justify-between text-xs">
          <button
            type="submit"
            disabled={uploading}
            className="rounded bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-70"
          >
            {uploading ? "Uploading..." : "Upload"}
          </button>
          <div className="flex items-center gap-3">
            {uploadMessage && (
              <span className="text-xs text-emerald-700">{uploadMessage}</span>
            )}
            {uploadError && (
              <span className="text-xs text-red-600">{uploadError}</span>
            )}
          </div>
        </div>
      </form>

      <div className="border-t border-zinc-200 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900">Your media</h2>
          {loading && <span className="text-xs text-zinc-500">Loading...</span>}
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {!loading && !error && items.length === 0 && (
          <p className="text-xs text-zinc-600">
            No media uploaded yet. Use the form above to add your first file.
          </p>
        )}
        {!loading && !error && items.length > 0 && (
          <ul className="divide-y divide-zinc-100">
            {items.map((item) => (
              <li key={item.id} className="py-2 text-xs">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-zinc-900">
                      {item.originalFilename}
                    </div>
                    <div className="text-[11px] text-zinc-600">
                      {item.mimeType} · {formatBytes(item.sizeBytes)}
                    </div>
                    {item.baseCaption && (
                      <div className="mt-1 text-[11px] text-zinc-700">
                        {item.baseCaption}
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] text-zinc-500">
                      {new Date(item.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
