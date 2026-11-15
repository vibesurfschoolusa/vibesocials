import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

import { AccountSection, ChangeEmailForm, emailChangeSentMessage } from "./account-section";

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
