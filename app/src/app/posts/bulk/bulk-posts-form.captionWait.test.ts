import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { waitSecondsOf } from "@/lib/tooManyTriesText";

import { captionFailedText } from "./bulk-post-row";

// R42 review: Add many's caption 429 says the limit's own wait (up to 15
// minutes), from the answer's body, else its Retry-After header.
describe("Add many: a caption refused by the limit", () => {
  it("passes the answer's wait to the row's sentence", () => {
    const source = readFileSync(join(__dirname, "bulk-posts-form.tsx"), "utf8");
    // R45 pages-a L4: and the route's own sentence, for the daily limit.
    expect(source.replace(/\s+/g, " ")).toContain(
      'captionFailedText( response.ok ? null : response.status, data?.code, waitSecondsOf(data, response.headers.get("Retry-After")), data?.error, )',
    );
  });

  it("shows the route's wait, from the body or else the header", () => {
    const fromBody = waitSecondsOf({ error: "Too many tries. Wait 13 minutes, then try again.", retryAfterSeconds: 750 }, null);
    expect(captionFailedText(429, undefined, fromBody)).toBe(
      "No caption was written. Too many tries. Wait 13 minutes, then ask again, or write one yourself.",
    );
    expect(captionFailedText(429, undefined, waitSecondsOf(null, "300"))).toBe(
      "No caption was written. Too many tries. Wait 5 minutes, then ask again, or write one yourself.",
    );
  });
});
