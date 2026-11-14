import { describe, expect, it } from "vitest";

import { emailSettingsLine, goTarget, workspaceLink } from "@/server/notifications/links";

describe("workspaceLink", () => {
  it("goes through /go with the workspace and the path", () => {
    expect(workspaceLink("ws_1", "/queue", "https://app.example.com")).toBe(
      "https://app.example.com/go?w=ws_1&to=%2Fqueue",
    );
  });

  it("trims a trailing slash from the base and keeps a hash and query in `to`", () => {
    expect(workspaceLink("ws 2", "/reports?month=2026-10#top", "https://app.example.com/")).toBe(
      "https://app.example.com/go?w=ws%202&to=%2Freports%3Fmonth%3D2026-10%23top",
    );
  });

  it("is a relative link without a base", () => {
    expect(workspaceLink("ws_1", "/media", "")).toBe("/go?w=ws_1&to=%2Fmedia");
    expect(workspaceLink("ws_1", "/media", null)).toBe("/go?w=ws_1&to=%2Fmedia");
  });

  it("reads NEXTAUTH_URL when no base is passed", () => {
    const before = process.env.NEXTAUTH_URL;
    process.env.NEXTAUTH_URL = "https://env.example.com";
    try {
      expect(workspaceLink("ws_1", "/queue")).toBe("https://env.example.com/go?w=ws_1&to=%2Fqueue");
    } finally {
      if (before === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = before;
    }
  });
});

describe("goTarget", () => {
  it.each([
    ["/queue", "/queue"],
    ["/settings#post-defaults", "/settings#post-defaults"],
    ["/reports?month=2026-10", "/reports?month=2026-10"],
  ])("keeps the same-site path %s", (to, expected) => {
    expect(goTarget(to)).toBe(expected);
  });

  it.each([
    "//evil.example",
    "https://evil.example",
    "/\\evil.example",
    "/%5Cevil.example",
    "/\t/evil.example",
    "javascript:alert(1)",
    "queue",
    "",
  ])("sends %j to /", (to) => {
    expect(goTarget(to)).toBe("/");
  });

  it("sends a missing value to /", () => {
    expect(goTarget(null)).toBe("/");
  });
});

describe("emailSettingsLine", () => {
  it("names Settings, Posts and emails and links it through /go", () => {
    const line = emailSettingsLine({
      action: 'turn off "Email me the monthly report"',
      workspaceId: "ws_1",
      appBaseUrl: "https://app.example.com",
    });
    expect(line).toBe(
      '<p>To stop these emails, turn off &quot;Email me the monthly report&quot; in <a href="https://app.example.com/go?w=ws_1&amp;to=%2Fsettings%23post-defaults">Settings, Posts and emails</a>.</p>',
    );
  });

  it("has no link without a base", () => {
    const line = emailSettingsLine({ action: "turn it off", workspaceId: "ws_1", appBaseUrl: null });
    expect(line).toBe("<p>To stop these emails, turn it off in Settings, Posts and emails.</p>");
  });
});
