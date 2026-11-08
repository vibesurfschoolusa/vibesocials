import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { META_GRAPH_BASE_URL, META_GRAPH_VERSION, META_OAUTH_DIALOG_URL } from "./metaGraph";

const SRC_DIR = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("metaGraph", () => {
  it("uses a supported Graph API version, not v21.0 (retired 2027-01-21)", () => {
    expect(META_GRAPH_VERSION).toMatch(/^v\d+\.0$/);
    expect(Number(META_GRAPH_VERSION.slice(1))).toBeGreaterThanOrEqual(22);
  });

  it("builds the Graph and OAuth dialog URLs from that one version", () => {
    expect(META_GRAPH_BASE_URL).toBe(`https://graph.facebook.com/${META_GRAPH_VERSION}`);
    expect(META_OAUTH_DIALOG_URL).toBe(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
  });

  it("is the only place in the source that names a Graph API version", () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((file) => path.basename(file) !== "metaGraph.ts")
      .filter((file) => /facebook\.com\/v\d+\.\d+/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC_DIR, file));
    expect(offenders).toEqual([]);
  });
});
