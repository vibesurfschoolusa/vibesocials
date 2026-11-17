"use client";

import { useCallback, useRef, useState, type SetStateAction } from "react";

import { captionAfterMediaChange } from "./attached-photos";

/** What a caption request noted at its press: the media, the box as it was, and the form's generation. */
export interface CaptionPress {
  askedAbout: unknown;
  captionAtPress: string;
  generation: number;
  /** The box held the AI's unedited caption from media at the press. */
  wasAiCaption: boolean;
}

/**
 * R39 lead review: how long Create waits for an AI answer before the request
 * is given up (aborted) and the submit no longer waits for it. The server's
 * own provider limit is 20 s per call (lib/aiGuards.ts), so a working answer
 * is always in well before this.
 */
export const AI_REQUEST_TIMEOUT_MS = 60_000;

/**
 * One AI request that writes into the post (useCaptionBox.aiRequestStarted).
 * The submit waits while it runs; it ends when it is done, runs out of time,
 * or is let go by the rule it belongs to (a media change, an untick, a reset).
 */
export interface AiRequest {
  /** Aborts the fetch when the request is let go or runs out of time. */
  signal: AbortSignal;
  /** False once a media change, an untick or a form reset let it go: send nothing, write nothing, say nothing. */
  live(): boolean;
  /** The request ended: the submit stops waiting for it. Safe to call twice. */
  done(): void;
  /**
   * R40 review: the caller's own rule says its answer can no longer apply
   * (Adapt's source changed): let go as a media change does. Safe to call twice.
   */
  letGo(): void;
}

/** What a request is about, for the rules that let it go. */
export interface AiRequestKind {
  /** A caption from media: a media change lets it go. */
  media: boolean;
  /** Started by the media, not a press: unticking its switch lets it go. */
  automatic: boolean;
  /**
   * R40: its answer goes into the caption box, by captionResultApplies with
   * this press and `overwrite`. It is held only while that answer can still
   * be written: not taken when it already can't, let go once the box changes.
   */
  intoCaption?: { press: CaptionPress; overwrite: boolean };
  /**
   * R40 lead review: a photo's description ("Write it for me"), asked about
   * this photo (its File, or the reused item). Create lets it go once that
   * photo is gone; the wait names a description, not a caption.
   */
  photo?: object;
}

/** R40 lead review: what the submit's wait says, by what the AI is writing. */
export const AI_CAPTION_WAIT_MESSAGE = "Wait until the AI caption is ready.";
export const AI_DESCRIPTION_WAIT_MESSAGE = "Wait until the photo description is ready.";
export const AI_WRITING_WAIT_MESSAGE = "Wait until the AI has finished writing.";

/** The one sentence for the wait (null: nothing is being written). */
export function aiWaitMessage(running: { captions: number; descriptions: number }): string | null {
  if (running.captions > 0 && running.descriptions > 0) return AI_WRITING_WAIT_MESSAGE;
  if (running.captions > 0) return AI_CAPTION_WAIT_MESSAGE;
  return running.descriptions > 0 ? AI_DESCRIPTION_WAIT_MESSAGE : null;
}

