"use client";

import { useEffect, useRef, useState } from "react";
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
import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";
import type { AiRequest, AiRequestKind } from "./useCaptionBox";

/** Lead review 3 (R28 NN2): on a lost answer the AI ran and used the allowance; only its answer is missing, and nothing is saved. */
export const adaptLostText = (label: string): string =>
  answerLostText(`the adapted caption for ${label} isn't shown`, "Nothing was saved; try again.");

/** What an Adapt was sent from, noted at its press. */
export interface AdaptPress {
  platform: Platform;
  /** The platform's own text at the press ("" when it had none). */
  ownAtPress: string;
  /** The text sent to be adapted. */
  source: string;
  /** The source was the main caption (the platform's own box was empty). */
  sentMainCaption: boolean;
}

/**
 * R40 review: an Adapt answer is written only while its sources are as they
 * were at the press: the platform's own text (applyAdaptedCaption) and, when
 * it was sent, the main caption. The running Adapt is let go once this is false.
 */
export function adaptAnswerCanApply(
  press: AdaptPress,
  now: { caption: string; overrides: PlatformOverrides | null },
): boolean {
  if (press.sentMainCaption && now.caption !== press.source) return false;
  return now.overrides?.[press.platform] === press.ownAtPress;
}

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
  /** R31: the workspace the page was drawn for, sent with Adapt (null: none yet, left out). */
  workspaceId: string | null;
  /**
   * R38: Create's form generation (useCaptionBox), read live; an Adapt answer
   * pressed before the post was saved and the form reset is dropped.
   */
  formGeneration?: () => number;
  /**
   * R39 new-customer M1: Create's "AI is writing" state (useCaptionBox); an
   * Adapt holds it while it runs, so the post can't be sent meanwhile. Lead
   * review: it is aborted after its time limit, or let go by a form reset.
   */
  aiRequestStarted?: (kind: AiRequestKind) => AiRequest;
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
  workspaceId,
  formGeneration,
  aiRequestStarted,
}: PlatformCaptionEditorProps) {
  const toast = useToast();
  const [adapting, setAdapting] = useState<Platform | null>(null);
  // R38 review: the main caption as it is now, for an Adapt that sent it.
  const captionRef = useRef(caption);
  useEffect(() => {
    captionRef.current = caption;
  }, [caption]);
  // R40 review: the Adapt running now, with what it was sent from. Once that
  // source changes its answer can't be written, so it stops holding the
  // submit at once and its fetch is aborted.
  const runningAdaptRef = useRef<{ press: AdaptPress; request: AiRequest } | null>(null);
  useEffect(() => {
    const running = runningAdaptRef.current;
    if (running && !adaptAnswerCanApply(running.press, { caption, overrides })) running.request.letGo();
  }, [caption, overrides]);

  if (platforms.length === 0) return null;

  const count = countPlatformOverrides(overrides, platforms);

  async function handleAdapt(platform: Platform) {
    const own = overrides?.[platform];
    // What the answer must still find when it comes back (applyAdaptedCaption).
    const ownAtPress = own ?? "";
    const generationAtPress = formGeneration?.();
    // Adapt the platform's own text once it has some; otherwise the main caption.
    const source = own?.trim() ? own : caption;
    const sentMainCaption = source !== own;
    if (!source.trim()) {
      toast.error("Write a caption first, then adapt it.");
      return;
    }
    const maxLength = adaptMaxLength(platform, footer);
    setAdapting(platform);
    const request = aiRequestStarted?.({ media: false, automatic: false });
    const press: AdaptPress = { platform, ownAtPress, source, sentMainCaption };
    if (request) runningAdaptRef.current = { press, request };
    try {
      const response = await fetchOrNoAnswer("/api/posts/enhance-caption", {
        method: "POST",
        ...(request ? { signal: request.signal } : {}),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caption: source,
          platform,
          ...(maxLength !== undefined ? { maxLength } : {}),
          ...(workspaceId ? { workspaceId } : {}),
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { enhancedCaption?: unknown; error?: unknown }
        | null;
      // Let go (the form was reset): nothing to write or say.
      if (request && !request.live()) return;
      if (!response.ok || typeof data?.enhancedCaption !== "string") {
        toast.error(
          typeof data?.error === "string" && data.error
            ? data.error
            : `Couldn't adapt the caption for ${platformLabel(platform)}. Try again.`,
        );
        return;
      }
      const adapted = data.enhancedCaption;
      if (formGeneration && formGeneration() !== generationAtPress) return;
      // Its source edited meanwhile: the answer is out of date (adaptAnswerCanApply).
      if (sentMainCaption && captionRef.current !== source) return;
      onChange((prev) => applyAdaptedCaption(prev, platform, adapted, ownAtPress));
    } catch (caught) {
      if (request && !request.live()) return;
      toast.error(isNoAnswer(caught) ? adaptLostText(platformLabel(platform)) : `Couldn't adapt the caption for ${platformLabel(platform)}. Try again.`);
    } finally {
      setAdapting(null);
      if (runningAdaptRef.current?.request === request) runningAdaptRef.current = null;
      request?.done();
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
          const hintId = `${countId}-hint`;
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
                    aria-describedby={counter.hint ? `${countId} ${hintId}` : countId}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleAdapt(platform)}
                      loading={adapting === platform}
                      disabled={disabled || (adapting !== null && adapting !== platform)}
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
                  {/* Its own line, so "(too long)" stays next to the number on a phone. */}
                  {counter.hint ? (
                    <p id={hintId} className="text-xs text-muted-foreground">
                      {counter.hint}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}
