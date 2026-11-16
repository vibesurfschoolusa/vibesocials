import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  // R8-client-journey L1 / security L2: a demotion turns them off too.
  it("after a demotion: turned off when they stopped being an owner", () => {
    expect(buildFormerOwnerEmail({ ...base, joinLinksRevoked: 1, demoted: true }).text).toContain(
      "The invite link Sam made was turned off when Sam stopped being an owner, so it can't be used to join Surf Co again.",
    );
    expect(buildFormerOwnerEmail({ ...base, joinLinksRevoked: 3, demoted: true }).text).toContain(
      "The 3 invite links Sam made were turned off when Sam stopped being an owner, so they can't be used to join Surf Co again.",
    );
  });

  it("the notice passes a demotion on", async () => {
    await noticeOwnersOfFormerOwner({
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
      formerOwnerId: "user-2",
      at: new Date(),
      joinLinksRevoked: 1,
      demoted: true,
    });
    expect(m.sendEmail.mock.calls[0][0].text).toContain("The invite link Sam made was turned off when Sam stopped being an owner");
  });

  // R11-client-journey L4: deleting the account turns them off too.
  it("after an account deletion: turned off when they deleted their account", () => {
    expect(buildFormerOwnerEmail({ ...base, joinLinksRevoked: 1, deletedAccount: true }).text).toContain(
      "The invite link Sam made was turned off when Sam deleted their account, so it can't be used to join Surf Co again.",
    );
    expect(buildFormerOwnerEmail({ ...base, joinLinksRevoked: 2, deletedAccount: true }).text).toContain(
      "The 2 invite links Sam made were turned off when Sam deleted their account, so they can't be used to join Surf Co again.",
    );
  });

  it("the notice passes an account deletion on, with the name it is given", async () => {
    await noticeOwnersOfFormerOwner({
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
      formerOwnerId: "user-2",
      formerOwnerName: "Gone Person",
      at: new Date(),
      joinLinksRevoked: 2,
      deletedAccount: true,
    });
    expect(m.sendEmail.mock.calls[0][0].text).toContain(
      "The 2 invite links Gone Person made were turned off when Gone Person deleted their account",
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
    // R24 security-billing L2: one link on, one copy kept.
    expect(email.text).toContain(
      "If the plan changes to one with client links (Growth or Pro), the copy Sam kept would work again.",
    );
    expect(email.text).not.toContain("the copies");
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

// R22 client-journey L1: while the workspace is blocked no client link works
// and none can be made; the copies work again once the block ends.
describe("buildFormerOwnerEmail: while the workspace is blocked", () => {
  const base = { workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerName: "Sam", appBaseUrl: "https://app.example.com" };
  const BLOCKED = "Client links don't work right now. This workspace is paused. Contact help@example.com.";

  it("says the links don't work now, work again once the block ends, and offers Turn off", () => {
    const email = buildFormerOwnerEmail({ ...base, uploadLink: true, reviewLink: true, clientLinksIncluded: true, workspaceBlocked: BLOCKED });
    expect(email.subject).toBe("Turn off client links for Surf Co");
    expect(email.text).toContain(
      `Sam is no longer an owner of Surf Co. As an owner, Sam had access to its client upload link and client review link. ${BLOCKED}`,
    );
    expect(email.text).toContain(
      'The copies Sam kept will work again once the workspace is active again. To stop that, open Settings, Team and press "Turn off client links".',
    );
    expect(email.text).not.toContain("Make new client links");
    expect(email.text).not.toContain("still work");
    expect(email.text).not.toContain("send the new");
  });

  // HH1 review: blocked AND on a plan without client links, the copies won't
  // work again when the block ends, so the plan's wording (the lasting reason) wins.
  it("blocked on a plan without client links: the plan's wording, not 'work again'", () => {
    const email = buildFormerOwnerEmail({ ...base, uploadLink: true, reviewLink: true, clientLinksIncluded: false, workspaceBlocked: BLOCKED });
    expect(email.text).toContain("paused, because this workspace's plan doesn't include client links");
    expect(email.text).not.toContain("work again once the workspace is active again");
  });

  it("blocked by an ended trial or plan: the copies work again once the workspace is on Growth or Pro", () => {
    const ended =
      "Client links don't work right now. Your plan has ended. Choose Growth or Pro in Settings and your client links work again, or contact help@example.com.";
    const many = buildFormerOwnerEmail({ ...base, uploadLink: true, reviewLink: true, workspaceBlocked: ended, workspaceBlockedBy: "plan" });
    expect(many.text).toContain(
      'The copies Sam kept will work again once the workspace is on Growth or Pro. To stop that, open Settings, Team and press "Turn off client links".',
    );
    const one = buildFormerOwnerEmail({ ...base, uploadLink: false, reviewLink: true, workspaceBlocked: ended, workspaceBlockedBy: "plan" });
    expect(one.text).toContain("The copy Sam kept will work again once the workspace is on Growth or Pro.");
    const paused = buildFormerOwnerEmail({ ...base, uploadLink: true, reviewLink: true, workspaceBlocked: BLOCKED, workspaceBlockedBy: "pause" });
    expect(paused.text).toContain("The copies Sam kept will work again once the workspace is active again.");
  });

  it("one link: singular wording", () => {
    const email = buildFormerOwnerEmail({ ...base, uploadLink: false, reviewLink: true, workspaceBlocked: BLOCKED });
    expect(email.text).toContain(`Sam had access to its client review link. ${BLOCKED}`);
    expect(email.text).toContain("The copy Sam kept will work again once the workspace is active again.");
  });

  it("the notice reads the pause and sends that email; with only a stopped connect link it sends none", async () => {
    m.workspaceFindUnique.mockResolvedValue({ id: "ws-1", pausedAt: new Date("2026-11-10T00:00:00Z"), pausedReason: null });
    await noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() });
    expect(m.workspaceFindUnique.mock.calls[0][0].select).toMatchObject({ pausedAt: true, pausedReason: true });
    const sent = m.sendEmail.mock.calls[0][0];
    expect(sent.subject).toBe("Turn off client links for Surf Co");
    expect(sent.text).toContain("This workspace is paused.");
    expect(sent.text).toContain("The copies Sam kept will work again once the workspace is active again.");

    m.sendEmail.mockClear();
    m.uploadFindFirst.mockResolvedValue(null);
    m.reviewFindFirst.mockResolvedValue(null);
    m.connectFindFirst.mockResolvedValue({ createdById: "user-2" });
    await expect(
      noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() }),
    ).resolves.toEqual({ clientLinksToReplace: false });
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("active: the notice sends today's email", async () => {
    m.workspaceFindUnique.mockResolvedValue({ id: "ws-1", pausedAt: null, pausedReason: null });
    await noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() });
    expect(m.sendEmail.mock.calls[0][0].subject).toBe("Make new client links for Surf Co");
  });
});

