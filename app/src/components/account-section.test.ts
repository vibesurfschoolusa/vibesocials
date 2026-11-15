import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

import { AccountSection, ChangeEmailForm, UndoLinkNotice, emailChangeSentMessage, undoLinkSentence } from "./account-section";

const deletion = { deleteWorkspaces: [], leaveWorkspaces: [], refusal: null };

function render(hasPassword: boolean): string {
  return renderToStaticMarkup(
    createElement(AccountSection, { email: "old@example.com", hasPassword, deletion }),
  );
}

// R5 new-customer L4: a person can change a mistyped sign-in email.
describe("Settings, Account: sign-in email", () => {
  it("offers to change the email of a password account", () => {
    expect(render(true)).toMatch(/<button[^>]*>(<[^>]+>)*Change email/);
  });

  it("says why a Google-only account can't change it here", () => {
    const html = render(false);
    expect(html).not.toMatch(/<button[^>]*>(<[^>]+>)*Change email/);
    expect(html).toContain("You sign in with Google");
  });

  it("labels both fields of the change form", () => {
    const html = renderToStaticMarkup(createElement(ChangeEmailForm, { email: "old@example.com", startOpen: true }));
    expect(html).toMatch(/<label[^>]*for="new-email"[^>]*>New email<\/label>/);
    expect(html).toMatch(/<input[^>]*id="new-email"/);
    expect(html).toMatch(/<label[^>]*for="change-email-password"[^>]*>Current password<\/label>/);
  });

  it("says where the link went and that nothing changed yet", () => {
    expect(emailChangeSentMessage("new@example.com", "old@example.com")).toBe(
      "If no other account uses new@example.com, we sent a link to it. Open that email within 24 hours to finish the change. Until then, you sign in with old@example.com.",
    );
  });
});

// Review 3: the person sees until when the previous address can undo the
// change, and whom to write to if that mailbox is lost. There is no switch to
// turn the link off: whoever changed the email knows the password.
describe("Settings, Account: undo link", () => {
  const UNTIL = "2026-11-21T12:00:00.000Z";

  it("says until when the previous address can undo the change", () => {
    expect(undoLinkSentence(UNTIL)).toBe("Your previous address can undo this change until November 21, 2026.");
  });

  it("shows the line and where to write, and no way to turn it off", () => {
    const html = renderToStaticMarkup(createElement(UndoLinkNotice, { initialUntil: UNTIL }));
    expect(html).toContain("Your previous address can undo this change until November 21, 2026.");
    expect(html).toContain("Lost access to your old address? Write to hello@vibesocials.wtf.");
    expect(html).not.toContain("Turn");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });

  it("shows nothing when there is no live link", () => {
    expect(renderToStaticMarkup(createElement(UndoLinkNotice, { initialUntil: null }))).toBe("");
  });

  it("is part of a password account's sign-in email section", () => {
    const source = readFileSync(join(__dirname, "account-section.tsx"), "utf8");
    expect(source).toMatch(/<ChangeEmailForm email=\{email\} \/>\s*<UndoLinkNotice \/>/);
  });
});
