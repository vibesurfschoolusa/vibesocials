import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import type { PostJobDTO, PostJobResultDTO } from "@/lib/postsDto";

import type { Platform } from "@prisma/client";

import { NOT_SENT_MESSAGE } from "@/lib/publishFailureText";
import { TOO_OLD_TO_SEND_MESSAGE } from "@/lib/sendAgain";

import {
  ByName,
  cardTime,
  createSendAgain,
  displayedJobStatus,
  failureSentence,
  PostJobCard,
  ReconnectStep,
  reconnectRefusalToast,
  retryAllToast,
  retryRequestBody,
  SEND_AGAIN_FAILED,
} from "./post-job-card";

// Fix round 1 (Stories, 2026-11-10): Activity labels a Story result "Story" and
// builds no link from a Facebook Story's id.

const result = (overrides: Partial<PostJobResultDTO>): PostJobResultDTO => ({
  platform: "facebook_page",
  status: "success",
  externalPostId: "111_222",
  externalPostUrl: null,
  errorMessage: null,
  deferral: null,
  unconfirmed: false,
  metric: null,
  ...overrides,
});

const job = (overrides: Partial<PostJobDTO>): PostJobDTO => ({
  id: "job-1",
  status: "completed",
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:00:00.000Z",
  scheduledFor: null,
  caption: "Two spots left today",
  platformCaptions: null,
  results: [],
  media: null,
  mediaCount: 1,
  publish: null,
  createdBy: null,
  approvalState: "none",
  ...overrides,
});

const render = (value: PostJobDTO) =>
  renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(PostJobCard, { job: value, onRetryAccepted: () => {} })),
  );

describe("PostJobCard - Stories", () => {
  it("labels a Story result and builds no link from a Facebook Story's id", () => {
    const html = render(
      job({
        storyPlatforms: ["facebook_page", "instagram"],
        results: [
          result({ platform: "facebook_page" }),
          result({
            platform: "instagram",
            externalPostId: "1789",
            externalPostUrl: "https://www.instagram.com/stories/acme/1/",
          }),
        ],
      }),
    );

    expect(html.match(/>Story</g)).toHaveLength(2);
    expect(html).not.toContain("https://www.facebook.com/111_222");
    // A link the platform returned is still shown.
    expect(html).toContain('href="https://www.instagram.com/stories/acme/1/"');
  });

  it("a feed post (no Story platforms) keeps its link and has no Story label", () => {
    const html = render(job({ results: [result({ platform: "facebook_page" })] }));

    expect(html).toContain('href="https://www.facebook.com/111_222"');
    expect(html).not.toContain(">Story<");
  });
});

describe("PostJobCard - a post without a photo", () => {
  it("shows the Text tile where the thumbnail would be", () => {
    const html = render(job({ media: null, mediaCount: 0, caption: "Wind is onshore" }));
    expect(html).toContain('aria-label="Text post, no photo"');
    expect(html).not.toContain("<img");
  });

  it("a post with a file shows no Text tile", () => {
    const html = render(job({ media: { url: "https://blob.example.com/a.jpg", mimeType: "image/jpeg" } }));
    expect(html).not.toContain("Text post, no photo");
    expect(html).toContain("<img");
  });
});

// Live check 2026-11-14: a post created at 2:21 and scheduled for 2:40 showed
// "2:21 AM" once it had gone out. A post that was scheduled shows the time it
// was set to go out (the scanner publishes it within 10 minutes of that).
describe("cardTime", () => {
  const created = "2026-11-14T08:21:00.000Z";
  const scheduled = "2026-11-14T08:40:00.000Z";
  it("still says Scheduled for while it waits", () => {
    expect(cardTime({ status: "scheduled", createdAt: created, scheduledFor: scheduled })).toEqual({ label: "Scheduled for", iso: scheduled });
  });
  // Review: a cancelled post, or one retried days later, must not read as if it
  // went out (or will go out) at an unlabelled time, so the label stays.
  it("keeps Scheduled for once a scheduled post has gone out, was retried or was cancelled", () => {
    for (const status of ["completed", "partial", "failed", "in_progress", "cancelled"]) {
      expect(cardTime({ status, createdAt: created, scheduledFor: scheduled })).toEqual({ label: "Scheduled for", iso: scheduled });
    }
  });
  it("shows the creation time for a post published straight away, and for a draft", () => {
    expect(cardTime({ status: "completed", createdAt: created, scheduledFor: null })).toEqual({ label: null, iso: created });
    expect(cardTime({ status: "draft", createdAt: created, scheduledFor: scheduled })).toEqual({ label: null, iso: created });
  });
  it("is null with no time at all", () => {
    expect(cardTime({ status: "completed", createdAt: null, scheduledFor: null })).toBeNull();
  });
});

