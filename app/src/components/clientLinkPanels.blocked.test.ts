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
 * R21 client-journey L1: in a blocked workspace (paused, or an ended trial or
 * plan) every client link answers "not active", so the panels show the GET's
 * sentence instead of the address, Copy, Replace and Create. Turn off stays.
 */

const BLOCKED = "Client links don&#x27;t work right now. This workspace is paused. Contact support.";
const BLOCKED_TEXT = "Client links don't work right now. This workspace is paused. Contact support.";
const noop = () => {};
const handlers = { busy: false, onCreate: noop, onCopy: noop, onReplace: noop, onTurnOff: noop };

const uploadLink = { url: "https://app.example/u/TOKEN", uploadCount: 2, lastUsedAt: null, createdAt: "2026-11-10T10:00:00.000Z" };
const reviewLink = { url: "https://app.example/v/TOKEN", lastUsedAt: null, createdAt: "2026-11-10T10:00:00.000Z" };
const connectLink = {
  url: "https://app.example/c/TOKEN",
  platforms: ["youtube" as const],
  expiresAt: "2026-11-24T10:00:00.000Z",
  lastUsedAt: null,
  createdAt: "2026-11-10T10:00:00.000Z",
};

type Extra = { workspaceBlocked?: string; pausedByPlan?: boolean };
const PANELS = [
  [
    "upload",
    (link: boolean, extra: Extra) =>
      renderToStaticMarkup(createElement(UploadLinkPanelView, { link: link ? uploadLink : null, ...handlers, ...extra })),
  ],
  [
    "review",
    (link: boolean, extra: Extra) =>
      renderToStaticMarkup(createElement(ReviewLinkPanelView, { link: link ? reviewLink : null, ...handlers, ...extra })),
  ],
  [
    "connect",
    (link: boolean, extra: Extra) =>
      renderToStaticMarkup(
        createElement(ConnectLinkSectionView, {
          available: ["youtube"],
          selected: ["youtube"],
          onToggle: noop,
          link: link ? connectLink : null,
          ...handlers,
          ...extra,
        }),
      ),
  ],
] as const;

describe.each(PANELS)("the %s link panel in a blocked workspace", (_name, render) => {
  it("with a link: the sentence, no address, no Copy, no Replace; Turn off stays", () => {
    const html = render(true, { workspaceBlocked: BLOCKED_TEXT });
    expect(html).toContain(BLOCKED);
    expect(html).not.toContain("TOKEN");
    expect(html).not.toContain("Copy");
    expect(html).not.toContain("Replace link");
    expect(html).toContain("Turn off");
  });

  it("with no link: the sentence instead of Create link", () => {
    const html = render(false, { workspaceBlocked: BLOCKED_TEXT });
    expect(html).toContain(BLOCKED);
    expect(html).not.toContain("Create link");
  });

  it("the block wins over the plan's sentence", () => {
    const html = render(true, { workspaceBlocked: BLOCKED_TEXT, pausedByPlan: true });
    expect(html).toContain(BLOCKED);
    expect(html).not.toContain("Growth and Pro");
  });

  it("not blocked: as today", () => {
    const html = render(true, {});
    expect(html).toContain("Copy");
    expect(html).not.toContain("work right now");
  });
});
