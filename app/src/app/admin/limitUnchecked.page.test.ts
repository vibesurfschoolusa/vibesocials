import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R38 lead review: the two operator pages count a load with
 * checkAdminRateLimit. A counter store that couldn't answer is "couldn't
 * check", not a used-up hour.
 */

const h = vi.hoisted(() => ({ getOperator: vi.fn(), checkAdminRateLimit: vi.fn(), list: vi.fn(), detail: vi.fn() }));
vi.mock("@/lib/operator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operator")>()),
  getOperator: h.getOperator,
  checkAdminRateLimit: h.checkAdminRateLimit,
}));
vi.mock("@/server/admin/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/admin/queries")>()),
  listAdminWorkspaces: h.list,
  getAdminWorkspaceDetail: h.detail,
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { LIMIT_UNCHECKED_MESSAGE } from "@/lib/limitUnchecked";

import AdminPage from "./page";
import AdminWorkspacePage from "./workspaces/[id]/page";

// R43 pages-a L7: the limit's own wait, against a fixed clock hour.
const LIMITED_TEXT = "Too many tries. Wait";

const pages = [
  ["the workspace list", () => AdminPage({ searchParams: Promise.resolve({}) })],
  ["one workspace", () => AdminWorkspacePage({ params: Promise.resolve({ id: "ws-1" }) })],
] as const;

beforeEach(() => {
  h.getOperator.mockResolvedValue({ userId: "op-1", email: "ops@example.com" });
  h.list.mockReset();
  h.detail.mockReset();
});

describe("operator pages and their hourly counter", () => {
  it.each(pages)("%s: a store that couldn't answer says couldn't check, and reads nothing", async (_name, load) => {
    h.checkAdminRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60, unavailable: true });
    const html = renderToStaticMarkup((await load()) as ReactElement);
    expect(html).toContain(LIMIT_UNCHECKED_MESSAGE.replace(/'/g, "&#x27;"));
    expect(html).not.toContain(LIMITED_TEXT);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.detail).not.toHaveBeenCalled();
  });

  it.each(pages)("%s: a used-up hour says the real wait", async (_name, load) => {
    h.checkAdminRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 40 * 60 });
    const html = renderToStaticMarkup((await load()) as ReactElement);
    expect(html).toContain("Too many tries. Wait 40 minutes, then reload.");
    expect(html).not.toContain("a few minutes");
  });
});

// R67: the search is cut in whole graphemes, never half an emoji.
describe("the workspace list's search", () => {
  it("keeps an emoji at the 100th place whole", async () => {
    h.checkAdminRateLimit.mockResolvedValue({ allowed: true });
    h.list.mockResolvedValue({ rows: [], hasNextPage: false });
    await AdminPage({ searchParams: Promise.resolve({ q: `${"a".repeat(99)}🌊 more` }) });
    expect(h.list.mock.calls[0][0].search).toBe(`${"a".repeat(99)}🌊`);
  });
});
