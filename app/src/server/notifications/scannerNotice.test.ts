import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { consumeMock, deliverMock, releaseMock } = vi.hoisted(() => ({
  consumeMock: vi.fn(),
  deliverMock: vi.fn(),
  releaseMock: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: consumeMock }));
vi.mock("@/server/notifications/postOutcomeEmail", () => ({ deliverPostOutcomeNotification: deliverMock }));
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
    expect(deliverMock).toHaveBeenCalledWith({ userId: "user-1", postJobId: "post-1", afterPairWait: true });
    await notifyNotSentAtScan({ ...NOTICE, userId: "user-2", postJobId: "post-2" }, NOW);
    expect(consumeMock.mock.calls[1][0].key).toBe("scan-notice:ws-1:user-2:LIMIT_REACHED:2026-11-14");
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("sends nothing once the day's notice for that recipient and reason went", async () => {
    consumeMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await notifyNotSentAtScan(NOTICE, NOW);
    expect(deliverMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  // Review of T1, item 3: a failed send lets the key go, so the next scan tries again.
  it("a send that fails lets the day's key go, and never throws", async () => {
    deliverMock.mockRejectedValue(new Error("resend 429"));
    await expect(notifyNotSentAtScan(NOTICE, NOW)).resolves.toBeUndefined();
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: KEY } });

    releaseMock.mockClear();
    consumeMock.mockRejectedValue(new Error("db down"));
    await expect(notifyNotSentAtScan(NOTICE, NOW)).resolves.toBeUndefined();
    expect(releaseMock).not.toHaveBeenCalled();
  });
});
