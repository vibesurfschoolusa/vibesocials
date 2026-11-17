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

const LIMITED_TEXT = "Too many admin page loads this hour. Wait a few minutes and reload.";

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

  it.each(pages)("%s: a used-up hour still says so", async (_name, load) => {
    h.checkAdminRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 600 });
    const html = renderToStaticMarkup((await load()) as ReactElement);
    expect(html).toContain(LIMITED_TEXT);
  });
});
