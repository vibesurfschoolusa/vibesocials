import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWorkspaceContext } from "./__test-helpers__/workspaceContextMock";

/**
 * R38 new-customer L1: every fail-closed limit whose store can't answer is
 * answered "couldn't check" (503, one sentence), never with the route's
 * "limit reached" sentence. The same table with a real limit still answers
 * each route's own 429. Each row reaches its limit with the least setup.
 */

const h = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getCurrentUser: vi.fn(),
  getWorkspaceContext: vi.fn(),
  requireOwnerContext: vi.fn(),
  findActiveConnectLink: vi.fn(),
  findActiveReviewLink: vi.fn(),
}));

vi.mock("@/lib/rateLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rateLimit")>()),
  checkRateLimit: h.checkRateLimit,
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getCurrentUser: h.getCurrentUser,
}));
vi.mock("@/lib/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace")>()),
  getWorkspaceContext: h.getWorkspaceContext,
  requireOwnerContext: h.requireOwnerContext,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    rateLimitEntry: { findMany: async () => [] },
    workspaceMember: { findMany: async () => [] },
    postJob: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing")>()),
  paymentsConfigured: () => true,
  stripeReachable: () => true,
}));
vi.mock("@/server/connectLink/origin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/connectLink/origin")>()),
  isSameOriginRequest: () => true,
}));
vi.mock("@/server/connectLink/link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/connectLink/link")>()),
  findActiveConnectLink: h.findActiveConnectLink,
}));
vi.mock("@/server/reviewLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/reviewLink")>()),
  findActiveReviewLink: h.findActiveReviewLink,
}));
vi.mock("@/app/api/upload/uploadRefusal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/upload/uploadRefusal")>()),
  clearUploadRefusal: async () => {},
  readUploadRefusal: async () => null,
  recordUploadRefusal: async () => {},
}));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { LIMIT_UNCHECKED_MESSAGE } from "@/lib/limitUnchecked";

import * as account from "./auth/account/route";
import * as changeEmailConfirm from "./auth/change-email/confirm/route";
import * as changeEmail from "./auth/change-email/route";
import * as changeEmailUndo from "./auth/change-email/undo/route";
import * as changePassword from "./auth/change-password/route";
import * as forgotPassword from "./auth/forgot-password/route";
import * as register from "./auth/register/route";
import * as resetPassword from "./auth/reset-password/route";
import * as verifyEmail from "./auth/verify-email/route";
import * as checkout from "./billing/checkout/route";
import * as portal from "./billing/portal/route";
import * as connectPending from "./connect-link/[token]/pending/[id]/route";
import * as connectStart from "./connect-link/[token]/start/route";
import * as autoCaption from "./posts/auto-caption/route";
import * as enhanceCaption from "./posts/enhance-caption/route";
import * as reviewDecision from "./review-link/[token]/posts/[postJobId]/route";
import * as reviewReport from "./review-link/[token]/report/route";
import * as reviewList from "./review-link/[token]/route";
import * as draftResponse from "./reviews/draft-response/route";
import * as upload from "./upload/route";
import * as uploadLinkUpload from "./upload-link/[token]/upload/route";
import * as logo from "./workspaces/logo/route";

const UNAVAILABLE = { allowed: false, retryAfterSeconds: 60, unavailable: true } as const;
const LIMITED = { allowed: false, retryAfterSeconds: 900 } as const;
const ALLOWED = { allowed: true } as const;
const TOKEN = "a".repeat(43);
const BLOB_URL = "https://abc123.public.blob.vercel-storage.com/photo.jpg";
const USER = { id: "user-1", email: "owner@example.com", passwordHash: "x" };

const json = (url: string, body: Record<string, unknown>, method = "POST") =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify(body),
  });
const get = (url: string) => new Request(`http://localhost${url}`, { headers: { "x-forwarded-for": "203.0.113.7" } });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

type Row = {
  name: string;
  call: () => Promise<Response>;
  /** How many limits pass before the one this row reaches. */
  passFirst?: number;
};

