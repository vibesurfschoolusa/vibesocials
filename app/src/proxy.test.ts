import { describe, expect, it } from "vitest";

import { isPublicPath } from "./proxy";

describe("isPublicPath", () => {
  it("lets signed-out visitors open the help page", () => {
    expect(isPublicPath("/help")).toBe(true);
    expect(isPublicPath("/help/anything")).toBe(true);
  });

  it("keeps the existing public pages public", () => {
    for (const path of ["/login", "/about", "/privacy", "/terms", "/data-deletion"]) {
      expect(isPublicPath(path), path).toBe(true);
    }
  });

  it("does not open app pages, or names that only start with a public one", () => {
    expect(isPublicPath("/settings")).toBe(false);
    expect(isPublicPath("/helpdesk")).toBe(false);
  });
});
