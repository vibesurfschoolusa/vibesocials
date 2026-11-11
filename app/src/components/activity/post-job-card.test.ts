import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import type { PostJobDTO, PostJobResultDTO } from "@/lib/postsDto";

import { PostJobCard } from "./post-job-card";

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
