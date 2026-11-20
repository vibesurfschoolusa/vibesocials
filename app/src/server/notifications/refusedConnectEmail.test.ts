import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  connectionFindUnique: vi.fn(),
  sendEmail: vi.fn(),
  consumeFixedWindow: vi.fn(),
  releaseKey: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: h.workspaceFindUnique },
    workspaceMember: { findMany: h.memberFindMany },
    socialConnection: { findUnique: h.connectionFindUnique },
    rateLimitEntry: { deleteMany: h.releaseKey },
  },
}));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: h.consumeFixedWindow }));
vi.mock("@/server/notifications/email", () => ({ sendEmail: h.sendEmail }));
vi.mock("@/server/notifications/onceADay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/notifications/onceADay")>();
  return { ...actual, sendOncePer: vi.fn(actual.sendOncePer) };
});
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sendOncePer } from "./onceADay";
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
      platform: "youtube",
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      connectedName: "Surf Co channel",
      appBaseUrl: BASE,
    });

    expect(email.subject).toBe("Surf Co: your client signed in to a different YouTube account");
    expect(email.html).toContain(
      "<p>Your client used your connect link for <strong>Surf Co</strong> and signed in to a different YouTube account than the one connected (<strong>Surf Co channel</strong>). Nothing was changed.</p>",
    );
    expect(email.html).toContain(
      "<p>If your client should post from their own account, disconnect Surf Co channel in Settings, Connections; then they can connect theirs through the link. If Surf Co channel is the right account, it has to be signed in to: use Reconnect in Settings, Connections, or ask your client to sign in to Surf Co channel.</p>",
    );
    expect(email.html).toContain(`href="${BASE}/go?w=ws_1&amp;to=%2Fsettings%23connections"`);
  });

  // R8-client-journey L2 / pages L1: a page is not signed in to; an account that manages it is.
  it.each([
    ["linkedin", "LinkedIn"],
    ["facebook_page", "Facebook"],
  ] as const)("%s: a page, managed by an account", (platform, account) => {
    const email = buildRefusedConnectEmail({
      platform,
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      connectedName: "Surf Co Page",
      appBaseUrl: BASE,
    });

    expect(email.subject).toBe(`Surf Co: your client signed in to ${account} for a different page`);
    expect(email.html).toContain(
      `<p>Your client used your connect link for <strong>Surf Co</strong> and signed in with a ${account} account for a different page than the one connected (<strong>Surf Co Page</strong>). Nothing was changed.</p>`,
    );
    expect(email.html).toContain(
      `<p>If your client should post to their own page, disconnect Surf Co Page in Settings, Connections; then they can connect theirs through the link. If Surf Co Page is the right page, use Reconnect in Settings, Connections, or ask your client to sign in with a ${account} account that manages Surf Co Page.</p>`,
    );
    expect(email.html).not.toContain("sign in to Surf Co Page");
  });

  // R51 pages-a L2: Instagram connects through Meta's Facebook login, from the
  // Page linked to the account; the email says what Settings says.
  it("instagram: the Facebook sign-in didn't return the Page linked to it", () => {
    const email = buildRefusedConnectEmail({
      platform: "instagram",
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      connectedName: "@surfschool",
      appBaseUrl: BASE,
    });

    expect(email.subject).toBe("Surf Co: your client's Facebook sign-in didn't return the connected Instagram account");
    expect(email.html).toContain(
      "<p>Your client used your connect link for <strong>Surf Co</strong> to reconnect Instagram, but Facebook didn&#39;t return the Page linked to @surfschool. Nothing was changed.</p>",
    );
    expect(email.html).toContain(
      "<p>If your client should post from their own account, disconnect @surfschool in Settings, Connections; then they can connect theirs through the link. If @surfschool is the right account, use Reconnect in Settings, Connections, or ask your client to sign in with a Facebook account that manages the Page linked to @surfschool, and tick that Page when Facebook lists the Pages.</p>",
    );
    expect(email.html).not.toMatch(/signed in to a different Instagram account|sign in to @surfschool|has to be signed in to/);
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
      { user: { id: "owner-a", email: "owner-a@example.com" } },
      { user: { id: "owner-b", email: "owner-b@example.com" } },
    ]);
    h.consumeFixedWindow.mockResolvedValue({ allowed: true });
    h.sendEmail.mockResolvedValue(true);
    h.releaseKey.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // R40 lead: the UTC day's key can first be used when the day begins.
  it("claims the UTC day with its start as keysFrom", async () => {
    await notifyOwnersOfRefusedConnect({ workspaceId: "ws-1", platform: "facebook_page" });
    expect(vi.mocked(sendOncePer).mock.calls.at(-1)![0]).toMatchObject({
      resetAt: new Date("2026-11-15T00:00:00.000Z"),
      keysFrom: new Date("2026-11-14T00:00:00.000Z"),
    });
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

  it("LinkedIn without the page's name: the connected LinkedIn page, never the profile id", async () => {
    h.connectionFindUnique.mockResolvedValue({
      id: "conn-2",
      platform: "linkedin",
      accountIdentifier: "aB3xYz9q",
      metadata: { username: null },
      needsReconnect: false,
    });
    await notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "linkedin" });
    const html = h.sendEmail.mock.calls[0][0].html as string;
    expect(html).toContain("the connected LinkedIn page");
    expect(html).not.toContain("aB3xYz9q");
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

  // R38 client-journey L2: the day's one email is let go unless one went, so a later try can still tell them.
  it("an email went: the day's claim is kept", async () => {
    await notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" });
    expect(h.releaseKey).not.toHaveBeenCalled();
  });

  it("the workspace or owners can't be read: the day's claim is let go", async () => {
    h.memberFindMany.mockRejectedValue(new Error("db blip"));
    await expect(notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" })).resolves.toBeUndefined();
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.releaseKey).toHaveBeenCalledWith({ where: { key: "refused-connect-email:conn-1:2026-11-14" } });
  });

  it("no send went out: the day's claim is let go", async () => {
    h.sendEmail.mockResolvedValue(false);
    await notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" });
    expect(h.sendEmail).toHaveBeenCalledTimes(2);
    expect(h.releaseKey).toHaveBeenCalledWith({ where: { key: "refused-connect-email:conn-1:2026-11-14" } });
  });

  it("one owner's send went out: the claim is kept", async () => {
    h.sendEmail.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" });
    expect(h.releaseKey).not.toHaveBeenCalled();
  });

  // R38 lead review: a reply lost after Resend took the email can't become a second copy that day.
  it("sends with a per-owner, per-day idempotency key and asks for retryable failures to throw", async () => {
    await notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" });
    expect(h.sendEmail.mock.calls.map(([, options]) => options)).toEqual([
      { label: "refused-connect", idempotencyKey: "refused-connect/conn-1/2026-11-14/owner-a", throwOnRetryable: true },
      { label: "refused-connect", idempotencyKey: "refused-connect/conn-1/2026-11-14/owner-b", throwOnRetryable: true },
    ]);
    expect(h.releaseKey).not.toHaveBeenCalled();
  });

  it("a lost reply lets the day go, and the next try the same day reuses the same keys", async () => {
    h.sendEmail.mockRejectedValueOnce(new Error("Resend request failed before a response (network error)"));
    await expect(notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" })).resolves.toBeUndefined();
    expect(h.releaseKey).toHaveBeenCalledWith({ where: { key: "refused-connect-email:conn-1:2026-11-14" } });

    h.releaseKey.mockClear();
    vi.setSystemTime(new Date("2026-11-14T23:10:00.000Z"));
    await notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" });
    const keys = h.sendEmail.mock.calls.map(([, options]) => options.idempotencyKey);
    expect(keys).toEqual([
      "refused-connect/conn-1/2026-11-14/owner-a",
      "refused-connect/conn-1/2026-11-14/owner-b",
      "refused-connect/conn-1/2026-11-14/owner-a",
      "refused-connect/conn-1/2026-11-14/owner-b",
    ]);
    expect(h.releaseKey).not.toHaveBeenCalled();
  });

  // R39 client-journey L3: one owner's retryable failure never stops the email to the others.
  it("the first owner fails retryably: the second is still sent and the day is let go", async () => {
    h.sendEmail.mockRejectedValueOnce(new Error("Resend rate limited the send")).mockResolvedValueOnce(true);
    await expect(notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" })).resolves.toBeUndefined();
    expect(h.sendEmail.mock.calls.map(([params]) => params.to)).toEqual(["owner-a@example.com", "owner-b@example.com"]);
    expect(h.releaseKey).toHaveBeenCalledWith({ where: { key: "refused-connect-email:conn-1:2026-11-14" } });
  });

  // R39 lead review L3: the day's window is inside the keys' 24 hours, so a store blip sends with them.
  it("a counter store that can't answer: each owner is sent once, with their key", async () => {
    h.consumeFixedWindow.mockResolvedValue({ allowed: false, retryAfterSeconds: 60, unavailable: true });
    await notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" });
    expect(h.sendEmail.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual([
      "refused-connect/conn-1/2026-11-14/owner-a",
      "refused-connect/conn-1/2026-11-14/owner-b",
    ]);
    expect(h.releaseKey).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    h.sendEmail.mockRejectedValue(new Error("smtp down"));
    await expect(notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" })).resolves.toBeUndefined();
    h.connectionFindUnique.mockRejectedValue(new Error("db down"));
    await expect(notifyOwnersOfRefusedConnect({ workspaceId: "ws_1", platform: "facebook_page" })).resolves.toBeUndefined();
  });
});
