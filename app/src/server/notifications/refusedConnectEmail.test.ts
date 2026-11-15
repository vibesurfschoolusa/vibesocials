import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  connectionFindUnique: vi.fn(),
  sendEmail: vi.fn(),
  consumeFixedWindow: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: h.workspaceFindUnique },
    workspaceMember: { findMany: h.memberFindMany },
    socialConnection: { findUnique: h.connectionFindUnique },
  },
}));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: h.consumeFixedWindow }));
vi.mock("@/server/notifications/email", () => ({ sendEmail: h.sendEmail }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { buildRefusedConnectEmail, notifyOwnersOfRefusedConnect } from "./refusedConnectEmail";

const BASE = "https://app.example.com";

/**
 * R7-client-journey L4: a client's sign-in through the connect link came back
 * with a different account than the one connected, so nothing changed. The
 * owners hear of it once per connection per day.
 */
describe("buildRefusedConnectEmail", () => {
  it("says what happened, that nothing changed, and both ways forward, linking to Settings, Connections", () => {
    const email = buildRefusedConnectEmail({
      platform: "facebook_page",
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      connectedName: "Surf Co Page",
      appBaseUrl: BASE,
    });

    expect(email.subject).toBe("Surf Co: your client signed in to a different Facebook Page account");
    expect(email.html).toContain(
      "<p>Your client used your connect link for <strong>Surf Co</strong> and signed in to a different Facebook Page account than the one connected (<strong>Surf Co Page</strong>). Nothing was changed.</p>",
    );
    expect(email.html).toContain(
      "<p>If your client should post from their own account, disconnect Surf Co Page in Settings, Connections; then they can connect theirs through the link. If Surf Co Page is the right account, it has to be signed in to: use Reconnect in Settings, Connections, or ask your client to sign in to Surf Co Page.</p>",
    );
    expect(email.html).toContain(`href="${BASE}/go?w=ws_1&amp;to=%2Fsettings%23connections"`);
  });

  it("escapes the names it shows", () => {
    const email = buildRefusedConnectEmail({
      platform: "x",
      workspaceId: "ws_1",
      workspaceName: "A <b> Co",
      connectedName: "<script>",
      appBaseUrl: null,
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<b>");
    expect(email.html).toContain("Open Settings, Connections in Vibe Socials");
  });
});

describe("notifyOwnersOfRefusedConnect", () => {
  beforeEach(() => {
    for (const mock of Object.values(h)) mock.mockReset();
    vi.stubEnv("NEXTAUTH_URL", BASE);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T22:30:00.000Z"));
    h.connectionFindUnique.mockResolvedValue({
      id: "conn-1",
      platform: "facebook_page",
      accountIdentifier: "page-1",
      metadata: { pageName: "Surf Co Page" },
      needsReconnect: true,
    });
    h.workspaceFindUnique.mockResolvedValue({ name: "Surf Co" });
    h.memberFindMany.mockResolvedValue([
      { user: { email: "owner-a@example.com" } },
      { user: { email: "owner-b@example.com" } },
    ]);
    h.consumeFixedWindow.mockResolvedValue({ allowed: true });
    h.sendEmail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("emails every owner once, keyed to the connection and the UTC day, ending at the next UTC midnight", async () => {
    await notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" });

    expect(h.connectionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId_platform: { workspaceId: "ws_1", platform: "facebook_page" } } }),
    );
    expect(h.consumeFixedWindow).toHaveBeenCalledWith({
      key: "refused-connect-email:conn-1:2026-11-14",
      limit: 1,
      resetAt: new Date("2026-11-15T00:00:00.000Z"),
      failClosed: true,
    });
    expect(h.memberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws_1", role: "owner" } }),
    );
    expect(h.sendEmail.mock.calls.map(([params]) => params.to)).toEqual(["owner-a@example.com", "owner-b@example.com"]);
    expect(h.sendEmail.mock.calls[0][0].html).toContain("Surf Co Page");
  });

  it("a second attempt the same day: no email", async () => {
    h.consumeFixedWindow.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("no such connection: nothing counted, nothing sent", async () => {
    h.connectionFindUnique.mockResolvedValue(null);
    await notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" });
    expect(h.consumeFixedWindow).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    h.sendEmail.mockRejectedValue(new Error("smtp down"));
    await expect(notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" })).resolves.toBeUndefined();
    h.connectionFindUnique.mockRejectedValue(new Error("db down"));
    await expect(notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" })).resolves.toBeUndefined();
  });
});