// Video cover (V1): a platform that refused the chosen cover still published
// the video; the result carries a plain note, shown under the platforms.
describe("PostJobCard - result notes", () => {
  it("shows each result's note with its platform", () => {
    const html = render(
      job({
        results: [
          result({ platform: "youtube", externalPostId: "abc", note: "Cover not set: YouTube only allows custom covers on verified channels." }),
          result({ platform: "instagram", externalPostId: "123" }),
        ],
      }),
    );
    expect(html).toContain("YouTube: Cover not set: YouTube only allows custom covers on verified channels.");
  });
  it("shows nothing extra without a note", () => {
    const html = render(job({ results: [result({ platform: "instagram", externalPostId: "123", note: null })] }));
    expect(html).not.toContain("Cover not set");
  });
});


// F1 H3: a post with chosen platforms that failed with no results was never
// sent (a problem on our side): every chosen platform gets a result otherwise.
describe("PostJobCard - a failed post with no results (F1 H3)", () => {
  const render = (overrides: Partial<PostJobDTO>) =>
    renderToStaticMarkup(
      createElement(ToastProvider, null, createElement(PostJobCard, { job: job(overrides), onRetryAccepted: () => {} })),
    ).replace(/<!-- -->/g, "");
  const publish = (targetPlatforms: Platform[]) => ({ targetPlatforms }) as unknown as PostJobDTO["publish"];

  // Review round 2, item 4: the job does not record why it was not sent, so the
  // card says only what is true for every cause, old jobs included.
  it.each([
    ["with chosen platforms", ["instagram"] as Platform[]],
    ["sent to every connection", null],
  ])("shows the one honest sentence for a post %s", (_label, targets) => {
    const html = render({ status: "failed", results: [], publish: targets ? publish(targets) : null });

    expect(html).toContain(NOT_SENT_MESSAGE);
    expect(html).not.toContain("no platforms were connected");
    expect(html).not.toContain("our side");
  });

  // Coordinator follow-up 1: the honest failure gets a Send again button that
  // calls the publish route (which accepts a failed post with no results).
  describe("Send again", () => {
    // The fixture post was created 2026-11-10: pin "now" so the 7-day rule holds.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-14T12:00:00.000Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("offers no button on a post older than a week, and says why", () => {
      const html = render({ status: "failed", results: [], createdAt: "2026-01-18T10:00:00.000Z", scheduledFor: null });
      expect(html).not.toContain("Send again</button>");
      expect(html).toContain(TOO_OLD_TO_SEND_MESSAGE);
      expect(html).not.toContain(NOT_SENT_MESSAGE);
    });

    it("shows the button only on a failed post with no results", () => {
      expect(render({ status: "failed", results: [], publish: publish(["instagram"]) })).toContain("Send again</button>");
      expect(render({ status: "failed", results: [], publish: null })).toContain("Send again</button>");
      expect(
        render({ status: "failed", results: [result({ platform: "x", status: "failed", errorMessage: "No." })] }),
      ).not.toContain("Send again</button>");
      expect(render({ status: "completed", results: [result({})] })).not.toContain("Send again</button>");
      expect(render({ status: "in_progress", results: [] })).not.toContain("Send again</button>");
    });

    const response = (status: number, body: unknown) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

    it("calls the publish route once, even when pressed twice", async () => {
      let release!: (value: Response) => void;
      const fetcher = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
      const press = createSendAgain("job-9", fetcher);

      const first = press();
      const second = press();
      release(response(202, { ok: true, status: "in_progress" }));

      await expect(first).resolves.toEqual({ ok: true });
      await expect(second).resolves.toBeNull();
      await expect(press()).resolves.toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith("/api/posts/job-9/publish", { method: "POST" });
    });

    it("shows the post as in progress once the server took it", () => {
      expect(displayedJobStatus("failed", true)).toBe("in_progress");
      expect(displayedJobStatus("failed", false)).toBe("failed");
      expect(displayedJobStatus("completed", true)).toBe("completed");
    });

    it("turns a refusal into the server's plain sentence, and lets the user press again", async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          response(409, { code: "NOT_PUBLISHABLE", error: "This post is no longer available to publish." }),
        )
        .mockResolvedValueOnce(response(202, { ok: true }));
      const press = createSendAgain("job-9", fetcher);

      await expect(press()).resolves.toEqual({ ok: false, error: "This post is no longer available to publish." });
      await expect(press()).resolves.toEqual({ ok: true });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("says it could not send when the answer has no sentence or the network fails", async () => {
      const noBody = createSendAgain("job-9", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error("x"); } }));
      await expect(noBody()).resolves.toEqual({ ok: false, error: SEND_AGAIN_FAILED });

      const offline = createSendAgain("job-9", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
      await expect(offline()).resolves.toEqual({ ok: false, error: SEND_AGAIN_FAILED });
      expect(SEND_AGAIN_FAILED).toBe("Couldn't send this post again. Please try again.");
    });
  });
});

