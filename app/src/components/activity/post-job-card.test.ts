import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import type { PostJobDTO, PostJobResultDTO } from "@/lib/postsDto";

import { cardTime, PostJobCard } from "./post-job-card";

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
