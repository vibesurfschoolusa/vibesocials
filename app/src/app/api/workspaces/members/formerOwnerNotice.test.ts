import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  uploadFindFirst: vi.fn(),
  reviewFindFirst: vi.fn(),
  connectFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  memberFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  sendEmail: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceUploadLink: { findFirst: m.uploadFindFirst },
    workspaceReviewLink: { findFirst: m.reviewFindFirst },
    workspaceConnectLink: { findFirst: m.connectFindFirst },
    workspaceMember: { findMany: m.memberFindMany, findFirst: m.memberFindFirst },
    user: { findUnique: m.userFindUnique },
    workspace: { findUnique: m.workspaceFindUnique },
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
  for (const fn of [m.uploadFindFirst, m.reviewFindFirst, m.connectFindFirst, m.memberFindMany, m.memberFindFirst, m.userFindUnique, m.workspaceFindUnique, m.sendEmail]) fn.mockReset();
  m.workspaceFindUnique.mockResolvedValue({ id: "ws-1", billingExempt: false, plan: "growth", planStatus: "active" });
  m.userFindUnique.mockResolvedValue({ name: "Sam", email: "sam@example.com" });
  for (const fn of Object.values(m.logger)) fn.mockReset();
  m.uploadFindFirst.mockResolvedValue({ id: "up-1" });
  m.reviewFindFirst.mockResolvedValue({ id: "rev-1" });
  m.connectFindFirst.mockResolvedValue(null);
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

// R6 M2: the client connect link is part of it.
describe("buildFormerOwnerEmail: the connect link", () => {
  const base = { workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerName: "Sam", appBaseUrl: "https://app.example.com" };

  it("names a working connect link with the others, and the button replaces all three", () => {
    const email = buildFormerOwnerEmail({ ...base, uploadLink: true, reviewLink: true, connectLink: "works" });
    expect(email.text).toContain(
      "Sam is no longer an owner of Surf Co. As an owner, Sam had access to its client upload link, client review link and client connect link, and those links still work.",
    );
    expect(email.text).toContain(
      'To stop them working, open Settings, Team and press "Make new client links". It replaces all three at once; send the new links to your client.',
    );
  });

  it("a connect link the former owner made has stopped working: says so, and how to give the client a new one", () => {
    const email = buildFormerOwnerEmail({ ...base, uploadLink: false, reviewLink: false, connectLink: "stopped" });
    expect(email.text).toContain("Sam is no longer an owner of Surf Co.");
    expect(email.text).toContain(
      "The client connect link Sam made stopped working when Sam stopped being an owner, so your client can't connect accounts with it.",
    );
    expect(email.text).toContain(
      'To make a new one with the same platforms, open Settings, Team and press "Make new client links"; send the new link to your client.',
    );
    expect(email.text).not.toContain("still work");
  });

  it("a stopped connect link beside a working review link", () => {
    const email = buildFormerOwnerEmail({ ...base, uploadLink: false, reviewLink: true, connectLink: "stopped" });
    expect(email.text).toContain("Sam had access to its client review link, and that link still works.");
    expect(email.text).toContain("The client connect link Sam made stopped working");
    expect(email.text).toContain(
      'To stop it working, open Settings, Team and press "Make new client links". It replaces both at once; send the new links to your client.',
    );
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

  it("reads the working connect link and tells whether the former owner made it", async () => {
    m.uploadFindFirst.mockResolvedValue(null);
    m.reviewFindFirst.mockResolvedValue(null);
    m.connectFindFirst.mockResolvedValue({ createdById: "user-1" });
    m.memberFindFirst.mockResolvedValue({ id: "mem-1" });

    await expect(
      noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() }),
    ).resolves.toEqual({ clientLinksToReplace: true });
    expect(m.connectFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      select: { createdById: true },
    });
    expect(m.sendEmail.mock.calls[0][0].text).toContain("client connect link, and that link still works.");

    m.sendEmail.mockClear();
    m.connectFindFirst.mockResolvedValue({ createdById: "user-2" });
    await noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() });
    expect(m.sendEmail.mock.calls[0][0].text).toContain("The client connect link Sam made stopped working");
  });

  it("a connect link an earlier former owner made stopped back then: not this notice's news", async () => {
    m.uploadFindFirst.mockResolvedValue(null);
    m.reviewFindFirst.mockResolvedValue(null);
    m.connectFindFirst.mockResolvedValue({ createdById: "user-9" });
    m.memberFindFirst.mockResolvedValue(null);

    await expect(
      noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() }),
    ).resolves.toEqual({ clientLinksToReplace: false });
    expect(m.memberFindFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", userId: "user-9", role: "owner" },
      select: { id: true },
    });
    expect(m.sendEmail).not.toHaveBeenCalled();
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

