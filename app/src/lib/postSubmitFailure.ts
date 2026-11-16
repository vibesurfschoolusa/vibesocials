/**
 * R24 JJ2 follow-up: what Create's Post button says when the press fails
 * before an answer. POST /api/posts carries no idempotency key, so a request
 * whose fetch rejected may still have been saved: the person checks the page
 * the post would be on (postDestination) before pressing again, rather than
 * risking a second post.
 */

import { answerLostText } from "./answerLost";
import { postDestination, type ComposerPublishMode } from "./composerSubmitOutcome";
import { UploadRefusedError } from "./uploadFailure";

/** What the form knows before an answer: the mode, and whether its posts are held. */
export type SubmitWhere = { mode: ComposerPublishMode; holdsForApproval: boolean };

function connectionLostText({ mode, holdsForApproval }: SubmitWhere): string {
  const page = postDestination(mode, holdsForApproval) === "activity" ? "Activity" : "Queue";
  return answerLostText("the post may have been saved", `Check ${page} to see whether it was before you try again.`);
}

const SUBMIT_FAILED_MESSAGE = "Unexpected error while creating post.";

/** The post request's fetch rejected: no answer came. */
export class PostConnectionLostError extends Error {
  constructor() {
    super("The post request got no answer.");
    this.name = "PostConnectionLostError";
  }
}

/**
 * R26 LL3: a 5xx carrying the route's own JSON (an `error` or `code` string).
 * A gateway's 502/504 page is not one, and it can come after the post was
 * created (the function timed out while the hand-off or an email hung).
 */
async function isRouteAnswer(response: Response): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await response.clone().text());
    if (typeof parsed !== "object" || parsed === null) return false;
    const { error, code } = parsed as Record<string, unknown>;
    return (typeof error === "string" && error !== "") || (typeof code === "string" && code !== "");
  } catch {
    return false;
  }
}

/**
 * POST /api/posts with `body`; any answer comes back as it is, except a 5xx
 * that isn't the route's JSON: like no answer at all, the post may exist.
 */
export async function sendPostRequest(body: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch {
    throw new PostConnectionLostError();
  }
  if (response.status >= 500 && !(await isRouteAnswer(response))) throw new PostConnectionLostError();
  return response;
}

/** An explained upload failure or a lost post request says why; anything else, today's text. */
export function submitErrorText(error: unknown, where: SubmitWhere): string {
  if (error instanceof UploadRefusedError) return error.message;
  if (error instanceof PostConnectionLostError) return connectionLostText(where);
  return SUBMIT_FAILED_MESSAGE;
}
