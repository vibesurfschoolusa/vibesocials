import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findOrCreateGoogleSsoUser, googleSsoConfig, planGoogleSsoLink } from "./googleSso";

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

describe("planGoogleSsoLink (pure linking rules)", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const earlier = new Date("2026-01-01T00:00:00Z");

  it.each([
    {
      label: "no account: create, linked + verified now",
      existing: null,
      expected: { action: "create", data: { googleLinkedAt: now, emailVerifiedAt: now } },
    },
    {
      label: "already linked (with a password): allow, no write",
      existing: { passwordHash: "h", googleLinkedAt: earlier, emailVerifiedAt: earlier },
      expected: { action: "allow" },
    },
    {
      label: "already linked (passwordless): allow, no write",
      existing: { passwordHash: null, googleLinkedAt: earlier, emailVerifiedAt: earlier },
      expected: { action: "allow" },
    },
    {
      label: "unlinked, passwordless, unverified: link and stamp verified",
      existing: { passwordHash: null, googleLinkedAt: null, emailVerifiedAt: null },
      expected: { action: "link", data: { googleLinkedAt: now, emailVerifiedAt: now } },
    },
    {
      label: "unlinked, passwordless, already verified: link, keep the original verified time",
      existing: { passwordHash: null, googleLinkedAt: null, emailVerifiedAt: earlier },
      expected: { action: "link", data: { googleLinkedAt: now } },
    },
    {
      label: "unlinked, password, VERIFIED: refuse (no silent auto-link into a password account)",
      existing: { passwordHash: "h", googleLinkedAt: null, emailVerifiedAt: earlier },
      expected: null,
    },
    {
      label: "unlinked, password, unverified: refuse (pre-hijack guard)",
      existing: { passwordHash: "h", googleLinkedAt: null, emailVerifiedAt: null },
      expected: null,
    },
  ])("$label", ({ existing, expected }) => {
    expect(planGoogleSsoLink(existing, now)).toEqual(expected);
  });
});

