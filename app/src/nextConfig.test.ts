import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

describe("next.config headers", () => {
  it("serves the service worker with no-cache so a fix reaches phones on the next visit", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const sw = rules.find((rule) => rule.source === "/sw.js");
    expect(sw?.headers).toContainEqual({ key: "Cache-Control", value: "no-cache" });
  });
});