// R23 security L1 / client-journey L2: with billing on, an ended trial or
// Growth plan has client links that work again once a plan with them is
// chosen, so it gets the block's email; only an ended Starter plan, which has
// none, gets the plan's.
describe("noticeOwnersOfFormerOwner: an ended trial or plan", () => {
  const PAST = () => new Date(Date.now() - 86_400_000);
  const notice = () =>
    noticeOwnersOfFormerOwner({ workspaceId: "ws-1", workspaceName: "Surf Co", formerOwnerId: "user-2", at: new Date() });

  beforeEach(() => vi.stubEnv("BILLING_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("an ended trial: the block's email, with the trial sentence", async () => {
    m.workspaceFindUnique.mockResolvedValue({ id: "ws-1", billingExempt: false, plan: null, trialEndsAt: PAST() });
    await notice();
    const sent = m.sendEmail.mock.calls[0][0];
    expect(sent.text).toContain("Your free trial has ended. Choose Growth or Pro in Settings and your client links work again");
    // II1 review: "once the workspace is active again" was untrue after picking Starter.
    expect(sent.text).toContain("The copies Sam kept will work again once the workspace is on Growth or Pro.");
    expect(sent.text).not.toContain("active again");
    expect(sent.text).not.toContain("plan doesn't include client links");
  });

  it("an ended Growth plan: the block's email, never that the plan lacks client links", async () => {
    m.workspaceFindUnique.mockResolvedValue({
      id: "ws-1",
      billingExempt: false,
      plan: "growth",
      planStatus: "canceled",
      currentPeriodEnd: PAST(),
    });
    await notice();
    const sent = m.sendEmail.mock.calls[0][0];
    expect(sent.subject).toBe("Turn off client links for Surf Co");
    expect(sent.text).toContain("Your plan has ended. Choose Growth or Pro in Settings and your client links work again");
    expect(sent.text).toContain("The copies Sam kept will work again once the workspace is on Growth or Pro.");
    expect(sent.text).not.toContain("active again");
    expect(sent.text).not.toContain("plan doesn't include client links");
  });

  it("an ended Starter plan: the plan's email", async () => {
    m.workspaceFindUnique.mockResolvedValue({
      id: "ws-1",
      billingExempt: false,
      plan: "starter",
      planStatus: "canceled",
      currentPeriodEnd: PAST(),
    });
    await notice();
    const sent = m.sendEmail.mock.calls[0][0];
    expect(sent.subject).toBe("Turn off client links for Surf Co");
    expect(sent.text).toContain("paused, because this workspace's plan doesn't include client links");
    expect(sent.text).not.toContain("work again once the workspace is active again");
  });
});
