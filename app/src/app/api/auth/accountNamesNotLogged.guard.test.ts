import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * R67 pages-a-2 L1 (the cure): the server log is no place for the person or
 * account behind a connection. R65 removed LinkedIn's vanity name from the
 * logs; R67 found the X handle and user id and the YouTube channel title. A
 * client who connects their own account often uses their own name, so the
 * OAuth start and callback routes and server/connections log only booleans,
 * counts, codes and our own ids. This reads the source: a logger or console
 * call that passes a variable or property whose name says it holds a name,
 * handle, title, email, profile address or platform user id fails here.
 */

const APP_SRC = fileURLToPath(new URL("../../../", import.meta.url));

/** Words that, in a variable or property name, say it holds who the account is. */
const NAME_WORDS = new Set(["name", "title", "email", "handle", "vanity", "username", "screenname", "displayname"]);
/**
 * The same, joined into one word in any case (userIdFromX, accountIdentifier),
 * and a platform's own id for the account (LinkedIn's sub, a Page or
 * Instagram account id, an organization id).
 */
const NAME_JOINED = /screenname|username|displayname|accountidentifier|userid|vanity|email|handle|pageid|accountid|orgid|channelid/;
const PLATFORM_ID_NAMES = new Set(["sub", "open_id"]);
/**
 * R67 lead follow-up: a token, a secret, an authorization code or a PKCE
 * verifier in a name (oauthToken, oauth_token, accessToken, refreshToken,
 * codeVerifier). console.* skips the logger's key redaction, so these are
 * kept out of every log call. `code` alone is the OAuth code.
 */
const TOKEN_WORDS = new Set(["token", "secret", "verifier"]);
const TOKEN_NAMES = new Set(["code"]);
/**
 * A whole account object logged as is (`orgs: organizations`,
 * `organizations[0]`) prints its name and id; reading one of its fields
 * (`organizations.length`) is judged by that field's own name.
 */
const ACCOUNT_OBJECTS = new Set([
  "org",
  "orgs",
  "organization",
  "organizations",
  "profile",
  "details",
  "account",
  "accounts",
  "channel",
  "channels",
  "me",
]);

function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** A has- or is- name is a boolean (hasScreenName), which says nothing about who. */
function isBooleanName(identifier: string): boolean {
  const [first] = words(identifier);
  return first === "has" || first === "is";
}

export function saysWhoItIs(identifier: string): boolean {
  if (isBooleanName(identifier)) return false;
  return (
    PLATFORM_ID_NAMES.has(identifier) ||
    TOKEN_NAMES.has(identifier) ||
    words(identifier).some((word) => TOKEN_WORDS.has(word)) ||
    words(identifier).some((word) => NAME_WORDS.has(word)) ||
    NAME_JOINED.test(identifier.toLowerCase())
  );
}

const LOG_METHODS = new Set(["log", "info", "warn", "error", "debug"]);

function isLogCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    (callee.expression.text === "logger" || callee.expression.text === "console") &&
    LOG_METHODS.has(callee.name.text)
  );
}

/** Each name in a log call's arguments that says who the account is, as `line: name`, once per line. */
export function loggedNames(source: string, fileName = "planted.ts"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits = new Set<string>();
  const record = (node: ts.Node, name: string) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    hits.add(`${line}: ${name}`);
  };
  const inArgument = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      // `hasEmail: !!profile.email` logs a boolean, whatever its value reads.
      if (isBooleanName(node.name.text)) return;
      if (saysWhoItIs(node.name.text)) record(node.name, node.name.text);
      inArgument(node.initializer);
      return;
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      // `tokenResponse.status` logs the status: a value whose field is read
      // is judged by that field's name, not its own.
      const readsAField = ts.isPropertyAccessExpression(parent) && parent.expression === node;
      if (!readsAField && (saysWhoItIs(node.text) || ACCOUNT_OBJECTS.has(node.text))) record(node, node.text);
    }
    ts.forEachChild(node, inArgument);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLogCall(node)) {
      for (const argument of node.arguments) inArgument(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...hits];
}

/** The OAuth start and callback routes and server/connections, tests left out. */
function scannedFiles(): string[] {
  const files: string[] = [];
  const auth = path.join(APP_SRC, "app", "api", "auth");
  for (const platform of readdirSync(auth)) {
    for (const leg of ["start", "callback"]) {
      const route = path.join(auth, platform, leg, "route.ts");
      try {
        if (statSync(route).isFile()) files.push(route);
      } catch {
        // Not every folder under auth/ is a platform.
      }
    }
  }
  const connections = path.join(APP_SRC, "server", "connections");
  for (const entry of readdirSync(connections)) {
    if (entry.endsWith(".ts") && !/\.test\.ts$|\.testkit\.ts$/.test(entry)) files.push(path.join(connections, entry));
  }
  return files;
}

function relative(file: string): string {
  return path.relative(APP_SRC, file).split(path.sep).join("/");
}

/**
 * Names that pass the word test but hold no one's name, with why. Keyed by
 * file and name, so the same name elsewhere is still caught.
 */
