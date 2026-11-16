import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { exceptionFor, relativeRoute, routeFiles, uncheckedHandlers } from "./handlerScan";

/**
 * R32 publishing L1 / new-customer L3 (source cure): round 31 made every write
 * check the page's workspace id; the reads still answered for the cookie's
 * workspace, which every tab shares. Activity's poll, Load more, Add many's
 * Media picker, Settings' "Use my recent posts" and Create's "Next free slot"
 * then filled a page drawn for workspace A with B's posts, files or times.
 * Every signed-in GET under src/app/api now takes the page's id
 * (?workspaceId=) and refuses another with renderedWorkspaceRefusal, unless it
 * is named below. A new read route that does neither fails here.
 */

const API = __dirname;

/** Reads that answer for no page's workspace, by path under src/app/api. Each says why. */
export const READ_CHECK_EXCEPTIONS: Record<string, string> = {
  "[...path]/route.ts": "the catch-all answers every method with the same 404",
  "auth/[...nextauth]/route.ts": "next-auth's session, providers and csrf reads: the signed-in person, no workspace",
  "auth/account-status/route.ts": "the signed-in person's own email confirmation",
  "auth/change-email/undo-link/route.ts": "the signed-in person's own undo link",
  ...Object.fromEntries(
    ["facebook_page", "google_business_profile", "instagram", "linkedin", "pinterest", "tiktok", "x", "youtube"].flatMap(
      (platform) => [
        [
          `auth/${platform}/start/route.ts`,
          "an OAuth start: it refuses a missing or different ?workspaceId= itself and signs the workspace into the state",
        ],
        [`auth/${platform}/callback/route.ts`, "an OAuth callback: it trusts only the workspace in the signed state"],
      ],
    ),
  ),
  "connections/google_business_profile/scheduled-count/route.ts":
    "the [platform] count with the platform fixed: it hands the request to that route, which checks the id",
  "inngest/route.ts": "Inngest calls it, signed with its key",
  "webhooks/": "Stripe and Meta call them, signed with their secrets",
  "instagram-photo/route.ts": "Instagram fetches it: the signed address names the photo, no session",
  "connect-link/[token]/": "the public /c page: its token names the workspace",
  "review-link/[token]/": "the public /v page: its token names the workspace",
  "upload-link/[token]/": "the public /u page: its token names the workspace",
  "invites/[token]/route.ts": "the Join page: the invite's token names the workspace",
  "workspaces/route.ts": "the signed-in person's list of workspaces, for the switcher",
  "tiktok/creator-info/route.ts": "read only by tiktok-post-settings.tsx, whose TikTok parts are frozen",
};


describe("every signed-in read route checks the page's workspace id", () => {
  it("the scan judges GET handlers as the write guard judges writes", () => {
    expect(uncheckedHandlers("export async function GET(request: Request) {\n  return list();\n}\n", ["GET"])).toEqual(["GET"]);
    expect(
      uncheckedHandlers(
        "export async function GET(request: Request) {\n  const refusal = renderedWorkspaceRefusal(sentWorkspaceId(request), id);\n}\n",
        ["GET"],
      ),
    ).toEqual([]);
    expect(uncheckedHandlers("export async function GET() {\n  // renderedWorkspaceRefusal(x, id)\n}\n", ["GET"])).toEqual(["GET"]);
    expect(uncheckedHandlers("export const GET = adminOtherMethods.GET;\n", ["GET"])).toEqual([]);
    expect(uncheckedHandlers('export { GET } from "./x";\n', ["GET"])).toEqual(["GET"]);
  });

  it("holds for every route under src/app/api, except the named ones", () => {
    const files = routeFiles(API);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((file) => {
      const relative = relativeRoute(API, file);
      if (exceptionFor(READ_CHECK_EXCEPTIONS, relative)) return [];
      return uncheckedHandlers(readFileSync(file, "utf8"), ["GET"]).map((method) => `${method} ${relative}`);
    });
    expect(offenders).toEqual([]);
  });

  it("every exception names a route that exists", () => {
    const relatives = routeFiles(API).map((file) => relativeRoute(API, file));
    for (const key of Object.keys(READ_CHECK_EXCEPTIONS)) {
      expect(relatives.some((relative) => (key.endsWith("/") ? relative.startsWith(key) : relative === key)), key).toBe(true);
    }
  });

  // R32 lead follow-up: the reads that waited on other workers' files are closed.
  it("no signed-in workspace read is left out but the frozen TikTok one", () => {
    const signedInReads = Object.keys(READ_CHECK_EXCEPTIONS).filter((key) =>
      /^(workspaces\/(status|invites|members)|upload\/route|media|connections\/route|tiktok)/.test(key),
    );
    expect(signedInReads).toEqual(["tiktok/creator-info/route.ts"]);
  });
});
