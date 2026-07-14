import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest. route.ts reads the
// caller via `@/lib/auth`'s getCurrentUser (a user-level account fact, NOT
// workspace context), mocked below so the test never touches next-auth/prisma.
const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));

vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));

import { GET } from "./route";

beforeEach(() => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue({ id: "user-1", email: "user@example.com", emailVerifiedAt: null });
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/auth/account-status", () => {
  it("returns 401 for an anonymous caller", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("reports emailVerified false for an unverified user when email is configured", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ emailVerified: false, verificationAvailable: true });
  });

  it("reports emailVerified true for a verified user", async () => {
    getCurrentUserMock.mockResolvedValue({
      id: "user-1",
      email: "user@example.com",
      emailVerifiedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ emailVerified: true, verificationAvailable: true });
  });

  it("reports verificationAvailable false when RESEND_API_KEY is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ emailVerified: false, verificationAvailable: false });
  });

  it("leaks nothing beyond the two booleans", async () => {
    const response = await GET();
    const body = await response.json();

    expect(Object.keys(body).sort()).toEqual(["emailVerified", "verificationAvailable"]);
    expect(typeof body.emailVerified).toBe("boolean");
    expect(typeof body.verificationAvailable).toBe("boolean");
  });
});
