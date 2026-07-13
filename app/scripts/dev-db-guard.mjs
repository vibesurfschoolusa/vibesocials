import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

/**
 * dev-db guard — a `next dev` tripwire.
 *
 * `app/.env.local` on the maintainer's machine points at PRODUCTION, so a
 * stray `npm run dev` would boot the app against the live database. This
 * script refuses to let `next dev` start when DATABASE_URL resolves to a
 * remote host, unless the developer opts in with DEV_DB_OK=1.
 *
 * Wiring: it is invoked ONLY as npm's `predev` hook (see package.json). It is
 * never referenced by `build`, `start`, CI, or Vercel, so it can never block a
 * deploy or a pipeline — it guards local `npm run dev` and nothing else.
 *
 * Fail-open by design: any uncertainty (no env file, no DATABASE_URL line, a
 * URL it cannot parse) exits 0 silently so a newcomer's first `npm run dev` is
 * never bricked by the guard itself. It only ever blocks the one case it is
 * sure about: a parseable, non-local host with no opt-in.
 *
 * Usage: node scripts/dev-db-guard.mjs [--env-file <path>]   (default .env.local)
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Resolve the env file to inspect (default `.env.local`, relative to cwd). */
function envFileFromArgs(argv) {
  // GOTCHA (review minor): `--env-file` is ALSO a Node >=20.6 builtin flag.
  // When testing manually, Node intercepts a MISSING explicit path and exits 9
  // before this script runs (an existing path is side-loaded into process.env,
  // which is harmless — the guard reads the file itself, and only DEV_DB_OK
  // from the environment). The real `predev` invocation passes no argument, so
  // none of this affects the guard's production behavior.
  const i = argv.indexOf("--env-file");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return ".env.local";
}

/** Return the DATABASE_URL value from an env file, or null if absent/unreadable. */
function readDatabaseUrl(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null; // missing or unreadable file -> nothing to guard
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Match DATABASE_URL exactly (not DIRECT_DATABASE_URL / DATABASE_URL_UNPOOLED).
    const match = line.match(/^(?:export\s+)?DATABASE_URL\s*=(.*)$/);
    if (!match) continue;
    let value = match[1].trim();
    // Strip one layer of surrounding single or double quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

/** Parse the hostname out of a connection string, or undefined if unparseable. */
function hostOf(value) {
  try {
    // WHATWG URL wraps IPv6 hosts in brackets (e.g. "[::1]"); strip them so the
    // allow-list can match a bare "::1".
    return new URL(value).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

function main() {
  const value = readDatabaseUrl(envFileFromArgs(process.argv.slice(2)));
  if (!value) process.exit(0); // no env file or no DATABASE_URL -> pass

  const host = hostOf(value);
  if (host === undefined) {
    // A malformed URL must never block dev — warn and move on.
    console.warn("dev-db-guard: could not parse DATABASE_URL host; skipping check.");
    process.exit(0);
  }

  if (LOCAL_HOSTS.has(host)) process.exit(0); // local database -> fine

  if (process.env.DEV_DB_OK === "1") {
    console.log(`dev-db-guard: DEV_DB_OK=1 set — starting next dev against remote host "${host}".`);
    process.exit(0);
  }

  const lines = [
    `DATABASE_URL points at remote host "${host}".`,
    "Refusing to start next dev against a possibly-production database.",
    "If this is intentional (e.g. a staging DB), re-run with DEV_DB_OK=1.",
  ];
  const width = Math.max(...lines.map((line) => line.length));
  const border = "+".padEnd(width + 3, "-") + "+";
  console.error("");
  console.error(border);
  for (const line of lines) console.error(`| ${line.padEnd(width)} |`);
  console.error(border);
  console.error("");
  process.exit(1);
}

main();
