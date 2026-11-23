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
// R68 lead follow-up: a post's author or an upload's owner can be a person (urn:li:person:…).
// R68 lead follow-up: tags and hashtags are the customer's own text, as a title is.
const NAME_WORDS = new Set([
  "name",
  "title",
  "email",
  "handle",
  "vanity",
  "username",
  "screenname",
  "displayname",
  "author",
  "tags",
  "hashtags",
  // R68 review: a caption, a description and a file name are the customer's own text.
  "caption",
  "description",
  "commentary",
  "preview",
  "filename",
]);
/**
 * The same, joined into one word in any case (userIdFromX, accountIdentifier),
 * and a platform's own id for the account (LinkedIn's sub, a Page or
 * Instagram account id, an organization id).
 */
const NAME_JOINED = /screenname|username|displayname|accountidentifier|userid|vanity|email|handle|pageid|accountid|orgid|channelid|ownerurn/;
const PLATFORM_ID_NAMES = new Set(["sub", "open_id"]);
/**
 * R68 lead follow-up: a stored file's address ends in the customer's file name
 * (lib/blobKey.ts), so it is logged only through blobLogRef(...).
 */
const BLOB_JOINED = /mediaurl|storagelocation|videourl|imageurl|photourl|fileurl|bloburl|coverurl|sourceurl|media_url|video_url|image_url|file_url/;
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
  // R67 review L2: a provider's raw reply holds the tokens. errorText (a
  // failed reply's body) stays allowed.
  "responseText",
  "params",
  "data",
  "json",
  "body",
  "text",
]);

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword,
]);

/** R67 review L1: a value that can only be yes or no: `!!x`, `x !== null`, `Boolean(x)`, true, false. */
function isYesNo(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isYesNo(node.expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) return true;
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Boolean";
}

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

/** R68 review: a length, a count or an extension (captionLength, fileExtension) says nothing about who. */
const MEASURE_WORDS = new Set(["length", "count", "extension"]);

export function saysWhoItIs(identifier: string): boolean {
  if (isBooleanName(identifier)) return false;
  if (MEASURE_WORDS.has(words(identifier).at(-1) ?? "")) return false;
  return (
    PLATFORM_ID_NAMES.has(identifier) ||
    TOKEN_NAMES.has(identifier) ||
    words(identifier).some((word) => TOKEN_WORDS.has(word)) ||
    words(identifier).some((word) => NAME_WORDS.has(word)) ||
    NAME_JOINED.test(identifier.toLowerCase()) ||
    BLOB_JOINED.test(identifier.toLowerCase())
  );
}

const LOG_METHODS = new Set(["log", "info", "warn", "error", "debug"]);

/** R68 review: what these return says nothing about who, whatever they are given. */
const SAFE_READERS = new Set(["extensionOf", "loggedAuthor", "blobLogRef"]);

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
      // `hasEmail: !!profile.email` logs a boolean, whatever its value reads;
      // `hasToken: accessToken` logs the token, so a has- name alone is not enough.
      // R68: a yes/no value says nothing about who under any key
      // (`refreshTokenRotated: data.refreshToken !== undefined`).
      if (isYesNo(node.initializer)) return;
      if (saysWhoItIs(node.name.text)) record(node.name, node.name.text);
      inArgument(node.initializer);
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && SAFE_READERS.has(node.expression.text)) return;
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      // `tokenResponse.status` logs the status: a value whose field is read
      // is judged by that field's name, not its own.
      const readsAField = ts.isPropertyAccessExpression(parent) && parent.expression === node;
      // R68: a field in the middle of a chain is no whole object (`session.data.video`
      // logs the video), but its name still counts (`channel.snippet.title.slice(0, 50)`).
      const midChain =
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        ts.isPropertyAccessExpression(parent.parent) &&
        parent.parent.expression === parent;
      // `ctx.caption?.length` logs a length.
      if (midChain && MEASURE_WORDS.has((parent.parent as ts.PropertyAccessExpression).name.text.toLowerCase())) return;
      if (!readsAField && (saysWhoItIs(node.text) || (!midChain && ACCOUNT_OBJECTS.has(node.text)))) record(node, node.text);
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

/** The OAuth start and callback routes, server/connections and the platform clients, tests left out. */
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
  // R68 platform-clients L1: the publish logs run on every post, so they are
  // held to the same rule as the connect logs.
  const platforms = path.join(APP_SRC, "server", "platforms");
  for (const entry of readdirSync(platforms)) {
    if (/Client\.ts$/.test(entry)) files.push(path.join(platforms, entry));
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
const TIKTOK_ERROR_DESCRIPTION = "TikTok's own sentence for a failed token reply (error_description), never customer text";
const FAILED_REPLY = "the body of a FAILED reply (read under !response.ok), as errorText elsewhere";
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
  "app/api/auth/youtube/callback/route.ts text":
    "the body of a FAILED token reply (await tokenResponse.text() under !tokenResponse.ok), as errorText elsewhere",
  "app/api/auth/tiktok/callback/route.ts token_type": TOKEN_TYPE,
  "app/api/auth/tiktok/callback/route.ts errorDescription": TIKTOK_ERROR_DESCRIPTION,
  "app/api/auth/tiktok/callback/route.ts error_description": TIKTOK_ERROR_DESCRIPTION,
  "server/platforms/tiktokClient.ts errorDescription": TIKTOK_ERROR_DESCRIPTION,
  "server/platforms/tiktokClient.ts error_description": TIKTOK_ERROR_DESCRIPTION,
  // R68 platform-clients L1: the publish logs.
  "server/platforms/facebookPageClient.ts code": ERROR_CODE,
  "server/platforms/facebookPageClient.ts pageId": "a business Page's id, never a person's (lead decision, R68)",
  "server/platforms/googleBusinessProfileClient.ts locationName":
    "a business location's id, Google's path accounts/<n>/locations/<n>, never its title (lead decision, R68)",
  "server/platforms/instagramClient.ts body": FAILED_REPLY,
  "server/platforms/instagramClient.ts code": ERROR_CODE,
  "server/platforms/instagramClient.ts name": ERROR_NAME,
  "server/platforms/linkedinClient.ts code": ERROR_CODE,
  "server/platforms/pinterestClient.ts body": `${FAILED_REPLY}, cut to 500 characters`,
  "server/platforms/pinterestClient.ts code": ERROR_CODE,
  "server/platforms/pinterestClient.ts name": ERROR_NAME,
  "server/platforms/tiktokClient.ts code": ERROR_CODE,
  "server/platforms/xClient.ts code": "an Error's code or the code X's reply sent (an API error number), never an OAuth code",
  "server/platforms/xClient.ts name": ERROR_NAME,
  "server/platforms/youtubeClient.ts code": ERROR_CODE,
};

