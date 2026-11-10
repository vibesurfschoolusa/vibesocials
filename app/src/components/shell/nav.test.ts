import { describe, expect, it } from "vitest";

import { isPublicRoute } from "./nav";

describe("isPublicRoute", () => {
  it("treats the help page as public", () => {
    expect(isPublicRoute("/help")).toBe(true);
    expect(isPublicRoute("/help/anything")).toBe(true);
  });

  it("keeps the existing public pages public", () => {
    for (const path of ["/login", "/about", "/privacy", "/terms", "/data-deletion"]) {
      expect(isPublicRoute(path), path).toBe(true);
    }
  });

  it("does not treat app pages, or names that only start with a public one, as public", () => {
    expect(isPublicRoute("/settings")).toBe(false);
    expect(isPublicRoute("/")).toBe(false);
    expect(isPublicRoute("/helpdesk")).toBe(false);
  });
});
