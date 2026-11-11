import { describe, expect, it } from "vitest";

import { PUBLIC_ROUTE_PREFIXES } from "./components/shell/nav";
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

  it("lets a signed-out client open a review link, and nothing that only starts with /v", () => {
    expect(isPublicPath("/v/abc")).toBe(true);
    expect(isPublicPath("/videos")).toBe(false);
    expect(isPublicPath("/verify")).toBe(false);
  });
});

describe("isPublicPath — pricing (23)", () => {
  it("lets a signed-out visitor reach /pricing, which answers the 404 until payments are configured", () => {
    expect(isPublicPath("/pricing")).toBe(true);
    expect(isPublicPath("/pricings")).toBe(false);
    expect(isPublicPath("/price")).toBe(false);
  });

  it("opens nothing else new: the public pages are the ones the shell treats as public, plus the two app files", () => {
    for (const prefix of PUBLIC_ROUTE_PREFIXES) {
      expect(isPublicPath(prefix), prefix).toBe(true);
    }
    for (const path of ["/settings", "/queue", "/posts/new", "/media", "/reports", "/reviews", "/workspaces", "/admin", "/join/abc", "/connections"]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });
});
