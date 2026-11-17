/**
 * What the forgot-password form shows after a submit, from the response
 * status (`null` when the request never got a response).
 *
 * A 2xx keeps the uniform "if an account exists" confirmation — the route
 * answers 200 whether or not the address has an account (SEC-1 no oracle).
 * A 429 or any other failure depends only on the request, never on whether an
 * account exists, so telling the user the request didn't go through leaks
 * nothing and stops them waiting for an email that was never sent.
 */

import { answerLostText } from "./answerLost";
import { LIMIT_UNCHECKED_MESSAGE } from "./limitUncheckedMessage";
import { tooManyTriesSentence, waitSecondsOf } from "./tooManyTriesText";

export type ForgotPasswordOutcome = { kind: "sent" } | { kind: "error"; message: string };

/**
 * `data`: the answer's body. R28 NN2 (new-customer L3): a 400's sentence
 * ("Enter a valid email address.") depends only on what was typed, never on
 * whether an account exists, so it is shown; so is the shared couldn't-check
 * sentence. Other bodies are not read.
 */
export function forgotPasswordOutcome(
  status: number | null,
  data?: { error?: unknown; retryAfterSeconds?: unknown } | null,
  retryAfterHeader?: string | number | null,
): ForgotPasswordOutcome {
  if (status !== null && status >= 200 && status < 300) {
    return { kind: "sent" };
  }
  if (status === 429) {
    // R42 review: the limit is up to 15 minutes, so the route's wait, in its words. The wait
    // depends only on the request, never on whether an account exists.
    const wait = waitSecondsOf(data, retryAfterHeader);
    return {
      kind: "error",
      message: wait === undefined ? "Too many requests. Please wait a few minutes and try again." : tooManyTriesSentence(wait),
    };
  }
  if (status === null) {
    // R27 MM3: no answer at all. The request may have gone through, and the
    // sentence is the same for every address, so it still reveals nothing.
    return {
      kind: "error",
      // Lead review: the inbox first, so following the steps in order never sends a second email.
      message: answerLostText(
        "the request may have gone through",
        "If an account exists for that address, a link may already be on its way: check your inbox first. If nothing arrives in a few minutes, check your connection and try again.",
      ),
    };
  }
  if (status === 400 && typeof data?.error === "string" && data.error) {
    return { kind: "error", message: data.error };
  }
  // R39 new-customer L1: the limit store failed. The shared sentence is fixed,
  // the same for every address, and says nothing was sent and when to retry.
  if (data?.error === LIMIT_UNCHECKED_MESSAGE) {
    return { kind: "error", message: LIMIT_UNCHECKED_MESSAGE };
  }
  return { kind: "error", message: "Something went wrong. Please try again." };
}
