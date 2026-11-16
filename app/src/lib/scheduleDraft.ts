import type { Platform } from "@prisma/client";

import { isRouteBody } from "./postSubmitFailure";
import { captionChanged, postActionRefusal, publishOutcome, queueMayHaveGoneThroughText, type JobPatch } from "./queueActions";

/**
 * "Schedule a draft" from the Queue's Edit dialog (2026-11-01 audit, Task 2),
 * extracted from the component so the orchestration is table-testable with an
 * injected `fetch`:
 *
 *   1. PATCH the caption — only if it or the per-platform captions changed;
 *   2. a failed PATCH stops here (publish is never called);
 *   3. POST `…/publish { scheduledFor }` — for a member in an approval
 *      workspace the server answers 202 pending (a submission) instead of 200
 *      scheduled;
 *   4. the publish response must be one of those two shapes — anything else is
 *      an ERROR (`unreadable_response`), never a success.
 *
 * It never throws. A request with no answer (the fetch threw, or a 5xx that
 * isn't the route's own JSON, such as a gateway's page) becomes `no_answer`:
 * it may have gone through, so the text says so and the caller reloads the
 * Queue (R27 MM4 review). Every
 * failure says whether the caption PATCH landed (`captionSaved`), so the
 * component can patch the card's caption without closing the dialog.
 */

/** The slice of `fetch` this flow needs (the real `fetch` satisfies it). */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<FetchResponseLike>;

export type ScheduleDraftResult =
  | {
      kind: "scheduled";
      /** Card patch: the caption plus whatever the publish response said. */
      patch: JobPatch;
      /** Toast text ("Post scheduled." / "Sent for approval"). */
      message: string;
      /** The caption PATCH landed in this call. */
      captionSaved: boolean;
    }
  | {
      kind: "failed";
      reason:
        | "caption_save_failed" // the PATCH was refused; publish never called
        | "publish_failed" // the publish call was refused (non-2xx)
        | "unreadable_response" // publish answered 2xx but not with a recognisable body
        | "no_answer"; // no answer, or a gateway's 5xx page: it may have gone through
      /** User-facing text: the server's own error when it sent one. */
      error: string;
      /** The caption PATCH landed in this call (so the card's caption changed). */
      captionSaved: boolean;
      /**
       * R31 publishing L3: the refusal means the post moved on (or the page is
       * for another workspace), by the shared rule (postActionRefusal): the
       * dialog keeps what was typed with Save off, and the Queue reloads when
       * `reload` says so.
       */
      movedOn?: { reload: boolean };
    };

export const SAVE_FALLBACK_ERROR = "Couldn't save your changes.";
/** Added to a moved-on refusal that came after the caption was saved. */
export const CAPTION_SAVED_NOTE = "Your caption changes were saved.";
export const UNREADABLE_PUBLISH_ERROR =
  "Couldn't confirm what happened to this post. Check the Queue before trying again.";

/**
 * A refused request's answer by the shared rule (postActionRefusal), or null
 * for a 5xx that isn't the route's (no answer).
 */
async function readRefusal(
  response: FetchResponseLike,
  fallback: string,
): Promise<{ error: string; movedOn?: { reload: boolean } } | null> {
  const data = (await response.json().catch(() => null)) as unknown;
  if (response.status >= 500 && !isRouteBody(data)) return null;
  const refusal = postActionRefusal(response.status, data, fallback);
  return refusal.movedOn ? { error: refusal.text, movedOn: { reload: refusal.reload } } : { error: refusal.text };
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/** 202 pending, or 200 scheduled carrying the time it was scheduled for. */
function isScheduleAnswer(patch: JobPatch): boolean {
  return (
    patch.approvalState === "pending" ||
    (patch.status === "scheduled" && typeof patch.scheduledFor === "string")
  );
}

export async function scheduleDraft(input: {
  fetchFn: FetchLike;
  jobId: string;
  /** The new (already trimmed) caption. */
  caption: string;
  /** The caption as last persisted, to decide whether a PATCH is needed. */
  originalCaption: string | null;
  /** UTC ISO of the chosen time (already validated by `checkScheduleTime`). */
  scheduledForIso: string;
  /** The server will treat this as a submission (member under approval) — only picks error wording. */
  submitsForApproval: boolean;
  /**
   * Per-platform captions to save with the caption, already cleaned: an object,
   * or `null` to remove them all. Leave it undefined when they were not edited.
   */
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
  /** R31 pages L2: the workspace the Queue was drawn for (null: none yet, left out). */
  workspaceId: string | null;
}): Promise<ScheduleDraftResult> {
  const {
    fetchFn,
    jobId,
    caption,
    originalCaption,
    scheduledForIso,
    submitsForApproval,
    perPlatformOverrides,
    workspaceId,
  } = input;
  const pageWorkspace = workspaceId ? { workspaceId } : {};
  let captionSaved = false;
  // Which request a lost answer belongs to, for what may have happened.
  let lost: "edit" | "schedule" | "submit" = "edit";
  const noAnswer = (): ScheduleDraftResult => ({
    kind: "failed",
    reason: "no_answer",
    error: queueMayHaveGoneThroughText(lost),
    captionSaved,
  });

  try {
    if (captionChanged(originalCaption, caption) || perPlatformOverrides !== undefined) {
      const patchResponse = await fetchFn(`/api/posts/${jobId}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          baseCaption: caption,
          ...(perPlatformOverrides !== undefined ? { perPlatformOverrides } : {}),
          ...pageWorkspace,
        }),
      });
      if (!patchResponse.ok) {
        const refusal = await readRefusal(patchResponse, SAVE_FALLBACK_ERROR);
        if (refusal === null) return noAnswer();
        return { kind: "failed", reason: "caption_save_failed", ...refusal, captionSaved: false };
      }
      captionSaved = true;
    }

    lost = submitsForApproval ? "submit" : "schedule";
    const publishResponse = await fetchFn(`/api/posts/${jobId}/publish`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scheduledFor: scheduledForIso, ...pageWorkspace }),
    });
    if (!publishResponse.ok) {
      const refusal = await readRefusal(
        publishResponse,
        submitsForApproval ? "Couldn't submit this post for approval." : "Couldn't schedule this post.",
      );
      if (refusal === null) return noAnswer();
      // Lead review: the post moved on after the caption landed: say it was saved, so
      // the dialog does not ask the person to copy text that is already kept.
      if (refusal.movedOn && captionSaved) {
        return { kind: "failed", reason: "publish_failed", ...refusal, error: `${refusal.error} ${CAPTION_SAVED_NOTE}`, captionSaved };
      }
      return { kind: "failed", reason: "publish_failed", ...refusal, captionSaved };
    }

    // A schedule request has exactly two successful answers: 200 scheduled (with
    // a time) or 202 pending. Anything else cannot be trusted to update the card.
    const outcome = publishOutcome(await publishResponse.json().catch(() => null));
    if (outcome.kind !== "update" || !isScheduleAnswer(outcome.patch)) {
      return {
        kind: "failed",
        reason: "unreadable_response",
        error: UNREADABLE_PUBLISH_ERROR,
        captionSaved,
      };
    }

    return {
      kind: "scheduled",
      patch: { caption, ...outcome.patch },
      message: outcome.message,
      captionSaved,
    };
  } catch {
    return noAnswer();
  }
}
