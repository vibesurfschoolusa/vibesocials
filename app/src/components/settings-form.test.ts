import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));

import type { UserSettings } from "@/lib/userSettings";

import { SettingsForm } from "./settings-form";

const SETTINGS: UserSettings = {
  companyWebsite: "www.example.com",
  defaultHashtags: null,
  notifyOnPostComplete: true,
  notifyDailyDigest: true,
  notifyNewReviews: true,
  requireApproval: false,
  googleButtonType: null,
  googleButtonUrl: null,
};

const render = (settings: UserSettings, role: "owner" | "member" = "owner") =>
  renderToStaticMarkup(createElement(SettingsForm, { settings, role }));

// 2026-11-10: the new Google review email preference.
describe("SettingsForm — Notifications", () => {
  const reviewBox = /<input type="checkbox"([^>]*)\/><span[^>]*>Email me when a new Google review arrives<\/span>/;

  it("shows the new review checkbox, checked when the preference is on", () => {
    const match = reviewBox.exec(render(SETTINGS));
    expect(match).not.toBeNull();
    expect(match?.[1]).toContain('checked=""');
  });

  it("shows it unchecked when the preference is off, to a member too", () => {
    const match = reviewBox.exec(render({ ...SETTINGS, notifyNewReviews: false }, "member"));
    expect(match).not.toBeNull();
    expect(match?.[1]).not.toContain("checked");
  });
});

// 2026-11-10: the workspace's default Google button.
describe("SettingsForm — Google posts", () => {
  it("shows an owner the Google posts group, with every button type and none", () => {
    const html = render(SETTINGS);

    expect(html).toContain("Google posts");
    expect(html).toContain("Add this button to every Google post");
    expect(html).toContain('id="googleButtonType"');
    for (const label of ["No button", "Book", "Order online", "Buy", "Learn more", "Sign up", "Call now"]) {
      expect(html).toContain(`>${label}</option>`);
    }
  });

  it("starts the link from the company website when no button is saved yet", () => {
    const html = render({ ...SETTINGS, googleButtonType: "BOOK" });

    expect(html).toContain('id="googleButtonUrl"');
    expect(html).toContain('value="https://www.example.com"');
  });

  it("shows the saved button and link", () => {
    const html = render({ ...SETTINGS, googleButtonType: "LEARN_MORE", googleButtonUrl: "https://e.com/more" });

    expect(html).toMatch(/<option value="LEARN_MORE" selected="">Learn more<\/option>/);
    expect(html).toContain('value="https://e.com/more"');
  });

  it("hides the link for no button and for Call now", () => {
    expect(render(SETTINGS)).not.toContain('id="googleButtonUrl"');
    expect(render({ ...SETTINGS, googleButtonType: "CALL" })).not.toContain('id="googleButtonUrl"');
  });

  it("shows the same message the server would give for a bad link", () => {
    const html = render({ ...SETTINGS, googleButtonType: "BOOK", googleButtonUrl: "http://e.com" });

    expect(html).toContain("The button link must start with https://.");
  });

  it("is not shown to a member (owner only)", () => {
    expect(render(SETTINGS, "member")).not.toContain("Google posts");
  });
});
