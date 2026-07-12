import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts). route.ts imports `@/lib/db` (a real
// `new PrismaClient()` requiring DATABASE_URL) at module scope, so it must be
// mocked before route.ts is imported below — otherwise importing the route
// module would try to construct a real Prisma client and throw. route.ts also
// imports `bcryptjs` directly; left un-mocked here and asserted on the hash
// shape instead (cheap enough at cost 10 for a unit test).
const { findUniqueMock, createMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  createMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
      create: createMock,
    },
  },
}));

import { POST } from "./route";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  findUniqueMock.mockReset();
  createMock.mockReset();
});

describe("POST /api/auth/register", () => {
  it("returns 400 when email and password are missing", async () => {
    const response = await POST(jsonRequest({}));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Email and password are required.",
    });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid email address", async () => {
    const response = await POST(
      jsonRequest({ email: "not-an-email", password: "goodpassword" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Enter a valid email address.",
    });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a password shorter than 8 characters", async () => {
    const response = await POST(
      jsonRequest({ email: "user@example.com", password: "short" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Password must be at least 8 characters.",
    });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 400 when a user with that email already exists", async () => {
    findUniqueMock.mockResolvedValue({ id: "existing-user", email: "user@example.com" });

    const response = await POST(
      jsonRequest({ email: "user@example.com", password: "goodpassword" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A user with that email already exists.",
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates the user, hashes the password, and returns 201 on the happy path", async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockResolvedValue({
      id: "user-1",
      email: "user@example.com",
      name: "New User",
    });

    const response = await POST(
      jsonRequest({
        email: "user@example.com",
        password: "goodpassword",
        name: "New User",
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "user-1",
      email: "user@example.com",
      name: "New User",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const createArgs = createMock.mock.calls[0][0];
    expect(createArgs.data.email).toBe("user@example.com");
    expect(createArgs.data.name).toBe("New User");
    // The route must persist a bcrypt hash, never the plaintext password.
    expect(typeof createArgs.data.passwordHash).toBe("string");
    expect(createArgs.data.passwordHash).not.toBe("goodpassword");
    expect(createArgs.data.passwordHash.length).toBeGreaterThan(0);
  });
});
