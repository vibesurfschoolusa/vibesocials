import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import type { PostJobDTO, PostJobResultDTO } from "@/lib/postsDto";

import type { Platform } from "@prisma/client";

import { NOT_SENT_MESSAGE } from "@/lib/publishFailureText";
import { STORY_TOO_OLD_TO_SEND_MESSAGE, TOO_OLD_TO_SEND_MESSAGE } from "@/lib/sendAgain";
import { answerLostText } from "@/lib/answerLost";
import { dispatchFailedText } from "@/lib/composerSubmitOutcome";

import {
  activityCardName,
  ByName,
  cardTime,
  createSendAgain,
  displayedJobStatus,
  failureSentence,
  PostJobCard,
  ReconnectStep,
  reconnectRefusalToast,
  refusedSteps,
  retryAllToast,
  retryRequestBody,
  SEND_AGAIN_FAILED,
  SEND_AGAIN_NO_ANSWER,
  SEND_AGAIN_NOT_SENT,
  SEND_AGAIN_STALE_NOTE,
  sendAgainKey,
} from "./post-job-card";

const cardSource = readFileSync(fileURLToPath(new URL("./post-job-card.tsx", import.meta.url)), "utf8");

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
  // went out (or will go out) at an unlabelled time, so it keeps a label.
  // R56 publishing-flow-2 L1: Publish now, Send again and approve-now write
  // scheduledFor = the moment of sending, so once the post is no longer waiting
  // the label is one that is true for a chosen time and a send-now time; a
  // cancelled post says only what it was set for.
  it("completed: Publishing time, as a label with a colon", () => {
    expect(cardTime({ status: "completed", createdAt: created, scheduledFor: scheduled })).toEqual({ label: "Publishing time:", iso: scheduled });
    expect(cardTime({ status: "partial", createdAt: created, scheduledFor: scheduled })).toEqual({ label: "Publishing time:", iso: scheduled });
  });
  it("failed: Publishing time, as a label with a colon", () => {
    expect(cardTime({ status: "failed", createdAt: created, scheduledFor: scheduled })).toEqual({ label: "Publishing time:", iso: scheduled });
  });
  it("in_progress: Publishing time, as a label with a colon", () => {
    expect(cardTime({ status: "in_progress", createdAt: created, scheduledFor: scheduled })).toEqual({ label: "Publishing time:", iso: scheduled });
  });
  it("cancelled: Was set for, so nothing suggests it will still go out", () => {
    expect(cardTime({ status: "cancelled", createdAt: created, scheduledFor: scheduled })).toEqual({ label: "Was set for", iso: scheduled });
  });
  it("a post published straight away (scheduledFor = its send moment): Publishing time, not Scheduled for", () => {
    const sent = "2026-11-14T08:21:05.000Z";
    expect(cardTime({ status: "completed", createdAt: created, scheduledFor: sent })).toEqual({ label: "Publishing time:", iso: sent });
  });
  it("shows the creation time for a post published straight away, and for a draft", () => {
    expect(cardTime({ status: "completed", createdAt: created, scheduledFor: null })).toEqual({ label: null, iso: created });
    expect(cardTime({ status: "draft", createdAt: created, scheduledFor: null })).toEqual({ label: null, iso: created });
  });
  // R59 client-journey L1: a post the client sent back from /v is a draft that keeps its time.
  it("a draft that still has a time: Was scheduled for that time; one waiting for approval, as before", () => {
    expect(cardTime({ status: "draft", createdAt: created, scheduledFor: scheduled })).toEqual({ label: "Was scheduled for", iso: scheduled });
    expect(cardTime({ status: "draft", approvalState: "pending", createdAt: created, scheduledFor: scheduled })).toEqual({ label: null, iso: created });
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
    )
      .replace(/<!-- -->/g, "")
      .replace(/&#x27;/g, "'");
  const publish = (targetPlatforms: Platform[]) => ({ targetPlatforms }) as unknown as PostJobDTO["publish"];
  // The fixture post was created 2026-11-10: pin "now" inside its 7-day window
  // (lib/sendAgain.ts), so every test here passes whatever today's date is.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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

  // R48 publishing L1: Send again sends one card's half, so the Story half's
  // card says it is the Story, and the feed half's card stays "This post".
  it("names the Story on an unsent Story half's card, and not on its feed half's", () => {
    const storyCard = render({ status: "failed", results: [], storyHalf: true, storyOf: { id: "job-feed", scheduledFor: null } });
    expect(storyCard).toContain("This Story was not sent. Use Send again to try once more.");
    expect(storyCard).not.toContain(NOT_SENT_MESSAGE);

    const feedCard = render({ status: "failed", results: [] });
    expect(feedCard).toContain(NOT_SENT_MESSAGE);
    expect(feedCard).not.toContain("This Story was not sent");
  });

  // R48 review: with its feed post cancelled the Story half has no storyOf
  // (that names a live partner), but it is still the Story.
  it("names the Story when its feed post was cancelled", () => {
    const storyCard = render({ status: "failed", results: [], storyHalf: true });
    expect(storyCard).toContain("This Story was not sent. Use Send again to try once more.");
    expect(storyCard).not.toContain(NOT_SENT_MESSAGE);
  });

  // Coordinator follow-up 1: the honest failure gets a Send again button that
  // calls the publish route (which accepts a failed post with no results).
  describe("Send again", () => {
    it("offers no button on a post older than a week, and says why", () => {
      const html = render({ status: "failed", results: [], createdAt: "2026-01-18T10:00:00.000Z", scheduledFor: null });
      expect(html).not.toContain("Send again</button>");
      expect(html).toContain(TOO_OLD_TO_SEND_MESSAGE);
      expect(html).not.toContain(NOT_SENT_MESSAGE);
    });

    // R49 pages-b L1: a Story half too old to send again says it is the Story,
    // and what to create, so the feed post is not made a second time.
    it("names the Story on a too-old Story half's card, and says to create the Story alone", () => {
      const html = render({
        status: "failed",
        results: [],
        storyHalf: true,
        createdAt: "2026-01-18T10:00:00.000Z",
        scheduledFor: null,
      });
      expect(html).not.toContain("Send again</button>");
      expect(html).toContain(STORY_TOO_OLD_TO_SEND_MESSAGE);
      expect(STORY_TOO_OLD_TO_SEND_MESSAGE).toMatch(/^This Story was not sent, and it is too old to send again\./);
      expect(html).not.toContain(TOO_OLD_TO_SEND_MESSAGE);
      expect(html).not.toContain("This Story was not sent. Use Send again");
    });

    // R50 pages-b L2: the card has no results, so no badges; its sentence names the Story's platforms.
    it("names the Story's platforms on a too-old Story half's card", () => {
      const html = render({
        status: "failed",
        results: [],
        storyHalf: true,
        storyPlatforms: ["instagram"],
        createdAt: "2026-01-18T10:00:00.000Z",
        scheduledFor: null,
      });
      expect(html).toContain(
        "This Story was not sent, and it is too old to send again. To post it, create a new post to Instagram only, with Story chosen.",
      );
      expect(html).not.toContain(STORY_TOO_OLD_TO_SEND_MESSAGE);
    });

    it("keeps the too-old sentence of a feed post as it was", () => {
      const html = render({ status: "failed", results: [], createdAt: "2026-01-18T10:00:00.000Z", scheduledFor: null });
      expect(html).toContain(
        "This post was not sent, and it is too old to send again. Create it again if you still want it.",
      );
      expect(html).not.toContain(STORY_TOO_OLD_TO_SEND_MESSAGE);
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
      const press = createSendAgain("job-9", "ws-1", fetcher);

      const first = press();
      const second = press();
      release(response(202, { ok: true, status: "in_progress" }));

      await expect(first).resolves.toEqual({ ok: true });
      await expect(second).resolves.toBeNull();
      await expect(press()).resolves.toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
      // R31 pages L2: with the workspace Activity was drawn for.
      expect(fetcher).toHaveBeenCalledWith("/api/posts/job-9/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-1" }),
      });
    });

    // R31 publishing L4 and pages L2: the shared refusal rule (postActionRefusal).
    it("deleted meanwhile: says it no longer exists and reads the list again", async () => {
      const fetcher = vi.fn().mockResolvedValueOnce(response(404, { error: "This post no longer exists." }));
      const press = createSendAgain("job-9", "ws-1", fetcher, () => true);
      await expect(press()).resolves.toEqual({ ok: false, error: "This post no longer exists.", refetch: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("another workspace: the route's sentence, and no list read into that workspace", async () => {
      const error = "You switched workspace in another tab. Reload this page, then try again.";
      const fetcher = vi.fn().mockResolvedValueOnce(response(409, { error, code: "WORKSPACE_CHANGED" }));
      const press = createSendAgain("job-9", "ws-1", fetcher, () => true);
      await expect(press()).resolves.toEqual({ ok: false, error });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("shows the post as in progress once the server took it", () => {
      expect(displayedJobStatus("failed", true)).toBe("in_progress");
      expect(displayedJobStatus("failed", false)).toBe("failed");
      expect(displayedJobStatus("completed", true)).toBe("completed");
    });

    // R28 publishing L1: a 409 or 429 may come after the claim, so the post is
    // read again; while it is still unsent the press is offered back.
    const unsentPost = () => response(200, { postJob: { id: "job-9", status: "failed" }, results: [] });
    const sentPost = () =>
      response(200, { postJob: { id: "job-9", status: "failed" }, results: [{ platform: "x", status: "failed" }] });

    it("turns a refusal into the server's plain sentence, and lets the user press again while the post is still unsent", async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          response(409, { code: "AWAITING_APPROVAL", error: "An owner needs to approve this post first." }),
        )
        .mockResolvedValueOnce(unsentPost())
        .mockResolvedValueOnce(response(202, { ok: true }));
      const press = createSendAgain("job-9", "ws-1", fetcher);

      await expect(press()).resolves.toEqual({ ok: false, error: "An owner needs to approve this post first.", refetch: true });
      expect(fetcher).toHaveBeenNthCalledWith(2, "/api/posts/job-9?workspaceId=ws-1", { method: "GET" });
      await expect(press()).resolves.toEqual({ ok: true });
      expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it("a 409 or 429 given after the claim (e.g. NO_CONNECTIONS): the list is read again and the press stays used", async () => {
      for (const answer of [
        response(409, { code: "NO_CONNECTIONS", error: "Nothing was posted: none of its platforms is connected. Activity shows what to reconnect." }),
        response(429, { code: "DAILY_LIMIT", error: "This workspace has reached its limit of 20 posts for today." }),
      ]) {
        const fetcher = vi.fn().mockResolvedValueOnce(answer).mockResolvedValueOnce(sentPost());
        const press = createSendAgain("job-9", "ws-1", fetcher, () => true);
        const outcome = await press();
        expect(outcome).toMatchObject({ ok: false, refetch: true });
        expect(outcome).not.toHaveProperty("note");
        await expect(press()).resolves.toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(2);
      }
    });

    // R50 publishing-flow L1: the route refuses before any claim, and the post
    // only gets older, so the card turns too-old and the press stays used.
    it("TOO_OLD: the route's sentence, the card told it is too old, and no second press", async () => {
      const error = TOO_OLD_TO_SEND_MESSAGE;
      const fetcher = vi.fn().mockResolvedValueOnce(response(409, { error, code: "TOO_OLD" }));
      const press = createSendAgain("job-9", "ws-1", fetcher, () => true);
      await expect(press()).resolves.toEqual({ ok: false, error, tooOld: true });
      await expect(press()).resolves.toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("publishing couldn't start and the reloaded post is still unsent: press Send again, and the press comes back", async () => {
      const body = dispatchBody(true);
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json(body, { status: 503 }))
        .mockResolvedValueOnce(unsentPost())
        .mockResolvedValueOnce(response(202, { ok: true }));
      const press = createSendAgain("job-9", "ws-1", fetcher, () => true);
      await expect(press()).resolves.toEqual({
        ok: false,
        error: "Publishing couldn't start, so nothing was sent. Press Send again to try once more.",
        refetch: true,
      });
      await expect(press()).resolves.toEqual({ ok: true });
    });

    // R29 OO3 follow-up: the re-read is the truth about the post.
    it("the 503 says not marked, but the re-read shows it unsent: press Send again", async () => {
      const body = { ...dispatchBody(false), withoutResults: true };
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json(body, { status: 503 }))
        .mockResolvedValueOnce(unsentPost());
      const press = createSendAgain("job-9", "ws-1", fetcher, () => true);
      await expect(press()).resolves.toEqual({
        ok: false,
        error: "Publishing couldn't start, so nothing was sent. Press Send again to try once more.",
        refetch: true,
      });
    });

    it("not marked, and the re-read shows it still in progress with no results: tried again on its own", async () => {
      const body = { ...dispatchBody(false), withoutResults: true };
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(Response.json(body, { status: 503 }))
        .mockResolvedValueOnce(response(200, { postJob: { id: "job-9", status: "in_progress" }, results: [] }));
      const press = createSendAgain("job-9", "ws-1", fetcher, () => true);
      await expect(press()).resolves.toEqual({
        ok: false,
        error:
          "Publishing didn't start. It will be tried again on its own within about 20 minutes; if that fails too, it shows as failed in Activity, with what to do next on its card.",
        refetch: true,
      });
      await expect(press()).resolves.toBeNull();
    });

    it("a refusal with no sentence says it could not send", async () => {
      const noBody = createSendAgain("job-9", "ws-1", vi.fn().mockResolvedValue(new Response("", { status: 400 })), () => true);
      await expect(noBody()).resolves.toEqual({ ok: false, error: SEND_AGAIN_FAILED });
      expect(SEND_AGAIN_FAILED).toBe("Couldn't send this post again. Please try again.");
    });

    // R27 publishing-flow L1: Send again after a failed start.
    const dispatchBody = (resultsMarked: boolean) => ({
      code: "DISPATCH_FAILED",
      error: "Couldn't start publishing. Please try again.",
      postJobId: "job-9",
      resultsMarked,
    });
    const fresh = () => new Response(JSON.stringify({ postJob: { id: "job-9" }, results: [] }), { status: 200 });

    it("publishing couldn't start: the shared DISPATCH_FAILED sentence for Send again; the post is read again and the press stays used", async () => {
      for (const resultsMarked of [true, false]) {
        const body = dispatchBody(resultsMarked);
        const fetcher = vi
          .fn()
          .mockResolvedValueOnce(Response.json(body, { status: 503 }))
          .mockResolvedValueOnce(fresh());
        const press = createSendAgain("job-9", "ws-1", fetcher, () => true);
        await expect(press()).resolves.toEqual({ ok: false, error: dispatchFailedText(body, "Send again"), refetch: true });
        expect(fetcher).toHaveBeenNthCalledWith(2, "/api/posts/job-9?workspaceId=ws-1", { method: "GET" });
        await expect(press()).resolves.toBeNull();
      }
    });

    // R27 MM4 review: a refresh that fails must not leave Send again used up and silent.
    it("publishing couldn't start and the post couldn't be read again: Send again comes back with a line saying so", async () => {
      expect(SEND_AGAIN_STALE_NOTE).toBe(
        "This list couldn't refresh, so this card may be out of date. Reload the page to see the post as it is before you press Send again.",
      );
      for (const failedRead of [new Response("<html>502</html>", { status: 502 }), new TypeError("Failed to fetch")]) {
        const body = dispatchBody(true);
        const fetcher = vi.fn().mockResolvedValueOnce(Response.json(body, { status: 503 }));
        if (failedRead instanceof Error) fetcher.mockRejectedValueOnce(failedRead);
        else fetcher.mockResolvedValueOnce(failedRead);
        fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 202 }));
        const press = createSendAgain("job-9", "ws-1", fetcher, () => true);
        await expect(press()).resolves.toEqual({
          ok: false,
          error: dispatchFailedText(body, "Send again"),
          refetch: true,
          note: SEND_AGAIN_STALE_NOTE,
        });
        await expect(press()).resolves.toEqual({ ok: true });
      }
    });

    it("the card shows the note in a status line by Send again, on the page from the first render", () => {
      expect(cardSource).toMatch(/<p role="status" className="[^"]*empty:sr-only[^"]*">\s*\{sendAgainNote\}\s*<\/p>/);
      expect(cardSource).toMatch(/setSendAgainNote\(outcome\.note \?\? ""\)/);
    });

    it("no answer or a gateway's page: it may have gone through, check before pressing again", async () => {
      expect(SEND_AGAIN_NO_ANSWER).toBe(
        answerLostText("the post may have started sending", "Wait for this card to update and check it before you press Send again."),
      );
      const lost = createSendAgain("job-9", "ws-1", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")), () => true);
      await expect(lost()).resolves.toEqual({ ok: false, error: SEND_AGAIN_NO_ANSWER, refetch: true });
      const gateway = createSendAgain("job-9", "ws-1", vi.fn().mockResolvedValue(new Response("<html>504</html>", { status: 504 })), () => true);
      await expect(gateway()).resolves.toEqual({ ok: false, error: SEND_AGAIN_NO_ANSWER, refetch: true });
    });

    it("offline: nothing is sent and it says to check the connection", async () => {
      expect(SEND_AGAIN_NOT_SENT).toBe(
        "We couldn't reach Vibe Socials, so the post wasn't sent. Check your connection and press Send again.",
      );
      const fetcher = vi.fn();
      const press = createSendAgain("job-9", "ws-1", fetcher, () => false);
      await expect(press()).resolves.toEqual({ ok: false, error: SEND_AGAIN_NOT_SENT });
      expect(fetcher).not.toHaveBeenCalled();
    });

    // R28 lead review: prepare and the marking both failed, so the re-read finds
    // the post publishing and the press stays used. When the stuck-job sweep
    // later fails it with no results, the card's next render shows it unsent,
    // and Send again works again: the press follows the post, not just its id.
    it("in progress, then later unsent: Send again works on the later render", async () => {
      const inProgress = job({ id: "job-9", status: "in_progress", results: [], updatedAt: "2026-11-14T12:00:00.000Z" });
      const unsent = job({ id: "job-9", status: "failed", results: [], updatedAt: "2026-11-14T14:05:00.000Z" });
      const body = dispatchBody(false);
      const first = createSendAgain(
        "job-9",
        "ws-1",
        vi
          .fn()
          .mockResolvedValueOnce(Response.json(body, { status: 503 }))
          .mockResolvedValueOnce(response(200, { postJob: { id: "job-9", status: "in_progress" }, results: [] })),
        () => true,
      );
      await expect(first()).resolves.toMatchObject({ ok: false, refetch: true });
      await expect(first()).resolves.toBeNull();

      expect(sendAgainKey(unsent)).not.toBe(sendAgainKey(inProgress));
      expect(sendAgainKey({ ...inProgress })).toBe(sendAgainKey(inProgress));
      expect(cardSource).toMatch(/useMemo\(\(\) => createSendAgain\(job\.id, workspaceId\), \[job\.id, workspaceId, pressKey\]\)/);
      expect(cardSource).toMatch(/const pressKey = sendAgainKey\(job\);/);

      const later = createSendAgain("job-9", "ws-1", vi.fn().mockResolvedValueOnce(response(202, { ok: true })), () => true);
      await expect(later()).resolves.toEqual({ ok: true });
    });

    it("the card reads the list again when the outcome asks", () => {
      expect(cardSource).toMatch(/if \(outcome\.refetch\) onRetryAccepted\(job\.id\)/);
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
    expect(retryRequestBody("all", "ws-1")).toEqual({ retryAllFailed: true, workspaceId: "ws-1" });
    expect(retryRequestBody("x", "ws-1")).toEqual({ platform: "x", workspaceId: "ws-1" });
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

  // R59 follow-up: the card's steps come from lib/connectionSteps.ts, word for word as before.
  it("the toast fallback with no reason and no platform listed names the card's label, as Reconnect", () => {
    expect(reconnectRefusalToast("owner", [], "the failed platforms", undefined)).toBe(
      "Reconnect the failed platforms in Settings before retrying.",
    );
    expect(reconnectRefusalToast("member", [], "the failed platforms", undefined)).toBe(
      "The workspace owner can reconnect the failed platforms; then retry.",
    );
    expect(reconnectRefusalToast("owner", [], "the failed platforms", undefined, "connect")).toBe(
      "Connect the failed platforms in Settings, then retry.",
    );
  });

  it("the owner's step keeps the Settings link, with the verb and platform before it", () => {
    for (const [step, verb] of [["connect", "Connect"], ["reconnect", "Reconnect"]] as const) {
      const owner = renderToStaticMarkup(createElement(ReconnectStep, { platform: "x", role: "owner", step })).replace(/<!-- -->/g, "");
      expect(owner).toMatch(new RegExp(`>${verb} X in <a [^>]*href="/settings[^"]*"[^>]*>Settings</a></span>$`));
    }
  });

  // R58 pages-a-4 L1: a platform with no connection is connected, not reconnected.
  it("the step for no connection: Connect with a Settings link for an owner, the owner's step for a member", () => {
    const owner = renderToStaticMarkup(
      createElement(ReconnectStep, { platform: "instagram", role: "owner", step: "connect" }),
    ).replace(/<!-- -->/g, "");
    expect(owner).toContain("Connect Instagram in");
    expect(owner).not.toContain("Reconnect");
    expect(owner).toContain("href=\"/settings");
    const member = renderToStaticMarkup(
      createElement(ReconnectStep, { platform: "instagram", role: "member", step: "connect" }),
    ).replace(/<!-- -->/g, "");
    expect(member).toContain("The workspace owner can connect Instagram; then retry.");
    expect(member).not.toContain("href=");
  });

  it("the step for a flagged connection keeps Reconnect", () => {
    const owner = renderToStaticMarkup(
      createElement(ReconnectStep, { platform: "instagram", role: "owner", step: "reconnect" }),
    ).replace(/<!-- -->/g, "");
    expect(owner).toContain("Reconnect Instagram in");
    const member = renderToStaticMarkup(
      createElement(ReconnectStep, { platform: "instagram", role: "member", step: "reconnect" }),
    ).replace(/<!-- -->/g, "");
    expect(member).toContain("The workspace owner can reconnect Instagram; then retry.");
  });

  it("a retry refused for no connection: the fallback says Connect; for a flagged one, Reconnect", () => {
    expect(reconnectRefusalToast("owner", ["x"], "X", undefined, "connect")).toBe("Connect X in Settings, then retry.");
    expect(reconnectRefusalToast("member", ["x"], "X", undefined, "connect")).toBe(
      "The workspace owner can connect X; then retry.",
    );
    expect(reconnectRefusalToast("owner", ["x"], "X", undefined, "reconnect")).toBe("Reconnect X in Settings before retrying.");
    expect(reconnectRefusalToast("member", ["x"], "X", undefined, "reconnect")).toBe(
      "The workspace owner can reconnect X; then retry.",
    );
  });

  it("the step each refused platform shows comes from the server's reason", () => {
    expect(refusedSteps("instagram", { code: "RECONNECT_REQUIRED", reason: "connect" })).toEqual([["instagram", "connect"]]);
    expect(refusedSteps("instagram", { code: "RECONNECT_REQUIRED", reason: "reconnect" })).toEqual([["instagram", "reconnect"]]);
    // An answer from before the reason was sent keeps the old step.
    expect(refusedSteps("instagram", { code: "RECONNECT_REQUIRED" })).toEqual([["instagram", "reconnect"]]);
    expect(
      refusedSteps("all", {
        leftOut: [
          { platform: "instagram", reason: "unconfirmed" },
          { platform: "x", reason: "reconnect" },
          { platform: "youtube", reason: "connect" },
        ],
      }),
    ).toEqual([
      ["x", "reconnect"],
      ["youtube", "connect"],
    ]);
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

// R27 pages L2: Retry all failed keeps focus while it runs.
const NL = String.fromCharCode(10);
describe("PostJobCard - Retry all failed while it runs", () => {
  it("is loading, never disabled, so focus stays on it", () => {
    const tag = cardSource.slice(cardSource.lastIndexOf("<Button", cardSource.indexOf("Retry all failed" + NL)), cardSource.indexOf("Retry all failed" + NL));
    expect(tag).toContain("loading={retryAllPlatforms.some((platform) => pending.has(platform))}");
    expect(tag).not.toContain("disabled=");
  });
});

// R28 NN2 step 3: a retry whose answer is lost may have started on the
// server; the card says so and reads the post again. Offline at the press,
// nothing was sent.
describe("Retry when the answer is lost", () => {
  const card = readFileSync(fileURLToPath(new URL("./post-job-card.tsx", import.meta.url)), "utf8");
  const retry = card.slice(card.indexOf("const retry = useCallback("), card.indexOf("[job.id, onRetryAccepted, toast, viewerRole, workspaceId]"));

  it("says what may have happened and where to check", async () => {
    const { retryNoAnswerText, retryNotSentText } = await import("./post-job-card");
    expect(retryNoAnswerText("Instagram")).toBe(
      "Vibe Socials' answer didn't reach you, so the retry of Instagram may have started. If your connection dropped, reconnect first. We're reloading Activity: check the post before you retry again.",
    );
    expect(retryNotSentText("the failed platforms")).toBe(
      "You're offline, so the retry of the failed platforms wasn't sent. Reconnect, then retry again.",
    );
  });

  it("sends through sendActionRequest; no answer rolls back, says so and reads the post again", () => {
    expect(retry).toMatch(/await sendActionRequest\(`\/api\/posts\/\$\{job\.id\}\/retry`/);
    expect(retry).not.toMatch(/await fetch\(/);
    expect(retry).toMatch(/answer\.kind === "not_sent"\) \{\s+rollBack\(\);\s+toast\.error\(retryNotSentText\(label\)\);\s+return;/);
    expect(retry).toMatch(/answer\.kind === "no_answer"\) \{\s+rollBack\(\);\s+toast\.error\(retryNoAnswerText\(label\)\);\s+onRetryAccepted\(job\.id\);\s+return;/);
  });

  // R31 publishing L3 and pages L2: a refusal that means the post moved on (a
  // 409, a 404) reads the post again with the route's sentence; another
  // workspace's answer is said without reading the list into that workspace.
  it("a refusal goes through postActionRefusal: the route's sentence, a reload when it says so", () => {
    expect(retry).toMatch(/const refusal = postActionRefusal\(response\.status, body, `Couldn't retry \$\{label\}\. Please try again\.`\);\s+toast\.error\(refusal\.text\);\s+if \(refusal\.reload\) onRetryAccepted\(job\.id\);/);
    expect(retry).toMatch(/JSON\.stringify\(retryRequestBody\(target, workspaceId\)\)/);
  });
});

// R57 pages-b L1 (#282's rule): every card repeats these buttons, so each
// one's name starts with its text and names the post, as the Queue's do.
describe("PostJobCard - repeated buttons name the post", () => {
  const failed = (platform: Platform) =>
    result({ platform, status: "failed", externalPostId: null, errorMessage: "No.", externalPostUrl: null });
  const html = (value: PostJobDTO) => render(value).replace(/<!-- -->/g, "");
  // Send again shows only inside the fixture's 7-day window, whatever today is.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // R58 pages-a L1: the name is the caption and the time the card shows (cardName).
  const at = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const NAME = `Two spots left today, ${at("2026-11-10T10:00:00.000Z")}`;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const button = (label: string, text: string) =>
    new RegExp(`aria-label="${escape(label)} &quot;${escape(NAME)}&quot;"[^>]*>${escape(text)}</button>`);

  it("Retry <platform>, Retry all failed and Show N errors", () => {
    const out = html(job({ status: "failed", results: [failed("x"), failed("linkedin")] }));
    expect(out).toMatch(button("Retry X", "Retry X"));
    expect(out).toMatch(button("Retry LinkedIn", "Retry LinkedIn"));
    expect(out).toMatch(button("Retry all failed", "Retry all failed"));
    expect(out).toContain(`aria-label="Show 2 errors &quot;${NAME}&quot;"`);
  });

  it("Send again", () => {
    const out = html(job({ status: "failed", results: [], publish: null }));
    expect(out).toMatch(button("Send again", "Send again"));
  });

  it("View on <platform>, with its new-tab hint", () => {
    const out = html(job({ results: [result({ platform: "x", externalPostId: "123", externalPostUrl: "https://x.com/i/status/123" })] }));
    expect(out).toContain(`aria-label="View on X &quot;${NAME}&quot; (opens in a new tab)"`);
  });

  it("a card with no caption is named Untitled post plus its time", () => {
    expect(html(job({ caption: "", status: "failed", results: [], publish: null }))).toContain(
      `aria-label="Send again &quot;Untitled post, ${at("2026-11-10T10:00:00.000Z")}&quot;"`,
    );
  });

  // R58 fix review L1: the Story half is its own job with the same caption and time.
  it("a Feed and Story pair: the Story card's name says Story, the Feed card's is as before", () => {
    const nameOf = (out: string) => /aria-label="Send again &quot;([^"]*)&quot;"/.exec(out)?.[1];
    const iso = "2026-11-11T15:00:00.000Z";
    const feed = nameOf(html(job({ id: "f", status: "failed", scheduledFor: iso })));
    const story = nameOf(html(job({ id: "s", status: "failed", scheduledFor: iso, storyOf: { id: "f", scheduledFor: iso }, storyHalf: true })));
    expect(feed).toBe(`Two spots left today, ${at(iso)}`);
    expect(story).toBe(`Two spots left today, Story, ${at(iso)}`);
  });

  it("two posts of a series, same caption, different times, have different names", () => {
    const nameOf = (out: string) => /aria-label="Send again &quot;([^"]*)&quot;"/.exec(out)?.[1];
    const a = nameOf(html(job({ id: "a", status: "failed", scheduledFor: "2026-11-11T15:00:00.000Z" })));
    const b = nameOf(html(job({ id: "b", status: "failed", scheduledFor: "2026-11-12T15:00:00.000Z" })));
    expect(a).toBe(`Two spots left today, ${at("2026-11-11T15:00:00.000Z")}`);
    expect(b).toBe(`Two spots left today, ${at("2026-11-12T15:00:00.000Z")}`);
  });
});

// R59 client-journey L1: a post the client sent back from /v shows the time it was scheduled for.
describe("PostJobCard - a draft that still has a time", () => {
  it("says Was scheduled for that time, not its save time", () => {
    const html = render(job({ status: "draft", results: [], scheduledFor: "2026-11-21T14:00:00.000Z" }));
    expect(html).toContain("Was scheduled for <time");
    expect(html).toContain('dateTime="2026-11-21T14:00:00.000Z"');
  });
  it("two posts of one series the client sent back get different names", () => {
    const at = (iso: string) =>
      new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const sentBack = (scheduledFor: string) =>
      job({ status: "draft", caption: "Sunday session", createdAt: "2026-11-14T15:02:00.000Z", scheduledFor });
    expect(activityCardName(sentBack("2026-11-21T14:00:00.000Z"))).toBe(`Sunday session, was ${at("2026-11-21T14:00:00.000Z")}`);
    expect(activityCardName(sentBack("2026-11-28T14:00:00.000Z"))).toBe(`Sunday session, was ${at("2026-11-28T14:00:00.000Z")}`);
  });
  it("a plain draft and a scheduled post: as before", () => {
    const at = (iso: string) =>
      new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    expect(activityCardName(job({ status: "draft", caption: "Dawn" }))).toBe(`Dawn, ${at("2026-11-10T10:00:00.000Z")}`);
    expect(activityCardName(job({ status: "scheduled", caption: "Dawn", scheduledFor: "2026-11-21T14:00:00.000Z" }))).toBe(
      `Dawn, ${at("2026-11-21T14:00:00.000Z")}`,
    );
  });
});
