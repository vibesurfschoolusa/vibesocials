import { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getWorkspaceContextMock, buildMonthlyReportMock, linkFindFirstMock, redirectMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  buildMonthlyReportMock: vi.fn(),
  linkFindFirstMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`);
  }),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/server/reports/monthlyReport", () => ({ buildMonthlyReport: buildMonthlyReportMock }));
vi.mock("@/lib/db", () => ({ prisma: { workspaceReviewLink: { findFirst: linkFindFirstMock } } }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

import { REPORT_MONTH_INVALID_MESSAGE } from "@/lib/monthlyReport";

import ReportsPage from "./page";

function context(role: "owner" | "member" = "member") {
  return { user: { id: "user-1" }, workspace: { id: "ws-1", name: "Surf Co" }, role };
}

const REPORT = {
  month: "2026-10",
  workspaceName: "Surf Co",
  logoUrl: "https://abc.public.blob.vercel-storage.com/logos/ws-1/0123456789abcdef.png",
  inProgress: false,
  postCount: 0,
  posts: [],
  totals: { resultsByPlatform: [], numbers: [] },
  listing: null,
  failed: [{ platform: "Instagram", count: 1 }],
};

async function render(searchParams: Record<string, string | string[]> = {}): Promise<string> {
  return renderToStaticMarkup(
    (await ReportsPage({ searchParams: Promise.resolve(searchParams) })) as ReactElement,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
  getWorkspaceContextMock.mockReset();
  buildMonthlyReportMock.mockReset();
  linkFindFirstMock.mockReset();
  redirectMock.mockClear();
  getWorkspaceContextMock.mockResolvedValue(context());
  buildMonthlyReportMock.mockResolvedValue(REPORT);
  linkFindFirstMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the Reports page", () => {
  it("sends a signed-out visitor to sign in and builds nothing", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("REDIRECT /login?callbackUrl=%2Freports");
    expect(buildMonthlyReportMock).not.toHaveBeenCalled();
  });

  it("shows any member the active workspace's last full month by default", async () => {
    const html = await render();
    expect(buildMonthlyReportMock).toHaveBeenCalledWith("ws-1", "2026-10", expect.any(Date));
    expect(html).toContain("Surf Co: October 2026");
    expect(html).toContain('src="https://abc.public.blob.vercel-storage.com/logos/ws-1/0123456789abcdef.png"');
    expect(html).toContain("Print or save as PDF");
    expect(html).toContain('name="month"');
    // The workspace's own page links failures to Activity.
    expect(html).toContain('href="/activity"');
  });

  it("takes the month from the address and the workspace only from the signed-in context", async () => {
    await render({ month: "2026-11", workspaceId: "ws-2", workspace: "ws-2" });
    expect(buildMonthlyReportMock).toHaveBeenCalledWith("ws-1", "2026-11", expect.any(Date));
  });

  it("refuses a month outside the list in plain words", async () => {
    const html = await render({ month: "2024-01" });
    expect(html).toContain(REPORT_MONTH_INVALID_MESSAGE);
    expect(buildMonthlyReportMock).not.toHaveBeenCalled();
  });

  it("tells an owner the client can open it, pointing at the Queue without the token", async () => {
    getWorkspaceContextMock.mockResolvedValue(context("owner"));
    linkFindFirstMock.mockResolvedValue({ id: "link-1" });
    const html = await render();
    expect(html).toContain("Your client can open this report from their link");
    expect(html).toContain('href="/queue"');
    expect(html).not.toContain("link-1");
    expect(html).not.toContain("/v/");
    expect(linkFindFirstMock.mock.calls[0][0].where).toEqual({ workspaceId: "ws-1", revokedAt: null });
  });

  it("says nothing of the client's link to a member, or when there is no link", async () => {
    linkFindFirstMock.mockResolvedValue({ id: "link-1" });
    expect(await render()).not.toContain("Your client can open");
    expect(linkFindFirstMock).not.toHaveBeenCalled();

    getWorkspaceContextMock.mockResolvedValue(context("owner"));
    linkFindFirstMock.mockResolvedValue(null);
    expect(await render()).not.toContain("Your client can open");
  });
});
