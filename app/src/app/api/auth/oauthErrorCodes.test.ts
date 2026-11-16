import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { platformFromCode } from "@/lib/oauthResult";

// R30 (platform-clients L1): Settings words a sign-in's result from the row of
// the platform the ?error= code names (Connect, Reconnect, "unchanged"). A code
// that names no platform reads as a first Connect, so a cancelled Reconnect
// said "nothing was connected". Guard: every code an OAuth start or callback
// route sends starts with that route's own platform, so a new branch can't
// bring a bare provider code (access_denied, invalid_state) back.

const AUTH_DIR = fileURLToPath(new URL(".", import.meta.url));
const PLACEHOLDER = "X";

/** `${...}` parts of a template become a placeholder; only the fixed text counts. */
function fixedText(literal: string): string {
  return literal.replace(/\$\{[^}]*\}/g, PLACEHOLDER);
}

/**
 * The codes a route's source sends: `?error=<code>` in any string or template,
 * the value of every `searchParams.set("error", ...)`, and the owner-only code
 * each start hands requireOwnerContextForOAuthStart. A value that is not a
 * literal (a variable passed on) is returned as-is, so it fails the check.
 */
function errorCodesIn(source: string): string[] {
  const codes: string[] = [];
  for (const match of source.matchAll(/\?error=([^"'`&\s]+)/g)) codes.push(fixedText(match[1]));
  for (const match of source.matchAll(/searchParams\.set\(\s*["']error["']\s*,\s*(`[^`]*`|"[^"]*"|'[^']*'|[^)]*?)\s*\)/g)) {
    const arg = match[1];
    const literal = /^(["'`])([\s\S]*)\1$/.exec(arg);
    codes.push(literal ? fixedText(literal[2]) : `<not a literal: ${arg}>`);
  }
  for (const match of source.matchAll(/oauthErrorRedirect\(\s*["'](\w+)["']\s*,\s*(?:(["'`])([^"'`]*)\2|[^,]+)/g)) {
    codes.push(`${match[1]}_${match[3] === undefined ? PLACEHOLDER : fixedText(match[3])}`);
  }
  for (const match of source.matchAll(/requireOwnerContextForOAuthStart\(\s*\w+\s*,\s*["'`]([^"'`]+)["'`]/g)) {
    codes.push(fixedText(match[1]));
  }
  return codes;
}

/**
 * R30 lead review: a route builds its ?error= only through oauthErrorRedirect
 * (lib/oauthErrorRedirect.ts), which names the platform and cleans the code.
 * Anything else that writes an "error" query value (a joined string, a
 * template, searchParams.set/append, a URLSearchParams init) is listed.
 * Comment lines and the read of the provider's own ?error= are left out.
 */
function otherErrorWrites(source: string): string[] {
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n")
    .replace(/searchParams\.get\(\s*["']error["']\s*\)/g, "");
  const patterns = [/error=/g, /["'`]error["'`]/g, /URLSearchParams\(\s*\{[^}]*\berror\s*:/g];
  return patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[0]));
}

/** The platform each oauthErrorRedirect call names. */
function helperPlatforms(source: string): string[] {
  return [...source.matchAll(/oauthErrorRedirect\(\s*([^,]+?)\s*,/g)].map((match) => match[1].replace(/^["']|["']$/g, ""));
}

/**
 * Frozen (CLAUDE.md, the TikTok review): the TikTok auth callback changes only
 * its provider-code line, so its other codes stay literal searchParams.set
 * calls. The code check above still holds them to "tiktok_".
 */
const FROZEN = new Set(["tiktok/callback"]);

const ROUTES = readdirSync(AUTH_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) =>
    ["start", "callback"].flatMap((kind) => {
      try {
        const file = join(AUTH_DIR, entry.name, kind, "route.ts");
        return [{ platform: entry.name, kind, file, source: readFileSync(file, "utf8") }];
      } catch {
        return [];
      }
    }),
  );

describe("errorCodesIn (the guard's reader)", () => {
  it("reads literals, templates and passed-on variables", () => {
    expect(
      errorCodesIn(`
        new URL("/settings?error=a_one", request.url);
        new URL(\`/settings?error=\${encodeURIComponent(error)}\`, request.url);
        settingsUrl.searchParams.set("error", errorParam);
        url.searchParams.set("error", \`pinterest_\${safe}\`);
        url.searchParams.set("error", "b_two");
        url.searchParams.set("error", \`tiktok_\${f(error)}\`);
        return oauthErrorRedirect("youtube", "no_channel", request.url);
        return oauthErrorRedirect("instagram", error, request.url);
        await requireOwnerContextForOAuthStart(request, "c_not_workspace_owner");
      `),
    ).toEqual([
      "a_one",
      "X",
      "<not a literal: errorParam>",
      "pinterest_X",
      "b_two",
      "tiktok_X",
      "youtube_no_channel",
      "instagram_X",
      "c_not_workspace_owner",
    ]);
  });

  it("lists every other way of writing an error query value, and nothing else", () => {
    expect(
      otherErrorWrites(`
        // a comment about ?error= codes
        const error = url.searchParams.get("error");
        console.error("[X OAuth] failed", { error: errorText });
        return oauthErrorRedirect("x", "auth_denied", base);
        new URL("/settings?error=" + code, base);
        url.searchParams.append("error", code);
        url.search = new URLSearchParams({ error: code }).toString();
        url.search = \`?error=\${code}\`;
      `),
    ).toEqual(["error=", "error=", '"error"', "URLSearchParams({ error:"]);
    expect(helperPlatforms('oauthErrorRedirect("x", "a", b); oauthErrorRedirect(platform, "a", b);')).toEqual(["x", "platform"]);
  });
});

describe("every OAuth start and callback route's ?error= codes name its platform", () => {
  it("finds the start and callback routes of all eight platforms", () => {
    expect(ROUTES.filter((route) => route.kind === "callback").map((route) => route.platform).sort()).toEqual([
      "facebook_page",
      "google_business_profile",
      "instagram",
      "linkedin",
      "pinterest",
      "tiktok",
      "x",
      "youtube",
    ]);
    expect(ROUTES.filter((route) => route.kind === "start")).toHaveLength(8);
  });

  it.each(ROUTES.map((route) => [`${route.platform}/${route.kind}`, route] as const))("%s", (_name, route) => {
    const codes = errorCodesIn(route.source);
    expect(codes.length).toBeGreaterThan(0);
    const unplaced = codes.filter((code) => platformFromCode(code) !== route.platform);
    expect(unplaced).toEqual([]);
  });

  it.each(ROUTES.map((route) => [`${route.platform}/${route.kind}`, route] as const))(
    "%s builds its ?error= only through oauthErrorRedirect, naming its own platform",
    (name, route) => {
      expect(helperPlatforms(route.source).filter((platform) => platform !== route.platform)).toEqual([]);
      if (FROZEN.has(name)) {
        expect(route.source).toMatch(/oauthErrorRedirect\("tiktok", errorParam, url\.origin\)/);
        return;
      }
      expect(otherErrorWrites(route.source)).toEqual([]);
    },
  );
});
