/**
 * R24 JJ2 follow-up: what Create's Post button says when the press fails
 * before an answer. POST /api/posts carries no idempotency key, so a request
 * whose fetch rejected may still have been saved: the person checks the page
 * the post would be on (postDestination) before pressing again, rather than
 * risking a second post.
 */

import { postDestination, type ComposerPublishMode } from "./composerSubmitOutcome";
import { UploadRefusedError } from "./uploadFailure";

/** What the form knows before an answer: the mode, and whether its posts are held. */
export type SubmitWhere = { mode: ComposerPublishMode; holdsForApproval: boolean };

function connectionLostText({ mode, holdsForApproval }: SubmitWhere): string {
  const page = postDestination(mode, holdsForApproval) === "activity" ? "Activity" : "Queue";
  return `We lost the connection before Vibe Socials answered. Check ${page} to see whether the post was saved before you try again.`;
}

const SUBMIT_FAILED_MESSAGE = "Unexpected error while creating post.";

/** The post request's fetch rejected: no answer came. */
export class PostConnectionLostError extends Error {
  constructor() {
    super("The post request got no answer.");
    this.name = "PostConnectionLostError";
  }
}

/** POST /api/posts with `body`; any answer comes back as it is. */
export async function sendPostRequest(body: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  try {
    return await fetchImpl("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch {
    throw new PostConnectionLostError();
  }
}

/** An explained upload failure or a lost post request says why; anything else, today's text. */
export function submitErrorText(error: unknown, where: SubmitWhere): string {
  if (error instanceof UploadRefusedError) return error.message;
  if (error instanceof PostConnectionLostError) return connectionLostText(where);
  return SUBMIT_FAILED_MESSAGE;
}
