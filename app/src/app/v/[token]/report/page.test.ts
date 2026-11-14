import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findActiveReviewLinkMock, viewPropsMock, buildMonthlyReportMock, findLogoMock } = vi.hoisted(() => ({
  findLogoMock: vi.fn(),
  findActiveReviewLinkMock: vi.fn(),
  viewPropsMock: vi.fn(),
  buildMonthlyReportMock: vi.fn(),
}));

vi.mock("@/lib/clientPageLogo", () => ({ findClientPageLogo: findLogoMock }));
vi.mock("@/server/reviewLink", () => ({ findActiveReviewLink: findActiveReviewLinkMock }));
// The page must never build the report itself: it reaches the client only
// through the limited route.
vi.mock("@/server/reports/monthlyReport", () => ({ buildMonthlyReport: buildMonthlyReportMock }));
// The report is fetched by a client component; what the page hands it is what matters here.
vi.mock("./client-report-view", () => ({
  ClientReportView: (props: Record<string, unknown>) => {
    viewPropsMock(props);
    return createElement("section", null, "report");
  },
}));

import { REPORT_MONTH_INVALID_MESSAGE } from "@/lib/monthlyReport";
import { REVIEW_LINK_INACTIVE_MESSAGE } from "@/lib/reviewLink";

import ClientReportPage, { metadata } from "./page";

const TOKEN = "T".repeat(43);
const LINK = { id: "link-1", workspaceId: "ws-1", workspaceName: "Surf & Co" };

async function render(token = TOKEN, searchParams: Record<string, string | string[]> = {}): Promise<string> {
  return renderToStaticMarkup(
    (await ClientReportPage({
      params: Promise.resolve({ token }),
      searchParams: Promise.resolve(searchParams),
    })) as ReactElement,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
  findActiveReviewLinkMock.mockReset();
  viewPropsMock.mockReset();
  findActiveReviewLinkMock.mockResolvedValue(LINK);
  findLogoMock.mockReset();
  findLogoMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the client's report page", () => {
  it("is not indexed and passes no referrer", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
  });

  it("shows an unknown and a revoked link identically, with only the sentence", async () => {
    findActiveReviewLinkMock.mockResolvedValue(null);
    const unknown = await render("unknown");
    const revoked = await render(TOKEN);

    expect(unknown).toBe(revoked);
    expect(unknown).toContain(REVIEW_LINK_INACTIVE_MESSAGE);
    expect(unknown).not.toContain("<section");
    expect(unknown).not.toContain('name="month"');
    expect(viewPropsMock).not.toHaveBeenCalled();
  });

  it("hands the report view only the token and the month, and shows the month list and print", async () => {
    const html = await render(TOKEN, { month: "2026-09", workspaceId: "ws-2" });

    expect(findActiveReviewLinkMock).toHaveBeenCalledWith(TOKEN);
    expect(viewPropsMock).toHaveBeenCalledWith({ token: TOKEN, month: "2026-09" });
    expect(html).toContain('name="month"');
    expect(html).toContain("Print or save as PDF");
    expect(html).toContain("Sent with Vibe Socials");
    expect(html).toContain(`href="/v/${TOKEN}"`);
    expect(html).not.toContain("ws-1");
    expect(html).not.toContain("link-1");
    expect(buildMonthlyReportMock).not.toHaveBeenCalled();
  });

  it("defaults to the last full month", async () => {
    await render();
    expect(viewPropsMock).toHaveBeenCalledWith({ token: TOKEN, month: "2026-10" });
  });

  it("refuses a month outside the list without asking for a report", async () => {
    const html = await render(TOKEN, { month: "2030-01" });
    expect(html).toContain(REPORT_MONTH_INVALID_MESSAGE);
    expect(viewPropsMock).not.toHaveBeenCalled();
  });
});
