import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));

import { qrSvg } from "@/lib/qrSvg";

import { ReviewLinkPanelView, reviewRequestMessage } from "./review-link-panel";

const LINK = "https://g.page/r/abc/review";
const render = (state: Parameters<typeof ReviewLinkPanelView>[0]["state"]) =>
  renderToStaticMarkup(createElement(ReviewLinkPanelView, { state }));

describe("reviewRequestMessage", () => {
  it("is the message to send a customer, with the link", () => {
    expect(reviewRequestMessage(LINK)).toBe(
      `Thanks for coming out with us! If you have a minute, a quick Google review helps us a lot: ${LINK}`,
    );
  });
});

describe("ReviewLinkPanelView", () => {
  it("shows the link with Copy, its QR code, a Print card button and the message with Copy", () => {
    const html = render({ status: "ready", url: LINK });

    expect(html).toContain("Get more reviews");
    expect(html).toContain(`href="${LINK}"`);
    expect(html).toContain(qrSvg(LINK));
    expect(html).toContain('href="/reviews/print-card"');
    expect(html).toContain("Print card");
    expect(html).toContain(reviewRequestMessage(LINK));
    expect(html.match(/>Copy link</g)).toHaveLength(1);
    expect(html.match(/>Copy message</g)).toHaveLength(1);
  });

  it("says what to do in one line when there is no link", () => {
    const html = render({ status: "none", reason: "Choose your Maps location in Settings." });

    expect(html).toContain("Get more reviews");
    expect(html).toContain("Choose your Maps location in Settings.");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("Print card");
  });

  it("shows a placeholder while loading", () => {
    const html = render({ status: "loading" });

    expect(html).toContain("Get more reviews");
    expect(html).not.toContain("<svg");
  });
});
