import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsertMock } = vi.hoisted(() => ({ upsertMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { rateLimitEntry: { upsert: upsertMock } } }));

import { GEOCODE_APP_DAILY_LIMIT, consumeGeocodeAppDay } from "./appDay";

const NOW = new Date("2026-11-14T15:30:00.000Z");

beforeEach(() => {
  upsertMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("consumeGeocodeAppDay", () => {
  it("counts one lookup under one app-wide key per UTC day", async () => {
    upsertMock.mockResolvedValue({ count: 1 });

    await expect(consumeGeocodeAppDay(NOW)).resolves.toEqual({ outcome: "allowed" });
    expect(GEOCODE_APP_DAILY_LIMIT).toBe(2000);
    expect(upsertMock).toHaveBeenCalledWith({
      where: { key: "geocode:app:2026-11-14" },
      create: { key: "geocode:app:2026-11-14", count: 1, expiresAt: new Date("2026-11-15T00:00:00.000Z") },
      update: { count: { increment: 1 } },
    });
  });

  it("refuses the 2,001st lookup of the day until midnight UTC", async () => {
    upsertMock.mockResolvedValue({ count: 2001 });
    await expect(consumeGeocodeAppDay(NOW)).resolves.toEqual({ outcome: "limit", retryAfterSeconds: 30_600 });
  });

  it("tells an unreachable store apart from a used-up day", async () => {
    upsertMock.mockRejectedValue(new Error("db down"));
    await expect(consumeGeocodeAppDay(NOW)).resolves.toEqual({ outcome: "unavailable" });
  });
});