// R7-security L4: leaving turned off the invite links the person made; the
// owners are told, so a teammate's failed join makes sense.
describe("buildFormerOwnerEmail: invite links turned off", () => {
  const base = {
    workspaceId: "ws-1",
    workspaceName: "Surf Co",
    formerOwnerName: "Sam",
    uploadLink: true,
    reviewLink: false,
    appBaseUrl: "https://app.example.com",
  };

  it("says how many of their invite links were turned off", () => {
    expect(buildFormerOwnerEmail({ ...base, joinLinksRevoked: 1 }).text).toContain(
      "The invite link Sam made was turned off when Sam left, so it can't be used to join Surf Co again.",
    );
    expect(buildFormerOwnerEmail({ ...base, joinLinksRevoked: 2 }).text).toContain(
      "The 2 invite links Sam made were turned off when Sam left, so they can't be used to join Surf Co again.",
    );
  });

  it("says nothing about invite links when none was turned off", () => {
    expect(buildFormerOwnerEmail({ ...base, joinLinksRevoked: 0 }).text).not.toContain("invite link");
    expect(buildFormerOwnerEmail(base).text).not.toContain("invite link");
  });

  it("is passed on by the notice", async () => {
    await noticeOwnersOfFormerOwner({
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
      formerOwnerId: "user-2",
      at: new Date(),
      joinLinksRevoked: 1,
    });
    expect(m.sendEmail.mock.calls[0][0].text).toContain("The invite link Sam made was turned off when Sam left");
  });
});

// R7-pages L3 / client-journey L2: on a plan without client links the links
// are paused, not off, and "Make new client links" is not offered; the owners
// can turn them off on any plan.
describe("buildFormerOwnerEmail: on a plan without client links", () => {
  const base = { workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerName: "Sam", appBaseUrl: "https://app.example.com" };

  it("as today when the plan includes client links", () => {
    const email = buildFormerOwnerEmail({ ...base, uploadLink: true, reviewLink: true, clientLinksIncluded: true });
    expect(email.subject).toBe("Make new client links for Surf Co");
    expect(email.text).toContain("and those links still work.");
    expect(email.text).toContain('press "Make new client links"');
  });

  it("says the links are paused, that the copies would work again with a plan with client links, and offers Turn off", () => {
    const email = buildFormerOwnerEmail({ ...base, uploadLink: true, reviewLink: true, clientLinksIncluded: false });
    expect(email.subject).toBe("Turn off client links for Surf Co");
    expect(email.text).toContain(
      "Sam is no longer an owner of Surf Co. As an owner, Sam had access to its client upload link and client review link. They are paused, because this workspace's plan doesn't include client links.",
    );
    expect(email.text).toContain(
      "If the plan changes to one with client links (Growth or Pro), the copies Sam kept would work again. To stop that, open Settings, Team and press \"Turn off client links\".",
    );
    expect(email.text).not.toContain("Make new client links");
    expect(email.text).not.toContain("still work");
  });

  it("one link: singular wording", () => {
    const email = buildFormerOwnerEmail({ ...base, uploadLink: false, reviewLink: true, clientLinksIncluded: false });
    expect(email.text).toContain("Sam had access to its client review link. It is paused, because");
  });

  it("the notice reads the plan, and with only a stopped connect link there is nothing to turn off: no email", async () => {
    vi.stubEnv("BILLING_ENABLED", "true");
    m.workspaceFindUnique.mockResolvedValue({ id: "ws-1", billingExempt: false, plan: "starter", planStatus: "active" });
    await noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() });
    expect(m.workspaceFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "ws-1" } }));
    expect(m.sendEmail.mock.calls[0][0].subject).toBe("Turn off client links for Surf Co");

    m.sendEmail.mockClear();
    m.uploadFindFirst.mockResolvedValue(null);
    m.reviewFindFirst.mockResolvedValue(null);
    m.connectFindFirst.mockResolvedValue({ createdById: "user-2" });
    await expect(
      noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() }),
    ).resolves.toEqual({ clientLinksToReplace: false });
    expect(m.sendEmail).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
