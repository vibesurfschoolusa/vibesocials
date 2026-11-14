import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ReviewPostDTO } from "@/lib/reviewLink";

import { ReviewPostCard } from "./review-link-view";

function post(over: Partial<ReviewPostDTO> = {}): ReviewPostDTO {
  return {
    id: "p1",
    scheduledFor: "2026-11-20T15:00:00.000Z",
    platforms: ["Instagram", "Facebook Page"],
    caption: "Sunday session",
    platformCaptions: [],
    media: { url: "https://x.example/a.jpg", mimeType: "image/jpeg" },
    mediaCount: 1,
    state: "pending",
    note: null,
    version: "v1",
    ...over,
  } as ReviewPostDTO;
}

function render(p: ReviewPostDTO): string {
  return renderToStaticMarkup(
    createElement("ul", null, createElement(ReviewPostCard, { post: p, token: "t", onDecided: () => {}, onStale: () => {} })),
  );
}

describe("ReviewPostCard", () => {
  it("shows the preview, time, platforms and caption with two full-width buttons on a phone", () => {
    const html = render(post());
    expect(html).toContain('src="https://x.example/a.jpg"');
    expect(html).toContain("<time");
    expect(html).toContain("Instagram, Facebook Page");
    expect(html).toContain("Sunday session");
    expect(html).toMatch(/<button[^>]*w-full[^>]*>Looks good<\/button>/);
    expect(html).toMatch(/<button[^>]*w-full[^>]*>Ask for a change<\/button>/);
  });

  it("shows a video with controls", () => {
    expect(render(post({ media: { url: "https://x.example/a.mp4", mimeType: "video/mp4" } }))).toContain("<video");
  });

  it("shows the approved state clearly and disables approving again", () => {
    const html = render(post({ state: "approved" }));
    expect(html).toContain("You approved this");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Looks good<\/button>/);
  });

  it("shows a change request with the client's note and no buttons", () => {
    const html = render(post({ state: "change_requested", note: "Use the other photo" }));
    expect(html).toContain("Change requested");
    expect(html).toContain("Use the other photo");
    expect(html).not.toContain("Looks good");
  });

  it("says when no time is set", () => {
    expect(render(post({ scheduledFor: null }))).toContain("No time set");
  });
});
