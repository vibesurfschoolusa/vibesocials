import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => ({ id: "u1" })) }));
vi.mock("@/components/dashboard/dashboard-home", () => ({ DashboardHome: () => null }));
vi.mock("@/components/landing", () => ({ Landing: () => null }));
vi.mock("@/components/server-signed-out-sync", () => ({ ServerSignedOutSync: () => null }));
vi.mock("@/lib/trialOffer", () => ({ startingPrice: vi.fn(async () => null) }));

const m = vi.hoisted(() => ({
  context: null as null | { role: "owner" | "member"; workspace: Record<string, unknown> },
  contextError: null as Error | null,
  findUnique: vi.fn(),
}));
vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: vi.fn(async () => {
    if (m.contextError) throw m.contextError;
    return m.context;
  }),
}));
vi.mock("@/lib/db", () => ({ prisma: { workspace: { findUnique: m.findUnique } } }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { getCurrentUser } from "@/lib/auth";

import { Landing } from "@/components/landing";
import { ServerSignedOutSync } from "@/components/server-signed-out-sync";

import HomePage from "./page";

const WORKSPACE = {
  id: "ws1",
  companyWebsite: "https://example.com",
  defaultHashtags: null,
  brandVoice: null,
  brandVoiceExamples: null,
};

afterEach(() => {
  vi.unstubAllEnvs();
  m.context = null;
  m.contextError = null;
  m.findUnique.mockReset();
});

type Setup = { role: string; footerSet: boolean; brandVoiceSet: boolean; hasClientLink: boolean } | null;
const setupOf = async () => ((await HomePage()) as { props: { setup: Setup } }).props.setup;

// S2: the Get started steps read the footer and brand voice of the active
// workspace here, on the server, as booleans.
describe("HomePage — the workspace setup the dashboard gets", () => {
  it("an owner: which settings are set, and whether a client link is on", async () => {
    m.context = { role: "owner", workspace: WORKSPACE };
    m.findUnique.mockResolvedValue({ _count: { uploadLinks: 0, reviewLinks: 1, connectLinks: 0 } });
    expect(await setupOf()).toEqual({ role: "owner", footerSet: true, brandVoiceSet: false, hasClientLink: true });
    expect(m.findUnique).toHaveBeenCalledWith({
      where: { id: "ws1" },
      select: {
        _count: {
          select: {
            uploadLinks: { where: { revokedAt: null } },
            reviewLinks: { where: { revokedAt: null } },
            connectLinks: { where: { revokedAt: null, expiresAt: { gt: expect.any(Date) } } },
          },
        },
      },
    });
  });

  // Fix round 1: only active links count, the rule each link's own page uses
  // (a connect link also expires; upload and review links do not).
  it("an expired connect link that was never revoked does not count", async () => {
    const now = new Date("2026-11-12T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      m.context = { role: "owner", workspace: WORKSPACE };
      const links = [{ revokedAt: null, expiresAt: new Date(now.getTime() - 60_000) }];
      type Filter = { where: { revokedAt: null; expiresAt?: { gt: Date } } };
      m.findUnique.mockImplementation(async (args: { select: { _count: { select: Record<string, Filter> } } }) => {
        const where = args.select._count.select.connectLinks.where;
        const active = links.filter(
          (link) => link.revokedAt === null && (!where.expiresAt || link.expiresAt > where.expiresAt.gt),
        );
        return { _count: { uploadLinks: 0, reviewLinks: 0, connectLinks: active.length } };
      });
      expect((await setupOf())?.hasClientLink).toBe(false);

      links[0].expiresAt = new Date(now.getTime() + 60_000);
      expect((await setupOf())?.hasClientLink).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an owner with no link on", async () => {
    m.context = { role: "owner", workspace: WORKSPACE };
    m.findUnique.mockResolvedValue({ _count: { uploadLinks: 0, reviewLinks: 0, connectLinks: 0 } });
    expect((await setupOf())?.hasClientLink).toBe(false);
  });

  it("a member: no link query", async () => {
    m.context = { role: "member", workspace: WORKSPACE };
    expect(await setupOf()).toEqual({ role: "member", footerSet: true, brandVoiceSet: false, hasClientLink: false });
    expect(m.findUnique).not.toHaveBeenCalled();
  });

  it("a failed read leaves the setup unknown, so the block stays hidden", async () => {
    m.contextError = new Error("db down");
    expect(await setupOf()).toBeNull();
    m.contextError = null;
    m.context = { role: "owner", workspace: WORKSPACE };
    m.findUnique.mockRejectedValue(new Error("db down"));
    expect(await setupOf()).toBeNull();
  });
});

// Go-live check 2026-11-11: the dashboard gets the platforms this site offers,
// so its YouTube card names Pinterest only where Pinterest is configured.
describe("HomePage — signed in", () => {
  it("passes the site's platforms without Pinterest when it is not configured", async () => {
    vi.stubEnv("PINTEREST_APP_ID", "");
    const element = (await HomePage()) as { props: { availablePlatforms: string[] } };
    expect(element.props.availablePlatforms).not.toContain("pinterest");
    expect(element.props.availablePlatforms).toContain("instagram");
  });

  it("includes Pinterest when its app is configured", async () => {
    vi.stubEnv("PINTEREST_APP_ID", "app");
    vi.stubEnv("PINTEREST_APP_SECRET", "test-secret");
    vi.stubEnv("PINTEREST_REDIRECT_URI", "https://example.test/callback");
    const element = (await HomePage()) as { props: { availablePlatforms: string[] } };
    expect(element.props.availablePlatforms).toContain("pinterest");
  });
});

// R2-client-journey L2: /go sends a person who is not a member of the link's
// workspace here with ?notice=other-workspace; the page names the signed-in
// account (from the session, never from the address) and no workspace.
describe("HomePage — the other-workspace notice from /go", () => {
  const noticeOf = async (query: Record<string, string>) =>
    ((await HomePage({ searchParams: Promise.resolve(query) })) as { props: { notice?: string | null } }).props.notice;

  it("names the signed-in account and says what to do", async () => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce({ id: "u1", email: "owner@example.com" } as never);
    expect(await noticeOf({ notice: "other-workspace" })).toBe(
      "That link is for another workspace. You are signed in as owner@example.com; sign in with the account that belongs to it.",
    );
  });

  it("no notice without the parameter or with an unknown one", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u1", email: "owner@example.com" } as never);
    expect(await noticeOf({})).toBeNull();
    expect(await noticeOf({ notice: "something-else" })).toBeNull();
  });
});

// R19 new-customer L1: the server rendered the Landing (nobody signed in), so a
// tab whose cached session still names someone reads it again and follows.
describe("HomePage — signed out", () => {
  it("renders the Landing with the client sync beside it", async () => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce(null);
    const page = (await HomePage()) as { props: { children: Array<{ type: unknown }> } };
    expect(page.props.children.map((child) => child.type)).toEqual([Landing, ServerSignedOutSync]);
  });
});
