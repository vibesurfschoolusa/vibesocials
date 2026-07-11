import type { User } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// googleTokens.test.ts / linkedinClient.test.ts). route.ts imports both
// `@/lib/db` (a real `new PrismaClient()` requiring DATABASE_URL) and
// `@/lib/auth` (next-auth session lookup) at module scope, so both must be
// mocked before route.ts is imported below — otherwise importing the route
// module would try to construct a real Prisma client and throw.
const { updateMock, getCurrentUserMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      update: updateMock,
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: getCurrentUserMock,
}));

import {
  COMPANY_WEBSITE_MAX_LENGTH,
  DEFAULT_HASHTAGS_MAX_LENGTH,
  NOTIFY_ON_POST_COMPLETE_DEFAULT,
  parseSettingsInput,
  POST,
} from "./route";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "user@example.com",
    name: null,
    passwordHash: null,
    companyWebsite: null,
    defaultHashtags: null,
    notifyOnPostComplete: true,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
    ...overrides,
  };
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(rawBody: string): Request {
  return new Request("http://localhost/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
}

beforeEach(() => {
  updateMock.mockReset();
  getCurrentUserMock.mockReset();
});

describe("parseSettingsInput", () => {
  it("accepts a body with both fields as valid strings", () => {
    expect(
      parseSettingsInput({ companyWebsite: "example.com", defaultHashtags: "#tag1 #tag2" }),
    ).toEqual({
      ok: true,
      data: {
        companyWebsite: "example.com",
        defaultHashtags: "#tag1 #tag2",
        notifyOnPostComplete: NOTIFY_ON_POST_COMPLETE_DEFAULT,
      },
    });
  });

  it("trims whitespace from valid string fields", () => {
    expect(
      parseSettingsInput({ companyWebsite: "  example.com  ", defaultHashtags: "  #tag  " }),
    ).toEqual({
      ok: true,
      data: {
        companyWebsite: "example.com",
        defaultHashtags: "#tag",
        notifyOnPostComplete: NOTIFY_ON_POST_COMPLETE_DEFAULT,
      },
    });
  });

  it("normalizes missing fields to null", () => {
    expect(parseSettingsInput({})).toEqual({
      ok: true,
      data: {
        companyWebsite: null,
        defaultHashtags: null,
        notifyOnPostComplete: NOTIFY_ON_POST_COMPLETE_DEFAULT,
      },
    });
  });

  it("normalizes explicit null fields to null", () => {
    expect(parseSettingsInput({ companyWebsite: null, defaultHashtags: null })).toEqual({
      ok: true,
      data: {
        companyWebsite: null,
        defaultHashtags: null,
        notifyOnPostComplete: NOTIFY_ON_POST_COMPLETE_DEFAULT,
      },
    });
  });

  it("normalizes empty and whitespace-only strings to null", () => {
    expect(parseSettingsInput({ companyWebsite: "", defaultHashtags: "   " })).toEqual({
      ok: true,
      data: {
        companyWebsite: null,
        defaultHashtags: null,
        notifyOnPostComplete: NOTIFY_ON_POST_COMPLETE_DEFAULT,
      },
    });
  });

  it("ignores unknown top-level fields", () => {
    expect(
      parseSettingsInput({
        companyWebsite: "example.com",
        defaultHashtags: "#tag",
        admin: true,
        extra: "field",
      }),
    ).toEqual({
      ok: true,
      data: {
        companyWebsite: "example.com",
        defaultHashtags: "#tag",
        notifyOnPostComplete: NOTIFY_ON_POST_COMPLETE_DEFAULT,
      },
    });
  });

  it("rejects a body that is not a JSON object", () => {
    const expected = { ok: false, error: "Request body must be a JSON object" };
    expect(parseSettingsInput("hello")).toEqual(expected);
    expect(parseSettingsInput(42)).toEqual(expected);
    expect(parseSettingsInput(true)).toEqual(expected);
    expect(parseSettingsInput(null)).toEqual(expected);
    expect(parseSettingsInput(["a", "b"])).toEqual(expected);
  });

  it("rejects a non-string companyWebsite", () => {
    expect(parseSettingsInput({ companyWebsite: 12345 })).toEqual({
      ok: false,
      error: "companyWebsite must be a string",
    });
  });

  it("rejects a non-string defaultHashtags", () => {
    expect(parseSettingsInput({ defaultHashtags: { nested: true } })).toEqual({
      ok: false,
      error: "defaultHashtags must be a string",
    });
  });

  it("rejects an array value for a field", () => {
    expect(parseSettingsInput({ companyWebsite: ["example.com"] })).toEqual({
      ok: false,
      error: "companyWebsite must be a string",
    });
  });

  it(`rejects companyWebsite longer than ${COMPANY_WEBSITE_MAX_LENGTH} characters`, () => {
    expect(
      parseSettingsInput({ companyWebsite: "a".repeat(COMPANY_WEBSITE_MAX_LENGTH + 1) }),
    ).toEqual({
      ok: false,
      error: `companyWebsite must be ${COMPANY_WEBSITE_MAX_LENGTH} characters or fewer`,
    });
  });

  it("accepts companyWebsite at exactly the max length", () => {
    const value = "a".repeat(COMPANY_WEBSITE_MAX_LENGTH);
    expect(parseSettingsInput({ companyWebsite: value })).toEqual({
      ok: true,
      data: {
        companyWebsite: value,
        defaultHashtags: null,
        notifyOnPostComplete: NOTIFY_ON_POST_COMPLETE_DEFAULT,
      },
    });
  });

  it(`rejects defaultHashtags longer than ${DEFAULT_HASHTAGS_MAX_LENGTH} characters`, () => {
    expect(
      parseSettingsInput({ defaultHashtags: "#".repeat(DEFAULT_HASHTAGS_MAX_LENGTH + 1) }),
    ).toEqual({
      ok: false,
      error: `defaultHashtags must be ${DEFAULT_HASHTAGS_MAX_LENGTH} characters or fewer`,
    });
  });

  it("accepts defaultHashtags at exactly the max length", () => {
    const value = "#".repeat(DEFAULT_HASHTAGS_MAX_LENGTH);
    expect(parseSettingsInput({ defaultHashtags: value })).toEqual({
      ok: true,
      data: {
        companyWebsite: null,
        defaultHashtags: value,
        notifyOnPostComplete: NOTIFY_ON_POST_COMPLETE_DEFAULT,
      },
    });
  });

  it("enforces the length limit after trimming, not before", () => {
    const padded = `  ${"a".repeat(COMPANY_WEBSITE_MAX_LENGTH)}  `;
    expect(parseSettingsInput({ companyWebsite: padded })).toEqual({
      ok: true,
      data: {
        companyWebsite: "a".repeat(COMPANY_WEBSITE_MAX_LENGTH),
        defaultHashtags: null,
        notifyOnPostComplete: NOTIFY_ON_POST_COMPLETE_DEFAULT,
      },
    });
  });

  describe("notifyOnPostComplete (Roadmap Phase 6)", () => {
    it("accepts an explicit true", () => {
      expect(parseSettingsInput({ notifyOnPostComplete: true })).toEqual({
        ok: true,
        data: { companyWebsite: null, defaultHashtags: null, notifyOnPostComplete: true },
      });
    });

    it("accepts an explicit false", () => {
      expect(parseSettingsInput({ notifyOnPostComplete: false })).toEqual({
        ok: true,
        data: { companyWebsite: null, defaultHashtags: null, notifyOnPostComplete: false },
      });
    });

    it("normalizes a missing value to the default (true)", () => {
      const result = parseSettingsInput({});
      expect(result.ok).toBe(true);
      expect(result.ok && result.data.notifyOnPostComplete).toBe(true);
    });

    it("normalizes an explicit null to the default (true)", () => {
      expect(parseSettingsInput({ notifyOnPostComplete: null })).toEqual({
        ok: true,
        data: { companyWebsite: null, defaultHashtags: null, notifyOnPostComplete: true },
      });
    });

    it("rejects a non-boolean value", () => {
      expect(parseSettingsInput({ notifyOnPostComplete: "yes" })).toEqual({
        ok: false,
        error: "notifyOnPostComplete must be a boolean",
      });
      expect(parseSettingsInput({ notifyOnPostComplete: 1 })).toEqual({
        ok: false,
        error: "notifyOnPostComplete must be a boolean",
      });
    });
  });
});

describe("POST /api/settings", () => {
  it("returns 401 and never touches the database when unauthenticated", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const response = await POST(
      jsonRequest({ companyWebsite: "example.com", notifyOnPostComplete: false }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body instead of a 500", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());

    const response = await POST(rawRequest("{not valid json"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 and never touches the database for an invalid field type", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());

    const response = await POST(jsonRequest({ companyWebsite: 42 }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "companyWebsite must be a string",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 and never touches the database for an oversized field", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());

    const response = await POST(
      jsonRequest({ defaultHashtags: "#".repeat(DEFAULT_HASHTAGS_MAX_LENGTH + 1) }),
    );

    expect(response.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 and never touches the database for a non-boolean notifyOnPostComplete", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());

    const response = await POST(jsonRequest({ notifyOnPostComplete: "sure" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "notifyOnPostComplete must be a boolean",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("persists trimmed valid input and returns { success: true }, unchanged from before", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser({ id: "user-42" }));
    updateMock.mockResolvedValue(makeUser());

    const response = await POST(
      jsonRequest({ companyWebsite: "  example.com  ", defaultHashtags: "  #tag  " }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "user-42" },
      data: {
        companyWebsite: "example.com",
        defaultHashtags: "#tag",
        notifyOnPostComplete: NOTIFY_ON_POST_COMPLETE_DEFAULT,
      },
    });
  });

  it("persists null for empty fields, matching prior `field || null` behavior", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser({ id: "user-42" }));
    updateMock.mockResolvedValue(makeUser());

    const response = await POST(jsonRequest({ companyWebsite: "", defaultHashtags: "" }));

    expect(response.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "user-42" },
      data: {
        companyWebsite: null,
        defaultHashtags: null,
        notifyOnPostComplete: NOTIFY_ON_POST_COMPLETE_DEFAULT,
      },
    });
  });

  it("persists notifyOnPostComplete: false (the toggle's whole purpose)", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser({ id: "user-42" }));
    updateMock.mockResolvedValue(makeUser({ notifyOnPostComplete: false }));

    const response = await POST(
      jsonRequest({
        companyWebsite: "example.com",
        defaultHashtags: "#tag",
        notifyOnPostComplete: false,
      }),
    );

    expect(response.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "user-42" },
      data: {
        companyWebsite: "example.com",
        defaultHashtags: "#tag",
        notifyOnPostComplete: false,
      },
    });
  });

  it("returns 500 when the database update fails", async () => {
    getCurrentUserMock.mockResolvedValue(makeUser());
    updateMock.mockRejectedValue(new Error("db down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(jsonRequest({ companyWebsite: "example.com" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to update settings" });

    consoleSpy.mockRestore();
  });
});
