import { describe, expect, it } from "vitest";

import {
  connectionGoneMessage,
  OUR_SIDE_FAILURE_MESSAGE,
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

describe("OUR_SIDE_FAILURE_MESSAGE (F1 H3)", () => {
  it("is the honest sentence for a post our side could not send", () => {
    expect(OUR_SIDE_FAILURE_MESSAGE).toBe(
      "This post could not be sent because of a problem on our side. Use Post now to send it again.",
    );
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

  it("never lets a database error reach the user", () => {
    const error = new Error(
      "Can't reach database server at `db.internal.example:5432`\n\nPlease make sure your database server is running.",
    );
    expect(publishErrorMessage("x", error)).toBe(platformRefusedMessage("x"));
  });

  it("never lets a Prisma request error reach the user, even with a code", () => {
    const error = coded("Invalid `prisma.postJobResult.update()` invocation", "P2025");
    expect(publishErrorMessage("x", error)).toBe(platformRefusedMessage("x"));
  });

  it("never lets a network error reach the user", () => {
    expect(publishErrorMessage("youtube", new TypeError("fetch failed"))).toBe(platformRefusedMessage("youtube"));
    expect(publishErrorMessage("youtube", coded("socket hang up", "ECONNRESET"))).toBe(
      platformRefusedMessage("youtube"),
    );
    expect(publishErrorMessage("youtube", coded("other side closed", "UND_ERR_SOCKET"))).toBe(
      platformRefusedMessage("youtube"),
    );
    expect(publishErrorMessage("youtube", coded("getaddrinfo ENOTFOUND api.example.com", "ERR_DNS"))).toBe(
      platformRefusedMessage("youtube"),
    );
  });

  it("hides a host name even inside a coded message", () => {
    const error = coded("Upload to storage.example.com:443 failed", "LINKEDIN_VIDEO_UPLOAD_FAILED");
    expect(publishErrorMessage("linkedin", error)).toBe(platformRefusedMessage("linkedin"));
  });

  it("uses the plain sentence for an empty or missing message", () => {
    expect(publishErrorMessage("pinterest", coded("", "PINTEREST_PIN_FAILED"))).toBe(
      platformRefusedMessage("pinterest"),
    );
    expect(publishErrorMessage("pinterest", {})).toBe(platformRefusedMessage("pinterest"));
  });
});
