import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1: Add many is a Growth and Pro feature. Without it the page shows a short
 * notice and a link to Settings, Plan instead of the form. The page's create
 * requests are the same POST /api/posts calls Create makes and cannot be told
 * apart from them without changing that route, so only the page is gated.
 */

const h = vi.hoisted(() => ({ getWorkspaceContext: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: h.getWorkspaceContext }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("./bulk-posts-form", () => ({
  BulkPostsForm: ({ workspaceId }: { workspaceId: string }) => createElement("form", { "data-workspace": workspaceId }),
}));

import BulkPostsPage from "./page";

const LATER = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
const STARTER = { plan: "starter", planStatus: "active", currentPeriodEnd: LATER };
const context = (billing: Record<string, unknown>, role: "owner" | "member" = "owner") => ({
  user: { id: "user-1" },
  workspace: { id: "ws-1", name: "Surf Co", ...billing },
  role,
});
const render = async () => renderToStaticMarkup((await BulkPostsPage()) as ReactElement);

beforeEach(() => {
  h.getWorkspaceContext.mockReset();
  vi.stubEnv("BILLING_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("/posts/bulk by plan", () => {
  it("shows the notice and the link to Settings, Plan on Starter, without the form", async () => {
    h.getWorkspaceContext.mockResolvedValue(context(STARTER));
    const html = await render();
    expect(html).not.toContain("<form");
    expect(html).toContain("Add many is part of the Growth and Pro plans.");
    expect(html).toMatch(/<a [^>]*href="\/settings#plan"[^>]*>Choose a plan in Settings, Plan<\/a>/);
  });

  it("shows the form on Growth, in a trial, for an exempt workspace and with billing off", async () => {
    for (const [billing, on] of [
      [{ ...STARTER, plan: "growth" }, true],
      [{ trialEndsAt: LATER }, true],
      [{ billingExempt: true, ...STARTER }, true],
      [STARTER, false],
    ] as const) {
      vi.stubEnv("BILLING_ENABLED", on ? "true" : "");
      h.getWorkspaceContext.mockResolvedValue(context(billing));
      const html = await render();
      expect(html).toContain('<form data-workspace="ws-1">');
      expect(html).not.toContain("Growth and Pro");
    }
  });
});

// P1 fix round 2: a member cannot see Settings, Plan, so they are not sent there.
describe("/posts/bulk on Starter for a member", () => {
  it("says to ask the owner, with no link to Settings, Plan", async () => {
    h.getWorkspaceContext.mockResolvedValue(context(STARTER, "member"));
    const html = await render();
    expect(html).not.toContain("<form");
    expect(html).toContain("Add many is part of the Growth and Pro plans. Ask the workspace owner about changing the plan.");
    expect(html).not.toContain("/settings#plan");
  });

  it("a member on Growth gets the form", async () => {
    h.getWorkspaceContext.mockResolvedValue(context({ ...STARTER, plan: "growth" }, "member"));
    expect(await render()).toContain('<form data-workspace="ws-1">');
  });
});
