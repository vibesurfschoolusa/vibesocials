"use client";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { platformLabel } from "@/lib/platforms";
import {
  choosePlacement,
  placementNote,
  storyVideoLengthRefusal,
  type PlacementChoice,
  type StoryPlacement,
  type StoryPlatform,
} from "@/lib/storyPlacement";

interface StoryPlacementSettingsProps {
  platform: StoryPlatform;
  choice: PlacementChoice;
  /** Files attached to the post: a Story takes one. */
  fileCount: number;
  /** The chosen video's length once the browser has read it; null for a photo or unknown. */
  videoDurationSec: number | null;
  onChange: (choice: PlacementChoice) => void;
}

const OPTIONS: { value: StoryPlacement; label: string }[] = [
  { value: "feed", label: "Feed" },
  { value: "story", label: "Story" },
];

/** Feed or Story for Instagram or a Facebook Page (2026-11-10). */
export function StoryPlacementSettings({
  platform,
  choice,
  fileCount,
  videoDurationSec,
  onChange,
}: StoryPlacementSettingsProps) {
  const label = platformLabel(platform);
  const note = placementNote(platform, choice, fileCount);
  const lengthRefusal = choice.placement === "story" ? storyVideoLengthRefusal(platform, videoDurationSec) : null;
  const storyBlocked = fileCount > 1;

  return (
    <Card className="space-y-2 p-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-foreground">{label}: post to</legend>
        <div className="flex flex-wrap gap-2">
          {OPTIONS.map(({ value, label: optionLabel }) => {
            const disabled = value === "story" && storyBlocked;
            const checked = choice.placement === value;
            return (
              <label
                key={value}
                className={cn(
                  "inline-flex items-center gap-2 rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors",
                  disabled
                    ? "cursor-not-allowed border-input text-muted-foreground opacity-60"
                    : checked
                      ? "cursor-pointer border-primary/40 bg-primary/10 text-foreground"
                      : "cursor-pointer border-input text-muted-foreground hover:text-foreground",
                )}
              >
                <input
                  type="radio"
                  name={`placement-${platform}`}
                  value={value}
                  className="h-3.5 w-3.5 accent-[var(--primary)]"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onChange(choosePlacement(choice, value, fileCount))}
                />
                {optionLabel}
              </label>
            );
          })}
        </div>
      </fieldset>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {lengthRefusal ? (
        <p className="text-xs text-destructive" role="alert">
          {lengthRefusal}
        </p>
      ) : null}
    </Card>
  );
}
