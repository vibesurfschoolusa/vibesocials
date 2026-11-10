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

  it("lets the browser fetch the web app manifest and the service worker signed out", () => {
    expect(isPublicPath("/manifest.webmanifest")).toBe(true);
    expect(isPublicPath("/sw.js")).toBe(true);
  });

  it("opens only those two exact files, nothing under or beside them", () => {
    expect(isPublicPath("/sw.js/x")).toBe(false);
    expect(isPublicPath("/manifest.webmanifest/x")).toBe(false);
    expect(isPublicPath("/sw.json")).toBe(false);
    expect(isPublicPath("/share-target")).toBe(false);
  });

  it("lets a signed-out client open an upload link, and nothing that only starts with /u", () => {
    expect(isPublicPath("/u/abc")).toBe(true);
    expect(isPublicPath("/upload")).toBe(false);
    expect(isPublicPath("/users")).toBe(false);
  });
});
