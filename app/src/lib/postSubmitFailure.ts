/**
 * R24 JJ2 follow-up: what Create's Post button says when the press fails
 * before an answer. POST /api/posts carries no idempotency key, so a request
 * whose fetch rejected may still have been saved: the person checks Queue
 * before pressing again, rather than risking a second post.
 */

import { UploadRefusedError } from "./uploadFailure";

export const POST_CONNECTION_LOST_MESSAGE =
  "We lost the connection before Vibe Socials answered. Check Queue to see whether the post was saved before you try again.";

const SUBMIT_FAILED_MESSAGE = "Unexpected error while creating post.";

/** The post request's fetch rejected: no answer came. */
export class PostConnectionLostError extends Error {
  constructor() {
    super(POST_CONNECTION_LOST_MESSAGE);
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
export function submitErrorText(error: unknown): string {
  return error instanceof UploadRefusedError || error instanceof PostConnectionLostError
    ? error.message
    : SUBMIT_FAILED_MESSAGE;
}