// R7-security L1: a retry request is one run whatever it includes, so the card
// offers one request for every failed platform beside the per-platform buttons.
describe("PostJobCard - Retry all failed", () => {
  const failed = (platform: Platform) => result({ platform, status: "failed", externalPostId: null, errorMessage: "No." });

  it("shows Retry all failed beside the per-platform buttons when two or more platforms failed", () => {
    const html = render(
      job({ status: "failed", results: ["x", "facebook_page", "instagram", "linkedin"].map((p) => failed(p as Platform)) }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("Retry all failed</button>");
    expect(html).toContain("Retry X</button>");
    expect(html).toContain("Retry LinkedIn</button>");
  });

  // R7 review, points 1 and 2: the shared rule decides; a result that may already be live is never in it.
  it("X, Facebook and LinkedIn failed, Instagram unconfirmed: Retry all failed is there for the three", () => {
    const html = render(
      job({
        status: "failed",
        results: [failed("x"), failed("facebook_page"), result({ platform: "instagram", status: "failed", unconfirmed: true }), failed("linkedin")],
      }),
    );
    expect(html).toContain("Retry all failed</button>");
  });

  it("no Retry all failed when only platforms that may already be live are left", () => {
    const html = render(
      job({
        status: "failed",
        results: [
          result({ platform: "instagram", status: "failed", unconfirmed: true }),
          result({ platform: "x", status: "failed", unconfirmed: true }),
        ],
      }),
    );
    expect(html).not.toContain("Retry all failed");
  });

  it("the toast says what was retried and what was left out", () => {
    expect(retryAllToast(["x", "facebook_page"], "Instagram left out: check whether it posted first.")).toBe(
      "Retrying X and Facebook Page. Instagram left out: check whether it posted first.",
    );
    expect(retryAllToast(["x"], undefined)).toBe("Retrying X.");
  });

  // R8-pages L6: X unconfirmed and YouTube failed: Retry all would retry only YouTube,
  // the same request as YouTube's own Retry.
  it("no Retry all failed when it would cover only one platform", () => {
    const html = render(
      job({
        status: "failed",
        results: [result({ platform: "x", status: "failed", unconfirmed: true }), failed("youtube")],
      }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("Retry YouTube</button>");
    expect(html).not.toContain("Retry all failed");
  });

  it("shows no Retry all failed for a single failed platform", () => {
    const html = render(job({ status: "failed", results: [failed("x"), result({ platform: "instagram" })] }));
    expect(html).not.toContain("Retry all failed");
  });

  it("asks the server for one retry of every failed platform", () => {
    expect(retryRequestBody("all")).toEqual({ retryAllFailed: true });
    expect(retryRequestBody("x")).toEqual({ platform: "x" });
  });
});

// R10-client-journey L1: only an owner can reconnect, so a member's Activity
// card never sends them to Settings.
describe("PostJobCard - what a member reads", () => {
  const stored = "Reconnect Instagram in Settings, then retry.";
  const failedInstagram = result({ platform: "instagram", status: "failed", externalPostId: null, errorMessage: stored });

  it("a failure's sentence: the owner reads it as stored, a member the owner's step", () => {
    expect(failureSentence(failedInstagram, "owner")).toBe(stored);
    expect(failureSentence(failedInstagram, "member")).toBe("The workspace owner can reconnect Instagram; then retry.");
  });

  // R19 publishing L6: the Business Profile location is chosen on an owner-only page.
  it("a Business Profile without a location: the owner chooses it in Settings, a member is told the owner can", () => {
    const owner = "Google Business Profile location is not configured. Choose the Business Profile location in Settings, then retry.";
    const member = "Google Business Profile location is not configured. The workspace owner can choose the Business Profile location; then retry.";
    for (const stored of [owner, "Google Business Profile location is not configured. Set it from the Connections page."]) {
      const failed = result({ platform: "google_business_profile", status: "failed", externalPostId: null, errorMessage: stored });
      expect(failureSentence(failed, "owner")).toBe(owner);
      expect(failureSentence(failed, "member")).toBe(member);
    }
  });

  // FF2 review: Instagram failures saved before R20 show the plain sentence too.
  it("an Instagram answer without a container id, saved in the old words, reads plainly", () => {
    const plain = "Instagram didn't answer as expected, so nothing was posted. Try again.";
    const failed = result({
      platform: "instagram",
      status: "failed",
      externalPostId: null,
      errorMessage: "Instagram container creation failed (no container id in the answer)",
    });
    expect(failureSentence(failed, "owner")).toBe(plain);
    expect(failureSentence(failed, "member")).toBe(plain);
  });

  it("the reconnect step: a Settings link for an owner, the owner's step and no link for a member", () => {
    const owner = renderToStaticMarkup(createElement(ReconnectStep, { platform: "instagram", role: "owner" })).replace(/<!-- -->/g, "");
    expect(owner).toContain("Reconnect Instagram in");
    expect(owner).toContain("href=\"/settings");
    const member = renderToStaticMarkup(createElement(ReconnectStep, { platform: "instagram", role: "member" })).replace(/<!-- -->/g, "");
    expect(member).toContain("The workspace owner can reconnect Instagram; then retry.");
    expect(member).not.toContain("Settings");
    expect(member).not.toContain("href=");
  });

  it("a retry refused for reconnecting: the server's sentence (worded for the viewer), else the viewer's own", () => {
    const server = "The workspace owner can reconnect X; then retry.";
    expect(reconnectRefusalToast("member", ["x"], "X", server)).toBe(server);
    expect(reconnectRefusalToast("owner", ["x"], "X", undefined)).toBe("Reconnect X in Settings before retrying.");
    expect(reconnectRefusalToast("member", ["x", "instagram"], "the failed platforms", undefined)).toBe(
      "The workspace owner can reconnect X and Instagram; then retry.",
    );
  });

  it("the card takes the viewer's role", () => {
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(PostJobCard, { job: job({ status: "failed", results: [failedInstagram] }), viewerRole: "member", onRetryAccepted: () => {} }),
      ),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("Retry Instagram</button>");
  });
});

// R16-pages L4: on a phone an owner sees a full address in the "by" line; it
// wraps inside its column instead of drawing over the status badge.
describe("PostJobCard - the by line", () => {
  const LONG = "very.long.address.for.a.teammate@example-agency.com";

  it("wraps the name, whatever its length", () => {
    expect(renderToStaticMarkup(createElement(ByName, { name: LONG }))).toBe(`<span class="break-words">${LONG}</span>`);
  });

  it("the card puts the name in that span", () => {
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(PostJobCard, { job: job({ createdBy: { name: LONG } }), showAttribution: true, onRetryAccepted: () => {} }),
      ),
    );
    expect(html.replace(/<!-- -->/g, "")).toContain(` · by <span class="break-words">${LONG}</span>`);
  });
});
