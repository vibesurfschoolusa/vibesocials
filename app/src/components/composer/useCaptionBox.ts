"use client";

import { useCallback, useRef, useState, type SetStateAction } from "react";

import { captionAfterMediaChange } from "./attached-photos";

/** What a caption request noted at its press: the media, the box as it was, and the form's generation. */
export interface CaptionPress {
  askedAbout: unknown;
  captionAtPress: string;
  generation: number;
}

/**
 * R36 lead review: a caption from media is written only while the media it was
 * asked about is still the selected media (not dismissed, not replaced by a new
 * pick) and the caption box is as it was at the press. `overwrite` (a manual
 * press) replaces that caption; the automatic one fills only an empty box.
 */
export function captionResultApplies(state: {
  askedAbout: unknown;
  selectedNow: unknown;
  captionAtPress: string;
  captionNow: string;
  overwrite: boolean;
}): boolean {
  if (state.askedAbout !== state.selectedNow || state.captionNow !== state.captionAtPress) return false;
  return state.overwrite || !state.captionNow.trim();
}

/**
 * R37 lead review: Create's caption box, and the last caption the AI wrote
 * from the media. Caption requests outlive the render that started them (a
 * pick's upload, a set's queue), so the press and the answer read the box from
 * a ref that every change of the box updates at once, never from a closure.
 */
export function useCaptionBox() {
  const [caption, setCaptionState] = useState("");
  // 07c: "Remove all" clears the box only while it still holds exactly this.
  const [lastAiCaption, setLastAiState] = useState<string | null>(null);
  const captionRef = useRef("");
  const lastAiRef = useRef<string | null>(null);
  // R38 new-customer M1: saving the post resets the form and bumps this, so
  // every answer pressed for the old post is dropped, whatever the box says.
  const generationRef = useRef(0);

  // Stable, so effects can name it as they name a state setter.
  const setCaption = useCallback((next: SetStateAction<string>) => {
    const value = typeof next === "function" ? next(captionRef.current) : next;
    captionRef.current = value;
    setCaptionState(value);
  }, []);

  function setLastAiCaption(next: string | null) {
    lastAiRef.current = next;
    setLastAiState(next);
  }

  // R37 new-customer L1: the selected media is being replaced or dropped. A
  // caption the AI wrote for it, still unedited, goes with it
  // (captionAfterMediaChange); typed or edited text stays untouched.
  function forgetMediaCaption() {
    const next = captionAfterMediaChange(captionRef.current, lastAiRef.current);
    if (next.caption === captionRef.current) return;
    setCaption(next.caption);
    setLastAiCaption(next.lastAiCaption);
  }

  // Stable and read live, so the per-platform captions (Adapt) can hold
  // their answers to the same generation.
  const formGeneration = useCallback(() => generationRef.current, []);

  /** The form was saved and reset: answers pressed before now are dropped. */
  function formReset() {
    generationRef.current += 1;
  }

  function pressed(askedAbout: unknown): CaptionPress {
    return { askedAbout, captionAtPress: captionRef.current, generation: generationRef.current };
  }

  /**
   * Writes the answer by captionResultApplies, within the press's form
   * generation. A caption from media (`fromMedia`, the default) is remembered
   * as the AI's when written; Improve's rewrite is not, so a new pick keeps it.
   */
  function answered(
    press: CaptionPress,
    answer: { caption: string; selectedNow: unknown; overwrite: boolean; fromMedia?: boolean },
  ): boolean {
    if (press.generation !== generationRef.current) return false;
    const applies = captionResultApplies({
      askedAbout: press.askedAbout,
      selectedNow: answer.selectedNow,
      captionAtPress: press.captionAtPress,
      captionNow: captionRef.current,
      overwrite: answer.overwrite,
    });
    if (!applies) return false;
    setCaption(answer.caption);
    if (answer.fromMedia !== false) setLastAiCaption(answer.caption);
    return true;
  }

  return { caption, setCaption, lastAiCaption, forgetMediaCaption, pressed, answered, formReset, formGeneration };
}
