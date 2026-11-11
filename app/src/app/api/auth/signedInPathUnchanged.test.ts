import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Platform } from "@prisma/client";

/**
 * Client connect link (16): the signed-in connect flow that platform reviewers
 * test on the live site must not change. This table records, for each of the
 * eight callbacks and each signed-in outcome, the response (status and every
 * header) and the full sequence of calls the callback makes: database calls
 * with their arguments, the session and owner checks, every provider request
 * and every log line. The snapshot was written with the callbacks as they were
 * before the connect link existed, and every later change must leave it equal.
 */

const h = vi.hoisted(() => {
  const calls: unknown[][] = [];
  const answers: Record<string, (...args: unknown[]) => unknown> = {};

  // Dates as ISO text so the record is plain data; everything else as is.
  const clean = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

  const prisma = new Proxy(
    {},
    {
      get(_target, model: string) {
        if (model === "$transaction") {
          return async (operations: Array<Promise<unknown>>) => {
            calls.push(["prisma.$transaction", operations.length]);
            return Promise.all(operations);
          };
        }
        return new Proxy(
          {},
          {
            get(_inner, method: string) {
              return (...args: unknown[]) => {
                calls.push([`prisma.${model}.${method}`, ...args.map(clean)]);
                const answer = answers[`${model}.${method}`];
                return Promise.resolve(answer ? answer(...args) : null);
              };
            },
          },
        );
      },
    },
  );

  const recorder = (name: string, result: () => unknown) =>
    (...args: unknown[]) => {
      calls.push([name, ...args.map(clean)]);
      return result();
    };

  return { calls, answers, clean, prisma, recorder, session: { user: null as { id: string } | null }, owner: { value: true } };
});

vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: h.recorder("getCurrentUser", async () => h.session.user),
}));
vi.mock("@/lib/workspace", () => ({
  isWorkspaceOwner: h.recorder("isWorkspaceOwner", async () => h.owner.value),
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    debug: h.recorder("logger.debug", () => undefined),
    info: h.recorder("logger.info", () => undefined),
    warn: h.recorder("logger.warn", () => undefined),
    error: h.recorder("logger.error", () => undefined),
  },
}));

import { createOAuthState } from "@/lib/oauthState";
import { GET as facebookPageGET } from "./facebook_page/callback/route";
import { GET as gbpGET } from "./google_business_profile/callback/route";
import { GET as instagramGET } from "./instagram/callback/route";
import { GET as linkedinGET } from "./linkedin/callback/route";
import { GET as pinterestGET } from "./pinterest/callback/route";
import { GET as tiktokGET } from "./tiktok/callback/route";
import { GET as xGET } from "./x/callback/route";
import { GET as youtubeGET } from "./youtube/callback/route";

