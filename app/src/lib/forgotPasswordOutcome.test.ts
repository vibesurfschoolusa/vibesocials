import { describe, expect, it } from "vitest";

import { forgotPasswordOutcome } from "./forgotPasswordOutcome";

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
