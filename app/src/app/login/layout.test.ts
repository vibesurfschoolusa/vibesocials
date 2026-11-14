import { describe, expect, it } from "vitest";

import { metadata } from "./layout";

// F7 (R1 L6): the login page is a client component, so its title comes from this server layout.
describe("login layout", () => {
  it("names the browser tab", () => {
    expect(metadata.title).toBe("Log in | Vibe Socials");
  });
});
