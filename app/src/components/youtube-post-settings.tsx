"use client";

import type { YouTubePostMetadata } from "@/server/platforms/types";

interface YouTubePostSettingsProps {
  metadata: YouTubePostMetadata;
  onChange: (metadata: YouTubePostMetadata) => void;
}

export function YouTubePostSettings({ metadata, onChange }: YouTubePostSettingsProps) {
  return (
    <div className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="pb-2 border-b border-zinc-200">
        <h3 className="text-sm font-semibold text-zinc-900">YouTube Post Settings</h3>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-900 mb-2">
          Privacy
        </label>
        <select
          value={metadata.privacyStatus}
          onChange={(e) =>
            onChange({
              ...metadata,
              privacyStatus: e.target.value as YouTubePostMetadata["privacyStatus"],
            })
          }
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
        >
          <option value="public">Public</option>
          <option value="unlisted">Unlisted</option>
          <option value="private">Private</option>
        </select>
        <p className="mt-1 text-xs text-zinc-500">
          Unlisted: only people with the link can view — recommended.
        </p>
      </div>
    </div>
  );
}
