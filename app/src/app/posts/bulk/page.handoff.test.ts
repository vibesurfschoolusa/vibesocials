import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getWorkspaceContext: vi.fn(), loadMediaHandoff: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: h.getWorkspaceContext }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("./mediaHandoff", () => ({ loadMediaHandoff: h.loadMediaHandoff }));
vi.mock("./bulk-posts-form", () => ({
  BulkPostsForm: (props: { initialMedia?: { id: string }[]; skippedMedia?: number }) =>
    createElement("form", {
      "data-media": (props.initialMedia ?? []).map((m) => m.id).join(","),
      "data-skipped": props.skippedMedia ?? 0,
    }),
}));

import BulkPostsPage from "./page";

const growth = {
  user: { id: "u1" },
  workspace: { id: "ws-1", plan: "growth", planStatus: "active", currentPeriodEnd: new Date(Date.now() + 1e9) },
  role: "owner",
};
const render = async (searchParams?: Record<string, string>) =>
  renderToStaticMarkup((await BulkPostsPage({ searchParams: Promise.resolve(searchParams ?? {}) })) as ReactElement);

beforeEach(() => {
  h.getWorkspaceContext.mockReset().mockResolvedValue(growth);
  h.loadMediaHandoff.mockReset().mockResolvedValue({ items: [], skipped: 0 });
  vi.stubEnv("BILLING_ENABLED", "true");
});

describe("/posts/bulk?media=", () => {
  it("hands the form the workspace's own items and the number skipped", async () => {
    h.loadMediaHandoff.mockResolvedValue({ items: [{ id: "a" }, { id: "b" }], skipped: 2 });
    const html = await render({ media: "a,b,foreign,unknown" });
    expect(h.loadMediaHandoff).toHaveBeenCalledWith("ws-1", "a,b,foreign,unknown");
    expect(html).toContain('data-media="a,b"');
    expect(html).toContain('data-skipped="2"');
  });

  it("reads nothing when there is no media parameter", async () => {
    await render();
    expect(h.loadMediaHandoff).not.toHaveBeenCalled();
  });
});
