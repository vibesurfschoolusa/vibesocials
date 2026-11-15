import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { consumeMock, deliverMock } = vi.hoisted(() => ({ consumeMock: vi.fn(), deliverMock: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: consumeMock }));
vi.mock("@/server/notifications/postOutcomeEmail", () => ({ deliverPostOutcomeNotification: deliverMock }));

import { notifyNotSentAtScan } from "./scannerNotice";

const NOW = new Date("2026-11-14T15:00:00Z");
const NOTICE = { postJobId: "post-1", userId: "user-1", workspaceId: "ws-1", reason: "LIMIT_REACHED" as const };

beforeEach(() => {
  consumeMock.mockReset();
  consumeMock.mockResolvedValue({ allowed: true });
  deliverMock.mockReset();
  deliverMock.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("notifyNotSentAtScan", () => {
  it("is keyed per workspace, reason and UTC day, fails closed, and sends the outcome email without a pair wait", async () => {
    await notifyNotSentAtScan(NOTICE, NOW);
    expect(consumeMock).toHaveBeenCalledWith({
      key: "scan-notice:ws-1:LIMIT_REACHED:2026-11-14",
      limit: 1,
      resetAt: new Date("2026-11-15T00:00:00Z"),
      failClosed: true,
    });
    expect(deliverMock).toHaveBeenCalledWith({ userId: "user-1", postJobId: "post-1", afterPairWait: true });
  });

  it("sends nothing once the day's notice for that reason went", async () => {
    consumeMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await notifyNotSentAtScan(NOTICE, NOW);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it("never throws, even on a retryable email failure", async () => {
    deliverMock.mockRejectedValue(new Error("resend 429"));
    await expect(notifyNotSentAtScan(NOTICE, NOW)).resolves.toBeUndefined();
    consumeMock.mockRejectedValue(new Error("db down"));
    await expect(notifyNotSentAtScan(NOTICE, NOW)).resolves.toBeUndefined();
  });
});