describe("findOrCreateGoogleSsoUser", () => {
  it("refuses (unverified_email) when the email is missing", async () => {
    expect(
      await findOrCreateGoogleSsoUser({ email: null, emailVerified: true }),
    ).toEqual({ ok: false, reason: "unverified_email" });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("refuses (unverified_email) when Google reports the email as unverified — linking would enable account takeover", async () => {
    expect(
      await findOrCreateGoogleSsoUser({
        email: "victim@example.com",
        emailVerified: false,
      }),
    ).toEqual({ ok: false, reason: "unverified_email" });
    expect(
      await findOrCreateGoogleSsoUser({ email: "victim@example.com" }),
    ).toEqual({ ok: false, reason: "unverified_email" });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses (password_account) an existing UNVERIFIED account that has a password — pre-hijack guard, and never stamps it", async () => {
    // Attacker seeds a password account for the victim's email (registration
    // needs no verification). The victim's Google sign-in must NOT link to it.
    findUniqueMock.mockResolvedValue({
      id: "u1",
      email: "victim@example.com",
      passwordHash: "attacker-set-hash",
      emailVerifiedAt: null,
      googleLinkedAt: null,
    });

    const result = await findOrCreateGoogleSsoUser({
      email: "victim@example.com",
      emailVerified: true,
    });

    expect(result).toEqual({ ok: false, reason: "password_account" });
    expect(updateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("refuses (password_account) an existing VERIFIED password account that was never linked to Google", async () => {
    findUniqueMock.mockResolvedValue({
      id: "u1",
      email: "a@b.co",
      passwordHash: "their-own-hash",
      emailVerifiedAt: new Date(),
      googleLinkedAt: null,
    });

    const result = await findOrCreateGoogleSsoUser({
      email: "a@b.co",
      emailVerified: true,
    });

    expect(result).toEqual({ ok: false, reason: "password_account" });
    expect(updateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("returns an already-linked user as-is without any write (even with a password)", async () => {
    const existing = {
      id: "u1",
      email: "a@b.co",
      passwordHash: "their-own-hash",
      emailVerifiedAt: new Date(),
      googleLinkedAt: new Date(),
    };
    findUniqueMock.mockResolvedValue(existing);

    const result = await findOrCreateGoogleSsoUser({
      email: "a@b.co",
      emailVerified: true,
    });

    expect(result).toEqual({ ok: true, user: existing });
    expect(updateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("links an unlinked PASSWORDLESS row: stamps googleLinkedAt and emailVerifiedAt (Google sign-in proves the mailbox)", async () => {
    const existing = {
      id: "u1",
      email: "a@b.co",
      passwordHash: null,
      emailVerifiedAt: null,
      googleLinkedAt: null,
    };
    const stamped = { ...existing, emailVerifiedAt: new Date(), googleLinkedAt: new Date() };
    findUniqueMock.mockResolvedValue(existing);
    updateMock.mockResolvedValue(stamped);

    const result = await findOrCreateGoogleSsoUser({
      email: "a@b.co",
      emailVerified: true,
    });

    expect(result).toEqual({ ok: true, user: stamped });
    const arg = updateMock.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: "u1" });
    expect(Object.keys(arg.data).sort()).toEqual(["emailVerifiedAt", "googleLinkedAt"]);
    expect(arg.data.googleLinkedAt).toBeInstanceOf(Date);
    expect(arg.data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("links an unlinked passwordless row that is already verified without touching emailVerifiedAt", async () => {
    findUniqueMock.mockResolvedValue({
      id: "u1",
      email: "a@b.co",
      passwordHash: null,
      emailVerifiedAt: new Date("2026-01-01T00:00:00Z"),
      googleLinkedAt: null,
    });
    updateMock.mockImplementation(async (arg: { data: object }) => ({ id: "u1", ...arg.data }));

    await findOrCreateGoogleSsoUser({ email: "a@b.co", emailVerified: true });

    const arg = updateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(arg.data)).toEqual(["googleLinkedAt"]);
  });

  it("normalizes the email before lookup (Google casing must match our stored form)", async () => {
    findUniqueMock.mockResolvedValue({
      id: "u1",
      passwordHash: null,
      emailVerifiedAt: new Date(),
      googleLinkedAt: new Date(),
    });

    await findOrCreateGoogleSsoUser({
      email: "  Person@Example.COM ",
      emailVerified: true,
    });

    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { email: "person@example.com" },
    });
  });

  it("creates a new SSO-only user — linked and verified — ATOMICALLY with their personal workspace (register-route shape)", async () => {
    findUniqueMock.mockResolvedValue(null);
    const created = { id: "u-new", email: "new@example.com" };
    createMock.mockResolvedValue(created);

    const result = await findOrCreateGoogleSsoUser({
      email: "new@example.com",
      name: "  Ada Lovelace  ",
      emailVerified: true,
    });

    expect(result).toEqual({ ok: true, user: created });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.email).toBe("new@example.com");
    expect(arg.data.name).toBe("Ada Lovelace");
    expect(arg.data.passwordHash).toBeNull();
    expect(arg.data.emailVerifiedAt).toBeInstanceOf(Date);
    expect(arg.data.googleLinkedAt).toBeInstanceOf(Date);
    // Workspace provisioned inside the SAME transaction, with the created row.
    expect(provisionMock).toHaveBeenCalledWith(tx, created);
  });

  it("re-resolves on a unique-email race (P2002) so the winner's row still passes the linking rules", async () => {
    const winner = {
      id: "u-winner",
      passwordHash: null,
      emailVerifiedAt: new Date(),
      googleLinkedAt: new Date(),
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

    expect(result).toEqual({ ok: true, user: winner });
  });

  it("REFUSES after a P2002 race when the winner is a concurrent password registration", async () => {
    findUniqueMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "u-pw",
        passwordHash: "their-hash",
        emailVerifiedAt: null,
        googleLinkedAt: null,
      });
    transactionMock.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const result = await findOrCreateGoogleSsoUser({
      email: "race@example.com",
      emailVerified: true,
    });

    expect(result).toEqual({ ok: false, reason: "password_account" });
  });

  it("rethrows a create failure that is NOT a unique race", async () => {
    findUniqueMock.mockResolvedValue(null);
    transactionMock.mockRejectedValueOnce(new Error("db down"));

    await expect(
      findOrCreateGoogleSsoUser({ email: "x@example.com", emailVerified: true }),
    ).rejects.toThrow("db down");
  });
});
