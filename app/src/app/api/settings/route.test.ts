import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock + vi.hoisted are hoisted above imports by vitest (mirrors
// workspaces/switch/route.test.ts). route.ts imports `@/lib/db` (a real
// `new PrismaClient()` requiring DATABASE_URL) and `@/lib/workspace` (the
// shared workspace-context resolver) at module scope, so both must be
// mocked before route.ts is imported below — otherwise importing the route
// module would try to construct a real Prisma client and throw.
const { workspaceUpdateMock, userUpdateMock, getWorkspaceContextMock } = vi.hoisted(() => ({
  workspaceUpdateMock: vi.fn(),
  userUpdateMock: vi.fn(),
  getWorkspaceContextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { update: workspaceUpdateMock },
    user: { update: userUpdateMock },
  },
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspaceContext: getWorkspaceContextMock,
}));

import {
  COMPANY_WEBSITE_MAX_LENGTH,
  DEFAULT_HASHTAGS_MAX_LENGTH,
  NOTIFY_ON_POST_COMPLETE_DEFAULT,
  OWNER_ONLY_FOOTER_ERROR,
  parseSettingsInput,
  POST,
  touchesWorkspaceFooter,
} from "./route";

const OWNER_CONTEXT = {
  user: { id: "user-owner", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "owner" as const,
  memberCount: 2,
};

const MEMBER_CONTEXT = {
  user: { id: "user-member", email: "member@example.com", name: "Member" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "member" as const,
  memberCount: 2,
};

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
  workspaceUpdateMock.mockReset();
  userUpdateMock.mockReset();
  getWorkspaceContextMock.mockReset();
});