const OWN_USER_ID = "our own user id (Vibe Socials' User.id), never the platform's";
const ERROR_CODE = "an Error's own code (error.code), never an OAuth code";
const TOKEN_TYPE = "the kind of token TikTok sent (Bearer), never the token";
const ERROR_NAME = "an Error's class name (error.name), never a person's";
const SAFE: Record<string, string> = {
  "app/api/auth/facebook_page/callback/route.ts userId": OWN_USER_ID,
  "app/api/auth/instagram/callback/route.ts userId": OWN_USER_ID,
  "app/api/auth/linkedin/start/route.ts userId": OWN_USER_ID,
  "app/api/auth/linkedin/callback/route.ts userId": OWN_USER_ID,
  "app/api/auth/x/start/route.ts userId": OWN_USER_ID,
  "app/api/auth/x/callback/route.ts userId": OWN_USER_ID,
  "server/connections/gbpLocationTitle.ts name": ERROR_NAME,
  "server/connections/pendingConnection.ts name": ERROR_NAME,
  "server/connections/saveConnection.ts name": ERROR_NAME,
  "server/connections/gbpLocationTitle.ts code": ERROR_CODE,
  "server/connections/saveConnection.ts code": ERROR_CODE,
  "app/api/auth/tiktok/callback/route.ts tokenType": TOKEN_TYPE,
  "app/api/auth/tiktok/callback/route.ts token_type": TOKEN_TYPE,
};

describe("account names stay out of the server log (R67 pages-a-2 L1)", () => {
  it("scans the routes and server/connections", () => {
    const files = scannedFiles().map(relative);
    expect(files).toContain("app/api/auth/x/callback/route.ts");
    expect(files).toContain("app/api/auth/youtube/callback/route.ts");
    expect(files).toContain("app/api/auth/linkedin/start/route.ts");
    expect(files).toContain("server/connections/saveConnection.ts");
    expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
  });

  it("no log call in them passes a name, handle, title, email or platform user id", () => {
    const found: string[] = [];
    const used = new Set<string>();
    for (const file of scannedFiles()) {
      const name = relative(file);
      for (const hit of loggedNames(readFileSync(file, "utf8"), name)) {
        const key = `${name} ${hit.replace(/^\d+: /, "")}`;
        if (key in SAFE) used.add(key);
        else found.push(`${name}:${hit}`);
      }
    }
    expect(found).toEqual([]);
    // A safe entry nothing uses any more is removed, so the list stays true.
    expect(Object.keys(SAFE).filter((key) => !used.has(key))).toEqual([]);
  });

  describe("fails on a planted log call", () => {
    it.each([
      ['logger.info("Connected", { screenName });', "screenName"],
      ['console.log("[X] token", { screenName, userIdFromX });', "userIdFromX"],
      ['console.log("[YouTube] connected channel:", accountIdentifier);', "accountIdentifier"],
      ["logger.info(`Connected ${channel.snippet.title}`);", "title"],
      ['logger.warn("Saved", { page: page.name });', "name"],
      ['logger.info("Saved", { who: profile.email });', "email"],
      ['console.info("Hint", { vanityName });', "vanityName"],
      ['logger.debug("Me", { displayName: me.display_name });', "displayName"],
      ['console.log("[LinkedIn] Strategy 1", { orgs: organizations });', "organizations"],
      ['console.log("[LinkedIn] Found by id!", organizations[0]);', "organizations"],
      ['console.log("[LinkedIn] Profile", { sub: profile.sub });', "sub"],
      ['console.log("[Facebook] Connected", { pageId });', "pageId"],
      ['console.log("[Instagram] Connected", { igAccountId });', "igAccountId"],
      ['console.log("[LinkedIn] Lookup failed", { orgId: id });', "orgId"],
      ['logger.info("Me", { username });', "username"],
      ['logger.info("Me", { handle });', "handle"],
      ['console.log("[X OAuth 1.0a] Request token received", oauthToken);', "oauthToken"],
      ['console.log("[Google] token", tokenResponse.access_token);', "access_token"],
      ['console.log("[X] token", { oauth_token: params.get("oauth_token") });', "oauth_token"],
      ['console.log("[X] token", { token });', "token"],
      ['console.log("[Google] tokens", { accessToken, refreshToken });', "refreshToken"],
      ['console.log("[X] secret", { secret });', "secret"],
      ['console.log("[Google] code", { code });', "code"],
      ['console.log("[X] verifier", { verifier, codeVerifier });', "codeVerifier"],
    ])("%s", (source, name) => {
      expect(loggedNames(source).map((hit) => hit.replace(/^\d+: /, ""))).toContain(name);
    });
  });

  it("passes booleans, counts, codes and our own ids", () => {
    expect(
      loggedNames(
        'logger.info("Connected", { hasScreenName, hasUserId: userIdFromX !== null, hasEmail: !!profile.email, connectionId: saved.id, count: organizations.length, status: response.status });',
      ),
    ).toEqual([]);
  });

  it("leaves non-log calls alone", () => {
    expect(loggedNames("save({ screenName, accountIdentifier });")).toEqual([]);
  });
});
