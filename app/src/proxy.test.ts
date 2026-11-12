import { describe, expect, it } from "vitest";

import { PUBLIC_ROUTE_PREFIXES } from "./components/shell/nav";
import { authorizeRequest, isPublicPath } from "./proxy";

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

  it("lets crawlers fetch robots.txt and sitemap.xml signed out, exact matches only", () => {
    expect(isPublicPath("/robots.txt")).toBe(true);
    expect(isPublicPath("/sitemap.xml")).toBe(true);
    expect(signedOut("/robots.txt")).toBe(true);
    expect(signedOut("/sitemap.xml")).toBe(true);
    for (const p of ["/robots.txt/x", "/sitemap.xml/x", "/robots", "/sitemap", "/robots.txt.bak"]) {
      expect(isPublicPath(p), p).toBe(false);
      expect(signedOut(p), p).toBe(false);
    }
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

const PAYMENTS = {
  BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_placeholder",
  STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
  STRIPE_PRICE_STARTER: "price_starter",
};

function signedOut(pathname: string, env: Record<string, string | undefined> = {}) {
  return authorizeRequest({ token: null, req: { nextUrl: new URL(`https://example.test${pathname}`) } }, env);
}

describe("/pricing in the proxy (23, fix round 1)", () => {
  it("without payments configured, sends a signed-out visitor to sign-in exactly like an address that does not exist", () => {
    expect(isPublicPath("/pricing", {})).toBe(false);
    expect(signedOut("/pricing")).toBe(false);
    expect(signedOut("/no-such-page")).toBe(false);
    // Billing on alone is not enough.
    expect(isPublicPath("/pricing", { BILLING_ENABLED: "true" })).toBe(false);
  });

  it("with payments configured, lets a signed-out visitor open /pricing, and nothing that only starts with it", () => {
    expect(isPublicPath("/pricing", PAYMENTS)).toBe(true);
    expect(signedOut("/pricing", PAYMENTS)).toBe(true);
    expect(isPublicPath("/pricings", PAYMENTS)).toBe(false);
    expect(signedOut("/no-such-page", PAYMENTS)).toBe(false);
  });

  it("opens nothing else new: the public pages are the ones the shell treats as public, plus the two app files", () => {
    for (const prefix of PUBLIC_ROUTE_PREFIXES) {
      expect(isPublicPath(prefix, {}), prefix).toBe(true);
    }
    for (const path of ["/settings", "/queue", "/posts/new", "/media", "/reports", "/reviews", "/workspaces", "/admin", "/join/abc", "/connections"]) {
      expect(isPublicPath(path, PAYMENTS), path).toBe(false);
    }
  });
});