describe("parseSettingsInput", () => {
  // Team Workspaces (Task 6, design §4): the footer fields and
  // notifyOnPostComplete now write to different rows (workspace vs. user)
  // with different role gates, so the parser switched from
  // full-replace-with-defaults to presence-based partial update — a key
  // absent from the body is OMITTED from `data` entirely (not normalized to
  // null/a default), so the caller can tell "not touching this field" apart
  // from "clearing it to null".
  it("returns an empty data object when the body has no recognized keys", () => {
    expect(parseSettingsInput({})).toEqual({ ok: true, data: {} });
  });

  it("includes only the keys present in the body", () => {
    expect(parseSettingsInput({ companyWebsite: "example.com" })).toEqual({
      ok: true,
      data: { companyWebsite: "example.com" },
    });
    expect(parseSettingsInput({ notifyOnPostComplete: false })).toEqual({
      ok: true,
      data: { notifyOnPostComplete: false },
    });
  });

  it("accepts all three fields together as valid values", () => {
    expect(
      parseSettingsInput({
        companyWebsite: "example.com",
        defaultHashtags: "#tag1 #tag2",
        notifyOnPostComplete: false,
      }),
    ).toEqual({
      ok: true,
      data: {
        companyWebsite: "example.com",
        defaultHashtags: "#tag1 #tag2",
        notifyOnPostComplete: false,
      },
    });
  });

  it("trims whitespace from valid string fields", () => {
    expect(
      parseSettingsInput({ companyWebsite: "  example.com  ", defaultHashtags: "  #tag  " }),
    ).toEqual({
      ok: true,
      data: { companyWebsite: "example.com", defaultHashtags: "#tag" },
    });
  });

  it("normalizes an explicit null to null (present, cleared) rather than omitting the key", () => {
    expect(parseSettingsInput({ companyWebsite: null, defaultHashtags: null })).toEqual({
      ok: true,
      data: { companyWebsite: null, defaultHashtags: null },
    });
  });

  it("normalizes empty and whitespace-only strings to null", () => {
    expect(parseSettingsInput({ companyWebsite: "", defaultHashtags: "   " })).toEqual({
      ok: true,
      data: { companyWebsite: null, defaultHashtags: null },
    });
  });

  it("ignores unknown top-level fields", () => {
    expect(
      parseSettingsInput({ companyWebsite: "example.com", admin: true, extra: "field" }),
    ).toEqual({
      ok: true,
      data: { companyWebsite: "example.com" },
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
      data: { companyWebsite: value },
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
      data: { defaultHashtags: value },
    });
  });

  it("enforces the length limit after trimming, not before", () => {
    const padded = `  ${"a".repeat(COMPANY_WEBSITE_MAX_LENGTH)}  `;
    expect(parseSettingsInput({ companyWebsite: padded })).toEqual({
      ok: true,
      data: { companyWebsite: "a".repeat(COMPANY_WEBSITE_MAX_LENGTH) },
    });
  });

  describe("notifyOnPostComplete (Roadmap Phase 6)", () => {
    it("accepts an explicit true", () => {
      expect(parseSettingsInput({ notifyOnPostComplete: true })).toEqual({
        ok: true,
        data: { notifyOnPostComplete: true },
      });
    });

    it("accepts an explicit false", () => {
      expect(parseSettingsInput({ notifyOnPostComplete: false })).toEqual({
        ok: true,
        data: { notifyOnPostComplete: false },
      });
    });

    it("normalizes an explicit null (present) to the default (true)", () => {
      expect(parseSettingsInput({ notifyOnPostComplete: null })).toEqual({
        ok: true,
        data: { notifyOnPostComplete: true },
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

describe("touchesWorkspaceFooter", () => {
  it("is false when neither footer key is present", () => {
    expect(touchesWorkspaceFooter({})).toBe(false);
    expect(touchesWorkspaceFooter({ notifyOnPostComplete: true })).toBe(false);
  });

  it("is true when companyWebsite is present, even if null", () => {
    expect(touchesWorkspaceFooter({ companyWebsite: "a.com" })).toBe(true);
    expect(touchesWorkspaceFooter({ companyWebsite: null })).toBe(true);
  });

  it("is true when defaultHashtags is present, even if null", () => {
    expect(touchesWorkspaceFooter({ defaultHashtags: "#a" })).toBe(true);
    expect(touchesWorkspaceFooter({ defaultHashtags: null })).toBe(true);
  });
});

describe("POST /api/settings", () => {
  it("returns 401 and never touches the database when unauthenticated", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    const response = await POST(
      jsonRequest({ companyWebsite: "example.com", notifyOnPostComplete: false }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(workspaceUpdateMock).not.toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body instead of a 500", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);

    const response = await POST(rawRequest("{not valid json"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(workspaceUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 and never touches the database for an invalid field type", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);

    const response = await POST(jsonRequest({ companyWebsite: 42 }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "companyWebsite must be a string",
    });
    expect(workspaceUpdateMock).not.toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 and never touches the database for an oversized field", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);

    const response = await POST(
      jsonRequest({ defaultHashtags: "#".repeat(DEFAULT_HASHTAGS_MAX_LENGTH + 1) }),
    );

    expect(response.status).toBe(400);
    expect(workspaceUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 400 and never touches the database for a non-boolean notifyOnPostComplete", async () => {
    getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);

    const response = await POST(jsonRequest({ notifyOnPostComplete: "sure" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "notifyOnPostComplete must be a boolean",
    });
    expect(workspaceUpdateMock).not.toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  describe("owner", () => {
    beforeEach(() => {
      getWorkspaceContextMock.mockResolvedValue(OWNER_CONTEXT);
      workspaceUpdateMock.mockResolvedValue({});
      userUpdateMock.mockResolvedValue({});
    });

    it("persists trimmed footer fields to the workspace row, keyed by the active workspace id", async () => {
      const response = await POST(
        jsonRequest({ companyWebsite: "  example.com  ", defaultHashtags: "  #tag  " }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
      expect(workspaceUpdateMock).toHaveBeenCalledWith({
        where: { id: "ws-1" },
        data: { companyWebsite: "example.com", defaultHashtags: "#tag" },
      });
      expect(userUpdateMock).not.toHaveBeenCalled();
    });

    it("persists null for empty footer fields, matching prior `field || null` behavior", async () => {
      const response = await POST(jsonRequest({ companyWebsite: "", defaultHashtags: "" }));

      expect(response.status).toBe(200);
      expect(workspaceUpdateMock).toHaveBeenCalledWith({
        where: { id: "ws-1" },
        data: { companyWebsite: null, defaultHashtags: null },
      });
    });

    it("sending only notifyOnPostComplete writes only the user row, not the workspace", async () => {
      const response = await POST(jsonRequest({ notifyOnPostComplete: false }));

      expect(response.status).toBe(200);
      expect(userUpdateMock).toHaveBeenCalledWith({
        where: { id: "user-owner" },
        data: { notifyOnPostComplete: false },
      });
      expect(workspaceUpdateMock).not.toHaveBeenCalled();
    });

    it("sending footer fields + notifyOnPostComplete together writes both rows", async () => {
      const response = await POST(
        jsonRequest({
          companyWebsite: "example.com",
          defaultHashtags: "#tag",
          notifyOnPostComplete: false,
        }),
      );

      expect(response.status).toBe(200);
      expect(workspaceUpdateMock).toHaveBeenCalledWith({
        where: { id: "ws-1" },
        data: { companyWebsite: "example.com", defaultHashtags: "#tag" },
      });
      expect(userUpdateMock).toHaveBeenCalledWith({
        where: { id: "user-owner" },
        data: { notifyOnPostComplete: false },
      });
    });

    it("sending only companyWebsite (not defaultHashtags) writes only that key", async () => {
      const response = await POST(jsonRequest({ companyWebsite: "example.com" }));

      expect(response.status).toBe(200);
      expect(workspaceUpdateMock).toHaveBeenCalledWith({
        where: { id: "ws-1" },
        data: { companyWebsite: "example.com" },
      });
    });

    it("returns 200 with no writes for an empty body", async () => {
      const response = await POST(jsonRequest({}));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
      expect(workspaceUpdateMock).not.toHaveBeenCalled();
      expect(userUpdateMock).not.toHaveBeenCalled();
    });

    it("returns 500 when the workspace update fails", async () => {
      workspaceUpdateMock.mockRejectedValue(new Error("db down"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await POST(jsonRequest({ companyWebsite: "example.com" }));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Failed to update settings" });

      consoleSpy.mockRestore();
    });

    it("returns 500 when the user update fails", async () => {
      userUpdateMock.mockRejectedValue(new Error("db down"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await POST(jsonRequest({ notifyOnPostComplete: false }));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Failed to update settings" });

      consoleSpy.mockRestore();
    });
  });

  describe("member", () => {
    beforeEach(() => {
      getWorkspaceContextMock.mockResolvedValue(MEMBER_CONTEXT);
      workspaceUpdateMock.mockResolvedValue({});
      userUpdateMock.mockResolvedValue({});
    });

    it("sending only notifyOnPostComplete succeeds and writes the calling user's own row", async () => {
      const response = await POST(jsonRequest({ notifyOnPostComplete: false }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
      expect(userUpdateMock).toHaveBeenCalledWith({
        where: { id: "user-member" },
        data: { notifyOnPostComplete: false },
      });
      expect(workspaceUpdateMock).not.toHaveBeenCalled();
    });

    it("sending a footer field returns 403 and writes nothing", async () => {
      const response = await POST(jsonRequest({ companyWebsite: "evil.com" }));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: OWNER_ONLY_FOOTER_ERROR });
      expect(workspaceUpdateMock).not.toHaveBeenCalled();
      expect(userUpdateMock).not.toHaveBeenCalled();
    });

    it("sending an explicit-null footer field still 403s (presence, not truthiness, gates it)", async () => {
      const response = await POST(jsonRequest({ companyWebsite: null }));

      expect(response.status).toBe(403);
      expect(workspaceUpdateMock).not.toHaveBeenCalled();
    });

    it("sending footer fields + notifyOnPostComplete together 403s wholesale (no partial apply)", async () => {
      const response = await POST(
        jsonRequest({ companyWebsite: "evil.com", notifyOnPostComplete: false }),
      );

      expect(response.status).toBe(403);
      expect(workspaceUpdateMock).not.toHaveBeenCalled();
      expect(userUpdateMock).not.toHaveBeenCalled();
    });

    it("returns 200 with no writes for an empty body", async () => {
      const response = await POST(jsonRequest({}));

      expect(response.status).toBe(200);
      expect(workspaceUpdateMock).not.toHaveBeenCalled();
      expect(userUpdateMock).not.toHaveBeenCalled();
    });
  });
});

// Coverage for the exported constants staying wired to the schema default
// (Roadmap Phase 6) — kept from the pre-Task-6 suite.
describe("NOTIFY_ON_POST_COMPLETE_DEFAULT", () => {
  it("is true, matching the Prisma schema's @default(true)", () => {
    expect(NOTIFY_ON_POST_COMPLETE_DEFAULT).toBe(true);
  });
});