const ORIGIN = "https://app.example.com";
const OWNER = "user-owner";
const WORKSPACE = "ws-1";
const NOW = new Date("2026-11-11T08:00:00.000Z");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Each provider answered with the least its happy path reads, one account each. */
const PROVIDERS: Record<Platform, (url: string) => Response> = {
  tiktok: (url) =>
    url.includes("/user/info")
      ? json({ data: { user: { display_name: "Brand" } } })
      : json({ access_token: "tt-access", open_id: "open-1", scope: "user.info.basic", token_type: "Bearer" }),
  youtube: (url) =>
    url.includes("youtube/v3/channels")
      ? json({ items: [{ id: "chan-1", snippet: { title: "My Channel" } }] })
      : json({ access_token: "yt-access", expires_in: 3600, token_type: "Bearer" }),
  google_business_profile: () => json({ access_token: "gbp-access", token_type: "Bearer" }),
  instagram: (url) => {
    if (url.includes("/me/accounts")) {
      return json({
        data: [{ id: "page-1", name: "Page", access_token: "page-token", instagram_business_account: { id: "ig-1" } }],
      });
    }
    if (url.includes("/ig-1")) return json({ username: "brand" });
    return json({ access_token: "fb-user-token", expires_in: 5184000 });
  },
  facebook_page: (url) =>
    url.includes("/me/accounts")
      ? json({ data: [{ id: "page-1", name: "Page", access_token: "page-token" }] })
      : json({ access_token: "fb-user-token", expires_in: 5184000 }),
  linkedin: (url) => {
    if (url.includes("oauth/v2/accessToken")) {
      return json({ access_token: "li-access", expires_in: 3600, scope: "w_organization_social" });
    }
    if (url.includes("/rest/organizationAcls")) {
      return json({
        elements: [
          { role: "ADMINISTRATOR", organization: "urn:li:organization:101", roleAssignee: "urn:li:person:m", state: "APPROVED" },
        ],
        paging: { count: 10, start: 0, links: [] },
      });
    }
    if (url.includes("/rest/organizations/101")) return json({ id: 101, localizedName: "Org" });
    return new Response("not found", { status: 404 });
  },
  pinterest: (url) => {
    if (url.includes("/v5/oauth/token")) {
      return json({
        access_token: "pin-access",
        refresh_token: "pin-refresh",
        expires_in: 2592000,
        scope: "boards:read,boards:write,pins:read,pins:write,user_accounts:read",
        token_type: "bearer",
      });
    }
    if (url.includes("/v5/user_account")) return json({ id: "9001", username: "brand", account_type: "BUSINESS" });
    if (url.includes("/v5/boards")) return json({ items: [{ id: "555", name: "Board", privacy: "PUBLIC" }], bookmark: null });
    return new Response("not found", { status: 404 });
  },
  x: () => new Response("oauth_token=access-token&oauth_token_secret=access-secret&screen_name=brand&user_id=42"),
};

type Handler = (request: NextRequest) => Promise<Response>;

const CALLBACKS: Array<{ platform: Platform; GET: Handler }> = [
  { platform: "tiktok", GET: tiktokGET },
  { platform: "youtube", GET: youtubeGET },
  { platform: "google_business_profile", GET: gbpGET },
  { platform: "instagram", GET: instagramGET },
  { platform: "facebook_page", GET: facebookPageGET },
  { platform: "linkedin", GET: linkedinGET },
  { platform: "pinterest", GET: pinterestGET },
  { platform: "x", GET: xGET as Handler },
];

type Outcome =
  | "provider_error"
  | "missing_params"
  | "invalid_state"
  | "no_session"
  | "wrong_session"
  | "not_owner"
  | "success";

const OUTCOMES: Outcome[] = [
  "provider_error",
  "missing_params",
  "invalid_state",
  "no_session",
  "wrong_session",
  "not_owner",
  "success",
];

function handshakeRow() {
  return {
    token: "req-token",
    tokenSecret: "req-token-secret",
    userId: OWNER,
    workspaceId: WORKSPACE,
    expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
    createdAt: NOW,
  };
}

function requestFor(platform: Platform, outcome: Outcome, cookie?: string): NextRequest {
  const url = new URL(`/api/auth/${platform}/callback`, ORIGIN);
  if (platform === "x") {
    if (outcome === "provider_error") {
      url.searchParams.set("denied", "req-token");
    } else {
      url.searchParams.set("oauth_token", "req-token");
      if (outcome !== "missing_params") url.searchParams.set("oauth_verifier", "the-verifier");
    }
  } else {
    const state = outcome === "invalid_state" ? "not-a-signed-state" : createOAuthState({ userId: OWNER, workspaceId: WORKSPACE });
    if (outcome === "provider_error") url.searchParams.set("error", "access_denied");
    else if (outcome !== "missing_params") url.searchParams.set("code", "auth-code");
    url.searchParams.set("state", state);
  }
  return new NextRequest(url, cookie ? { headers: { cookie } } : undefined);
}

function arrange(platform: Platform, outcome: Outcome) {
  h.session.user = outcome === "no_session" ? null : { id: outcome === "wrong_session" ? "user-other" : OWNER };
  h.owner.value = outcome !== "not_owner";
  h.answers["oAuthHandshake.findUnique"] = () => (outcome === "invalid_state" ? null : handshakeRow());
  h.answers["socialConnection.upsert"] = () => ({ id: "conn-1" });
  h.answers["pendingConnection.create"] = () => ({ id: "pending-1" });
  h.answers["pendingConnection.deleteMany"] = () => ({ count: 0 });
  h.answers["oAuthHandshake.delete"] = () => ({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      h.calls.push(["fetch", init?.method ?? "GET", String(input)]);
      return PROVIDERS[platform](String(input));
    }),
  );
}

