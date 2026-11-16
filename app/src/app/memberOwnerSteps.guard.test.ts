import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "@prisma/client";

/**
 * X1 (R10, R11, R12): a member is never told to take a step only an owner can
 * take. Members reading owner-only steps came back three rounds running, each
 * time on a new page, so this one test renders every surface a member can
 * reach that has such a step, for an owner and for a member:
 * - the owner's version must still carry the owner step (so the case really
 *   is exercised, and the owners' wording stays);
 * - the member's must carry none of OWNER_STEPS and must name the owner.
 * A new surface with an owner-only step belongs in SURFACES.
 */

const h = vi.hoisted(() => ({
  getWorkspaceContext: vi.fn(),
  findFirst: vi.fn(),
  ensureFreshTikTokToken: vi.fn(),
  getTikTokCreatorInfo: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/toast")>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: () => null,
  DialogBody: () => null,
  DialogDescription: () => null,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
  ConfirmDialog: () => null,
}));
vi.mock("@/components/linkedin-account-dialog", () => ({ LinkedInAccountDialog: () => null, LinkedInConnectButton: () => null }));
vi.mock("@/components/linkedin-setup-dialog", () => ({ LinkedInSetupDialog: () => null }));
vi.mock("@/components/pending-connection-dialog", () => ({ PendingConnectionDialog: () => null }));
vi.mock("@/components/google-business-location-form", () => ({
  GoogleBusinessLocationForm: () => createElement("p", null, "Choose the Maps location to post to"),
}));
vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: h.getWorkspaceContext }));
vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findFirst: h.findFirst } } }));
vi.mock("@/server/platforms/tiktokClient", () => ({
  TIKTOK_CREATOR_CANNOT_POST: "TIKTOK_CREATOR_CANNOT_POST",
  ensureFreshTikTokToken: h.ensureFreshTikTokToken,
  getTikTokCreatorInfo: h.getTikTokCreatorInfo,
}));

import { NothingConnectedState } from "@/components/create-post-form";
import { ConnectionActions } from "@/components/connection-actions";
import { ConnectionsSection } from "@/components/connections-section";
import { ConnectionHealth } from "@/components/dashboard/connection-health";
import { ReconnectStep } from "@/components/activity/post-job-card";
import { SetPostingTimesPrompt } from "@/components/posting-times-prompt";
import { ErrorState } from "@/components/reviews/error-state";
import { ReviewsEmptyState } from "@/components/reviews/reviews-empty-state";
import { WorkspaceStatusAlert } from "@/components/shell/workspace-paused-banner";
import type { ConnectionSummary } from "@/lib/connectionSummary";
import type { ConnectionStatus } from "@/lib/connectionsDto";
import { accessBlock } from "@/lib/workspaceStatus";
import { reviewLinkReason, reviewsErrorBody, type ReviewLinkProblem } from "@/server/googleReviews";
import { NoPlatformConnectedLine } from "@/app/posts/bulk/bulk-posts-form";
import { GET as tiktokCreatorInfo } from "@/app/api/tiktok/creator-info/route";
import {
  connectionsSectionIntro,
  noConnectionsMessage,
  nothingSentMessage,
  retryReconnectMessage,
} from "@/lib/ownerStepAnswers";

type Role = "owner" | "member";

/** Sentences and links that ask the reader to do what only an owner can. */
const OWNER_STEPS: RegExp[] = [
  /\bConnect (it|one|at least one|Google Business Profile|a platform|your)\b/,
  /\bReconnect\b/,
  /\bChoose (a plan|the Maps location|your Maps location)\b/,
  /\bSet your posting times\b/,
  /\bGo to (connections|Settings)\b/,
  /\bAdd one in Google Business Profile\b/,
  /\bCheck that the listing is verified\b/,
  /\bCheck that the connected Google account still manages\b/,
  // JJ3 lead review: the card's own control, and the location step.
  /\bSwitch account\b/,
  /\bChoose another location\b/,
  /href="\/settings#(connections|plan|posting-times|connect-link|team)"/,
  /href="\/api\/auth\//,
  // Review of X1: owner-only steps other pages say, so a leak of any of them to a member fails here.
  /\bSee Settings, Plan\b/,
  /\bMake new client links\b/,
  /\bTurn off client links\b/,
  /\bChoose the Google business location\b/,
  /\bpress Connect\b/i,
  /\bclick Connect\b/i,
  /\bConnect at least one platform\b/,
  /\bManage plan, card and invoices\b/,
  /\bInvite teammates\b/,
  /\bSwitch account\b/,
  /\bDisconnect\b/,
  /\bHow to connect\b/,
  /\bChoose (which|the board|a board)\b/,
  /\bshows what to reconnect\b/,
];

