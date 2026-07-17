import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findOrCreateGoogleSsoUser, googleSsoConfig } from "./googleSso";

const { findUniqueMock, createMock, updateMock, transactionMock, provisionMock } =
  vi.hoisted(() => ({
    findUniqueMock: vi.fn(),
    createMock: vi.fn(),
    updateMock: vi.fn(),
    transactionMock: vi.fn(),
    provisionMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
      update: updateMock,
    },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/workspace", () => ({
  provisionPersonalWorkspace: provisionMock,
}));

// The $transaction mock hands the callback a tx whose user.create is
// createMock — mirroring how the register route uses the same shape.
const tx = { user: { create: createMock } };

beforeEach(() => {
  findUniqueMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  provisionMock.mockReset();
  provisionMock.mockResolvedValue({ workspaceId: "ws-1" });
  transactionMock.mockReset();
  transactionMock.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("googleSsoConfig", () => {
  it("is null when either env var is missing or blank (the default today)", () => {
    vi.stubEnv("GOOGLE_SSO_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_SSO_CLIENT_SECRET", "");
    expect(googleSsoConfig()).toBeNull();

    vi.stubEnv("GOOGLE_SSO_CLIENT_ID", "id-only");
    expect(googleSsoConfig()).toBeNull();

    vi.stubEnv("GOOGLE_SSO_CLIENT_ID", "   ");
    vi.stubEnv("GOOGLE_SSO_CLIENT_SECRET", "secret");
    expect(googleSsoConfig()).toBeNull();
  });

  it("returns trimmed credentials when both are set", () => {
    vi.stubEnv("GOOGLE_SSO_CLIENT_ID", " id ");
    vi.stubEnv("GOOGLE_SSO_CLIENT_SECRET", " secret ");
    expect(googleSsoConfig()).toEqual({ clientId: "id", clientSecret: "secret" });
  });
});

describe("findOrCreateGoogleSsoUser", () => {
  it("refuses (null) when the email is missing", async () => {
    expect(
      await findOrCreateGoogleSsoUser({ email: null, emailVerified: true }),
    ).toBeNull();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("refuses (null) when Google reports the email as unverified — linking would enable account takeover", async () => {
    expect(
      await findOrCreateGoogleSsoUser({
        email: "victim@example.com",
        emailVerified: false,
      }),
    ).toBeNull();
    expect(
      await findOrCreateGoogleSsoUser({ email: "victim@example.com" }),
    ).toBeNull();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses (null) an existing UNVERIFIED account that has a password — pre-hijack guard, and never stamps it verified", async () => {
    // Attacker seeds a password account for the victim's email (registration
    // needs no verification). The victim's Google sign-in must NOT link to it.
    findUniqueMock.mockResolvedValue({
      id: "u1",
      email: "victim@example.com",
      passwordHash: "attacker-set-hash",
      emailVerifiedAt: null,
    });

    const result = await findOrCreateGoogleSsoUser({
      email: "victim@example.com",
      emailVerified: true,
    });

    expect(result).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("returns an existing verified user as-is without any write (verified password accounts may link)", async () => {
    const existing = {
      id: "u1",
      email: "a@b.co",
      passwordHash: "their-own-hash",
      emailVerifiedAt: new Date(),
    };
    findUniqueMock.mockResolvedValue(existing);

    const result = await findOrCreateGoogleSsoUser({
      email: "a@b.co",
      emailVerified: true,
    });

    expect(result).toBe(existing);
    expect(updateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("stamps emailVerifiedAt on an existing unverified PASSWORDLESS row (Google sign-in proves the mailbox)", async () => {
    const existing = {
      id: "u1",
      email: "a@b.co",
      passwordHash: null,
      emailVerifiedAt: null,
    };
    const stamped = { ...existing, emailVerifiedAt: new Date() };
    findUniqueMock.mockResolvedValue(existing);
    updateMock.mockResolvedValue(stamped);

    const result = await findOrCreateGoogleSsoUser({
      email: "a@b.co",
      emailVerified: true,
    });

    expect(result).toBe(stamped);
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: "u1" });
    expect(Object.keys(arg.data)).toEqual(["emailVerifiedAt"]);
  });

  it("normalizes the email before lookup (Google casing must match our stored form)", async () => {
    findUniqueMock.mockResolvedValue({
      id: "u1",
      passwordHash: null,
      emailVerifiedAt: new Date(),
    });

    await findOrCreateGoogleSsoUser({
      email: "  Person@Example.COM ",
      emailVerified: true,
    });

    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { email: "person@example.com" },
    });
  });

  it("creates a new SSO-only user ATOMICALLY with their personal workspace (register-route shape)", async () => {
    findUniqueMock.mockResolvedValue(null);
    const created = { id: "u-new", email: "new@example.com" };
    createMock.mockResolvedValue(created);

    const result = await findOrCreateGoogleSsoUser({
      email: "new@example.com",
      name: "  Ada Lovelace  ",
      emailVerified: true,
    });

    expect(result).toBe(created);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.email).toBe("new@example.com");
    expect(arg.data.name).toBe("Ada Lovelace");
    expect(arg.data.passwordHash).toBeNull();
    expect(arg.data.emailVerifiedAt).toBeInstanceOf(Date);
    // Workspace provisioned inside the SAME transaction, with the created row.
    expect(provisionMock).toHaveBeenCalledWith(tx, created);
  });

  it("re-resolves on a unique-email race (P2002) so the winner's row still passes the linking rules", async () => {
    const winner = {
      id: "u-winner",
      passwordHash: null,
      emailVerifiedAt: new Date(),
    };
    findUniqueMock
      .mockResolvedValueOnce(null) // pre-create lookup: not there yet
      .mockResolvedValueOnce(winner); // re-resolution: winner's row
    const raceError = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    });
    transactionMock.mockRejectedValueOnce(raceError);

    const result = await findOrCreateGoogleSsoUser({
      email: "race@example.com",
      emailVerified: true,
    });

    expect(result).toBe(winner);
  });

  it("REFUSES after a P2002 race when the winner is a concurrent unverified password registration", async () => {
    findUniqueMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "u-pw",
        passwordHash: "their-hash",
        emailVerifiedAt: null,
      });
    transactionMock.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const result = await findOrCreateGoogleSsoUser({
      email: "race@example.com",
      emailVerified: true,
    });

    expect(result).toBeNull();
  });

  it("rethrows a create failure that is NOT a unique race", async () => {
    findUniqueMock.mockResolvedValue(null);
    transactionMock.mockRejectedValueOnce(new Error("db down"));

    await expect(
      findOrCreateGoogleSsoUser({ email: "x@example.com", emailVerified: true }),
    ).rejects.toThrow("db down");
  });
});