async function run(platform: Platform, GET: Handler, outcome: Outcome, cookie?: string) {
  arrange(platform, outcome);
  const res = await GET(requestFor(platform, outcome, cookie));
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    calls: [...h.calls],
  };
}

beforeEach(() => {
  h.calls.length = 0;
  for (const key of Object.keys(h.answers)) delete h.answers[key];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(Math, "random").mockReturnValue(0.5);

  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
  vi.stubEnv("NEXTAUTH_URL", ORIGIN);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("TIKTOK_CLIENT_KEY", "tt-key");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", "tt-secret");
  vi.stubEnv("TIKTOK_REDIRECT_URI", `${ORIGIN}/api/auth/tiktok/callback`);
  vi.stubEnv("GOOGLE_GBP_CLIENT_ID", "g-id");
  vi.stubEnv("GOOGLE_GBP_CLIENT_SECRET", "g-secret");
  vi.stubEnv("GOOGLE_GBP_REDIRECT_URI", `${ORIGIN}/api/auth/google_business_profile/callback`);
  vi.stubEnv("YOUTUBE_REDIRECT_URI", `${ORIGIN}/api/auth/youtube/callback`);
  vi.stubEnv("FACEBOOK_APP_ID", "fb-id");
  vi.stubEnv("FACEBOOK_APP_SECRET", "fb-secret");
  vi.stubEnv("INSTAGRAM_REDIRECT_URI", `${ORIGIN}/api/auth/instagram/callback`);
  vi.stubEnv("FACEBOOK_PAGE_REDIRECT_URI", `${ORIGIN}/api/auth/facebook_page/callback`);
  vi.stubEnv("LINKEDIN_CLIENT_ID", "li-id");
  vi.stubEnv("LINKEDIN_CLIENT_SECRET", "li-secret");
  vi.stubEnv("LINKEDIN_REDIRECT_URI", `${ORIGIN}/api/auth/linkedin/callback`);
  vi.stubEnv("PINTEREST_APP_ID", "1234567");
  vi.stubEnv("PINTEREST_APP_SECRET", "pin-secret");
  vi.stubEnv("PINTEREST_REDIRECT_URI", `${ORIGIN}/api/auth/pinterest/callback`);
  vi.stubEnv("X_CONSUMER_KEY", "x-key");
  vi.stubEnv("X_CONSUMER_SECRET", "x-secret");
  vi.stubEnv("X_CALLBACK_URL", `${ORIGIN}/api/auth/x/callback`);

  // The callbacks log through console.* as well: those lines are part of the record.
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      h.calls.push([`console.${method}`, ...args.map((arg) => (arg instanceof Error ? `Error: ${arg.message}` : h.clean(arg)))]);
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(CALLBACKS)("$platform callback, signed in: unchanged", ({ platform, GET }) => {
  it.each(OUTCOMES)("%s", async (outcome) => {
    expect(await run(platform, GET, outcome)).toMatchSnapshot();
  });

  it("an ordinary flow in a browser that also holds a connect-link cookie is handled exactly the same", async () => {
    const plain = await run(platform, GET, "success");
    h.calls.length = 0;
    const withCookie = await run(platform, GET, "success", "vs_connect=enc%3Av1%3Aanything");
    // X has no state to tell a link flow by, so with the cookie present (and
    // only then) the handshake row may be read once more first, by its token.
    // Nothing else may differ.
    if (
      platform === "x" &&
      withCookie.calls.length === plain.calls.length + 1 &&
      JSON.stringify(withCookie.calls[0]) === JSON.stringify(["prisma.oAuthHandshake.findUnique", { where: { token: "req-token" } }])
    ) {
      withCookie.calls.shift();
    }
    expect(withCookie).toEqual(plain);
  });
});
