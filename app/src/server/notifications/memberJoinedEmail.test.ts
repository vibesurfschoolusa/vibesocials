import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { workspaceFindUniqueMock, memberFindManyMock, sendEmailMock } = vi.hoisted(() => ({
  workspaceFindUniqueMock: vi.fn(),
  memberFindManyMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: workspaceFindUniqueMock },
    workspaceMember: { findMany: memberFindManyMock },
  },
}));
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { buildMemberJoinedEmail, notifyOwnersOfMemberJoined } from "./memberJoinedEmail";

const BASE = "https://vibesocials.wtf";

// R2-client-journey L3: owners hear when someone joins through the invite link.
describe("buildMemberJoinedEmail", () => {
  it("names the new member, their email and the workspace, and links to Team through /go", () => {
    const email = buildMemberJoinedEmail({
      memberName: "Sam Rivera",
      memberEmail: "sam@example.com",
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      appBaseUrl: BASE,
    });

    expect(email.subject).toBe("Surf Co: Sam Rivera joined through your invite link");
    expect(email.html).toContain(
      "<p><strong>Sam Rivera</strong> (sam@example.com) joined <strong>Surf Co</strong> as a member through your invite link.</p>",
    );
    expect(email.html).toContain(
      "<p>If you don't know them, remove them in Settings, Team. To stop more people joining, revoke the invite link there.</p>",
    );
    expect(email.html).toContain(`href="${BASE}/go?w=ws_1&amp;to=%2Fsettings%23team"`);
  });

  it("uses the email when the person has no name", () => {
    const email = buildMemberJoinedEmail({
      memberName: null,
      memberEmail: "sam@example.com",
      workspaceId: "ws_1",
      workspaceName: "Surf Co",
      appBaseUrl: BASE,
    });
    expect(email.subject).toBe("Surf Co: sam@example.com joined through your invite link");
    expect(email.html).toContain("<p><strong>sam@example.com</strong> joined <strong>Surf Co</strong>");
  });

  it("escapes names, keeps line breaks out of the subject, and has no link without a base URL", () => {
    const email = buildMemberJoinedEmail({
      memberName: "<b>Sam</b>\r\nBcc: x",
      memberEmail: "sam@example.com",
      workspaceId: "ws_1",
      workspaceName: "Surf\nCo",
      appBaseUrl: null,
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html).not.toContain("<b>Sam");
    expect(email.html).not.toContain("<a ");
    expect(email.html).toContain("Settings, Team");
  });
});

describe("notifyOwnersOfMemberJoined", () => {
  beforeEach(() => {
    workspaceFindUniqueMock.mockReset();
    memberFindManyMock.mockReset();
    sendEmailMock.mockReset();
    workspaceFindUniqueMock.mockResolvedValue({ name: "Surf Co" });
    memberFindManyMock.mockResolvedValue([
      { user: { email: "a@example.com" } },
      { user: { email: "b@example.com" } },
    ]);
    sendEmailMock.mockResolvedValue(undefined);
    vi.stubEnv("NEXTAUTH_URL", BASE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emails every owner of the workspace once", async () => {
    await notifyOwnersOfMemberJoined({
      workspaceId: "ws-1",
      member: { name: "Sam", email: "sam@example.com" },
    });

    expect(memberFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner" },
      select: { user: { select: { email: true } } },
    });
    expect(sendEmailMock.mock.calls.map((call) => call[0].to)).toEqual(["a@example.com", "b@example.com"]);
    expect(sendEmailMock.mock.calls[0][0].subject).toBe("Surf Co: Sam joined through your invite link");
  });

  it("never throws when a lookup or a send fails", async () => {
    sendEmailMock.mockRejectedValue(new Error("resend down"));
    await expect(
      notifyOwnersOfMemberJoined({ workspaceId: "ws-1", member: { name: null, email: "sam@example.com" } }),
    ).resolves.toBeUndefined();

    workspaceFindUniqueMock.mockRejectedValue(new Error("db down"));
    await expect(
      notifyOwnersOfMemberJoined({ workspaceId: "ws-1", member: { name: null, email: "sam@example.com" } }),
    ).resolves.toBeUndefined();
  });

  it("sends nothing for a workspace that is gone", async () => {
    workspaceFindUniqueMock.mockResolvedValue(null);
    await notifyOwnersOfMemberJoined({ workspaceId: "ws-1", member: { name: null, email: "sam@example.com" } });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
