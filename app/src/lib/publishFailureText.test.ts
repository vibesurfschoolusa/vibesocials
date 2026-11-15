import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PLATFORM_LABELS } from "./platforms";

import {
  connectionGoneMessage,
  memberReconnectMessage,
  notSentAtCreation,
  notSentSentence,
  notReachedMessage,
  NOT_SENT_MESSAGE,
  platformDownMessage,
  renewalRefusedMessage,
  platformRefusedMessage,
  publishErrorMessage,
  reconnectRequiredMessage,
  sentenceForRecipient,
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

  // Second review, item 2: a token refresh failure means "reconnect" only when
  // the refresh was refused for good: the refresher flagged the connection
  // needsReconnect (it does so for a terminal 400/401, never for 429, 5xx or our
  // own invalid_client), or, when the caller cannot tell, a 400/401. Anything
  // else is the platform's (or our) passing problem: try again later.
  describe.each([
    ["GOOGLE_TOKEN_REFRESH_FAILED", "google_business_profile"],
    ["LINKEDIN_TOKEN_REFRESH_FAILED", "linkedin"],
    ["PINTEREST_TOKEN_REFRESH_FAILED", "pinterest"],
    ["TIKTOK_TOKEN_REFRESH_FAILED", "tiktok"],
  ] as const)("a %s", (code, platform) => {
    const refresh = (status?: number) =>
      Object.assign(new Error(`Token refresh failed${status ? ` (status ${status})` : ""}`), {
        code,
        ...(status ? { status } : {}),
      });

    it("refused for good (the connection was flagged) reads the reconnect sentence", () => {
      expect(publishErrorMessage(platform, { ...refresh(400), connectionNeedsReconnect: true })).toBe(
        reconnectRequiredMessage(platform),
      );
    });

    it("refused with 400/401 when the caller cannot tell reads the reconnect sentence", () => {
      expect(publishErrorMessage(platform, refresh(400))).toBe(reconnectRequiredMessage(platform));
      expect(publishErrorMessage(platform, refresh(401))).toBe(reconnectRequiredMessage(platform));
    });

    // Third review: a 4xx refusal the refresher did not flag may be our side
    // (invalid_client) or a grant it could not classify (TikTok 403): say both.
    it.each([
      ["invalid_client (a 400/401 the refresher did not flag)", 400],
      ["invalid_client answered 401", 401],
      ["a 403 the refresher did not flag", 403],
    ])("%s reads try later, then reconnect if it keeps happening", (_label, status) => {
      expect(publishErrorMessage(platform, { ...refresh(status), connectionNeedsReconnect: false })).toBe(
        renewalRefusedMessage(platform),
      );
    });

    it.each([
      ["a 429", 429],
      ["a 5xx", 503],
      ["no answer at all", undefined],
    ])("%s reads try again later", (_label, status) => {
      expect(publishErrorMessage(platform, { ...refresh(status), connectionNeedsReconnect: false })).toBe(
        platformDownMessage(platform),
      );
    });

    it("a 429, 5xx or no answer reads try again later even when the caller cannot tell", () => {
      expect(publishErrorMessage(platform, refresh(429))).toBe(platformDownMessage(platform));
      expect(publishErrorMessage(platform, refresh(500))).toBe(platformDownMessage(platform));
      expect(publishErrorMessage(platform, refresh())).toBe(platformDownMessage(platform));
    });
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

describe("renewalRefusedMessage", () => {
  it("says to try later and to reconnect if it keeps happening", () => {
    expect(renewalRefusedMessage("tiktok")).toBe(
      "TikTok didn't renew the connection. Try again later; if it keeps happening, reconnect TikTok in Settings.",
    );
  });
});


// G1 review: "Post now" tells the person at once which platforms were not sent
// because their connection needs reconnecting or is gone.
describe("notSentAtCreation", () => {
  const row = (platform: string, status: string, errorCode: string | null = null) => ({
    platform: platform as never,
    status,
    errorCode,
  });

  it("lists the platforms failed up front, once each, and says when nothing is left to send", () => {
    expect(
      notSentAtCreation([
        row("x", "failed", "RECONNECT_REQUIRED"),
        row("instagram", "failed", "CONNECTION_GONE"),
        // The Story job's row for the same platform.
        row("instagram", "failed", "CONNECTION_GONE"),
      ]),
    ).toEqual({
      allFailed: true,
      notSent: [
        { platform: "x", reason: "RECONNECT_REQUIRED" },
        { platform: "instagram", reason: "CONNECTION_GONE" },
      ],
    });
  });

  it("one dead, one healthy: the dead one is listed, something is still sent", () => {
    expect(notSentAtCreation([row("x", "failed", "RECONNECT_REQUIRED"), row("instagram", "pending")])).toEqual({
      allFailed: false,
      notSent: [{ platform: "x", reason: "RECONNECT_REQUIRED" }],
    });
  });

  it("healthy: nothing listed", () => {
    expect(notSentAtCreation([row("x", "pending"), row("instagram", "pending")])).toEqual({
      allFailed: false,
      notSent: [],
    });
  });

  it("no rows (a scheduled post or a draft): nothing listed, not all failed", () => {
    expect(notSentAtCreation([])).toEqual({ allFailed: false, notSent: [] });
  });
});

describe("notSentSentence", () => {
  it("nothing sent, one platform", () => {
    expect(notSentSentence([{ platform: "x", reason: "RECONNECT_REQUIRED" }], true)).toBe(
      "Nothing was sent: Reconnect X in Settings, then use Retry in Activity.",
    );
  });

  it("nothing sent, several platforms and both reasons", () => {
    expect(
      notSentSentence(
        [
          { platform: "x", reason: "RECONNECT_REQUIRED" },
          { platform: "instagram", reason: "RECONNECT_REQUIRED" },
          { platform: "facebook_page", reason: "CONNECTION_GONE" },
        ],
        true,
      ),
    ).toBe("Nothing was sent: Reconnect X and Instagram, and connect Facebook Page, in Settings, then use Retry in Activity.");
  });

  it("some sent: names the platforms that were not", () => {
    expect(notSentSentence([{ platform: "x", reason: "RECONNECT_REQUIRED" }], false)).toBe(
      "Not sent to X: Reconnect X in Settings, then use Retry in Activity.",
    );
    expect(notSentSentence([{ platform: "instagram", reason: "CONNECTION_GONE" }], false)).toBe(
      "Not sent to Instagram: Connect Instagram in Settings, then use Retry in Activity.",
    );
  });
});

// R9-client-journey L4: only an owner can connect or reconnect, so a member's
// post emails never tell them to act in Settings.
describe("sentenceForRecipient", () => {
  const PLATFORMS = Object.keys(PLATFORM_LABELS) as Platform[];

  it("gives a member the owner variant of each sentence this module writes", () => {
    expect(memberReconnectMessage("instagram")).toBe("The workspace owner can reconnect Instagram; then retry.");
    expect(sentenceForRecipient(reconnectRequiredMessage("instagram"), "instagram", "member")).toBe(
      "The workspace owner can reconnect Instagram; then retry.",
    );
    expect(sentenceForRecipient(connectionGoneMessage("pinterest"), "pinterest", "member")).toBe(
      "The workspace owner can connect Pinterest; then retry.",
    );
    expect(sentenceForRecipient(renewalRefusedMessage("tiktok"), "tiktok", "member")).toBe(
      "TikTok didn't renew the connection. Try again later; if it keeps happening, the workspace owner can reconnect TikTok.",
    );
  });

  it("runs every owner sentence, on every platform, to a member sentence that names the owner and not Settings", () => {
    for (const platform of PLATFORMS) {
      for (const owner of [reconnectRequiredMessage(platform), connectionGoneMessage(platform), renewalRefusedMessage(platform)]) {
        expect(owner).toContain("Settings");
        const member = sentenceForRecipient(owner, platform, "member")!;
        expect(member, owner).not.toContain("Settings");
        expect(member, owner).toContain("workspace owner can");
        expect(sentenceForRecipient(owner, platform, "owner")).toBe(owner);
      }
    }
  });

  // The sentences the publish run and the clients write themselves: every string
  // literal under src/server/jobs and src/server/platforms (log lines aside)
  // that tells its reader to connect, reconnect or choose, with or without
  // "Settings". Only the choices a member makes on the post itself stay.
  it("covers every connect, reconnect or choose sentence the publish code writes, so none is missed", () => {
    const roots = ["src/server/jobs", "src/server/platforms"].map((dir) => join(process.cwd(), dir));
    const files = roots.flatMap((root) =>
      (readdirSync(root, { recursive: true }) as string[])
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .map((name) => join(root, name)),
    );
    const literals = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .flatMap((line) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2]))
        .filter((text) => /\s/.test(text) && !text.startsWith("["))
        .filter((text) => /\b(?:re)?connect\b|\bchoose\b|\bSettings\b/i.test(text)),
    );
    // A member chooses these on the post itself (Create), so they stay as written.
    const onThePost = [
      /^A Story takes one photo or video\. Choose Feed for /,
      /^The TikTok privacy setting chosen for this post is no longer available/,
      /^No TikTok privacy setting was chosen for this post\./,
    ];
    expect(literals).toContain("This platform connection was removed. Reconnect and retry.");
    expect(literals.length).toBeGreaterThan(10);
    for (const owner of literals) {
      const member = sentenceForRecipient(owner, "linkedin", "member")!;
      if (onThePost.some((pattern) => pattern.test(owner))) {
        expect(member, owner).toBe(owner);
        continue;
      }
      expect(member, owner).not.toContain("Settings");
      expect(member, owner).toContain("workspace owner can");
      expect(sentenceForRecipient(owner, "linkedin", "owner")).toBe(owner);
    }
  });

  it("a removed connection, and LinkedIn with no company page, keep their reason for a member", () => {
    expect(sentenceForRecipient("This platform connection was removed. Reconnect and retry.", "x", "member")).toBe(
      "The workspace owner can reconnect X; then retry.",
    );
    const noOrganization =
      "No LinkedIn company pages configured. This app only posts to company pages, not personal profiles.\n\nTo fix this:\n2. Go to Settings → Connections\n";
    expect(sentenceForRecipient(noOrganization, "linkedin", "member")).toBe(
      "The connected LinkedIn account manages no company page. The workspace owner can reconnect with an account that manages one; then retry.",
    );
  });

  it("keeps what the client sentences say beside the step", () => {
    expect(
      sentenceForRecipient(
        "The Pinterest board this connection posts to no longer exists. Reconnect Pinterest in Settings and choose a board.",
        "pinterest",
        "member",
      ),
    ).toBe(
      "The Pinterest board this connection posts to no longer exists. The workspace owner can reconnect Pinterest and choose a board; then retry.",
    );
    expect(
      sentenceForRecipient("This platform is no longer connected. Reconnect it in Settings and try again.", "youtube", "member"),
    ).toBe("The workspace owner can reconnect YouTube; then retry.");
  });

  it("leaves an owner's sentence, and every sentence without Settings, as stored", () => {
    expect(sentenceForRecipient(reconnectRequiredMessage("instagram"), "instagram", "owner")).toBe(
      "Reconnect Instagram in Settings, then retry.",
    );
    expect(sentenceForRecipient("X refused it.", "x", "member")).toBe("X refused it.");
    expect(sentenceForRecipient(null, "x", "member")).toBeNull();
  });
});
