import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  uploadFindFirst: vi.fn(),
  reviewFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  sendEmail: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceUploadLink: { findFirst: m.uploadFindFirst },
    workspaceReviewLink: { findFirst: m.reviewFindFirst },
    workspaceMember: { findMany: m.memberFindMany },
    user: { findUnique: m.userFindUnique },
  },
}));
vi.mock("@/server/notifications/email", () => ({ sendEmail: m.sendEmail }));
vi.mock("@/lib/logger", () => ({ logger: m.logger }));

import { buildFormerOwnerEmail, noticeOwnersOfFormerOwner } from "./formerOwnerNotice";

/**
 * R5-security L1: an owner who is demoted or leaves could copy the client
 * upload and review links, which keep working. The owners who remain are told,
 * and offered new links.
 */


beforeEach(() => {
  for (const fn of [m.uploadFindFirst, m.reviewFindFirst, m.memberFindMany, m.userFindUnique, m.sendEmail]) fn.mockReset();
  m.userFindUnique.mockResolvedValue({ name: "Sam", email: "sam@example.com" });
  for (const fn of Object.values(m.logger)) fn.mockReset();
  m.uploadFindFirst.mockResolvedValue({ id: "up-1" });
  m.reviewFindFirst.mockResolvedValue({ id: "rev-1" });
  m.memberFindMany.mockResolvedValue([{ user: { id: "user-1", email: "owner@example.com" } }]);
  m.sendEmail.mockResolvedValue(undefined);
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
});

describe("buildFormerOwnerEmail", () => {
  it("says who had the links, that they still work, and where to make new ones", () => {
    const email = buildFormerOwnerEmail({
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
      formerOwnerName: "Sam",
      uploadLink: true,
      reviewLink: true,
      appBaseUrl: "https://app.example.com",
    });
    expect(email.subject).toBe("Make new client links for Surf Co");
    expect(email.text).toContain(
      "Sam is no longer an owner of Surf Co. As an owner, Sam had access to its client upload link and client review link, and those links still work.",
    );
    expect(email.text).toContain(
      'To stop them working, open Settings, Team and press "Make new client links". It replaces both at once; send the new links to your client.',
    );
    expect(email.text).toContain("https://app.example.com/go?w=ws-1&to=%2Fsettings%23team");
    expect(email.html).toContain("https://app.example.com/go?w=ws-1&amp;to=%2Fsettings%23team");
  });

  it("names only the link that is on, and escapes names in the HTML", () => {
    const email = buildFormerOwnerEmail({
      workspaceId: "ws-1",
      workspaceName: "<Surf & Co>",
      formerOwnerName: "Sam",
      uploadLink: false,
      reviewLink: true,
      appBaseUrl: "https://app.example.com",
    });
    expect(email.text).toContain("Sam had access to its client review link, and that link still works.");
    expect(email.html).toContain("&lt;Surf &amp; Co&gt;");
    expect(email.html).not.toContain("<Surf & Co>");
  });
});

describe("noticeOwnersOfFormerOwner", () => {
  it("emails every remaining owner once and offers new links when a link is on", async () => {
    m.memberFindMany.mockResolvedValue([
      { user: { id: "user-1", email: "owner@example.com" } },
      { user: { id: "user-3", email: "third@example.com" } },
    ]);

    await expect(
      noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date("2026-11-14T10:00:00Z") }),
    ).resolves.toEqual({ clientLinksToReplace: true });

    expect(m.uploadFindFirst).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", revokedAt: null }, select: { id: true } });
    expect(m.reviewFindFirst).toHaveBeenCalledWith({ where: { workspaceId: "ws-1", revokedAt: null }, select: { id: true } });
    expect(m.userFindUnique).toHaveBeenCalledWith({ where: { id: "user-2" }, select: { name: true, email: true } });
    expect(m.memberFindMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", role: "owner", userId: { not: "user-2" } },
      select: { user: { select: { id: true, email: true } } },
    });
    expect(m.sendEmail).toHaveBeenCalledTimes(2);
    expect(m.sendEmail.mock.calls[0][0]).toMatchObject({ to: "owner@example.com", subject: "Make new client links for Surf Co" });
    expect(m.sendEmail.mock.calls[0][1]).toEqual({
      idempotencyKey: "former-owner-links/ws-1/user-2/2026-11-14T10:00:00.000Z/user-1",
    });
  });

  it("with no client link on, emails nobody and offers nothing", async () => {
    m.uploadFindFirst.mockResolvedValue(null);
    m.reviewFindFirst.mockResolvedValue(null);
    await expect(
      noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() }),
    ).resolves.toEqual({ clientLinksToReplace: false });
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  // Account deletion: the person is gone by the time the email is built.
  it("uses the name it is given without reading the person", async () => {
    await noticeOwnersOfFormerOwner({
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
      formerOwnerId: "user-2",
      formerOwnerName: "Sam Gone",
      at: new Date(),
    });
    expect(m.userFindUnique).not.toHaveBeenCalled();
    expect(m.sendEmail.mock.calls[0][0].text).toContain("Sam Gone is no longer an owner of Surf Co.");
  });

  it("uses the email address when the former owner has no name", async () => {
    m.userFindUnique.mockResolvedValue({ name: "  ", email: "sam@example.com" });
    await noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() });
    expect(m.sendEmail.mock.calls[0][0].text).toContain("sam@example.com is no longer an owner of Surf Co.");
  });

  it("never throws: a failed read or send is logged, and the change it follows stands", async () => {
    m.sendEmail.mockRejectedValue(new Error("mail down"));
    await expect(
      noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() }),
    ).resolves.toEqual({ clientLinksToReplace: true });

    m.uploadFindFirst.mockRejectedValue(new Error("db down"));
    await expect(
      noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() }),
    ).resolves.toEqual({ clientLinksToReplace: false });
    expect(m.logger.error).toHaveBeenCalled();
    // The log never carries an address.
    expect(JSON.stringify(m.logger.error.mock.calls)).not.toContain("@example.com");
  });
});
