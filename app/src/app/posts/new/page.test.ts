import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// R11-client-journey L2: Create's nothing-connected state needs to know a member
// (only the owner can connect), so the page passes it.
const h = vi.hoisted(() => ({ getWorkspaceContext: vi.fn(), redirect: vi.fn(), textPostsEnabled: vi.fn(() => true) }));
vi.mock("@/lib/platformLimits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platformLimits")>()),
  textPostsEnabled: h.textPostsEnabled,
}));
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

// R58 publishing-flow-2 L2: text-only posts are on, Create can reuse a Media
// item, and the person picks the platforms.
describe("/posts/new's intro says what Create does", () => {
  it("text posts on: a file or just text, to the platforms chosen", async () => {
    h.textPostsEnabled.mockReturnValue(true);
    h.getWorkspaceContext.mockResolvedValue(context("owner"));
    const html = await render();
    expect(html).toContain("Add a photo or video, or just write, then post to the platforms you choose.");
    expect(html).not.toContain("your connected platforms");
  });

  it("text posts off: a file is needed", async () => {
    h.textPostsEnabled.mockReturnValue(false);
    h.getWorkspaceContext.mockResolvedValue(context("owner"));
    const html = await render();
    expect(html).toContain("Add a photo or video, then post to the platforms you choose.");
    expect(html).not.toContain("just write");
  });
});