describe("account names stay out of the server log (R67 pages-a-2 L1)", () => {
  it("scans the routes, server/connections and the platform clients", () => {
    const files = scannedFiles().map(relative);
    expect(files).toContain("app/api/auth/x/callback/route.ts");
    expect(files).toContain("app/api/auth/youtube/callback/route.ts");
    expect(files).toContain("app/api/auth/linkedin/start/route.ts");
    expect(files).toContain("server/connections/saveConnection.ts");
    // R68 platform-clients L1: the publish logs run on every post.
    expect(files).toContain("server/platforms/tiktokClient.ts");
    expect(files).toContain("server/platforms/instagramClient.ts");
    expect(files).toContain("server/platforms/linkedinClient.ts");
    expect(files).toContain("server/platforms/youtubeClient.ts");
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
      ['console.log("[X] token", { hasScreenName: screenName });', "screenName"],
      ['console.log("[Google] token", { hasToken: accessToken });', "accessToken"],
      ['console.log("[X OAuth 1.0a] Access token reply", responseText);', "responseText"],
      ['console.log("[X] reply", params);', "params"],
      ['console.log("[Google] reply", { data: json });', "json"],
      ['console.log("[Google] reply", body);', "body"],
      ['console.log("[X] token", { oauth_token: params.get("oauth_token") });', "oauth_token"],
      ['console.log("[X] token", { token });', "token"],
      ['console.log("[Google] tokens", { accessToken, refreshToken });', "refreshToken"],
      ['console.log("[X] secret", { secret });', "secret"],
      ['console.log("[Google] code", { code });', "code"],
      ['console.log("[X] verifier", { verifier, codeVerifier });', "codeVerifier"],
      // R68 platform-clients L1: the handle logs found in the publish clients.
      ['console.log("[TikTok] Creator info", { username: creatorInfo.creatorUsername });', "creatorUsername"],
      ['console.log("[Instagram] Published", { mediaId, username });', "username"],
      ['console.log("[LinkedIn] Posting as organization", { orgName: organizations[0].name });', "orgName"],
      ['console.log("[Instagram] Carousel", { igAccountId });', "igAccountId"],
      ['console.log("[LinkedIn] Upload", { upload: session.data });', "data"],
      ['console.log("[TikTok] Refreshed", { rotated: data.refreshToken });', "refreshToken"],
      // R68 lead follow-up: a post's author can be a person (urn:li:person:…).
      ['logger.info("[LinkedIn] Creating post", { authorUrn });', "authorUrn"],
      ['console.log("[LinkedIn] Sending", { author: postBody.author });', "author"],
      ['console.log("[LinkedIn] Registering video", { ownerUrn });', "ownerUrn"],
      ['console.log("[YouTube] Uploading with metadata", { tags: tags });', "tags"],
      ['console.log("[Instagram] Caption", { hashtags });', "hashtags"],
      // R68 review: the caption and the file name, and a name read in the middle of a chain.
      ['console.log("[TikTok] Init", { caption });', "caption"],
      ['console.log("[TikTok] Init", { captionPreview: preview });', "captionPreview"],
      ['console.log("[X] Media", { originalFilename: mediaItem.originalFilename });', "originalFilename"],
      ['console.log("[LinkedIn] Video", { filename });', "filename"],
      // R68 lead follow-up: a stored file's address ends in its name.
      ['logger.info("[LinkedIn] Upload", { mediaUrl });', "mediaUrl"],
      ['console.log("[TikTok] Media", { storageLocation: mediaItem.storageLocation });', "storageLocation"],
      ['console.log("[LinkedIn] Image", { imageUrl });', "imageUrl"],
      ['console.log("[LinkedIn] Video", { videoUrl });', "videoUrl"],
      ['console.log("[YouTube] Channel", { c: channel.snippet.title.slice(0, 50) });', "title"],
      ['console.log("[TikTok] Me", { me: me.display_name.trim() });', "display_name"],
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

  it("passes a yes/no under any key and a field read in the middle of a chain (R68)", () => {
    expect(
      loggedNames(
        'console.log("[TikTok] Refreshed", { refreshTokenRotated: data.refreshToken !== undefined, videoUrn: session.data.video, parts: current.data.partCount, tagCount: tags.length, captionLength: caption.length, fileExtension: extensionOf(mediaItem.originalFilename), titleLength: 3, postedAs: loggedAuthor(authorUrn), n: ctx.caption?.length, mediaRef: blobLogRef(mediaItem.storageLocation) });',
      ),
    ).toEqual([]);
  });

  it("leaves non-log calls alone", () => {
    expect(loggedNames("save({ screenName, accountIdentifier });")).toEqual([]);
  });
});
