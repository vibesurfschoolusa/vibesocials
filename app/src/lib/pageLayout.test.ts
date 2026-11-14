import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { APP_PAGE_CLASS } from "./pageLayout";

const SRC = join(__dirname, "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("APP_PAGE_CLASS", () => {
  it("is the one shared signed-in page container", () => {
    expect(APP_PAGE_CLASS).toBe("mx-auto w-full max-w-5xl px-4 py-8 md:px-6 lg:px-8");
  });

  it.each([
    "components/dashboard/dashboard-home.tsx",
    "app/queue/queue-view.tsx",
    "app/activity/activity-view.tsx",
    "app/reports/page.tsx",
    "app/media/page.tsx",
    "app/workspaces/page.tsx",
    "app/posts/bulk/page.tsx",
  ])("%s uses it", (file) => {
    const source = read(file);
    expect(source).toContain("APP_PAGE_CLASS");
    expect(source).not.toMatch(/"mx-auto[^"]*max-w-(3|4|5|6)xl/);
  });
});

describe("page tab titles", () => {
  it.each([
    ["app/queue/page.tsx", "Queue"],
    ["app/activity/page.tsx", "Activity"],
    ["app/reports/page.tsx", "Reports"],
    ["app/media/page.tsx", "Media library"],
    ["app/workspaces/page.tsx", "Workspaces"],
    ["app/posts/new/page.tsx", "Create post"],
    ["app/posts/bulk/page.tsx", "Add many"],
  ])("%s is titled %s", (file, name) => {
    expect(read(file)).toContain(`title: "${name} | Vibe Socials"`);
  });
});
