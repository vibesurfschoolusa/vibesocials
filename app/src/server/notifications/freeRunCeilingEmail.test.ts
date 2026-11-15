import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { consumeMock, sendEmailMock } = vi.hoisted(() => ({ consumeMock: vi.fn(), sendEmailMock: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: consumeMock }));
vi.mock("@/server/notifications/email", () => ({ sendEmail: sendEmailMock }));

import { buildFreeRunCeilingEmail, notifyOperatorOfFreeRunCeiling } from "./freeRunCeilingEmail";

const DAY = new Date("2026-11-14T15:00:00Z");

beforeEach(() => {
  consumeMock.mockReset();
  consumeMock.mockResolvedValue({ allowed: true });
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
  vi.stubEnv("ADMIN_EMAILS", "ops@example.com, second@example.com");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("buildFreeRunCeilingEmail", () => {
  it("says what happened, until when, and escapes the addresses", () => {
    const email = buildFreeRunCeilingEmail({ day: DAY, runs: 30, topOwners: [{ email: "a<b>@example.com", runs: 9 }] });
    expect(email.subject).toBe("Vibe Socials reached its daily ceiling of 30 free posts (2026-11-14, UTC)");
    expect(email.html).toContain("30 free posts went out today (UTC), the most allowed in one day. Until 00:00 UTC");
    expect(email.html).toContain("<td>a&lt;b&gt;@example.com</td><td>9</td>");
    expect(email.html).not.toMatch(/admin/i);
  });

  it("with no owner to name, says so", () => {
    expect(buildFreeRunCeilingEmail({ day: DAY, runs: 30, topOwners: [] }).html).toContain(
      "No owner could be named for today's free posts.",
    );
  });
});

describe("notifyOperatorOfFreeRunCeiling", () => {
  const topOwners = vi.fn(async () => [{ email: "a@example.com", runs: 3 }]);

  it("emails each operator once, keyed by the UTC day, reading the owners only then", async () => {
    await notifyOperatorOfFreeRunCeiling({ day: DAY, runs: 30, topOwners });
    expect(consumeMock).toHaveBeenCalledWith({
      key: "free-run-ceiling-email:2026-11-14",
      limit: 1,
      resetAt: new Date("2026-11-15T00:00:00Z"),
      failClosed: true,
    });
    expect(sendEmailMock.mock.calls.map(([message]) => message.to)).toEqual(["ops@example.com", "second@example.com"]);
    expect(topOwners).toHaveBeenCalledTimes(1);
  });

  it("sends nothing once the day's email went, or with no operator configured", async () => {
    consumeMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await notifyOperatorOfFreeRunCeiling({ day: DAY, runs: 30, topOwners });
    vi.stubEnv("ADMIN_EMAILS", "");
    consumeMock.mockResolvedValue({ allowed: true });
    await notifyOperatorOfFreeRunCeiling({ day: DAY, runs: 30, topOwners });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("never throws, and logs no address", async () => {
    topOwners.mockRejectedValueOnce(new Error("read failed for a@example.com"));
    await expect(notifyOperatorOfFreeRunCeiling({ day: DAY, runs: 30, topOwners })).resolves.toBeUndefined();
    sendEmailMock.mockRejectedValueOnce(new Error("mail down"));
    await expect(notifyOperatorOfFreeRunCeiling({ day: DAY, runs: 30, topOwners })).resolves.toBeUndefined();
    const logged = vi.mocked(console.error).mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toContain("@example.com");
  });
});