const rows: Row[] = [
  { name: "account DELETE", call: () => account.DELETE(json("/api/auth/account", { password: "pw" }, "DELETE")) },
  { name: "change-email", call: () => changeEmail.POST(json("/api/auth/change-email", { newEmail: "new@example.com" })) },
  { name: "change-email/confirm", call: () => changeEmailConfirm.POST(json("/api/auth/change-email/confirm", { token: "t" })) },
  { name: "change-email/undo", call: () => changeEmailUndo.POST(json("/api/auth/change-email/undo", { token: "t" })) },
  { name: "change-password", call: () => changePassword.POST(json("/api/auth/change-password", {})) },
  { name: "forgot-password (address)", call: () => forgotPassword.POST(json("/api/auth/forgot-password", { email: "a@example.com" })) },
  {
    name: "forgot-password (network)",
    passFirst: 1,
    call: () => forgotPassword.POST(json("/api/auth/forgot-password", { email: "a@example.com" })),
  },
  { name: "register", call: () => register.POST(json("/api/auth/register", { email: "a@example.com", password: "goodpassword" })) },
  { name: "reset-password", call: () => resetPassword.POST(json("/api/auth/reset-password", { token: "t", password: "pw" })) },
  { name: "verify-email", call: () => verifyEmail.POST(json("/api/auth/verify-email", { token: "t" })) },
  { name: "billing/checkout", call: () => checkout.POST(json("/api/billing/checkout", { workspaceId: "ws-1", plan: "starter" })) },
  { name: "billing/portal", call: () => portal.POST(json("/api/billing/portal", { workspaceId: "ws-1" })) },
  {
    name: "connect-link pending",
    call: () => connectPending.GET(get(`/api/connect-link/${TOKEN}/pending/p1`), params({ token: TOKEN, id: "p1" })),
  },
  {
    name: "posts/auto-caption",
    call: () => autoCaption.POST(json("/api/posts/auto-caption", { workspaceId: "ws-1", blobUrl: "https://x.example/a.jpg" })),
  },
  {
    name: "posts/auto-caption (AI budget)",
    passFirst: 1,
    call: () =>
      autoCaption.POST(
        json("/api/posts/auto-caption", { workspaceId: "ws-1", blobUrl: BLOB_URL, mimeType: "image/jpeg" }),
      ),
  },
  {
    name: "posts/enhance-caption",
    call: () => enhanceCaption.POST(json("/api/posts/enhance-caption", { workspaceId: "ws-1", caption: "Surf today" })),
  },
  {
    name: "posts/enhance-caption (AI budget)",
    passFirst: 1,
    call: () => enhanceCaption.POST(json("/api/posts/enhance-caption", { workspaceId: "ws-1", caption: "Surf today" })),
  },
  {
    name: "review-link decision (network)",
    call: () =>
      reviewDecision.POST(
        json(`/api/review-link/${TOKEN}/posts/p1`, { decision: "change", note: "Later" }),
        params({ token: TOKEN, postJobId: "p1" }),
      ),
  },
  {
    name: "review-link decision (link's day)",
    passFirst: 1,
    call: () =>
      reviewDecision.POST(
        json(`/api/review-link/${TOKEN}/posts/p1`, { decision: "change", note: "Later" }),
        params({ token: TOKEN, postJobId: "p1" }),
      ),
  },
  { name: "review-link report", call: () => reviewReport.GET(get(`/api/review-link/${TOKEN}/report`), params({ token: TOKEN })) },
  { name: "review-link list", call: () => reviewList.GET(get(`/api/review-link/${TOKEN}`), params({ token: TOKEN })) },
  {
    name: "reviews/draft-response",
    call: () =>
      draftResponse.POST(json("/api/reviews/draft-response", { workspaceId: "ws-1", reviewerName: "Sam", starRating: "5" })),
  },
  {
    name: "reviews/draft-response (AI budget)",
    passFirst: 1,
    call: () =>
      draftResponse.POST(json("/api/reviews/draft-response", { workspaceId: "ws-1", reviewerName: "Sam", starRating: "FIVE" })),
  },
  { name: "upload", call: () => upload.POST(json("/api/upload?workspaceId=ws-1", { type: "blob.generate-client-token" })) },
  {
    name: "upload-link upload",
    call: () =>
      uploadLinkUpload.POST(json(`/api/upload-link/${TOKEN}/upload`, { type: "blob.generate-client-token" }), params({ token: TOKEN })),
  },
  { name: "workspaces/logo DELETE", call: () => logo.DELETE(get("/api/workspaces/logo?workspaceId=ws-1")) },
];

/** The start form gets plain text, as its other refusals. */
const textRows: Row[] = [
  {
    name: "connect-link start (network)",
    call: () => connectStart.POST(new Request(`http://localhost/api/connect-link/${TOKEN}/start`, { method: "POST" }), params({ token: TOKEN })),
  },
  {
    name: "connect-link start (link)",
    passFirst: 1,
    call: () => connectStart.POST(new Request(`http://localhost/api/connect-link/${TOKEN}/start`, { method: "POST" }), params({ token: TOKEN })),
  },
];

function limitReturns(passFirst: number, result: object) {
  h.checkRateLimit.mockReset();
  for (let i = 0; i < passFirst; i++) h.checkRateLimit.mockResolvedValueOnce(ALLOWED);
  h.checkRateLimit.mockResolvedValue(result);
}

beforeEach(() => {
  const context = makeWorkspaceContext({ role: "owner" });
  h.getCurrentUser.mockResolvedValue(USER);
  h.getWorkspaceContext.mockResolvedValue(context);
  h.requireOwnerContext.mockResolvedValue(context);
  h.findActiveConnectLink.mockResolvedValue({ id: "link-1", workspaceId: "ws-1", createdById: "user-1", platforms: [] });
  h.findActiveReviewLink.mockResolvedValue({ id: "rlink-1", workspaceId: "ws-1" });
  vi.stubEnv("XAI_API_KEY", "xai-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a fail-closed limit that couldn't be checked", () => {
  it.each(rows.map((row) => [row.name, row] as const))("%s: 503, couldn't check", async (_name, row) => {
    limitReturns(row.passFirst ?? 0, UNAVAILABLE);
    const response = await row.call();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toEqual({ error: LIMIT_UNCHECKED_MESSAGE });
  });

  it.each(textRows.map((row) => [row.name, row] as const))("%s: 503 plain text, couldn't check", async (_name, row) => {
    limitReturns(row.passFirst ?? 0, UNAVAILABLE);
    const response = await row.call();
    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe(LIMIT_UNCHECKED_MESSAGE);
  });

  it.each(rows.map((row) => [row.name, row] as const))(
    "%s: a real limit still answers its own 429",
    async (_name, row) => {
      limitReturns(row.passFirst ?? 0, LIMITED);
      const response = await row.call();
      expect(response.status).toBe(429);
      expect(await response.text()).not.toContain(LIMIT_UNCHECKED_MESSAGE);
    },
  );

  // R45 pages-a L7: the start form's real limit goes back to /c with its wait.
  it.each(textRows.map((row) => [row.name, row] as const))(
    "%s: a real limit goes back to the page with its own code",
    async (_name, row) => {
      limitReturns(row.passFirst ?? 0, LIMITED);
      const response = await row.call();
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location") as string).searchParams.get("error")).toMatch(/^(rate_limited|used_too_often)$/);
    },
  );
});
