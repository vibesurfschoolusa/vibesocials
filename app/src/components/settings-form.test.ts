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
  notifyMonthlyReport: true,
  requireApproval: false,
  googleButtonType: null,
  googleButtonUrl: null,
  brandVoice: null,
  brandVoiceExamples: null,
  trackWebsiteLinks: false,
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

// 18b: the monthly report email preference, beside the other email switches.
describe("SettingsForm — monthly report email", () => {
  const monthlyBox = /<input type="checkbox"([^>]*)\/><span[^>]*>Email me the monthly report<\/span>/;

  it("shows the monthly report checkbox, checked when the preference is on", () => {
    const match = monthlyBox.exec(render(SETTINGS));
    expect(match).not.toBeNull();
    expect(match?.[1]).toContain('checked=""');
  });

  it("shows it unchecked when the preference is off, to a member too", () => {
    const match = monthlyBox.exec(render({ ...SETTINGS, notifyMonthlyReport: false }, "member"));
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

// Polish: where hashtags go.
describe("SettingsForm — Brand voice hashtag hint", () => {
  it("tells an owner under How you sound that hashtags belong in Default hashtags", () => {
    const html = render(SETTINGS);

    const hint = "Put hashtags in Default hashtags above. The AI does not write hashtags.";
    expect(html).toContain(hint);
    expect(html.indexOf(hint)).toBeGreaterThan(html.indexOf('id="brandVoice"'));
    expect(html.indexOf(hint)).toBeLessThan(html.indexOf('id="brandVoiceExamples"'));
  });

  it("is not shown to a member", () => {
    expect(render(SETTINGS, "member")).not.toContain("Put hashtags in Default hashtags above.");
  });
});

// 20: tracking tags on the website link, under the website field.
describe("SettingsForm — Tracking tags", () => {
  const box = /<input type="checkbox"([^>]*)\/><span[^>]*>Add tracking tags to my website link<\/span>/;
  const FACEBOOK_EXAMPLE =
    "www.example.com/?utm_source=facebook&amp;utm_medium=social&amp;utm_campaign=vibesocials";

  it("shows an owner the checkbox under the website field, off by default, with both lines", () => {
    const html = render(SETTINGS);
    const match = box.exec(html);

    expect(match).not.toBeNull();
    expect(match?.[1]).not.toContain('checked=""');
    expect(match?.[1]).not.toContain('disabled=""');
    expect(html.indexOf("Add tracking tags")).toBeGreaterThan(html.indexOf('id="companyWebsite"'));
    expect(html.indexOf("Add tracking tags")).toBeLessThan(html.indexOf('id="defaultHashtags"'));
    expect(html).toContain(
      "Your Google Analytics will then show which platform each visit came from. The link in your posts gets longer. Where the longer link would not fit, the plain link is used.",
    );
    expect(html).toContain("Applies to posts published from now on, including ones already scheduled.");
    // Off: no example link.
    expect(html).not.toContain(FACEBOOK_EXAMPLE);
  });

  it("when on, shows the Facebook example link built from the website", () => {
    const html = render({ ...SETTINGS, trackWebsiteLinks: true });

    expect(box.exec(html)?.[1]).toContain('checked=""');
    expect(html).toContain(FACEBOOK_EXAMPLE);
  });

  it("keeps the footer preview untagged", () => {
    const html = render({ ...SETTINGS, trackWebsiteLinks: true });

    expect(html).toContain("Check out this amazing content!\n\nFor more info visit www.example.com</div>");
    expect(html).not.toMatch(/For more info visit [^<]*utm_/);
  });

  it("shows a member the setting read-only", () => {
    const html = render({ ...SETTINGS, trackWebsiteLinks: true }, "member");
    const match = box.exec(html);

    expect(match).not.toBeNull();
    expect(match?.[1]).toContain('checked=""');
    expect(match?.[1]).toContain('disabled=""');
    expect(html).toContain(FACEBOOK_EXAMPLE);
  });
});

// P1: one line each where the plan leaves out the brand voice or new-review emails.
describe("SettingsForm — what the plan leaves out", () => {
  // Fix round 2: the brand voice note replaces the section's own sentence (below), so it is one sentence.
  const VOICE_LINE =
    "On the Growth and Pro plans, the AI follows this when it writes or rewrites a caption and when it drafts a reply to a Google review.";
  const REVIEWS_LINE =
    "New-review emails are sent on the Growth and Pro plans. Your choice here is kept for when you choose one.";

  it("shows neither line by default, so the form is exactly as before", () => {
    const html = render(SETTINGS);
    expect(html).not.toContain(VOICE_LINE);
    expect(html).not.toContain(REVIEWS_LINE);
  });

  it("shows each line when the page passes it, with the fields still there", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsForm, {
        settings: SETTINGS,
        role: "owner",
        planNotes: { brandVoice: VOICE_LINE, reviewAlerts: REVIEWS_LINE },
      }),
    );
    expect(html).toContain(VOICE_LINE);
    expect(html).toContain(REVIEWS_LINE);
    expect(html).toContain('id="brandVoice"');
    expect(html).toContain("Email me when a new Google review arrives");
    expect(html.indexOf(REVIEWS_LINE)).toBeGreaterThan(html.indexOf("Email me when a new Google review arrives"));
  });
});

// P1 fix round 2: the monthly report toggle's line on Starter.
describe("SettingsForm — the monthly report email and the plan", () => {
  const LINE = "The monthly report email is part of the Growth and Pro plans.";
  const TODAY = "Sent to workspace owners in the first days of each month, when something was published the";

  it("adds the line after today's when the page passes it", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsForm, { settings: SETTINGS, role: "owner", planNotes: { monthlyReport: LINE } }),
    );
    expect(html).toContain(LINE);
    expect(html.indexOf(LINE)).toBeGreaterThan(html.indexOf(TODAY));
  });

  it("shows only today's line otherwise", () => {
    const html = render(SETTINGS);
    expect(html).toContain(TODAY);
    expect(html).not.toContain(LINE);
  });
});

// P1 fix round 2: the brand voice heading on a plan without it.
describe("SettingsForm — the brand voice heading and the plan", () => {
  const TODAY =
    "The AI follows this when it writes or rewrites a caption and when it drafts a reply to a Google review.";
  const ON_PLANS =
    "On the Growth and Pro plans, the AI follows this when it writes or rewrites a caption and when it drafts a reply to a Google review.";
  const squash = (html: string) => html.replace(/\s+/g, " ");

  it("with the note: one sentence in place of today's, and no second line", () => {
    const html = squash(
      renderToStaticMarkup(createElement(SettingsForm, { settings: SETTINGS, role: "owner", planNotes: { brandVoice: ON_PLANS } })),
    );
    expect(html).toContain(ON_PLANS);
    expect(html).not.toContain(`>${TODAY}<`);
    expect(html).not.toContain("Saved. Captions follow your brand voice");
    expect(html.split("Growth and Pro plans")).toHaveLength(2);
  });

  it("without it: today's sentence exactly", () => {
    const html = squash(render(SETTINGS));
    expect(html).toContain(`>${TODAY}<`);
    expect(html).not.toContain("On the Growth and Pro plans");
  });
});
