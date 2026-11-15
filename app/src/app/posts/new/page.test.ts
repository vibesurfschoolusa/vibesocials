import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// R11-client-journey L2: Create's nothing-connected state needs to know a member
// (only the owner can connect), so the page passes it.
const h = vi.hoisted(() => ({ getWorkspaceContext: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: h.getWorkspaceContext }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@/components/create-post-form", () => ({
  CreatePostForm: ({ isMember }: { isMember?: boolean }) =>
    createElement("form", isMember ? { "data-member": "yes" } : {}),
}));

import NewPostPage from "./page";

const context = (role: "owner" | "member") => ({
  user: { id: "user-1" },
  workspace: { id: "ws-1", companyWebsite: null, defaultHashtags: null, trackWebsiteLinks: false, requireApproval: false },
  role,
});
const render = async () => renderToStaticMarkup((await NewPostPage()) as ReactElement);

beforeEach(() => h.getWorkspaceContext.mockReset());

describe("/posts/new passes the viewer's role to the form", () => {
  it("a member", async () => {
    h.getWorkspaceContext.mockResolvedValue(context("member"));
    expect(await render()).toContain('<form data-member="yes">');
  });

  it("an owner", async () => {
    h.getWorkspaceContext.mockResolvedValue(context("owner"));
    expect(await render()).toContain("<form></form>");
  });
});
