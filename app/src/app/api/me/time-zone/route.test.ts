import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentUserMock, updateManyMock, checkRateLimitMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  updateManyMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/db", () => ({ prisma: { user: { updateMany: updateManyMock } } }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));

import { POST } from "./route";

function post(body: unknown): Request {
  return new Request("https://vibesocials.wtf/api/me/time-zone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  updateManyMock.mockReset();
  checkRateLimitMock.mockReset();
  getCurrentUserMock.mockResolvedValue({ id: "user-1", timeZone: null });
  updateManyMock.mockResolvedValue({ count: 1 });
  checkRateLimitMock.mockResolvedValue({ allowed: true });
});

describe("POST /api/me/time-zone", () => {
  it("stores a real zone for the signed-in person", async () => {
    const response = await POST(post({ timeZone: "America/New_York" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, timeZone: "America/New_York" });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { timeZone: "America/New_York" },
    });
  });

  it("writes nothing when the zone is already the stored one", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-1", timeZone: "Europe/Berlin" });

    const response = await POST(post({ timeZone: "Europe/Berlin" }));

    expect(response.status).toBe(200);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it.each([["Mars/Olympus"], [""], [42], [null], ["A".repeat(65)]])("refuses %j", async (timeZone) => {
    const response = await POST(post({ timeZone }));

    expect(response.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const response = await POST(post("not json"));
    expect(response.status).toBe(400);
  });

  it("is 401 when signed out", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const response = await POST(post({ timeZone: "UTC" }));

    expect(response.status).toBe(401);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("is 429 past the rate limit", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });

    const response = await POST(post({ timeZone: "UTC" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});
