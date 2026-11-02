import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest hoists vi.mock above imports. The DB and the transport are mocked;
// the email BUILDER stays real so the assertions see the actual subject/body.
const { memberFindManyMock, sendEmailMock } = vi.hoisted(() => ({
  memberFindManyMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { workspaceMember: { findMany: memberFindManyMock } },
}));
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));

import { notifyOwnersOfApprovalRequest } from "./approvalRequested";

const PARAMS = {
  workspaceId: "ws-1",
  workspaceName: "Acme",
  submitter: { id: "member-1", name: "Sam", email: "sam@example.com" },
  caption: "Sunset session this Friday",
  platformCaptions: null,
};

const ORIGINAL_NEXTAUTH_URL = process.env.NEXTAUTH_URL;

beforeEach(() => {
  memberFindManyMock.mockReset();
  sendEmailMock.mockReset();
  memberFindManyMock.mockResolvedValue([
    { user: { email: "owner1@example.com" } },
    { user: { email: "owner2@example.com" } },
  ]);
  sendEmailMock.mockResolvedValue(undefined);
  process.env.NEXTAUTH_URL = "https://vibesocials.wtf";
});

afterEach(() => {
  if (ORIGINAL_NEXTAUTH_URL === undefined) delete process.env.NEXTAUTH_URL;
  else process.env.NEXTAUTH_URL = ORIGINAL_NEXTAUTH_URL;
});

describe("notifyOwnersOfApprovalRequest", () => {
  it("looks up the workspace's OWNERS only, never the submitter", async () => {
    await notifyOwnersOfApprovalRequest(PARAMS);

    expect(memberFindManyMock).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner", userId: { not: "member-1" } },
      select: { user: { select: { email: true } } },
    });
  });

  it("emails every owner the approval-requested email", async () => {
    await notifyOwnersOfApprovalRequest(PARAMS);

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock.mock.calls.map((call) => call[0].to)).toEqual([
      "owner1@example.com",
      "owner2@example.com",
    ]);
    const sent = sendEmailMock.mock.calls[0][0];
    expect(sent.subject).toBe("A post needs your approval in Acme");
    expect(sent.html).toContain("Sam");
    expect(sent.html).toContain("Sunset session this Friday");
    expect(sent.html).toContain("https://vibesocials.wtf/queue");
  });

  it("puts the per-platform captions in the email body, HTML-escaped (2026-11-01 audit, M1)", async () => {
    await notifyOwnersOfApprovalRequest({
      ...PARAMS,
      platformCaptions: { linkedin: "Hidden <b>text</b>" },
    });

    const sent = sendEmailMock.mock.calls[0][0];
    expect(sent.html).toContain("Platform-specific captions");
    expect(sent.html).toContain("LinkedIn");
    expect(sent.html).toContain("Hidden &lt;b&gt;text&lt;/b&gt;");
    expect(sent.html).not.toContain("<b>text</b>");
  });

  it("adds no per-platform section when the post has none", async () => {
    await notifyOwnersOfApprovalRequest(PARAMS);

    expect(sendEmailMock.mock.calls[0][0].html).not.toContain("Platform-specific captions");
  });

  it("names the submitter by their email local-part when they have no display name", async () => {
    await notifyOwnersOfApprovalRequest({
      ...PARAMS,
      submitter: { id: "member-1", name: null, email: "sam.lee@example.com" },
    });

    const sent = sendEmailMock.mock.calls[0][0];
    expect(sent.html).toContain("sam.lee");
    expect(sent.html).not.toContain("sam.lee@example.com");
  });

  it("renders without a link when NEXTAUTH_URL isn't configured", async () => {
    delete process.env.NEXTAUTH_URL;

    await notifyOwnersOfApprovalRequest(PARAMS);

    expect(sendEmailMock.mock.calls[0][0].html).not.toContain("<a ");
  });

  it("sends nothing when the workspace has no other owner", async () => {
    memberFindManyMock.mockResolvedValue([]);

    await notifyOwnersOfApprovalRequest(PARAMS);

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("never throws — a lookup failure must not fail the submitter's request", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    memberFindManyMock.mockRejectedValue(new Error("db down"));

    await expect(notifyOwnersOfApprovalRequest(PARAMS)).resolves.toBeUndefined();

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
