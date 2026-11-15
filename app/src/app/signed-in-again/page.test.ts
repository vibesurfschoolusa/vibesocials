import { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentUserMock, redirectMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`);
  }),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never) };
});

import SignedInAgainPage, { metadata } from "./page";

async function render(): Promise<string> {
  return renderToStaticMarkup((await SignedInAgainPage()) as ReactElement);
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  redirectMock.mockClear();
});

// R21 GG1 follow-up: the signed-out line's link opens Log in in a new tab and
// lands here, not on a second, empty copy of the page the person was writing on.
describe("/signed-in-again", () => {
  it("signed out: sent to Log in, coming back here", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("REDIRECT /login?callbackUrl=%2Fsigned-in-again");
  });

  it("signed in: says so, tells them to close the tab, links the dashboard", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-1", email: "owner@example.com" });
    const html = await render();
    expect(html).toContain("<h1");
    expect(html).toContain("You&#x27;re signed in again</h1>");
    expect(html).toContain("Close this tab and go back to the page you were working on. It kept what you wrote.");
    expect(html).toMatch(/<a href="\/"[^>]*>[^<]+<\/a>/);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("shows no account or workspace data", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-1", email: "owner@example.com", name: "Owner" });
    const html = await render();
    expect(html).not.toContain("owner@example.com");
    expect(html).not.toContain("Owner");
  });

  it("is not for search engines", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
