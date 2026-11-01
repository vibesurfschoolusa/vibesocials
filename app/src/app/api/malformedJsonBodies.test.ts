import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-11-01 audit, Task 8: a JSON body of `null`, an array or a primitive is
// valid JSON but cannot be indexed — several routes used to TypeError -> 500
// on it. Every JSON route now reads its body through `readJsonObject` and
// answers 400 { error: "Invalid JSON body" }. This table drives each route
// with real Request objects and the whole set of bad bodies.
//
// `prisma` is a trap: a route that touches the database BEFORE it has a valid
// body fails loudly here instead of silently passing. (posts, media and
// workspaces/members have the same cases in their own suites.)

const { handleUploadMock } = vi.hoisted(() => ({ handleUploadMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`prisma.${String(prop)} was touched before the body was validated`);
      },
    },
  ),
}));

const CONTEXT = {
  user: { id: "user-1", email: "owner@example.com", name: "Owner" },
  workspace: { id: "ws-1", name: "Acme", companyWebsite: null, defaultHashtags: null },
  role: "owner" as const,
  memberCount: 1,
};

vi.mock("@/lib/workspace", () => ({
  ACTIVE_WORKSPACE_COOKIE: "active_workspace",
  getWorkspaceContext: async () => CONTEXT,
  requireOwnerContext: async () => CONTEXT,
  provisionPersonalWorkspace: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => CONTEXT.user }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/inngest", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@vercel/blob/client", () => ({ handleUpload: handleUploadMock }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { POST as registerPOST } from "./auth/register/route";
import { POST as forgotPasswordPOST } from "./auth/forgot-password/route";
import { POST as resetPasswordPOST } from "./auth/reset-password/route";
import { POST as verifyEmailPOST } from "./auth/verify-email/route";
import { POST as gbpLocationPOST } from "./connections/google_business_profile/location/route";
import { PATCH as postJobPATCH } from "./posts/[postJobId]/route";
import { POST as approvalPOST } from "./posts/[postJobId]/approval/route";
import { POST as retryPOST } from "./posts/[postJobId]/retry/route";
import { POST as autoCaptionPOST } from "./posts/auto-caption/route";
import { POST as enhanceCaptionPOST } from "./posts/enhance-caption/route";
import { POST as draftResponsePOST } from "./reviews/draft-response/route";
import { POST as reviewReplyPOST } from "./reviews/[reviewId]/reply/route";
import { POST as settingsPOST } from "./settings/route";
import { POST as uploadPOST } from "./upload/route";
import { PATCH as workspaceActivePATCH } from "./workspaces/active/route";
import { POST as workspaceSwitchPOST } from "./workspaces/switch/route";

const postJobParams = { params: Promise.resolve({ postJobId: "job-1" }) };

type Call = (request: Request) => Promise<Response>;

const ROUTES: Array<[string, Call]> = [
  ["POST /api/auth/register", (r) => registerPOST(r)],
  ["POST /api/auth/forgot-password", (r) => forgotPasswordPOST(r)],
  ["POST /api/auth/reset-password", (r) => resetPasswordPOST(r)],
  ["POST /api/auth/verify-email", (r) => verifyEmailPOST(r)],
  ["POST /api/connections/google_business_profile/location", (r) => gbpLocationPOST(r)],
  ["PATCH /api/posts/[postJobId]", (r) => postJobPATCH(r as never, postJobParams)],
  ["POST /api/posts/[postJobId]/approval", (r) => approvalPOST(r as never, postJobParams)],
  ["POST /api/posts/[postJobId]/retry", (r) => retryPOST(r as never, postJobParams)],
  ["POST /api/posts/auto-caption", (r) => autoCaptionPOST(r)],
  ["POST /api/posts/enhance-caption", (r) => enhanceCaptionPOST(r)],
  ["POST /api/reviews/draft-response", (r) => draftResponsePOST(r)],
  [
    "POST /api/reviews/[reviewId]/reply",
    (r) => reviewReplyPOST(r),
  ],
  ["POST /api/settings", (r) => settingsPOST(r)],
  ["POST /api/upload", (r) => uploadPOST(r)],
  ["PATCH /api/workspaces/active", (r) => workspaceActivePATCH(r)],
  ["POST /api/workspaces/switch", (r) => workspaceSwitchPOST(r)],
];

const BAD_BODIES: Array<[string, string]> = [
  ["null", "null"],
  ["an array", "[1,2]"],
  ["a number", "5"],
  ["a string", '"hello"'],
  ["a boolean", "true"],
  ["syntactically invalid JSON", "{not json"],
  ["an empty body", ""],
];

function requestWith(raw: string): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw || undefined,
  });
}

beforeEach(() => {
  handleUploadMock.mockReset();
  // Routes log through console on unexpected paths; keep the run quiet.
});

describe.each(ROUTES)("%s", (_name, call) => {
  it.each(BAD_BODIES)("answers 400 { error: 'Invalid JSON body' } for %s", async (_label, raw) => {
    const response = await call(requestWith(raw));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(handleUploadMock).not.toHaveBeenCalled();
  });
});

describe("JSON-body routes use readJsonObject", () => {
  /** Every route.ts under src/app/api. */
  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return routeFiles(full);
      return entry === "route.ts" ? [full] : [];
    });
  }

  it("no API route calls request.json() directly (a future route can't regress the 500)", () => {
    const apiRoot = join(__dirname);
    const offenders = routeFiles(apiRoot)
      .filter((file) => /\b(?:request|req)\.json\(\)/.test(readFileSync(file, "utf8")))
      .map((file) => relative(apiRoot, file));

    expect(offenders).toEqual([]);
  });
});
