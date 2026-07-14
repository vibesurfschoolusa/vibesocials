import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// settings/route.test.ts). route.ts imports `@/lib/db` (a real
// `new PrismaClient()` requiring DATABASE_URL) at module scope, so it must be
// mocked before route.ts is imported below — otherwise importing the route
// module would try to construct a real Prisma client and throw. route.ts also
// imports `bcryptjs` directly; left un-mocked here and asserted on the hash
// shape instead (cheap enough at cost 10 for a unit test).
//
// Task 2 — registration now wraps the User create in `prisma.$transaction`
// together with `provisionPersonalWorkspace` (the REAL implementation runs
// here, against these mocked `workspace`/`workspaceMember` models, so the
// happy-path test below exercises the actual name-rule + owner-role logic).
//
// Task A3 — after the transaction commits, registration fires a best-effort,
// failure-isolated email-verification send. `@/lib/accountToken` and
// `@/lib/accountEmails` are mocked so those tests can assert the hook is gated
// on RESEND_API_KEY and can NEVER fail the 201. `@/lib/logger` is left REAL (its
// console.warn sink is spied where the swallow path is exercised).
const {
  findUniqueMock,
  createMock,
  workspaceCreateMock,
  workspaceMemberCreateMock,
  issueAccountTokenMock,
  buildVerifyEmailMock,
  deliverAccountEmailMock,
  checkRateLimitMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  createMock: vi.fn(),
  workspaceCreateMock: vi.fn(),
  workspaceMemberCreateMock: vi.fn(),
  issueAccountTokenMock: vi.fn(),
  buildVerifyEmailMock: vi.fn(),
  deliverAccountEmailMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const prisma: Record<string, unknown> = {
    user: {
      findUnique: findUniqueMock,
      create: createMock,
    },
    workspace: { create: workspaceCreateMock },
    workspaceMember: { create: workspaceMemberCreateMock },
    $transaction: (cb: (tx: unknown) => unknown) => cb(prisma),
  };
  return { prisma };
});

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: checkRateLimitMock,
}));

vi.mock("@/lib/accountToken", () => ({ issueAccountToken: issueAccountTokenMock }));

vi.mock("@/lib/accountEmails", () => ({
  buildVerifyEmail: buildVerifyEmailMock,
  deliverAccountEmail: deliverAccountEmailMock,
}));

import { POST } from "./route";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function happyPathUser() {
  findUniqueMock.mockResolvedValue(null);
  createMock.mockResolvedValue({
    id: "user-1",
    email: "user@example.com",
    name: "New User",
  });
  workspaceCreateMock.mockResolvedValue({ id: "workspace-1" });
  workspaceMemberCreateMock.mockResolvedValue({});
}

beforeEach(() => {
  findUniqueMock.mockReset();
  createMock.mockReset();
  workspaceCreateMock.mockReset();
  workspaceMemberCreateMock.mockReset();
  issueAccountTokenMock.mockReset();
  buildVerifyEmailMock.mockReset();
  deliverAccountEmailMock.mockReset();
  checkRateLimitMock.mockReset();

  checkRateLimitMock.mockResolvedValue({ allowed: true });
  issueAccountTokenMock.mockResolvedValue("raw-verify-token");
  buildVerifyEmailMock.mockReturnValue({ subject: "Verify your email address", html: "<html>", text: "text" });
  deliverAccountEmailMock.mockResolvedValue(true);

  // Deterministic baseline: email disabled, so the existing tests never touch
  // the verification hook. The hook-specific tests below stub the key explicitly.
  vi.stubEnv("RESEND_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

  it("returns the same 201 shape when a user with that email already exists (no oracle)", async () => {
    findUniqueMock.mockResolvedValue({ id: "existing-user", email: "user@example.com" });

    const response = await POST(
      jsonRequest({ email: "user@example.com", password: "goodpassword", name: "Hacker" }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "ok",
      email: "user@example.com",
      name: "Hacker",
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
    workspaceCreateMock.mockResolvedValue({ id: "workspace-1" });
    workspaceMemberCreateMock.mockResolvedValue({});

    const response = await POST(
      jsonRequest({
        email: "User@Example.com",
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

    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "auth/register",
        failClosed: true,
      }),
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    const createArgs = createMock.mock.calls[0][0];
    // Email is always stored normalized (trim + lowercase).
    expect(createArgs.data.email).toBe("user@example.com");
    expect(createArgs.data.name).toBe("New User");
    // The route must persist a bcrypt hash, never the plaintext password.
    expect(typeof createArgs.data.passwordHash).toBe("string");
    expect(createArgs.data.passwordHash).not.toBe("goodpassword");
    expect(createArgs.data.passwordHash.length).toBeGreaterThan(0);

    // Task 2 — registration provisions a personal workspace + owner
    // membership in the same transaction as the User row.
    expect(workspaceCreateMock).toHaveBeenCalledWith({
      data: {
        name: "New User's workspace",
      },
    });
    expect(workspaceMemberCreateMock).toHaveBeenCalledWith({
      data: { workspaceId: "workspace-1", userId: "user-1", role: "owner" },
    });
  });

  it("returns 429 when the registration rate limit blocks", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 900 });

    const response = await POST(
      jsonRequest({ email: "user@example.com", password: "goodpassword" }),
    );

    expect(response.status).toBe(429);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("still returns 201 when the verification email REJECTS — the send is fire-and-forget and can never fail registration", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    happyPathUser();
    deliverAccountEmailMock.mockRejectedValue(new Error("resend exploded"));

    const response = await POST(
      jsonRequest({ email: "user@example.com", password: "goodpassword", name: "New User" }),
    );

    // The registration succeeds despite the email work throwing.
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "user-1",
      email: "user@example.com",
      name: "New User",
    });
    // Proof the hook actually ran (issued + attempted delivery) and its
    // rejection was swallowed rather than propagated.
    expect(issueAccountTokenMock).toHaveBeenCalledWith(expect.anything(), "user-1", "email_verify");
    expect(deliverAccountEmailMock).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("does not issue a token or attempt a send when RESEND_API_KEY is unset (issuance is inside the env guard)", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    happyPathUser();

    const response = await POST(
      jsonRequest({ email: "user@example.com", password: "goodpassword", name: "New User" }),
    );

    expect(response.status).toBe(201);
    expect(issueAccountTokenMock).not.toHaveBeenCalled();
    expect(deliverAccountEmailMock).not.toHaveBeenCalled();
  });
});
