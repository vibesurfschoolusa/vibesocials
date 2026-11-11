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
  brandVoice: null,
  brandVoiceExamples: null,
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

// 15: the workspace's brand voice, after the hashtags.
describe("SettingsForm — Brand voice", () => {
  const saved = {
    ...SETTINGS,
    brandVoice: "Friendly and short.",
    brandVoiceExamples: "Waves are up\nLesson at 9",
  };

  it("shows an owner the group after the hashtags, with both boxes and the button", () => {
    const html = render(SETTINGS);

    expect(html).toContain("Brand voice");
    expect(html.indexOf("Brand voice")).toBeGreaterThan(html.indexOf('id="defaultHashtags"'));
    expect(html).toContain("How you sound");
    expect(html).toContain('id="brandVoice"');
    expect(html).toContain("Example captions, one per line (up to 5)");
    expect(html).toContain('id="brandVoiceExamples"');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Use my recent posts<\/button>/);
  });

  it("uses the brief's example as the placeholder and limits the description to 600 characters", () => {
    const html = render(SETTINGS);

    expect(html).toContain(
      'placeholder="Friendly and short. We say &#x27;surf fam&#x27;. No exclamation marks in a row. Always mention the beach we are on."',
    );
    expect(html).toMatch(/<textarea[^>]*maxLength="600"[^>]*id="brandVoice"|<textarea[^>]*id="brandVoice"[^>]*maxLength="600"/);
  });

  it("fills the boxes with what is saved", () => {
    const html = render(saved);

    expect(html).toMatch(/id="brandVoice"[^>]*>Friendly and short\.<\/textarea>/);
    expect(html).toMatch(/id="brandVoiceExamples"[^>]*>Waves are up\nLesson at 9<\/textarea>/);
  });

  it("shows a member the saved voice read-only, without boxes or the button", () => {
    const html = render(saved, "member");

    expect(html).toContain("Brand voice");
    expect(html).toContain("Friendly and short.");
    expect(html).toContain("Waves are up\nLesson at 9");
    expect(html).not.toContain('id="brandVoice"');
    expect(html).not.toContain('id="brandVoiceExamples"');
    expect(html).not.toContain("Use my recent posts");
  });

  it("tells a member when nothing is saved", () => {
    const html = render(SETTINGS, "member");

    expect(html).toMatch(/How you sound<\/h3><p[^>]*>Not set\.<\/p>/);
    expect(html).toMatch(/Example captions<\/h3><p[^>]*>Not set\.<\/p>/);
  });
});

// Fix round 1: nothing is cut without the owner seeing it.
describe("SettingsForm — Brand voice limits shown live", () => {
  const WARNING = "Lines over 500 characters are shortened and only the first five are kept.";

  it("counts the examples under the box", () => {
    const html = render({ ...SETTINGS, brandVoiceExamples: "Waves are up\n\nLesson at 9" });

    expect(html).toContain("2 of 5 examples");
    expect(html).not.toContain(WARNING);
  });

  it("says 0 of 5 for an empty box", () => {
    expect(render(SETTINGS)).toContain("0 of 5 examples");
  });

  it("warns when there are more than five", () => {
    const html = render({ ...SETTINGS, brandVoiceExamples: "1\n2\n3\n4\n5\n6" });

    expect(html).toContain("6 of 5 examples");
    expect(html).toContain(WARNING);
  });

  it("warns when a line is over 500 characters", () => {
    const html = render({ ...SETTINGS, brandVoiceExamples: "x".repeat(501) });

    expect(html).toContain("1 of 5 examples");
    expect(html).toContain(WARNING);
  });

  it("shows the description's character count against its 600 limit", () => {
    expect(render({ ...SETTINGS, brandVoice: "Friendly and short." })).toContain("19 of 600 characters");
    expect(render(SETTINGS)).toContain("0 of 600 characters");
  });

  it("shows a member no counts", () => {
    const html = render({ ...SETTINGS, brandVoiceExamples: "1\n2" }, "member");

    expect(html).not.toContain("of 5 examples");
    expect(html).not.toContain("of 600 characters");
  });
});
