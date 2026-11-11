import { describe, expect, it } from "vitest";

import { PUBLIC_ROUTE_PREFIXES, isPublicRoute } from "./components/shell/nav";
import { authorizeRequest, isPublicPath } from "./proxy";

/**
 * Client connect link (16): /c and its API are open signed out, and nothing
 * else new is.
 */

function signedOut(pathname: string) {
  return authorizeRequest({ token: null, req: { nextUrl: new URL(`https://example.test${pathname}`) } }, {});
}

describe("the connect link's public paths", () => {
  it("/c and /c/<token> open signed out, with no app shell", () => {
    for (const path of ["/c", "/c/abc"]) {
      expect(isPublicPath(path, {}), path).toBe(true);
      expect(signedOut(path), path).toBe(true);
      expect(isPublicRoute(path), path).toBe(true);
    }
  });

  it("the link's API is reachable signed out (the routes check the token themselves)", () => {
    expect(signedOut("/api/connect-link/abc/start")).toBe(true);
    expect(signedOut("/api/connect-link/abc/pending/p1")).toBe(true);
  });

  it("nothing that only starts with /c opens", () => {
    for (const path of ["/connections", "/calendar", "/create", "/c-anything"]) {
      expect(isPublicPath(path, {}), path).toBe(false);
      expect(signedOut(path), path).toBe(false);
      expect(isPublicRoute(path), path).toBe(false);
    }
  });

  it("/c is the only new public page prefix", () => {
    expect(PUBLIC_ROUTE_PREFIXES.filter((prefix) => prefix === "/c")).toHaveLength(1);
    expect(PUBLIC_ROUTE_PREFIXES).toHaveLength(13);
  });
});
