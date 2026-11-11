import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

import { retentionText } from "./media-library";

// F1 round 2: Media read "auto-removes in 1 days".
describe("retentionText", () => {
  it("0 days: says soon, as before", () => {
    expect(retentionText(0)).toBe("auto-removes soon");
  });

  it("1 day: singular", () => {
    expect(retentionText(1)).toBe("auto-removes in 1 day");
  });

  it("2 days: plural", () => {
    expect(retentionText(2)).toBe("auto-removes in 2 days");
  });
});
