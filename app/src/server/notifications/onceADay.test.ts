import { beforeEach, describe, expect, it, vi } from "vitest";

const { consumeMock, releaseMock } = vi.hoisted(() => ({ consumeMock: vi.fn(), releaseMock: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: consumeMock }));
vi.mock("@/lib/db", () => ({ prisma: { rateLimitEntry: { deleteMany: releaseMock } } }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sendOnceADay } from "./onceADay";

const KEY = "some-email:2026-11-17";
const RESET_AT = new Date("2026-11-18T00:00:00Z");
const onError = vi.fn();

beforeEach(() => {
  consumeMock.mockReset();
  consumeMock.mockResolvedValue({ allowed: true });
  releaseMock.mockReset();
  releaseMock.mockResolvedValue({ count: 1 });
  onError.mockReset();
});

/** R38 client-journey L2: one rule for every once-a-day email: claim, send, let go unless it went. */
describe("sendOnceADay", () => {
  it("claims the day fail-closed, sends, and keeps the claim when an email went", async () => {
    const send = vi.fn().mockResolvedValue(true);
    await expect(sendOnceADay(KEY, RESET_AT, send, onError)).resolves.toBe("sent");
    expect(consumeMock).toHaveBeenCalledWith({ key: KEY, limit: 1, resetAt: RESET_AT, failClosed: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("already claimed today, or a store that couldn't answer: nothing sent, nothing let go", async () => {
    for (const result of [{ allowed: false, retryAfterSeconds: 10 }, { allowed: false, retryAfterSeconds: 60, unavailable: true }]) {
      consumeMock.mockResolvedValueOnce(result);
      const send = vi.fn();
      await expect(sendOnceADay(KEY, RESET_AT, send, onError)).resolves.toBe("skipped");
      expect(send).not.toHaveBeenCalled();
    }
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("no email went (send answered false): the claim is let go", async () => {
    await expect(sendOnceADay(KEY, RESET_AT, async () => false, onError)).resolves.toBe("failed");
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: KEY } });
  });

  it("a read or send that throws: the claim is let go, nothing thrown", async () => {
    await expect(
      sendOnceADay(
        KEY,
        RESET_AT,
        async () => {
          throw new Error("db blip");
        },
        onError,
      ),
    ).resolves.toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "db blip" }));
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: KEY } });
  });

  it("a claim that throws: nothing sent, nothing let go, nothing thrown", async () => {
    consumeMock.mockRejectedValueOnce(new Error("boom"));
    const send = vi.fn();
    await expect(sendOnceADay(KEY, RESET_AT, send, onError)).resolves.toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });
});
