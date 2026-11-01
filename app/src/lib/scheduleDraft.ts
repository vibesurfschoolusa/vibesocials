import { captionChanged, publishOutcome, type JobPatch } from "./queueActions";

/**
 * "Schedule a draft" from the Queue's Edit dialog (2026-11-01 audit, Task 2),
 * extracted from the component so the orchestration is table-testable with an
 * injected `fetch`:
 *
 *   1. PATCH the caption — only if it changed;
 *   2. a failed PATCH stops here (publish is never called);
 *   3. POST `…/publish { scheduledFor }` — for a member in an approval
 *      workspace the server answers 202 pending (a submission) instead of 200
 *      scheduled;
 *   4. the publish response must be one of those two shapes — anything else is
 *      an ERROR (`unreadable_response`), never a success.
 *
 * It never throws: a network failure becomes a `network_error` result. Every
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
        | "network_error"; // fetch threw (before or after the PATCH landed)
      /** User-facing text: the server's own error when it sent one. */
      error: string;
      /** The caption PATCH landed in this call (so the card's caption changed). */
      captionSaved: boolean;
    };

export const SAVE_FALLBACK_ERROR = "Couldn't save your changes.";
export const UNREADABLE_PUBLISH_ERROR =
  "Couldn't confirm what happened to this post. Check the Queue before trying again.";

async function readServerError(response: FetchResponseLike, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === "string" && data.error ? data.error : fallback;
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
}): Promise<ScheduleDraftResult> {
  const { fetchFn, jobId, caption, originalCaption, scheduledForIso, submitsForApproval } = input;
  let captionSaved = false;

  try {
    if (captionChanged(originalCaption, caption)) {
      const patchResponse = await fetchFn(`/api/posts/${jobId}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ baseCaption: caption }),
      });
      if (!patchResponse.ok) {
        return {
          kind: "failed",
          reason: "caption_save_failed",
          error: await readServerError(patchResponse, SAVE_FALLBACK_ERROR),
          captionSaved: false,
        };
      }
      captionSaved = true;
    }

    const publishResponse = await fetchFn(`/api/posts/${jobId}/publish`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scheduledFor: scheduledForIso }),
    });
    if (!publishResponse.ok) {
      return {
        kind: "failed",
        reason: "publish_failed",
        error: await readServerError(
          publishResponse,
          submitsForApproval
            ? "Couldn't submit this post for approval."
            : "Couldn't schedule this post.",
        ),
        captionSaved,
      };
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
    return { kind: "failed", reason: "network_error", error: SAVE_FALLBACK_ERROR, captionSaved };
  }
}
