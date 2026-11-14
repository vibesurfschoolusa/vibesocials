import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { workspaceFindUniqueMock, memberFindManyMock, sendEmailMock, connectionFindUniqueMock } = vi.hoisted(() => ({
  workspaceFindUniqueMock: vi.fn(),
  connectionFindUniqueMock: vi.fn(),
  memberFindManyMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: workspaceFindUniqueMock },
    workspaceMember: { findMany: memberFindManyMock },
    socialConnection: { findUnique: connectionFindUniqueMock },
  },
}));
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { buildClientConnectEmail, notifyOwnersOfClientConnect } from "./clientConnectEmail";

const BASE = "https://vibesocials.wtf";

describe("buildClientConnectEmail", () => {
  it("names the platform and the workspace, and links to Settings, Connections through /go", () => {
    const email = buildClientConnectEmail({
      platform: "instagram",
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      appBaseUrl: BASE,
    });

    expect(email.subject).toBe("Surf Co: your client connected Instagram");
    expect(email.html).toContain(
      "<p>Your client connected <strong>Instagram</strong> to <strong>Surf Co</strong> through your connect link. Posts in Surf Co can go to Instagram now.</p>",
    );
    expect(email.html).toContain(`href="${BASE}/go?w=ws_1&amp;to=%2Fsettings%23connections"`);
    expect(email.html).not.toContain("business location");
  });

  it("for Google Business Profile with no location chosen, says to choose the business location first", () => {
    const email = buildClientConnectEmail({
      platform: "google_business_profile",
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      appBaseUrl: BASE,
      locationChosen: false,
    });

    expect(email.subject).toBe("Surf Co: your client connected Google Business Profile");
    expect(email.html).toContain(
      "<p>Before posts can go to Google, choose the business location: open Settings, Connections and pick it under Google Business Profile. Until then, posts to Google fail.</p>",
    );
    expect(email.html).not.toContain("can go to Google Business Profile now");
  });

  // R2-pages L6: a reconnect keeps the chosen location, so nothing is left to do.
  it("for Google Business Profile with a location already chosen, says posts can go out", () => {
    const email = buildClientConnectEmail({
      platform: "google_business_profile",
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      appBaseUrl: BASE,
      locationChosen: true,
    });
    expect(email.html).not.toContain("business location");
    expect(email.html).toContain("Posts in Surf Co can go to Google Business Profile now.");
  });

  it("has no link without a base URL, and escapes the workspace name", () => {
    const email = buildClientConnectEmail({
      platform: "x",
      workspaceId: "ws_1",
      workspaceName: "<b>Surf</b>",
      appBaseUrl: null,
    });
    expect(email.html).not.toContain("<a ");
    expect(email.html).not.toContain("<b>Surf");
    expect(email.html).toContain("Open Settings, Connections in Vibe Socials to see it.");
  });
});

describe("notifyOwnersOfClientConnect", () => {
  beforeEach(() => {
    workspaceFindUniqueMock.mockReset();
    memberFindManyMock.mockReset();
    sendEmailMock.mockReset();
    workspaceFindUniqueMock.mockResolvedValue({ name: "Surf Co" });
    memberFindManyMock.mockResolvedValue([
      { user: { id: "owner-1", email: "a@example.com" } },
      { user: { id: "owner-2", email: "b@example.com" } },
    ]);
    sendEmailMock.mockResolvedValue(undefined);
    connectionFindUniqueMock.mockReset();
    connectionFindUniqueMock.mockResolvedValue(null);
    vi.stubEnv("NEXTAUTH_URL", BASE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emails every owner of the workspace once", async () => {
    await notifyOwnersOfClientConnect({ workspaceId: "ws-1", platform: "tiktok" });

    expect(workspaceFindUniqueMock).toHaveBeenCalledWith({ where: { id: "ws-1" }, select: { name: true } });
    expect(memberFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner" },
      select: { user: { select: { id: true, email: true } } },
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock.mock.calls.map((call) => call[0].to)).toEqual(["a@example.com", "b@example.com"]);
    expect(sendEmailMock.mock.calls[0][0].subject).toBe("Surf Co: your client connected TikTok");
  });

  it("never throws when a lookup or a send fails", async () => {
    sendEmailMock.mockRejectedValue(new Error("resend down"));
    await expect(notifyOwnersOfClientConnect({ workspaceId: "ws-1", platform: "tiktok" })).resolves.toBeUndefined();

    workspaceFindUniqueMock.mockRejectedValue(new Error("db down"));
    await expect(notifyOwnersOfClientConnect({ workspaceId: "ws-1", platform: "tiktok" })).resolves.toBeUndefined();
  });

  it("reads the Google connection's chosen location: none -> the email asks for one", async () => {
    connectionFindUniqueMock.mockResolvedValue({ metadata: { locationName: null } });
    await notifyOwnersOfClientConnect({ workspaceId: "ws-1", platform: "google_business_profile" });
    expect(connectionFindUniqueMock).toHaveBeenCalledWith({
      where: { workspaceId_platform: { workspaceId: "ws-1", platform: "google_business_profile" } },
      select: { metadata: true },
    });
    expect(sendEmailMock.mock.calls[0][0].html).toContain("choose the business location");
  });

  it("reads the Google connection's chosen location: kept on a reconnect -> no ask", async () => {
    connectionFindUniqueMock.mockResolvedValue({ metadata: { locationName: "locations/123" } });
    await notifyOwnersOfClientConnect({ workspaceId: "ws-1", platform: "google_business_profile" });
    expect(sendEmailMock.mock.calls[0][0].html).not.toContain("business location");
  });

  it("does not read the connection for other platforms", async () => {
    await notifyOwnersOfClientConnect({ workspaceId: "ws-1", platform: "tiktok" });
    expect(connectionFindUniqueMock).not.toHaveBeenCalled();
  });

  it("sends nothing for a workspace that is gone", async () => {
    workspaceFindUniqueMock.mockResolvedValue(null);
    await notifyOwnersOfClientConnect({ workspaceId: "ws-1", platform: "tiktok" });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
