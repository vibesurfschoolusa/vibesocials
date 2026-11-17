import { describe, expect, it } from "vitest";

import { forgotPasswordOutcome } from "./forgotPasswordOutcome";
import { LIMIT_UNCHECKED_MESSAGE } from "./limitUncheckedMessage";

const SENT = { kind: "sent" } as const;
const TOO_MANY = {
  kind: "error",
  message: "Too many requests. Please wait a few minutes and try again.",
} as const;
const GENERIC = { kind: "error", message: "Something went wrong. Please try again." } as const;

describe("forgotPasswordOutcome", () => {
  it.each([
    // 2xx keeps the uniform "if an account exists" confirmation (no oracle:
    // the route answers 200 whether or not the address has an account).
    [200, SENT],
    [201, SENT],
    [204, SENT],
    [429, TOO_MANY],
    [400, GENERIC],
    [403, GENERIC],
    [500, GENERIC],
    [503, GENERIC],
  ])("status %s", (status, expected) => {
    expect(forgotPasswordOutcome(status)).toEqual(expected);
  });
});

// R27 MM3 (new-customer L7): no answer at all said "Something went wrong". It
// says the connection, and still never whether the address has an account.
describe("forgotPasswordOutcome with no answer", () => {
  it("says the connection was lost and what to do, the same for every address", () => {
    expect(forgotPasswordOutcome(null)).toEqual({
      kind: "error",
      message:
        "Vibe Socials' answer didn't reach you, so the request may have gone through. If your connection dropped, reconnect first. If an account exists for that address, a link may already be on its way: check your inbox first. If nothing arrives in a few minutes, check your connection and try again.",
    });
  });
});

// R28 NN2 (new-customer L3): a typo the browser accepts ("sam@gmailcom") got
// "Something went wrong" every time. The route's 400 sentence depends only on
// the typed text, never on whether an account exists, so it is shown.
describe("forgotPasswordOutcome with the route's own sentence", () => {
  it("a 400 shows the route's sentence", () => {
    expect(forgotPasswordOutcome(400, { error: "Enter a valid email address." })).toEqual({
      kind: "error",
      message: "Enter a valid email address.",
    });
  });

  it("anything else keeps its own words, whatever the body says", () => {
    expect(forgotPasswordOutcome(400, null)).toEqual(GENERIC);
    expect(forgotPasswordOutcome(400, { error: 42 })).toEqual(GENERIC);
    expect(forgotPasswordOutcome(500, { error: "No account for that address." })).toEqual(GENERIC);
    expect(forgotPasswordOutcome(200, { error: "x" })).toEqual(SENT);
  });
});

// R39 new-customer L1: the limit store failed, and the shared sentence (the
// same for every address) says nothing was sent and when to try again.
describe("forgotPasswordOutcome when the limit couldn't be checked", () => {
  it("a 503 with the shared sentence shows it", () => {
    expect(forgotPasswordOutcome(503, { error: LIMIT_UNCHECKED_MESSAGE })).toEqual({
      kind: "error",
      message: LIMIT_UNCHECKED_MESSAGE,
    });
  });

  it("any other 5xx, or another 503 body, keeps its own words", () => {
    expect(forgotPasswordOutcome(503, { error: "No account for that address." })).toEqual(GENERIC);
    expect(forgotPasswordOutcome(503, null)).toEqual(GENERIC);
    expect(forgotPasswordOutcome(502, { error: "x" })).toEqual(GENERIC);
  });
});
