import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentUserMock, checkRateLimitMock, consumeFixedWindowMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  consumeFixedWindowMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
  consumeFixedWindow: consumeFixedWindowMock,
}));

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
  consumeFixedWindowMock.mockReset();
  fetchMock.mockReset();
  getCurrentUserMock.mockResolvedValue({ id: "user-1" });
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  consumeFixedWindowMock.mockResolvedValue({ allowed: true });
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
  it("allows one person 30 lookups in 5 minutes, failing closed", async () => {
    await GET(lookup());
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      userId: "user-1",
      route: "geocode",
      limit: 30,
      windowMs: 5 * 60 * 1000,
      failClosed: true,
    });
  });

  it("counts every paid lookup against one app-wide cap of 2,000 a UTC day, failing closed", async () => {
    const response = await GET(lookup());

    expect(response.status).toBe(200);
    expect(consumeFixedWindowMock).toHaveBeenCalledWith({
      key: "geocode:app:2026-11-14",
      limit: 2000,
      resetAt: new Date("2026-11-15T00:00:00.000Z"),
      failClosed: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("over the app's cap: no paid call, and a plain note that typing the place still works", async () => {
    consumeFixedWindowMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 30_600 });

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
      error: "Too many place lookups. Type the place in full, or wait a few minutes for suggestions.",
      retryAfterSeconds: 120,
    });
    expect(consumeFixedWindowMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not spend the app's cap on a query too short to look up", async () => {
    const response = await GET(lookup("a"));

    await expect(response.json()).resolves.toEqual({ suggestions: [] });
    expect(consumeFixedWindowMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