function decoded(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

const render = (element: ReactElement) => decoded(renderToStaticMarkup(element));

const NOW = new Date("2026-12-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ENDED_TRIAL = { billingExempt: false, plan: null, planStatus: null, trialEndsAt: new Date(NOW.getTime() - DAY) };
const ENDED_PLAN = {
  billingExempt: false,
  plan: "growth",
  planStatus: "canceled",
  currentPeriodEnd: new Date(NOW.getTime() - 3 * DAY),
};
const PERSON = { email: "someone@example.com", emailVerifiedAt: NOW, googleLinkedAt: null };

function banner(workspace: Record<string, unknown>, role: Role): string {
  const block = accessBlock({ user: PERSON, workspace, role }, NOW);
  return render(
    createElement(WorkspaceStatusAlert, {
      status: {
        message: block?.message ?? null,
        notice: null,
        emailUnconfirmed: false,
        daysLeft: null,
        // As GET /api/workspaces/status sets it: an owner's ended plan only.
        planLink: role === "owner",
      },
      sending: false,
      onResend: () => {},
    }),
  );
}

function gbpWithoutLocation(): ConnectionSummary {
  return {
    platform: "google_business_profile",
    accountIdentifier: "",
    username: null,
    locationName: null,
    needsReconnect: false,
  } as unknown as ConnectionSummary;
}

function healthRow(over: Partial<ConnectionStatus>): ConnectionStatus {
  return { platform: "instagram", connected: true, needsReconnect: false, expiry: null, ...over } as ConnectionStatus;
}

async function tiktokReconnectAnswer(role: Role): Promise<string> {
  h.getWorkspaceContext.mockResolvedValue({ user: { id: "u1" }, workspace: { id: "ws-1" }, role });
  h.findFirst.mockResolvedValue({ id: "c1", platform: "tiktok", accessToken: "t" });
  h.ensureFreshTikTokToken.mockRejectedValue(Object.assign(new Error("expired"), { code: "TIKTOK_RECONNECT_REQUIRED" }));
  const response = await tiktokCreatorInfo();
  return JSON.stringify(await response.json());
}

// JJ3 lead review: a flagged row asks for a reconnect; a 403 says
// to check the account (googleFailure.ts kinds), guarded below too.
function reviewsRefused(role: Role, status = 401, subject: "location" | "account" = "location"): string {
  // A 401 is a flagged row here (the card shows Reconnect): RECONNECT_REQUIRED.
  return reviewsRefusedBy(role, status === 401 ? { code: "RECONNECT_REQUIRED" } : { status }, subject);
}

function reviewsRefusedBy(role: Role, error: object, subject: "location" | "account" = "location"): string {
  const body = reviewsErrorBody(error, "Couldn't load your Google reviews.", role, { subject });
  return render(
    createElement(ErrorState, {
      title: "Couldn't load reviews",
      message: body.error,
      settingsLink: body.reconnect === true,
      isMember: role === "member",
      onRetry: () => {},
    }),
  );
}

const LINK_PROBLEMS: ReviewLinkProblem[] = [
  "not_connected",
  "no_location",
  "needs_reconnect",
  "sign_in_again",
  "location_removed",
  "google_has_none",
];

/** Each surface: what an owner and a member read in the same state. */
const SURFACES: Record<string, (role: Role) => string | Promise<string>> = {
  "Reviews, nothing connected": (role) =>
    render(createElement(ReviewsEmptyState, { locationsCount: 0, gbpConnected: false, isMember: role === "member" })),
  "Reviews, connected with no locations": (role) =>
    render(createElement(ReviewsEmptyState, { locationsCount: 0, gbpConnected: true, isMember: role === "member" })),
  "Reviews, Google refused (error card)": (role) => reviewsRefused(role),
  "Reviews, Google refused access to the location (error card)": (role) => reviewsRefused(role, 403),
  "Reviews, Google refused access to the account (error card)": (role) => reviewsRefused(role, 403, "account"),
  // JJ3 lead review: an unflagged refusal (Switch account) and a removed location.
  "Reviews, Google refused, row not flagged (error card)": (role) =>
    reviewsRefusedBy(role, { status: 403, googleReasons: ["accesstokenscopeinsufficient"] }),
  "Reviews, location removed (error card)": (role) =>
    reviewsRefusedBy(role, { status: 404, code: "GBP_REVIEWS_FETCH_FAILED" }),
  ...Object.fromEntries(
    LINK_PROBLEMS.map((problem) => [`Reviews, Get more reviews (${problem})`, (role: Role) => reviewLinkReason(problem, role)]),
  ),
  "Settings, Connections intro": (role) => connectionsSectionIntro(role === "member"),
  "Settings, Google Business Profile without a location": (role) =>
    render(
      createElement(ConnectionsSection, {
        workspaceId: "ws-1",
        connections: [gbpWithoutLocation()],
        readOnly: role === "member",
      }),
    ),
  "Settings, a row that needs reconnecting": (role) =>
    render(
      createElement(ConnectionActions, {
        platform: "instagram",
        workspaceId: "ws-1",
        isConnected: true,
        needsReconnect: true,
        readOnly: role === "member",
      }),
    ),
  "Settings, a row that ended": (role) =>
    render(
      createElement(ConnectionActions, {
        platform: "linkedin",
        workspaceId: "ws-1",
        isConnected: true,
        reconnectSoon: true,
        endedAt: "2026-11-21T01:00:00.000Z",
        readOnly: role === "member",
      }),
    ),
  "Create and Add many, no posting times": (role) =>
    render(createElement(SetPostingTimesPrompt, { isMember: role === "member" })),
  "Create, nothing connected": (role) => render(createElement(NothingConnectedState, { isMember: role === "member" })),
  "Add many, nothing connected": (role) =>
    render(createElement(NoPlatformConnectedLine, { isMember: role === "member", onlyTikTok: false })),
  "Add many, only TikTok connected": (role) =>
    render(createElement(NoPlatformConnectedLine, { isMember: role === "member", onlyTikTok: true })),
  "Create, publish, retry and the banner, trial ended": (role) => banner(ENDED_TRIAL, role),
  "Create, publish, retry and the banner, plan ended": (role) => banner(ENDED_PLAN, role),
  "Dashboard, Connections card": (role) =>
    render(
      createElement(ConnectionHealth, {
        connections: [healthRow({ needsReconnect: true }), healthRow({ platform: "x" as Platform, connected: false })],
        loading: false,
        error: null,
        isMember: role === "member",
      }),
    ),
  "Activity, a result that needs reconnecting": (role) =>
    render(createElement(ReconnectStep, { platform: "instagram", role })),
  // The server answers the pages show as is (R11-publishing L1, R10-client-journey L1).
  "Create, nothing connected (POST /api/posts NO_CONNECTIONS)": (role) => noConnectionsMessage("create", role),
  "Publish now, nothing connected (publish NO_CONNECTIONS)": (role) => noConnectionsMessage("publish", role),
  "Publish now, none of the post's platforms connected (publish 409)": (role) => nothingSentMessage(role),
  "Retry, the platform needs reconnecting (retry RECONNECT_REQUIRED)": (role) =>
    retryReconnectMessage(["instagram", "facebook_page"], role),
};

/** Each route words its answer with the helper and the role of its own workspace context. */
const ROUTES_USING_THE_HELPERS: Array<[string, string[]]> = [
  ["api/posts/route.ts", ['noConnectionsMessage("create", context.role)']],
  [
    "api/posts/[postJobId]/publish/route.ts",
    ['noConnectionsMessage("publish", workspaceContext.role)', "nothingSentMessage(workspaceContext.role)"],
  ],
  ["api/posts/[postJobId]/retry/route.ts", ["retryReconnectMessage(dead, workspaceContext.role)"]],
];

/**
 * The one exclusion, frozen for TikTok's audit: Create's TikTok panel shows
 * GET /api/tiktok/creator-info's answer as is, and that panel stays exactly as
 * it is while TikTok reviews the app. So a member still reads "Reconnect TikTok
 * in Settings to keep posting." there. Pinned here so a change to it is a
 * decision, not an accident; move it into SURFACES once the audit is over.
 */
const FROZEN_FOR_TIKTOK_AUDIT = "Reconnect TikTok in Settings to keep posting.";

beforeEach(() => {
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("members are never told to take an owner-only step", () => {
  for (const [surface, read] of Object.entries(SURFACES)) {
    it(`${surface}: the owner reads the step, a member reads who can take it`, async () => {
      const owner = await read("owner");
      const member = await read("member");

      expect(
        OWNER_STEPS.some((step) => step.test(owner)),
        `${surface}: the owner's version has lost its step:\n${owner}`,
      ).toBe(true);
      for (const step of OWNER_STEPS) {
        expect(member, `${surface}: a member reads ${step}`).not.toMatch(step);
      }
      expect(member, `${surface}: a member's version names the owner`).toMatch(/workspace owner/i);
    });
  }
});

describe("the routes word those answers through the helpers, with their context's role", () => {
  for (const [file, calls] of ROUTES_USING_THE_HELPERS) {
    it(file, () => {
      const source = readFileSync(path.join(__dirname, file), "utf8");
      for (const call of calls) expect(source).toContain(call);
      expect(source).not.toMatch(/Connect at least one platform|Activity shows what to reconnect|in Settings before retrying/);
    });
  }
});

// The reviews error card can't be used without saying who reads it (review of X1).
describe("ErrorState needs the viewer's role", () => {
  it("is a type error without isMember", () => {
    // @ts-expect-error isMember is required: a caller that forgets it must not compile.
    const element = createElement(ErrorState, { title: "t", message: "m", onRetry: () => {} });
    expect(element).toBeTruthy();
  });
});

describe("excluded: frozen for TikTok's audit", () => {
  it("the TikTok panel's reconnect answer is the same for an owner and a member", async () => {
    for (const role of ["owner", "member"] as const) {
      expect(JSON.parse(await tiktokReconnectAnswer(role))).toEqual({
        error: FROZEN_FOR_TIKTOK_AUDIT,
        code: "TIKTOK_RECONNECT_REQUIRED",
      });
    }
  });
});

describe("the member sentences", () => {
  it("say exactly what the brief asks", async () => {
    expect(await SURFACES["Settings, Google Business Profile without a location"]("member")).toContain(
      "Connected. The workspace owner chooses the Maps location.",
    );
    expect(await SURFACES["Settings, a row that needs reconnecting"]("member")).toContain(
      "The workspace owner can reconnect it.",
    );
    expect(await SURFACES["Create, publish, retry and the banner, plan ended"]("member")).toContain(
      "This workspace's plan has ended. The workspace owner can choose a plan in Settings, Plan, or contact hello@vibesocials.wtf.",
    );
    expect(await SURFACES["Create, publish, retry and the banner, trial ended"]("member")).toContain(
      "This workspace's free trial has ended. The workspace owner can choose a plan in Settings, Plan, or contact hello@vibesocials.wtf.",
    );
    expect(await SURFACES["Add many, only TikTok connected"]("owner")).toContain(
      "Add many posts to every platform except TikTok, and none of those is connected yet.",
    );
    expect(await SURFACES["Add many, only TikTok connected"]("member")).toContain(
      "Add many posts to every platform except TikTok, and none of those is connected yet.",
    );
  });
});
