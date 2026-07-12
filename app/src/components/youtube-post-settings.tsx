"use client";

import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { YouTubePostMetadata } from "@/server/platforms/types";

interface YouTubePostSettingsProps {
  metadata: YouTubePostMetadata;
  onChange: (metadata: YouTubePostMetadata) => void;
}

export function YouTubePostSettings({ metadata, onChange }: YouTubePostSettingsProps) {
  return (
    <Card className="space-y-3 p-4">
      <div className="border-b border-border pb-2">
        <h3 className="text-sm font-semibold text-foreground">YouTube post settings</h3>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="youtube-privacy">Privacy</Label>
        <Select
          id="youtube-privacy"
          value={metadata.privacyStatus}
          onChange={(e) =>
            onChange({
              ...metadata,
              privacyStatus: e.target.value as YouTubePostMetadata["privacyStatus"],
            })
          }
        >
          <option value="public">Public</option>
          <option value="unlisted">Unlisted</option>
          <option value="private">Private</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          Unlisted: only people with the link can view &mdash; recommended.
        </p>
      </div>
    </Card>
  );
}
