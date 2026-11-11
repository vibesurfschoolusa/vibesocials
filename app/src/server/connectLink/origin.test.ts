import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isSameOriginRequest } from "./origin";

/**
 * Fix round 1 (16): a Connect press is a plain form POST from /c/<token>.
 * Browsers with fetch metadata say so in Sec-Fetch-Site; older ones (Safari
 * before 16.4) send only an Origin, which must be ours.
 */

const APP = "https://vibesocials.example";
const URL_ON_APP = `${APP}/api/connect-link/t/start`;

function req(headers: Record<string, string>, url = URL_ON_APP): Request {
  return new Request(url, { method: "POST", headers });
}

beforeEach(() => vi.stubEnv("NEXTAUTH_URL", APP));
afterEach(() => vi.unstubAllEnvs());

describe("isSameOriginRequest", () => {
  it("Sec-Fetch-Site: same-origin is allowed", () => {
    expect(isSameOriginRequest(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it.each(["cross-site", "same-site", "none"])("Sec-Fetch-Site: %s is refused, even with a matching Origin", (site) => {
    expect(isSameOriginRequest(req({ "sec-fetch-site": site, origin: APP }))).toBe(false);
  });

  it("no fetch metadata and the app's Origin is allowed", () => {
    expect(isSameOriginRequest(req({ origin: APP }))).toBe(true);
  });

  it("no fetch metadata and the request's own Origin is allowed when NEXTAUTH_URL names another host", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://other-host.example");
    expect(isSameOriginRequest(req({ origin: APP }))).toBe(true);
  });

  it("no fetch metadata and Origin: null is refused", () => {
    expect(isSameOriginRequest(req({ origin: "null" }))).toBe(false);
  });

  it("no fetch metadata and no Origin is refused", () => {
    expect(isSameOriginRequest(req({}))).toBe(false);
  });

  it("another site's Origin is refused", () => {
    expect(isSameOriginRequest(req({ origin: "https://evil.example" }))).toBe(false);
  });
});
