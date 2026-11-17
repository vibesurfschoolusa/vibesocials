import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { consumeMock, deliverMock, partnerMock, releaseMock } = vi.hoisted(() => ({
  consumeMock: vi.fn(),
  deliverMock: vi.fn(),
  partnerMock: vi.fn(),
  releaseMock: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: consumeMock }));
vi.mock("@/server/notifications/postOutcomeEmail", () => ({
  deliverPostOutcomeNotification: deliverMock,
  pairPartnerStillToSend: partnerMock,
}));
vi.mock("@/lib/db", () => ({ prisma: { rateLimitEntry: { deleteMany: releaseMock } } }));

import { notifyNotSentAtScan } from "./scannerNotice";

const NOW = new Date("2026-11-14T15:00:00Z");
const NOTICE = { postJobId: "post-1", userId: "user-1", workspaceId: "ws-1", reason: "LIMIT_REACHED" as const };
const KEY = "scan-notice:ws-1:user-1:LIMIT_REACHED:2026-11-14";

beforeEach(() => {
  consumeMock.mockReset();
  consumeMock.mockResolvedValue({ allowed: true });
  deliverMock.mockReset();
  deliverMock.mockResolvedValue(undefined);
  partnerMock.mockReset();
  partnerMock.mockResolvedValue(false);
  releaseMock.mockReset();
  releaseMock.mockResolvedValue({ count: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("notifyNotSentAtScan", () => {
  // Review of T1, item 3: the key names the recipient too, so a second author gets their own.
  it("is keyed per workspace, recipient, reason and UTC day, fails closed, and sends the outcome email without a pair wait", async () => {
    await notifyNotSentAtScan(NOTICE, NOW);
    expect(consumeMock).toHaveBeenCalledWith({
      key: KEY,
      limit: 1,
      resetAt: new Date("2026-11-15T00:00:00Z"),
      failClosed: true,
    });
    expect(deliverMock).toHaveBeenCalledWith({
      userId: "user-1",
      postJobId: "post-1",
      afterPairWait: true,
      scanNotice: true,
    });
    await notifyNotSentAtScan({ ...NOTICE, userId: "user-2", postJobId: "post-2" }, NOW);
    expect(consumeMock.mock.calls[1][0].key).toBe("scan-notice:ws-1:user-2:LIMIT_REACHED:2026-11-14");
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("a notice that went keeps the day's key", async () => {
    await expect(notifyNotSentAtScan(NOTICE, NOW)).resolves.toBe(true);
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("sends nothing once the day's notice for that recipient and reason went", async () => {
    consumeMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await notifyNotSentAtScan(NOTICE, NOW);
    expect(deliverMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  // R40 security L2: deliverPostOutcomeNotification throws only from its send, and its
  // key is per post, so a lost reply (Resend took the email) must not free the day for a
  // second notice about the next post.
  it("a send that throws keeps the day's key, so the next post sends no second notice, and never throws", async () => {
    deliverMock.mockRejectedValueOnce(new Error("network error"));
    await expect(notifyNotSentAtScan(NOTICE, NOW)).resolves.toBe(true);
    expect(releaseMock).not.toHaveBeenCalled();

    consumeMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await expect(notifyNotSentAtScan({ ...NOTICE, postJobId: "post-2" }, NOW)).resolves.toBe(true);
    expect(deliverMock).toHaveBeenCalledTimes(1);

    consumeMock.mockRejectedValue(new Error("db down"));
    await expect(notifyNotSentAtScan(NOTICE, NOW)).resolves.toBe(true);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  // R40 lead review: Resend's 429 means the notice was not sent, so the day is let go
  // and the next scan sends; a 409 in flight may still send, so the day is kept.
  it("a 429 (marked not sent) lets the day's key go, and the next scan sends", async () => {
    const { RetryAfterError } = await import("inngest");
    deliverMock.mockRejectedValueOnce(Object.assign(new RetryAfterError("Resend rate limited the send", 2000), { emailNotSent: true }));
    await notifyNotSentAtScan(NOTICE, NOW);
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: KEY } });

    await notifyNotSentAtScan({ ...NOTICE, postJobId: "post-2" }, NOW);
    expect(deliverMock).toHaveBeenCalledTimes(2);
  });

  it("a 409 in flight (not marked) keeps the day's key", async () => {
    const { RetryAfterError } = await import("inngest");
    deliverMock.mockRejectedValueOnce(new RetryAfterError("Resend rate limited the send (status 409)", 2000));
    await notifyNotSentAtScan(NOTICE, NOW);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  // R9-publishing L1: a Feed and Story pair gets one email. The half the scan
  // could not send stays quiet while its partner is still to be sent; the
  // partner's run then sends the pair's one email.
  // R39 lead review L3: the outcome email's key is per post, not per recipient and day,
  // so a store blip must not send one email per post.
  it("a counter store that can't answer sends nothing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      consumeMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60, unavailable: true });
      await notifyNotSentAtScan(NOTICE, NOW);
      expect(deliverMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a half whose partner is still to be sent sends nothing and leaves the day's key unused", async () => {
    partnerMock.mockResolvedValue(true);
    // Not handled: the scanner may still tell the recipient about another post.
    await expect(notifyNotSentAtScan(NOTICE, NOW)).resolves.toBe(false);
    expect(partnerMock).toHaveBeenCalledWith("post-1", NOW);
    expect(consumeMock).not.toHaveBeenCalled();
    expect(deliverMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("a lone post, or a half whose partner is done, is told about as before", async () => {
    partnerMock.mockResolvedValue(false);
    await expect(notifyNotSentAtScan(NOTICE, NOW)).resolves.toBe(true);
    expect(consumeMock).toHaveBeenCalledTimes(1);
    expect(deliverMock).toHaveBeenCalledTimes(1);
    // Already told today: dealt with too.
    consumeMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await expect(notifyNotSentAtScan(NOTICE, NOW)).resolves.toBe(true);
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it("a failed partner check sends nothing, uses no key, and never throws", async () => {
    partnerMock.mockRejectedValue(new Error("db down"));
    await expect(notifyNotSentAtScan(NOTICE, NOW)).resolves.toBe(false);
    expect(consumeMock).not.toHaveBeenCalled();
    expect(deliverMock).not.toHaveBeenCalled();
  });
});
