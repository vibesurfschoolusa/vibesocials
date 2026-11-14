import { describe, expect, it } from "vitest";

import { settingsSections } from "./sections";

describe("settingsSections", () => {
  it("lists every section in page order when the Plan section shows", () => {
    expect(settingsSections({ planShown: true })).toEqual([
      { id: "post-defaults", label: "Posts and emails" },
      { id: "posting-times", label: "Posting times" },
      { id: "connections", label: "Connections" },
      { id: "team", label: "Team" },
      { id: "plan", label: "Plan" },
      { id: "usage", label: "Usage" },
      { id: "account", label: "Account" },
    ]);
  });

  it("leaves Plan out when the page does not show it", () => {
    expect(settingsSections({ planShown: false }).map((s) => s.id)).toEqual([
      "post-defaults",
      "posting-times",
      "connections",
      "team",
      "usage",
      "account",
    ]);
  });
});
