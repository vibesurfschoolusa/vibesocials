import { describe, expect, it } from "vitest";

import {
  connectionGoneMessage,
  notReachedMessage,
  NOT_SENT_MESSAGE,
  platformDownMessage,
  platformRefusedMessage,
  publishErrorMessage,
  reconnectRequiredMessage,
} from "./publishFailureText";

describe("dispatch sentences (F1 H1)", () => {
  it("tells the user to reconnect a platform whose connection needs it", () => {
    expect(reconnectRequiredMessage("instagram")).toBe("Reconnect Instagram in Settings, then retry.");
  });

  it("tells the user a removed platform is no longer connected", () => {
    expect(connectionGoneMessage("linkedin")).toBe(
      "LinkedIn is no longer connected. Connect it in Settings, then retry.",
    );
  });
});

// Review round 2, item 4: one sentence true for every cause of a failed post
// with no results, old or new (no connection could take it, or our side gave up).
describe("NOT_SENT_MESSAGE (F1 H3)", () => {
  it("is the honest sentence for a failed post with no results", () => {
    expect(NOT_SENT_MESSAGE).toBe("This post was not sent. Use Send again to try once more.");
  });
});

describe("publishErrorMessage (F1 L7)", () => {
  const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

  it("keeps a sentence a platform client wrote for the user", () => {
    const error = coded(
      "Google rejected this Business Profile post under its content policy, so it is not shown. Edit the caption and try again.",
      "GBP_POST_REJECTED",
    );
    expect(publishErrorMessage("google_business_profile", error)).toBe(error.message);
  });

  it("replaces an HTTP status line with the platform's plain sentence", () => {
    const error = coded("Facebook Page video upload failed (status 400)", "FACEBOOK_PAGE_PUBLISH_FAILED");
    expect(publishErrorMessage("facebook_page", error)).toBe(platformRefusedMessage("facebook_page"));
    expect(platformRefusedMessage("facebook_page")).toBe(
      "Facebook Page did not accept the post. Try again; if it fails again, check the post meets Facebook Page's rules.",
    );
  });

  // Review round 2, item 3: an error that is not a refusal of the post's
  // content (our database, the network, an unknown failure) must not tell the
  // user to check the post against the rules.
  it("never lets a database error reach the user", () => {
    const error = new Error(
      "Can't reach database server at `db.internal.example:5432`\n\nPlease make sure your database server is running.",
    );
    expect(publishErrorMessage("x", error)).toBe(notReachedMessage("x"));
    expect(notReachedMessage("x")).toBe("The post did not reach X. Try again later.");
  });

  it("never lets a Prisma request error reach the user, even with a code", () => {
    const error = coded("Invalid `prisma.postJobResult.update()` invocation", "P2025");
    expect(publishErrorMessage("x", error)).toBe(notReachedMessage("x"));
  });

  it("never lets a network error reach the user", () => {
    expect(publishErrorMessage("youtube", new TypeError("fetch failed"))).toBe(notReachedMessage("youtube"));
    expect(publishErrorMessage("youtube", coded("socket hang up", "ECONNRESET"))).toBe(notReachedMessage("youtube"));
    expect(publishErrorMessage("youtube", coded("other side closed", "UND_ERR_SOCKET"))).toBe(
      notReachedMessage("youtube"),
    );
    expect(publishErrorMessage("youtube", coded("getaddrinfo ENOTFOUND api.example.com", "ERR_DNS"))).toBe(
      notReachedMessage("youtube"),
    );
  });

  it("hides a host name even inside a coded message", () => {
    const error = coded("Upload to storage.example.com:443 failed", "LINKEDIN_VIDEO_UPLOAD_FAILED");
    expect(publishErrorMessage("linkedin", error)).toBe(notReachedMessage("linkedin"));
  });

  it("uses the not-reached sentence for an empty or missing message", () => {
    expect(publishErrorMessage("pinterest", coded("", "PINTEREST_PIN_FAILED"))).toBe(notReachedMessage("pinterest"));
    expect(publishErrorMessage("pinterest", {})).toBe(notReachedMessage("pinterest"));
  });

  it.each([
    "GOOGLE_TOKEN_REFRESH_FAILED",
    "LINKEDIN_TOKEN_REFRESH_FAILED",
    "PINTEREST_TOKEN_REFRESH_FAILED",
    "TIKTOK_TOKEN_REFRESH_FAILED",
    "GOOGLE_NO_REFRESH_TOKEN",
    "LINKEDIN_NO_REFRESH_TOKEN",
    "FACEBOOK_PAGE_NO_ACCESS_TOKEN",
    "INSTAGRAM_RECONNECT_REQUIRED",
    "RECONNECT_REQUIRED",
  ])("tells the user to reconnect for %s", (code) => {
    const error = Object.assign(coded("Google token refresh failed (status 400)", code), { status: 400 });
    expect(publishErrorMessage("google_business_profile", error)).toBe(
      reconnectRequiredMessage("google_business_profile"),
    );
  });

  it("tells the user to reconnect when the platform answered 401", () => {
    const error = Object.assign(coded("LinkedIn post creation failed (status 401)", "LINKEDIN_POST_CREATION_FAILED"), {
      status: 401,
    });
    expect(publishErrorMessage("linkedin", error)).toBe(reconnectRequiredMessage("linkedin"));
  });

  it("says a removed connection is gone", () => {
    expect(publishErrorMessage("x", coded("This platform connection was removed.", "CONNECTION_GONE"))).toBe(
      connectionGoneMessage("x"),
    );
  });

  it("puts a 5xx (after the in-step retries) on the platform's side, from the status or the status line", () => {
    const withStatus = Object.assign(coded("TikTok said no", "TIKTOK_INIT_FAILED"), { status: 503 });
    expect(publishErrorMessage("tiktok", withStatus)).toBe(platformDownMessage("tiktok"));
    expect(platformDownMessage("tiktok")).toBe("TikTok had a problem on its side. Try again later.");
    const fromLine = coded("Instagram container creation failed (status 500)", "INSTAGRAM_CONTAINER_FAILED");
    expect(publishErrorMessage("instagram", fromLine)).toBe(platformDownMessage("instagram"));
  });

  it("keeps the rules sentence for a 4xx refusal only", () => {
    const refused = Object.assign(coded("Pinterest pin creation failed (status 400)", "PINTEREST_PIN_FAILED"), {
      status: 400,
    });
    expect(publishErrorMessage("pinterest", refused)).toBe(platformRefusedMessage("pinterest"));
  });
});
