"use client";

import { useRef, useState } from "react";

import { Label } from "@/components/ui/label";
import {
  COVER_IMAGE_RULE,
  clampCoverTimeMs,
  formatCoverTime,
  validateCoverImageFile,
  type CoverChoice,
} from "@/lib/videoCover";

interface VideoCoverPickerProps {
  /** The video being posted: its local preview URL or its stored URL. */
  videoUrl: string;
  /** The video's length, once the preview has read it. */
  durationSec: number | null;
  value: CoverChoice;
  onChange: (choice: CoverChoice) => void;
}

const OPTIONS: Array<{ kind: CoverChoice["kind"]; label: string }> = [
  { kind: "default", label: "Platform default" },
  { kind: "frame", label: "Pick a frame" },
  { kind: "upload", label: "Upload a cover image" },
];

/**
 * The Cover control under a video's preview (V1): the platforms' own cover,
 * a frame of the video, or an uploaded JPEG.
 */
export function VideoCoverPicker({ videoUrl, durationSec, value, onChange }: VideoCoverPickerProps) {
  const frameRef = useRef<HTMLVideoElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const durationMs = durationSec && Number.isFinite(durationSec) ? Math.floor(durationSec * 1000) : 0;

  function choose(kind: CoverChoice["kind"]) {
    setUploadError(null);
    if (kind === "default") onChange({ kind: "default" });
    else if (kind === "frame") onChange({ kind: "frame", timeMs: value.kind === "frame" ? value.timeMs : 0 });
    // "Upload" waits for a file; until then the cover stays as it was.
    else if (value.kind !== "upload") onChange({ kind: "default" });
  }

  function seek(timeMs: number) {
    const clamped = clampCoverTimeMs(timeMs, durationSec);
    if (frameRef.current) frameRef.current.currentTime = clamped / 1000;
    onChange({ kind: "frame", timeMs: clamped });
  }

  function pickFile(file: File | undefined) {
    if (!file) return;
    const error = validateCoverImageFile(file);
    if (error) {
      setUploadError(error);
      return;
    }
    setUploadError(null);
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    setUploadPreview(URL.createObjectURL(file));
    onChange({ kind: "upload", file });
  }

  const [shownKind, setShownKind] = useState<CoverChoice["kind"]>(value.kind);
  const selected = value.kind === "default" && shownKind === "upload" ? "upload" : value.kind;

  return (
    <fieldset className="space-y-2 rounded-[var(--radius)] border border-border p-3">
      <legend className="px-1 text-sm font-medium text-foreground">Cover</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2" role="radiogroup" aria-label="Video cover">
        {OPTIONS.map((option) => (
          <label key={option.kind} className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="video-cover"
              value={option.kind}
              checked={selected === option.kind}
              onChange={() => {
                setShownKind(option.kind);
                choose(option.kind);
              }}
            />
            {option.label}
          </label>
        ))}
      </div>

      {selected === "default" && (
        <p className="text-xs text-muted-foreground">Each platform picks its own cover.</p>
      )}

      {selected === "frame" && value.kind === "frame" && (
        <div className="space-y-2">
          <video
            ref={frameRef}
            src={videoUrl}
            muted
            playsInline
            preload="auto"
            aria-label="Chosen cover frame"
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = value.timeMs / 1000;
            }}
            className="max-h-40 w-auto rounded-[var(--radius)] border border-border"
          />
          <Label htmlFor="video-cover-frame">Frame at {formatCoverTime(value.timeMs)}</Label>
          <input
            id="video-cover-frame"
            type="range"
            min={0}
            max={durationMs}
            step={100}
            value={value.timeMs}
            disabled={durationMs === 0}
            onChange={(e) => seek(Number(e.target.value))}
            className="w-full"
          />
        </div>
      )}

      {selected === "upload" && (
        <div className="space-y-2">
          <Label htmlFor="video-cover-file">Cover image</Label>
          <input
            id="video-cover-file"
            type="file"
            accept="image/jpeg"
            onChange={(e) => pickFile(e.target.files?.[0])}
            className="block w-full text-sm"
          />
          {value.kind === "upload" && uploadPreview && (
            // eslint-disable-next-line @next/next/no-img-element -- local object-URL preview, like the media preview above
            <img
              src={uploadPreview}
              alt="Chosen cover image"
              className="max-h-40 w-auto rounded-[var(--radius)] border border-border object-contain"
            />
          )}
          {uploadError && (
            <p role="alert" className="text-xs text-destructive">
              {uploadError}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{COVER_IMAGE_RULE} Instagram takes JPEG covers only.</p>
        </div>
      )}

      {selected !== "default" && (
        <p className="text-xs text-muted-foreground">
          Used on YouTube, Instagram Reels, Facebook and LinkedIn. YouTube shows a custom cover only on
          verified channels. X and TikTok pick their own.
        </p>
      )}
    </fieldset>
  );
}
