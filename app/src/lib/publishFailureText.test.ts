import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Platform } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { commitRequest } from "@/server/platforms/commitCall";

import { FETCH_TIMEOUT_CODE } from "./fetchWithTimeout";
import { PLATFORM_LABELS } from "./platforms";
import { PUBLISH_UNCONFIRMED_MESSAGE } from "./publishOutcomes";

import {
  connectionGoneMessage,
  hasInternalDetail,
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
  STORAGE_READ_CODES,
  storageReadFailedMessage,
  YOUTUBE_UPLOAD_REFUSED_TEXT,
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

  // R26 (found with platform-clients L4): "Reconnect" holds the letters of
  // ECONN, so a client's own sentence naming Reconnect read as a network error.
  it("keeps a client's own sentence that says Reconnect, and still hides ECONN codes", () => {
    const board = "The Pinterest board this connection posts to no longer exists. Reconnect Pinterest in Settings and choose a board.";
    expect(publishErrorMessage("pinterest", coded(board, "PINTEREST_BOARD_NOT_FOUND"))).toBe(board);
    expect(publishErrorMessage("x", coded("connect ECONNREFUSED", "X_UPLOAD_FAILED"))).toBe(notReachedMessage("x"));
    expect(publishErrorMessage("x", coded("read -ECONNRESET", "X_UPLOAD_FAILED"))).toBe(notReachedMessage("x"));
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

  // R19 publishing L2 follow-up: our storage failing to give the file back is
  // never the platform's fault, whatever status storage answered.
  describe("a file our storage couldn't give back", () => {
    const FILE_SENTENCE =
      "The file couldn't be read from storage, so nothing was posted. Try again; if it fails again, create the post again with the file.";
    const withStatus = (message: string, code: string, status: number) => Object.assign(coded(message, code), { status });

    it.each([401, 403, 404, 429, 500, 503])("status %i: the client's storage sentence, owner and member", (status) => {
      const sentence = storageReadFailedMessage("video");
      const read = publishErrorMessage("youtube", withStatus(sentence, "YOUTUBE_FETCH_MEDIA_FAILED", status));
      expect(read).toBe(sentence);
      expect(sentenceForRecipient(read, "youtube", "member")).toBe(sentence);
    });

    it("a storage text with a status line or internals reads the plain file sentence", () => {
      expect(
        publishErrorMessage(
          "pinterest",
          withStatus("Failed to download video from storage (status 503)", "PINTEREST_VIDEO_DOWNLOAD_FAILED", 503),
        ),
      ).toBe(FILE_SENTENCE);
      expect(publishErrorMessage("x", withStatus("fetch failed ECONNRESET", "X_MEDIA_DOWNLOAD_FAILED", 502))).toBe(FILE_SENTENCE);
    });

    it("a chunked upload's blob read keeps its own storage text on a 5xx", () => {
      const text = "The stored video couldn't be read. Nothing was posted. Try again; if it fails again, create the post again with the video.";
      expect(publishErrorMessage("linkedin", withStatus(text, "BLOB_READ_FAILED", 503))).toBe(text);
    });

    it("covers every storage-download code the platform clients throw", () => {
      const root = join(process.cwd(), "src/server/platforms");
      const codes = new Set(
        (readdirSync(root, { recursive: true }) as string[])
          .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
          .flatMap((name) => [
            ...readFileSync(join(root, name), "utf8").matchAll(/"([A-Z_]*(?:DOWNLOAD_FAILED|FETCH_(?:VIDEO|MEDIA)_FAILED|BLOB_READ_FAILED))"/g),
          ])
          .map((m) => m[1]),
      );
      expect(codes.size).toBeGreaterThanOrEqual(7);
      for (const code of codes) expect(STORAGE_READ_CODES.has(code), code).toBe(true);
    });
  });
});

// R38 publishing L2: our own limit ending a call before the post (a store-code
// lookup, a token or upload step) is one sentence for every platform, never the
// raw "Request timed out after 30000ms". The commit call's own timeout is
// sorted earlier (commitCall.ts) and stays PUBLISH_UNCONFIRMED.
describe("publishErrorMessage: FETCH_TIMEOUT", () => {
  // fetchWithTimeout's own error (fetchTimeoutError there).
  const fetchTimeoutError = (ms: number) =>
    Object.assign(new Error(`Request timed out after ${ms}ms`), { code: FETCH_TIMEOUT_CODE });

  it.each([
    ["google_business_profile", "Google Business Profile"],
    ["linkedin", "LinkedIn"],
  ] as const)("%s: didn't answer in time, nothing posted, try again later", (platform, label) => {
    expect(publishErrorMessage(platform, fetchTimeoutError(30_000))).toBe(
      `${label} didn't answer in time, so nothing was posted. Try again later.`,
    );
  });

  it("a sentence a client wrote for its own timeout is kept (TikTok's account check)", () => {
    const written = "TikTok didn't answer the account check it needs before a post, so nothing was posted. Try again in a few minutes.";
    expect(publishErrorMessage("tiktok", { code: FETCH_TIMEOUT_CODE, message: written })).toBe(written);
  });

  it("the raw timeout text never shows, whatever the code", () => {
    expect(publishErrorMessage("linkedin", { code: "LINKEDIN_UPLOAD_FAILED", message: "Request timed out after 12000ms" })).not.toMatch(
      /timed out after/,
    );
  });

  it("a commit call that timed out is unchanged: PUBLISH_UNCONFIRMED", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await commitRequest("google_business_profile", () => Promise.reject(fetchTimeoutError(30_000))).catch(
      (e: unknown) => e as Error & { code?: string },
    );
    expect(error).toMatchObject({ code: "PUBLISH_UNCONFIRMED" });
    expect(publishErrorMessage("google_business_profile", error)).toBe(PUBLISH_UNCONFIRMED_MESSAGE);
    vi.restoreAllMocks();
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

  // R10-client-journey L1: a member can't reconnect, so their answer names the owner.
  it("a member's sentence names the owner and not Settings", () => {
    expect(notSentSentence([{ platform: "x", reason: "RECONNECT_REQUIRED" }], true, "member")).toBe(
      "Nothing was sent: The workspace owner can reconnect X; then use Retry in Activity.",
    );
    expect(
      notSentSentence(
        [
          { platform: "x", reason: "RECONNECT_REQUIRED" },
          { platform: "instagram", reason: "RECONNECT_REQUIRED" },
          { platform: "facebook_page", reason: "CONNECTION_GONE" },
        ],
        false,
        "member",
      ),
    ).toBe(
      "Not sent to X, Instagram and Facebook Page: The workspace owner can reconnect X and Instagram, and connect Facebook Page; then use Retry in Activity.",
    );
    expect(notSentSentence([{ platform: "x", reason: "RECONNECT_REQUIRED" }], true, "owner")).toBe(
      "Nothing was sent: Reconnect X in Settings, then use Retry in Activity.",
    );
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
// R28 publishing addendum L5: the failed row offers "Retry YouTube", no
// "send it again", so the sentence ends "then retry."; rows that failed
// earlier carry the old words and read the new ones.
describe("YouTube's upload-refused sentence", () => {
  const OLD = "YouTube refused the upload, so nothing was posted. Check in YouTube Studio that this channel can upload videos, then send it again.";
  const NOW = "YouTube refused the upload, so nothing was posted. Check in YouTube Studio that this channel can upload videos, then retry.";
  const MEMBER =
    "YouTube refused the upload, so nothing was posted. The workspace owner can check in YouTube Studio that this channel can upload videos; then retry.";

  it("ends with retry for the owner and the member", () => {
    expect(YOUTUBE_UPLOAD_REFUSED_TEXT).toBe(NOW);
    expect(sentenceForRecipient(NOW, "youtube", "member")).toBe(MEMBER);
  });

  it("a row stored with the old words reads the new ones", () => {
    expect(sentenceForRecipient(OLD, "youtube", "owner")).toBe(NOW);
    expect(sentenceForRecipient(OLD, "youtube", "member")).toBe(MEMBER);
  });
});

describe("sentenceForRecipient", () => {
  const PLATFORMS = Object.keys(PLATFORM_LABELS) as Platform[];
  // What a sentence says went wrong, beside the step it asks for.
  const REASONS = [
    /store code/i,
    /board/i,
    /company page/i,
    /\badmin\b/i,
    /renew/i,
    /expired/i,
    /no longer valid/i,
    /removed/i,
    /no longer connected/i,
    /no longer exists/i,
  ];

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
      // R10-new-customer L2: the member sentence keeps the owner sentence's
      // reason, and never says reconnect when reconnecting is not the step.
      for (const reason of REASONS) {
        if (reason.test(owner)) expect(member, owner).toMatch(reason);
      }
      if (!/connect/i.test(owner)) expect(member, owner).not.toMatch(/connect/i);
    }
  });

  it("a removed connection, and LinkedIn with no company page, keep their reason for a member", () => {
    expect(sentenceForRecipient("This platform connection was removed. Reconnect and retry.", "x", "member")).toBe(
      "The X connection was removed. The workspace owner can reconnect X; then retry.",
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
    ).toBe("YouTube is no longer connected. The workspace owner can reconnect YouTube; then retry.");
  });

  // R10-new-customer L2: reconnecting fixes nothing for a wrong store code.
  it("a Google Business Profile store code a member can't find: the owner checks it, no reconnect", () => {
    expect(
      sentenceForRecipient(
        "Could not find a Google Business Profile location for the given store code. Double-check the store code in Advanced settings.",
        "google_business_profile",
        "member",
      ),
    ).toBe("The workspace owner can check the store code for Google Business Profile; then retry.");
  });

  // R11-pages L1: a Content admin can't be picked on reconnect, so the member
  // sentence names Super admin only, for the sentence written now and the one
  // stored on posts that failed before.
  it("LinkedIn's not-a-page-admin sentence names Super admin only for a member, new and stored", () => {
    const member =
      "LinkedIn refused the post because the connected LinkedIn account is not a Super admin of this company page. A Super admin of the page can add that account as a Super admin (Page admin tools > Manage admins); then the workspace owner can reconnect LinkedIn.";
    for (const stored of [
      "LinkedIn refused the post because the LinkedIn account you connected is not a Super admin of this company page. Ask a Super admin of the page to add that account as a Super admin (Page admin tools > Manage admins), then reconnect LinkedIn in Settings.",
      "LinkedIn refused the post because the LinkedIn account you connected is not an admin of this company page. Ask a page admin to add that account as a Super admin or Content admin (Page admin tools > Manage admins), then reconnect LinkedIn in Settings.",
    ]) {
      expect(sentenceForRecipient(stored, "linkedin", "member")).toBe(member);
    }
  });

  // R12-pages L5: an owner reading a post that failed before #158 reads the
  // current owner sentence, not the old "Super admin or Content admin" one.
  it("LinkedIn's old not-a-page-admin sentence reads as the current owner sentence for an owner", () => {
    const old =
      "LinkedIn refused the post because the LinkedIn account you connected is not an admin of this company page. Ask a page admin to add that account as a Super admin or Content admin (Page admin tools > Manage admins), then reconnect LinkedIn in Settings.";
    const current =
      "LinkedIn refused the post because the LinkedIn account you connected is not a Super admin of this company page. Ask a Super admin of the page to add that account as a Super admin (Page admin tools > Manage admins), then reconnect LinkedIn in Settings.";
    expect(sentenceForRecipient(old, "linkedin", "owner")).toBe(current);
    expect(sentenceForRecipient(current, "linkedin", "owner")).toBe(current);
  });

  it("an expired or invalid connection keeps saying so for a member", () => {
    expect(sentenceForRecipient("Your Instagram connection has expired — please reconnect it in Settings.", "instagram", "member")).toBe(
      "The Instagram connection has expired. The workspace owner can reconnect Instagram; then retry.",
    );
    expect(
      sentenceForRecipient("Your Facebook Page connection is no longer valid — please reconnect it in Settings.", "facebook_page", "member"),
    ).toBe("The Facebook Page connection is no longer valid. The workspace owner can reconnect Facebook Page; then retry.");
    expect(
      sentenceForRecipient(
        "Pinterest did not renew this connection (status 403). If this keeps happening, reconnect Pinterest in Settings.",
        "pinterest",
        "member",
      ),
    ).toBe("Pinterest did not renew this connection. If this keeps happening, the workspace owner can reconnect Pinterest.");
  });

  it("a sentence nobody wrote a member variant for: the owner can fix the connection, not reconnect it", () => {
    expect(sentenceForRecipient("Something new happened. Check Settings.", "x", "member")).toBe(
      "The workspace owner can fix X's connection; then retry.",
    );
  });

  it("leaves an owner's sentence, and every sentence without Settings, as stored", () => {
    expect(sentenceForRecipient(reconnectRequiredMessage("instagram"), "instagram", "owner")).toBe(
      "Reconnect Instagram in Settings, then retry.",
    );
    expect(sentenceForRecipient("X refused it.", "x", "member")).toBe("X refused it.");
    expect(sentenceForRecipient(null, "x", "member")).toBeNull();
  });
});

// R47 publishing "Text cost": the internal-detail check runs in linear time.
// The host:port part rescanned to the end from every dot, so 100,000 crafted
// characters took seconds. A missing fix is a quick red test, never a hung run.
describe("hasInternalDetail on long crafted text", () => {
  const crafted = [
    ["dotted words with no port", "a.".repeat(50_000)],
    ["dotted digits with no port (no group is an IP part)", "1111.".repeat(20_000)],
    ["hyphenated dotted words", "a-b.".repeat(25_000)],
    ["one long dotted name, a colon and no digits", `${"ab.".repeat(33_333)}x:`],
  ] as const;

  it.each(crafted)("%s: 100,000 characters in under 50 ms", (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(99_990);
    const started = performance.now();
    expect(hasInternalDetail(text)).toBe(false);
    publishErrorMessage("linkedin", { message: text, code: "LINKEDIN_POST_FAILED" });
    expect(performance.now() - started).toBeLessThan(50);
  }, 5_000);

  it("a host and port at the end of a long text is still found", () => {
    const text = `${"a.".repeat(50_000)} upload to storage.example.com:443 failed`;
    const started = performance.now();
    expect(hasInternalDetail(text)).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  }, 5_000);

  it.each([
    "Upload to storage.example.com:443 failed",
    "db.internal.example:5432 refused",
    "at a.b:80",
    "x-1.y-2.z:65535 down",
    "connect 10.0.0.12 failed",
  ])("still hides %s", (text) => {
    expect(hasInternalDetail(text)).toBe(true);
  });

  it.each([
    "Instagram refused the video: it is longer than 60 seconds.",
    "The caption is too long. Shorten it to 3,000 characters, then retry.",
    "Try again at 10.30",
    "Reconnect LinkedIn in Settings, then retry.",
  ])("still lets a plain sentence through: %s", (text) => {
    expect(hasInternalDetail(text)).toBe(false);
  });
});
