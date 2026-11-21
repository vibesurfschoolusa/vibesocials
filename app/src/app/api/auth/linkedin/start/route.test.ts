import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * R65 client-journey-2 L1: the vanity-name hint can be a person's own profile
 * address pasted into the setup dialog, so the start route logs only that a
 * hint was sent, never its value. The hint still rides the state as before.
 */
vi.mock("@/lib/workspace", () => ({
  requireOwnerContextForOAuthStart: vi.fn(async () => ({ user: { id: "user-1" }, workspace: { id: "ws-1" } })),
}));
vi.mock("@/lib/oauthState", () => ({ createOAuthState: vi.fn(() => "signed-state") }));

import { GET } from "./route";

const HINT = "https://www.linkedin.com/in/jane-doe";
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  vi.stubEnv("LINKEDIN_CLIENT_ID", "li-id");
  vi.stubEnv("LINKEDIN_REDIRECT_URI", "https://app.example.com/api/auth/linkedin/callback");
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

function start(query: string): Promise<Response> {
  return GET(new NextRequest(`https://app.example.com/api/auth/linkedin/start?workspaceId=ws-1${query}`));
}

function stateOf(response: Response): string {
  return new URL(response.headers.get("location")!).searchParams.get("state")!;
}

describe("LinkedIn start: the vanity-name hint", () => {
  it("a profile-address hint is never logged, only that one was sent", async () => {
    await start(`&vanity_name=${encodeURIComponent(HINT)}`);
    expect(logged.join("\n")).not.toContain("jane-doe");
    expect(logged.join("\n")).toContain('"hasVanityName":true');
  });

  it("the hint still rides the state, after the signed part", async () => {
    const response = await start(`&vanity_name=${encodeURIComponent(HINT)}`);
    expect(stateOf(response)).toBe(`signed-state.${Buffer.from(HINT, "utf8").toString("base64url")}`);
  });

  it("no hint: the state is the signed part alone, and no hint is logged", async () => {
    const response = await start("");
    expect(stateOf(response)).toBe("signed-state");
    expect(logged.join("\n")).not.toContain("hasVanityName");
  });
});
