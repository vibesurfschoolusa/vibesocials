import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { publishErrorMessage } from "@/lib/publishFailureText";

// R18-publishing addendum L3: publishErrorMessage strips an HTTP status only when it ends the
// message ("... (status 400)"), and then shows its own sentence instead. A status anywhere else
// in a client's text reached the Activity card and the email word for word. The status belongs
// in error.status; the text says what happened and what to try.

const here = fileURLToPath(new URL(".", import.meta.url));
const clients = readdirSync(here).filter((name) => /Client\.ts$/.test(name));

const STATUS = /status (?:\$\{[^}]*\}|\d{3})/g;

/** Each place a client's source puts a status into text anywhere but a closing "(status N)". */
function midSentenceStatuses(file: string): string[] {
  const found: string[] = [];
  readFileSync(join(here, file), "utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || line.includes("console.")) return;
      for (const match of line.matchAll(STATUS)) {
        const start = match.index ?? 0;
        const before = line.slice(0, start);
        const after = line.slice(start + match[0].length);
        if (before.endsWith("(") && /^\)[`"']/.test(after)) continue;
        found.push(`${file}:${index + 1}: ${trimmed}`);
      }
    });
  return found;
}

// A token refresh failure: publishErrorMessage answers with its own renewal sentence and never
// shows this text (checked below).
const NEVER_SHOWN = ["Pinterest did not renew this connection (status ${response.status})"];

describe("platform clients: no HTTP status in the middle of a message", () => {
  it("finds the clients", () => {
    expect(clients).toEqual(
      expect.arrayContaining(["facebookPageClient.ts", "instagramClient.ts", "linkedinClient.ts", "xClient.ts"]),
    );
  });

  it.each(clients)("%s puts a status only in a closing (status N), which publishErrorMessage replaces", (file) => {
    const found = midSentenceStatuses(file).filter((hit) => !NEVER_SHOWN.some((known) => hit.includes(known)));
    expect(found).toEqual([]);
  });

  it("the Pinterest renewal text, the one exception, never reaches the user", () => {
    for (const status of [403, 404, 429, 500]) {
      const shown = publishErrorMessage("pinterest", {
        message: `Pinterest did not renew this connection (status ${status}). If this keeps happening, reconnect Pinterest in Settings.`,
        code: "PINTEREST_TOKEN_REFRESH_FAILED",
        status,
      });
      expect(shown).not.toMatch(/status \d{3}/);
    }
  });
});
