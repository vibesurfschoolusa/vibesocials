import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob/client", () => ({ upload: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { ReviewLinkPanelView } from "@/app/queue/queue-view";

import { ConnectLinkSectionView } from "./connect-link-section";
import { UploadLinkPanelView } from "./media-library";

/**
 * P1 fix round 1: the three client link panels and the plan. With the
 * feature (which is what billing off and an exempt workspace give: the GET
 * then carries no pausedByPlan) each panel is exactly as before, pinned by the
 * snapshots. Without it, a link shows as paused (no address, no Copy, no
 * Replace; Turn off or Revoke stays), and with no link the Create button is
 * replaced by a sentence. Both link to Settings, Plan.
 */

const PAUSED =
  "This link is paused: client links are part of the Growth and Pro plans. Your link comes back when this workspace moves to one of them.";
const NOT_INCLUDED = "Client links are part of the Growth and Pro plans.";
const PLAN_LINK = /<a [^>]*href="\/settings#plan"[^>]*>Settings, Plan<\/a>/;
// Q1: the sentence then " See Settings, Plan.", true whether the owner chooses or switches.
const SEE_PLAN = /\. See <a [^>]*href="\/settings#plan"[^>]*>Settings, Plan<\/a>\./;
const noop = () => {};

const uploadLink = { url: "https://app.example/u/TOKEN", uploadCount: 2, lastUsedAt: null, createdAt: "2026-11-10T10:00:00.000Z" };
const reviewLink = { url: "https://app.example/v/TOKEN", lastUsedAt: null, createdAt: "2026-11-10T10:00:00.000Z" };
const connectLink = {
  url: "https://app.example/c/TOKEN",
  platforms: ["youtube" as const],
  expiresAt: "2026-11-24T10:00:00.000Z",
  lastUsedAt: null,
  createdAt: "2026-11-10T10:00:00.000Z",
};

const upload = (link: typeof uploadLink | null, pausedByPlan?: boolean) =>
  renderToStaticMarkup(
    createElement(UploadLinkPanelView, {
      link,
      pausedByPlan,
      busy: false,
      onCreate: noop,
      onCopy: noop,
      onReplace: noop,
      onTurnOff: noop,
    }),
  );
const review = (link: typeof reviewLink | null, pausedByPlan?: boolean) =>
  renderToStaticMarkup(
    createElement(ReviewLinkPanelView, {
      link,
      pausedByPlan,
      busy: false,
      onCreate: noop,
      onCopy: noop,
      onReplace: noop,
      onTurnOff: noop,
    }),
  );
const connect = (link: typeof connectLink | null, pausedByPlan?: boolean) =>
  renderToStaticMarkup(
    createElement(ConnectLinkSectionView, {
      available: ["youtube"],
      link,
      selected: ["youtube"],
      busy: false,
      onToggle: noop,
      onCreate: noop,
      onCopy: noop,
      onRevoke: noop,
      pausedByPlan,
    }),
  );

const PANELS = [
  ["upload", () => upload(uploadLink), () => upload(null), () => upload(uploadLink, true), () => upload(null, true), "Turn off"],
  ["review", () => review(reviewLink), () => review(null), () => review(reviewLink, true), () => review(null, true), "Turn off"],
  ["connect", () => connect(connectLink), () => connect(null), () => connect(connectLink, true), () => connect(null, true), "Revoke"],
] as const;

describe.each(PANELS)("the %s link panel", (_name, withLink, withoutLink, pausedLink, pausedNone, revokeLabel) => {
  it("with the feature and a link: as today", () => {
    const html = withLink();
    expect(html).toMatchSnapshot();
    expect(html).toContain("TOKEN");
    expect(html).toContain("Copy");
    expect(html).not.toContain("Growth and Pro");
  });

  it("with the feature and no link: as today", () => {
    const html = withoutLink();
    expect(html).toMatchSnapshot();
    expect(html).toContain("Create link");
    expect(html).not.toContain("Growth and Pro");
  });

  it("without the feature, with a link: paused, no address and no Copy, the way off stays", () => {
    const html = pausedLink();
    // The last clause differs for the connect link, which expires (fix round 2, below).
    expect(html).toContain("This link is paused: client links are part of the Growth and Pro plans. Your link comes back");
    expect(html).toMatch(PLAN_LINK);
    expect(html).toMatch(SEE_PLAN);
    expect(html).not.toContain("TOKEN");
    expect(html).not.toContain("Copy");
    expect(html).not.toContain("Replace link");
    expect(html).not.toContain("Create link");
    expect(html).toContain(revokeLabel);
  });

  it("without the feature and no link: the sentence instead of Create link", () => {
    const html = pausedNone();
    expect(html).toContain(NOT_INCLUDED);
    expect(html).not.toContain("Your link comes back");
    expect(html).toMatch(PLAN_LINK);
    expect(html).toMatch(SEE_PLAN);
    expect(html).not.toContain("Create link");
  });
});

// P1 fix round 2: a connect link expires, so it comes back only if a plan is chosen in time.
describe("the paused sentence by link kind", () => {
  const CONNECT_PAUSED =
    "This link is paused: client links are part of the Growth and Pro plans. Your link comes back if this workspace moves to one of them before it expires.";

  it("the connect panel says the link must not have expired", () => {
    const html = connect(connectLink, true);
    expect(html).toContain(CONNECT_PAUSED);
    expect(html).not.toContain("Your link comes back when");
  });

  it("the upload and review panels say as before", () => {
    for (const html of [upload(uploadLink, true), review(reviewLink, true)]) {
      expect(html).toContain(PAUSED);
      expect(html).not.toContain("before it expires");
    }
  });
});
