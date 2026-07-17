import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findOrCreateGoogleSsoUser, googleSsoConfig } from "./googleSso";

const { findUniqueMock, createMock, updateMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
      create: createMock,
      update: updateMock,
    },
  },
}));

beforeEach(() => {
  findUniqueMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
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

  it("returns an existing verified user as-is without any write", async () => {
    const existing = { id: "u1", email: "a@b.co", emailVerifiedAt: new Date() };
    findUniqueMock.mockResolvedValue(existing);

    const result = await findOrCreateGoogleSsoUser({
      email: "a@b.co",
      emailVerified: true,
    });

    expect(result).toBe(existing);
    expect(updateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("stamps emailVerifiedAt on an existing UNverified user (Google sign-in proves the mailbox)", async () => {
    const existing = { id: "u1", email: "a@b.co", emailVerifiedAt: null };
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
    findUniqueMock.mockResolvedValue({ id: "u1", emailVerifiedAt: new Date() });

    await findOrCreateGoogleSsoUser({
      email: "  Person@Example.COM ",
      emailVerified: true,
    });

    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { email: "person@example.com" },
    });
  });

  it("creates a new SSO-only user: null passwordHash, emailVerifiedAt stamped, name trimmed", async () => {
    findUniqueMock.mockResolvedValue(null);
    const created = { id: "u-new" };
    createMock.mockResolvedValue(created);

    const result = await findOrCreateGoogleSsoUser({
      email: "new@example.com",
      name: "  Ada Lovelace  ",
      emailVerified: true,
    });

    expect(result).toBe(created);
    const arg = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.email).toBe("new@example.com");
    expect(arg.data.name).toBe("Ada Lovelace");
    expect(arg.data.passwordHash).toBeNull();
    expect(arg.data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("adopts the winner's row on a unique-email create race instead of failing the sign-in", async () => {
    const winner = { id: "u-winner" };
    findUniqueMock
      .mockResolvedValueOnce(null) // pre-create lookup: not there yet
      .mockResolvedValueOnce(winner); // post-race lookup: winner's row
    createMock.mockRejectedValue(new Error("Unique constraint failed"));

    const result = await findOrCreateGoogleSsoUser({
      email: "race@example.com",
      emailVerified: true,
    });

    expect(result).toBe(winner);
  });

  it("rethrows a create failure that is NOT a race (no row appeared)", async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockRejectedValue(new Error("db down"));

    await expect(
      findOrCreateGoogleSsoUser({ email: "x@example.com", emailVerified: true }),
    ).rejects.toThrow("db down");
  });
});
