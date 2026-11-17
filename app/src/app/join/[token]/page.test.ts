import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("./join-view", () => ({ JoinView: () => null }));

import { metadata } from "./page";

// R44 (security L1): the invite token is in the address and the link stays
// usable for 7 days, so the browser never sends that address as a referrer,
// here or to another site. "strict-origin" like /c, not "no-referrer": the
// page posts its accept, and a browser without fetch metadata would send
// `Origin: null` under "no-referrer".
describe("the join page", () => {
  it("sends only the bare origin as referrer, never the address with the token", () => {
    expect(metadata.referrer).toBe("strict-origin");
  });
});
