import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { answerLostText } from "./answerLost";

/**
 * R27 MM3 lead review: fetchOrNoAnswer cannot tell "offline, nothing sent"
 * from "sent, answer lost", so a request that may have gone through names
 * both, as Create's connectionLostText does. One lead-in for every such text.
 */
describe("answerLostText", () => {
  // Lead review: true offline and for an unreadable 5xx, where the connection may be fine.
  it("says the answer didn't arrive, what may have happened, and the next step", () => {
    expect(answerLostText("the workspace may have been made", "Reload this page.")).toBe(
      "Vibe Socials' answer didn't reach you, so the workspace may have been made. If your connection dropped, reconnect first. Reload this page.",
    );
  });

  it("is the only copy: no other file in src writes the lead-in by hand", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
      });
    // Every wording this lead-in has had, and the current one, outside answerLost.ts.
    const leadIns = [/The answer was lost/, /We lost the connection before Vibe Socials answered/, /answer didn.t reach you/];
    const offenders = walk(join(__dirname, ".."))
      .filter((file) => !/[\\/]lib[\\/]answerLost\.ts$/.test(file))
      .filter((file) => leadIns.some((leadIn) => leadIn.test(readFileSync(file, "utf8"))));
    expect(offenders).toEqual([]);
  });
});
