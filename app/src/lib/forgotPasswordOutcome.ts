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
export type ForgotPasswordOutcome = { kind: "sent" } | { kind: "error"; message: string };

export function forgotPasswordOutcome(status: number | null): ForgotPasswordOutcome {
  if (status !== null && status >= 200 && status < 300) {
    return { kind: "sent" };
  }
  if (status === 429) {
    return {
      kind: "error",
      message: "Too many requests. Please wait a few minutes and try again.",
    };
  }
  return { kind: "error", message: "Something went wrong. Please try again." };
}
