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
    // Network failure / fetch threw: no status at all.
    [null, GENERIC],
  ])("status %s", (status, expected) => {
    expect(forgotPasswordOutcome(status)).toEqual(expected);
  });
});
