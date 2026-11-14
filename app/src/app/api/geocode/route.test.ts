import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentUserMock, checkRateLimitMock, consumeAppDayMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  consumeAppDayMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("./appDay", () => ({ consumeGeocodeAppDay: consumeAppDayMock }));

import { GET } from "./route";

const NOW = new Date("2026-11-14T15:30:00.000Z");

function lookup(query = "Dania Beach"): NextRequest {
  return new NextRequest(`http://localhost/api/geocode?query=${encodeURIComponent(query)}`);
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  getCurrentUserMock.mockReset();
  checkRateLimitMock.mockReset();
  consumeAppDayMock.mockReset();
  fetchMock.mockReset();
  getCurrentUserMock.mockResolvedValue({ id: "user-1" });
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  consumeAppDayMock.mockResolvedValue({ outcome: "allowed" });
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        status: "OK",
        results: [{ formatted_address: "Dania Beach, FL", geometry: { location: { lat: 26, lng: -80 } }, place_id: "p1" }],
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/geocode limits", () => {
  it("allows one person 30 lookups in 5 minutes (failing open: the app-wide count fails closed)", async () => {
    await GET(lookup());
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "geocode",
      limit: 30,
      windowMs: 5 * 60 * 1000,
    });
  });

  it("counts every paid lookup against the app's day", async () => {
    const response = await GET(lookup());

    expect(response.status).toBe(200);
    expect(consumeAppDayMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("when the app's count cannot be reached: no paid call, and says suggestions are not available now", async () => {
    consumeAppDayMock.mockResolvedValue({ outcome: "unavailable" });

    const response = await GET(lookup());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Place suggestions aren't available right now. Type the place.",
      code: "GEOCODE_UNAVAILABLE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("over the app's cap: no paid call, and a plain note that typing the place still works", async () => {
    consumeAppDayMock.mockResolvedValue({ outcome: "limit", retryAfterSeconds: 30_600 });

    const response = await GET(lookup());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30600");
    await expect(response.json()).resolves.toEqual({
      error: "Place suggestions are off for the rest of today. Type the place in full; it is saved as you type it.",
      code: "GEOCODE_DAILY_LIMIT",
      retryAfterSeconds: 30_600,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("over the person's limit: no paid call and nothing counted app-wide", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });

    const response = await GET(lookup());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "Too many place lookups. Wait a minute or type the place.",
      code: "GEOCODE_USER_LIMIT",
      retryAfterSeconds: 120,
    });
    expect(consumeAppDayMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // R2 L3: one person's day stays well under the app's 2,000, so one account
  // cannot use up everyone's suggestions.
  it("caps one person at 200 lookups a UTC day, counted only for a lookup really made", async () => {
    await GET(lookup());
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "geocode/day",
      limit: 200,
      windowMs: 24 * 60 * 60 * 1000,
    });
    checkRateLimitMock.mockClear();
    await GET(lookup("a"));
    expect(checkRateLimitMock).not.toHaveBeenCalledWith(expect.objectContaining({ route: "geocode/day" }));
  });

  it("over the person's day: no paid call, nothing counted app-wide, and a note that typing still works", async () => {
    checkRateLimitMock.mockImplementation(async ({ route }: { route: string }) =>
      route === "geocode/day" ? { allowed: false, retryAfterSeconds: 30_600 } : { allowed: true },
    );

    const response = await GET(lookup());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30600");
    await expect(response.json()).resolves.toEqual({
      error: "You have used today's place suggestions. Type the place in full; it is saved as you type it.",
      code: "GEOCODE_USER_DAY_LIMIT",
      retryAfterSeconds: 30_600,
    });
    expect(consumeAppDayMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not spend the app's cap on a query too short to look up", async () => {
    const response = await GET(lookup("a"));

    await expect(response.json()).resolves.toEqual({ suggestions: [] });
    expect(consumeAppDayMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
