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
  it("names the lost connection, what may have happened, and the next step", () => {
    expect(answerLostText("the workspace may have been made", "reload this page")).toBe(
      "We lost the connection before Vibe Socials answered, so the workspace may have been made. Check your connection, then reload this page.",
    );
  });

  it("is the only lead-in: no page writes its own 'The answer was lost' text", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
      });
    const offenders = walk(join(__dirname, "..")).filter((file) => readFileSync(file, "utf8").includes("The answer was lost"));
    expect(offenders).toEqual([]);
  });
});
