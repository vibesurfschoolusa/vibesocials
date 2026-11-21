import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R65 client-journey-2 L1: the vanity-name hint can be a person's own profile
 * address, so the callback logs only that a hint was sent, never its value.
 * The hint is still looked up exactly as before.
 */
const m = vi.hoisted(() => ({
  findAdministered: vi.fn(),
  lookupById: vi.fn(),
  lookupByVanity: vi.fn(),
  lookupPrevious: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/server/connectLink/callback", () => ({
  withConnectLink:
    (_platform: string, handler: (request: Request, link: null) => Promise<Response>) => (request: Request) =>
      handler(request, null),
}));
vi.mock("@/lib/oauthState", () => ({
  verifyOAuthState: vi.fn(() => ({ valid: true, userId: "user-1", workspaceId: "ws-1" })),
}));
vi.mock("@/lib/oauthCallbackGuard", () => ({
  guardOAuthCallbackSession: vi.fn(async () => null),
  oauthCallbackFailed: ({ error }: { error: unknown }) => {
    throw error;
  },
}));
vi.mock("@/lib/workspace", () => ({ isWorkspaceOwner: vi.fn(async () => true) }));
vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findUnique: vi.fn(async () => null) } } }));
vi.mock("@/lib/fetchWithTimeout", () => ({
  CONNECT_CALL_TIMEOUT_MS: 15_000,
  fetchWithinLimit: vi.fn(async () =>
    Response.json({ access_token: "li-access", expires_in: 3600, scope: "w_organization_social" }),
  ),
}));
vi.mock("@/server/connections/linkedinOrganizations", () => ({
  findAdministeredOrganizations: m.findAdministered,
  lookupOrganization: m.lookupPrevious,
  lookupOrganizationOutcome: m.lookupById,
  lookupOrganizationByVanityNameOutcome: m.lookupByVanity,
}));
vi.mock("@/server/connections/pendingConnection", () => ({ createPendingConnection: vi.fn() }));
vi.mock("@/server/connections/saveConnection", () => ({ saveLinkedInConnection: m.save }));

import { GET } from "./route";

const ORIGIN = "https://app.example.com";
const PROFILE = "https://www.linkedin.com/in/jane-doe";
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  for (const mock of Object.values(m)) mock.mockReset();
  // organizationAcls could not be read, so the fallbacks, the hint among them, run.
  m.findAdministered.mockResolvedValue(null);
  m.lookupById.mockResolvedValue({ outcome: "not_found" });
  m.lookupByVanity.mockResolvedValue({ outcome: "not_found" });
  m.save.mockResolvedValue({ ok: true });
  vi.stubEnv("NEXTAUTH_URL", ORIGIN);
  vi.stubEnv("LINKEDIN_CLIENT_ID", "li-id");
  vi.stubEnv("LINKEDIN_CLIENT_SECRET", "li-secret");
  vi.stubEnv("LINKEDIN_REDIRECT_URI", `${ORIGIN}/api/auth/linkedin/callback`);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function callback(hint: string | null): Promise<Response> {
  const state = hint === null ? "signed" : `signed.${Buffer.from(hint, "utf8").toString("base64url")}`;
  return GET(new Request(`${ORIGIN}/api/auth/linkedin/callback?code=c&state=${encodeURIComponent(state)}`));
}

describe("LinkedIn callback: the vanity-name hint", () => {
  it("a profile-address hint is never logged, and is still looked up as before", async () => {
    const response = await callback(PROFILE);
    expect(logged.join("\n")).not.toContain("jane-doe");
    expect(m.lookupByVanity).toHaveBeenCalledWith("li-access", PROFILE);
    expect(m.lookupById).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/settings?linkedin_setup=not_found`);
  });

  it("a numeric hint is never logged, and is still looked up by id as before", async () => {
    await callback("90210345");
    expect(logged.join("\n")).not.toContain("90210345");
    expect(m.lookupById).toHaveBeenCalledWith("li-access", "90210345");
    expect(m.lookupByVanity).not.toHaveBeenCalled();
  });

  it("a hint that finds the page still connects it, as before", async () => {
    m.lookupByVanity.mockResolvedValue({
      outcome: "found",
      organization: { id: 101, name: "Acme", vanityName: "acme" },
    });
    const response = await callback("acme");
    expect(m.save).toHaveBeenCalledWith(
      expect.objectContaining({ organization: { id: 101, name: "Acme", vanityName: "acme" } }),
    );
    expect(response.headers.get("location")).toContain("success=linkedin_connected");
  });

  it("no hint: no lookup, the setup dialog as before", async () => {
    const response = await callback(null);
    expect(m.lookupById).not.toHaveBeenCalled();
    expect(m.lookupByVanity).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/settings?linkedin_setup=true`);
  });
});
