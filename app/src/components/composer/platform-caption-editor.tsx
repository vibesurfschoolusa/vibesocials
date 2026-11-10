"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import type { Platform } from "@prisma/client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { CaptionFooterUser } from "@/lib/captionFooter";
import { cn } from "@/lib/cn";
import {
  adaptMaxLength,
  applyAdaptedCaption,
  countPlatformOverrides,
  platformCaptionCounter,
  setPlatformOverride,
  type PlatformOverrides,
} from "@/lib/platformOverrides";
import { platformLabel } from "@/lib/platforms";

export interface PlatformCaptionEditorProps {
  /** Prefix for element ids, unique on the page. */
  idPrefix: string;
  /** The platforms the post goes to, in display order. */
  platforms: readonly Platform[];
  /** The main caption: the starting text of a newly switched-on caption. */
  caption: string;
  /** Every caption the user has switched on, as typed (not yet cleaned). */
  overrides: PlatformOverrides | null;
  /** Takes an updater so an AI answer that lands late never undoes other edits. */
  onChange: (update: (prev: PlatformOverrides | null) => PlatformOverrides) => void;
  /** The footer the app appends, so counters and "Adapt" leave room for it. */
  footer?: CaptionFooterUser | null;
  disabled?: boolean;
}

function captionCountText(count: number): string {
  if (count === 0) return "All platforms use the main caption";
  if (count === 1) return "1 platform has its own caption";
  return `${count} platforms have their own caption`;
}

/**
 * "Caption per platform": a switch per platform that gives it its own caption,
 * with a counter against that platform's limit and an "Adapt for {label}" AI
 * rewrite. Shared by the Create page and the Queue's edit dialog. What gets
 * sent is cleaned by the caller (lib/platformOverrides.ts).
 */
export function PlatformCaptionEditor({
  idPrefix,
  platforms,
  caption,
  overrides,
  onChange,
  footer,
  disabled = false,
}: PlatformCaptionEditorProps) {
  const toast = useToast();
  const [adapting, setAdapting] = useState<Platform | null>(null);

  if (platforms.length === 0) return null;

  const count = countPlatformOverrides(overrides, platforms);

  async function handleAdapt(platform: Platform) {
    const own = overrides?.[platform];
    // Adapt the platform's own text once it has some; otherwise the main caption.
    const source = own?.trim() ? own : caption;
    if (!source.trim()) {
      toast.error("Write a caption first, then adapt it.");
      return;
    }
    const maxLength = adaptMaxLength(platform, footer);
    setAdapting(platform);
    try {
      const response = await fetch("/api/posts/enhance-caption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caption: source,
          platform,
          ...(maxLength !== undefined ? { maxLength } : {}),
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { enhancedCaption?: unknown; error?: unknown }
        | null;
      if (!response.ok || typeof data?.enhancedCaption !== "string") {
        toast.error(
          typeof data?.error === "string" && data.error
            ? data.error
            : `Couldn't adapt the caption for ${platformLabel(platform)}. Try again.`,
        );
        return;
      }
      const adapted = data.enhancedCaption;
      onChange((prev) => applyAdaptedCaption(prev, platform, adapted));
    } catch {
      toast.error(`Couldn't adapt the caption for ${platformLabel(platform)}. Try again.`);
    } finally {
      setAdapting(null);
    }
  }

  return (
    <details className="group rounded-[var(--radius)] border border-border">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
        <span className="font-medium text-foreground">Caption per platform</span>
        <span className="text-xs text-muted-foreground">{captionCountText(count)}</span>
      </summary>
      <div className="space-y-4 border-t border-border px-3 py-3">
        {platforms.map((platform) => {
          const label = platformLabel(platform);
          const text = overrides?.[platform];
          const on = typeof text === "string";
          const switchLabelId = `${idPrefix}-${platform}-switch-label`;
          const textareaId = `${idPrefix}-${platform}-caption`;
          const countId = `${idPrefix}-${platform}-count`;
          const counter = on ? platformCaptionCounter(text, platform, footer) : null;
          return (
            <div key={platform} className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span id={switchLabelId} className="text-sm text-foreground">
                  Different caption for {label}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-labelledby={switchLabelId}
                  // Not while "Adapt" runs for this platform: its answer needs the caption on.
                  disabled={disabled || adapting === platform}
                  onClick={() =>
                    onChange((prev) => setPlatformOverride(prev, platform, !on, caption))
                  }
                  className={cn(
                    "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
                    on ? "bg-primary" : "bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "inline-block h-4 w-4 rounded-full bg-background shadow transition-transform",
                      on ? "translate-x-6" : "translate-x-1",
                    )}
                  />
                </button>
              </div>
              {on && counter ? (
                <div className="space-y-1.5">
                  {/* No `maxLength`: it would silently cut a paste; the counter shows the limit. */}
                  <Textarea
                    id={textareaId}
                    aria-label={`Caption for ${label}`}
                    value={text}
                    disabled={disabled}
                    onChange={(event) => {
                      const value = event.target.value;
                      onChange((prev) => ({ ...prev, [platform]: value }));
                    }}
                    rows={3}
                    aria-invalid={counter.over || undefined}
                    aria-describedby={countId}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleAdapt(platform)}
                      loading={adapting === platform}
                      disabled={disabled || adapting !== null}
                    >
                      {adapting !== platform && <Sparkles className="h-4 w-4" aria-hidden />}
                      Adapt for {label}
                    </Button>
                    <p
                      id={countId}
                      className={cn(
                        "ml-auto text-xs tabular-nums",
                        counter.over ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {counter.label}
                      {counter.over ? " (too long)" : ""}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}
