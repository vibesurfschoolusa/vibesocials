import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { upsertMock, deleteManyMock } = vi.hoisted(() => ({ upsertMock: vi.fn(), deleteManyMock: vi.fn() }));

vi.mock("./db", () => ({ prisma: { rateLimitEntry: { upsert: upsertMock, deleteMany: deleteManyMock } } }));

import { clearLoginLimitForNetwork, LOGIN_EMAIL_IP_LIMIT, loginEmailIpUserId } from "./loginLimit";
import { checkRateLimit } from "./rateLimit";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T10:07:00Z"));
  upsertMock.mockReset().mockResolvedValue({ count: 1 });
  deleteManyMock.mockReset().mockResolvedValue({ count: 1 });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// R32 new-customer L1: after a password reset the person's own (address,
// network) bucket is emptied, so the new password works at once. Only that
// bucket: the per-network and per-address buckets stay, so a reset never buys
// a guesser more tries at other addresses or from other networks.
describe("clearLoginLimitForNetwork", () => {
  it("deletes exactly the counter Log in's (address, network) limit counts in, in the current window", async () => {
    await checkRateLimit({ userId: loginEmailIpUserId("owner@example.test", "203.0.113.9"), ...LOGIN_EMAIL_IP_LIMIT, failClosed: true });
    const counted = (upsertMock.mock.calls[0][0] as { where: { key: string } }).where.key;

    await clearLoginLimitForNetwork("  Owner@Example.TEST ", "203.0.113.9");

    expect(deleteManyMock).toHaveBeenCalledTimes(1);
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { key: counted } });
  });

  it("the address is normalised the way Log in normalises it", () => {
    expect(loginEmailIpUserId(" Owner@Example.TEST", "1.2.3.4")).toBe("email-ip:owner@example.test|1.2.3.4");
  });
});
