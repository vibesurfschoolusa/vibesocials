import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { consumeMock, sendEmailMock, releaseMock } = vi.hoisted(() => ({
  consumeMock: vi.fn(),
  sendEmailMock: vi.fn(),
  releaseMock: vi.fn(),
}));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: consumeMock }));
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));
vi.mock("@/lib/db", () => ({ prisma: { rateLimitEntry: { deleteMany: releaseMock } } }));

import { buildFreeRunCeilingEmail, notifyOperatorOfFreeRunCeiling } from "./freeRunCeilingEmail";

const DAY = new Date("2026-11-14T15:00:00Z");
const KEY = "free-run-ceiling-email:2026-11-14";

beforeEach(() => {
  consumeMock.mockReset();
  consumeMock.mockResolvedValue({ allowed: true });
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(true);
  releaseMock.mockReset();
  releaseMock.mockResolvedValue({ count: 1 });
  vi.stubEnv("ADMIN_EMAILS", "ops@example.com, second@example.com");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("buildFreeRunCeilingEmail", () => {
  // Review of T1, item 2: the ceiling was reached, said as the ceiling, not as a count before the refused run.
  it("says the free daily ceiling was reached, until when, and escapes the addresses", () => {
    const email = buildFreeRunCeilingEmail({ day: DAY, topOwners: [{ email: "a<b>@example.com", runs: 9 }] });
    expect(email.subject).toBe("Vibe Socials reached its daily ceiling of 30 free posts (2026-11-14, UTC)");
    expect(email.html).toContain("Free workspaces reached today's ceiling of 30 posts (UTC). Until 00:00 UTC");
    expect(email.html).toContain("<td>a&lt;b&gt;@example.com</td><td>9</td>");
    expect(email.html).not.toMatch(/admin/i);
  });

  it("with no owner to name, says so", () => {
    expect(buildFreeRunCeilingEmail({ day: DAY, topOwners: [] }).html).toContain(
      "No owner could be named for today's free posts.",
    );
  });
});

describe("notifyOperatorOfFreeRunCeiling", () => {
  const topOwners = vi.fn(async () => [{ email: "a@example.com", runs: 3 }]);

  it("emails each operator once, keyed by the UTC day, reading the owners only then", async () => {
    await notifyOperatorOfFreeRunCeiling({ day: DAY, topOwners });
    expect(consumeMock).toHaveBeenCalledWith({
      key: KEY,
      limit: 1,
      resetAt: new Date("2026-11-15T00:00:00Z"),
      failClosed: true,
    });
    expect(sendEmailMock.mock.calls.map(([message]) => message.to)).toEqual(["ops@example.com", "second@example.com"]);
    expect(sendEmailMock.mock.calls[0][1]).toEqual({ idempotencyKey: "free-run-ceiling/2026-11-14/0", throwOnRetryable: true });
    expect(topOwners).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("sends nothing once the day's email went, or with no operator configured", async () => {
    consumeMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await notifyOperatorOfFreeRunCeiling({ day: DAY, topOwners });
    vi.stubEnv("ADMIN_EMAILS", "");
    consumeMock.mockResolvedValue({ allowed: true });
    await notifyOperatorOfFreeRunCeiling({ day: DAY, topOwners });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  // Review of T1, item 2: a failure lets the day's key go, so a later refusal tries again.
  it("the owner lookup or a send fails: the day's key is let go, nothing thrown, no address logged", async () => {
    topOwners.mockRejectedValueOnce(new Error("read failed for a@example.com"));
    await expect(notifyOperatorOfFreeRunCeiling({ day: DAY, topOwners })).resolves.toBeUndefined();
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: KEY } });

    releaseMock.mockClear();
    sendEmailMock.mockRejectedValueOnce(new Error("resend 503"));
    await expect(notifyOperatorOfFreeRunCeiling({ day: DAY, topOwners })).resolves.toBeUndefined();
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: KEY } });

    const logged = vi.mocked(console.error).mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain("@example.com");
  });

  // R39 client-journey L3: one operator's retryable failure never stops the email to the next.
  it("the first operator fails retryably: the second is still sent and the day is let go", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("resend 429")).mockResolvedValueOnce(true);
    await notifyOperatorOfFreeRunCeiling({ day: DAY, topOwners });
    expect(sendEmailMock.mock.calls.map(([message]) => message.to)).toEqual(["ops@example.com", "second@example.com"]);
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: KEY } });
  });

  // R38 client-journey L2: a send that answered "not sent" for every operator is no email either.
  it("no send went out: the day's key is let go", async () => {
    sendEmailMock.mockResolvedValue(false);
    await notifyOperatorOfFreeRunCeiling({ day: DAY, topOwners });
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: KEY } });
  });

  // R39 lead review L3: the day's window is inside the keys' 24 hours, so a store blip sends with them.
  it("a counter store that can't answer: each operator is sent once, with their key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(DAY);
    try {
      consumeMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60, unavailable: true });
      await notifyOperatorOfFreeRunCeiling({ day: DAY, topOwners });
      expect(sendEmailMock.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual([
        "free-run-ceiling/2026-11-14/0",
        "free-run-ceiling/2026-11-14/1",
      ]);
      expect(releaseMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a counter store that fails closed sends nothing and lets nothing go", async () => {
    consumeMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await notifyOperatorOfFreeRunCeiling({ day: DAY, topOwners });
    expect(releaseMock).not.toHaveBeenCalled();
  });
});
