"use client";

import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { YouTubePostMetadata } from "@/server/platforms/types";

/**
 * R55 new-customer-2 L2: the select's option texts, also used by Create's
 * publish confirmation, so the two can't differ.
 */
export const YOUTUBE_PRIVACY_LABELS: Record<YouTubePostMetadata["privacyStatus"], string> = {
  public: "Public",
  unlisted: "Unlisted",
  private: "Private",
};

interface YouTubePostSettingsProps {
  metadata: YouTubePostMetadata;
  onChange: (metadata: YouTubePostMetadata) => void;
  /** R65: Create's send lock (sendLocksFields). */
  disabled?: boolean;
}

export function YouTubePostSettings({ metadata, onChange, disabled = false }: YouTubePostSettingsProps) {
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
          disabled={disabled}
          onChange={(e) =>
            onChange({
              ...metadata,
              privacyStatus: e.target.value as YouTubePostMetadata["privacyStatus"],
            })
          }
        >
          {(Object.keys(YOUTUBE_PRIVACY_LABELS) as YouTubePostMetadata["privacyStatus"][]).map((value) => (
            <option key={value} value={value}>
              {YOUTUBE_PRIVACY_LABELS[value]}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">
          Unlisted: only people with the link can view &mdash; recommended.
        </p>
      </div>
    </Card>
  );
}