/** R40: whether a request's answer could still be written into the box as it reads now. */
function answerCanApply(kind: AiRequestKind, captionNow: string): boolean {
  if (!kind.intoCaption) return true;
  return captionResultApplies({
    askedAbout: null,
    selectedNow: null,
    captionAtPress: kind.intoCaption.press.captionAtPress,
    captionNow,
    overwrite: kind.intoCaption.overwrite,
  });
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
  // R39 new-customer M1: how many requests that will write into the post
  // (Improve, Adapt, Caption from media, manual or automatic) are running,
  // and (lead review) each one, so the rule it belongs to can let it go.
  const [aiRequests, setAiRequests] = useState({ captions: 0, descriptions: 0 });
  const runningRef = useRef(new Set<{ kind: AiRequestKind; letGo: () => void }>());

  // Stable, so effects can name it as they name a state setter.
  const setCaption = useCallback((next: SetStateAction<string>) => {
    const value = typeof next === "function" ? next(captionRef.current) : next;
    captionRef.current = value;
    setCaptionState(value);
    // R40: a request whose answer this box can no longer take stops holding
    // the submit at once, and its fetch is aborted.
    for (const entry of [...runningRef.current]) if (!answerCanApply(entry.kind, value)) entry.letGo();
  }, []);

  /**
   * R39 new-customer M1: a request that will write into the post holds the
   * submit while it runs, so nothing is posted unseen. Lead review: it lets
   * go when done, after AI_REQUEST_TIMEOUT_MS (the fetch is aborted and the
   * caller's failure sentence shows), or at once when a media change, an
   * untick or a form reset lets it go (letGoAiRequests). Stable, like setCaption.
   *
   * R40: one whose answer the box can't take already (an automatic caption
   * with text in the box) takes no token: it comes back let go, so the
   * caller sends nothing.
   */
  const aiRequestStarted = useCallback((kind: AiRequestKind): AiRequest => {
    const controller = new AbortController();
    if (!answerCanApply(kind, captionRef.current)) {
      controller.abort();
      return { signal: controller.signal, live: () => false, done: () => {}, letGo: () => {} };
    }
    let ended = false;
    let letGo = false;
    const part = kind.photo === undefined ? "captions" : "descriptions";
    const entry = {
      kind,
      letGo: () => {
        letGo = true;
        request.done();
        controller.abort();
      },
    };
    const timer = setTimeout(() => {
      request.done();
      controller.abort();
    }, AI_REQUEST_TIMEOUT_MS);
    const request: AiRequest = {
      signal: controller.signal,
      live: () => !letGo,
      done: () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        runningRef.current.delete(entry);
        setAiRequests((count) => ({ ...count, [part]: count[part] - 1 }));
      },
      letGo: () => {
        if (!ended) entry.letGo();
      },
    };
    runningRef.current.add(entry);
    setAiRequests((count) => ({ ...count, [part]: count[part] + 1 }));
    return request;
  }, []);

  /** Lets go of every running request that `which` names (the rules above). */
  const letGoAiRequests = useCallback((which: (kind: AiRequestKind) => boolean) => {
    for (const entry of [...runningRef.current]) if (which(entry.kind)) entry.letGo();
  }, []);

  function setLastAiCaption(next: string | null) {
    lastAiRef.current = next;
    setLastAiState(next);
  }

  // R37 new-customer L1: the selected media is being replaced or dropped. A
  // caption the AI wrote for it, still unedited, goes with it
  // (captionAfterMediaChange); typed or edited text stays untouched.
  function forgetMediaCaption() {
    // A caption still being asked for about the old media is let go.
    letGoAiRequests((kind) => kind.media);
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
    letGoAiRequests(() => true);
  }

  function pressed(askedAbout: unknown): CaptionPress {
    return {
      askedAbout,
      captionAtPress: captionRef.current,
      generation: generationRef.current,
      wasAiCaption: lastAiRef.current !== null && captionRef.current === lastAiRef.current,
    };
  }

  /**
   * Writes the answer by captionResultApplies, within the press's form
   * generation. A caption from media (`fromMedia`, the default) is remembered
   * as the AI's when written. A rewrite (Improve, `fromMedia: false`) keeps
   * the box's authorship at the press: of the unedited AI media caption it is
   * still the AI's about that media (a new pick clears it); of the person's
   * own text it stays theirs.
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
    if (answer.fromMedia !== false || press.wasAiCaption) setLastAiCaption(answer.caption);
    return true;
  }

  return {
    caption,
    setCaption,
    lastAiCaption,
    forgetMediaCaption,
    pressed,
    answered,
    formReset,
    formGeneration,
    /** The submit's wait sentence while an AI request writes into the post, else null. */
    aiWait: aiWaitMessage(aiRequests),
    aiRequestStarted,
    letGoAiRequests,
  };
}
