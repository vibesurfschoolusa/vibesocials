import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

import {
  ACCOUNT_MAYBE_DELETED_MESSAGE,
  AccountSection,
  accountDeleteFailureText,
  ChangeEmailForm,
  EMAIL_CHANGE_MAYBE_SENT_MESSAGE,
  FormError,
  PASSWORD_MAYBE_CHANGED_MESSAGE,
  UndoLinkNotice,
  accountDeleteRefusal,
  emailChangeFailureText,
  emailChangeRefusal,
  emailChangeSentMessage,
  passwordFailureText,
  undoLinkSentence,
} from "./account-section";

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

  // R18 new-customer L2: the sign-in page shows a signed-in person the notice,
  // not its Forgot password link, so the sentence links the page itself.
  it("links a Google-only account straight to setting a password", () => {
    const html = render(false);
    expect(html).toMatch(/<a [^>]*href="\/forgot-password"[^>]*>set a password<\/a>/);
    expect(html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'")).toContain(
      "You sign in with Google, so your sign-in email is your Google account's address. To use another address, set a password, then change it here.",
    );
    expect(html).not.toContain("on the sign-in page");
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

// R6-security M1: a new change is refused while the last one can be undone;
// the form writes the date in the viewer's own time zone.
describe("Settings, Account: a change refused during the undo window", () => {
  it("writes the refusal from the date the server sends", () => {
    expect(
      emailChangeRefusal({ error: "server sentence", until: "2026-11-17T12:00:00.000Z" }, "fallback"),
    ).toBe("You changed your email recently; you can change it again after November 17, 2026.");
  });

  it("shows any other refusal as the server wrote it, or the fallback", () => {
    expect(emailChangeRefusal({ error: "Your current password is not correct." }, "fallback")).toBe(
      "Your current password is not correct.",
    );
    expect(emailChangeRefusal(null, "fallback")).toBe("fallback");
  });
});

// R6-pages L10: every form error in Account is announced, as Change email's is.
describe("Settings, Account: errors are announced", () => {
  it("renders an error as an alert", () => {
    expect(renderToStaticMarkup(createElement(FormError, { message: "Something failed." }))).toBe(
      '<p role="alert" class="text-sm text-destructive">Something failed.</p>',
    );
  });

  it("uses it for Change email, Change password and Delete account", () => {
    const source = readFileSync(join(__dirname, "account-section.tsx"), "utf8");
    expect(source.match(/<FormError message=\{error\} \/>/g)).toHaveLength(3);
    expect(source).not.toMatch(/<p className="text-sm text-destructive">/);
  });
});

// R6-pages L8: the same date format as the team and connect-link lines.
describe("Settings, Account: dates", () => {
  it("writes the undo date with the shared formatter", () => {
    const source = readFileSync(join(__dirname, "account-section.tsx"), "utf8");
    expect(source).toContain("formatDisplayDate(untilIso)");
    expect(source).not.toContain("toLocaleDateString");
  });
});

// R6 review: account deletion waits for the undo window; the dialog writes
// the date in the viewer's time zone.
describe("Settings, Account: deletion refused during the undo window", () => {
  it("writes the refusal from the date the server sends", () => {
    expect(accountDeleteRefusal({ error: "server", until: "2026-11-17T12:00:00.000Z" }, "fallback")).toBe(
      "You changed your email recently. You can delete the account after November 17, 2026, or undo the change from the link sent to your previous address.",
    );
  });

  it("shows any other refusal as the server wrote it, or the fallback", () => {
    expect(accountDeleteRefusal({ error: "Your password is not correct." }, "fallback")).toBe(
      "Your password is not correct.",
    );
    expect(accountDeleteRefusal(null, "fallback")).toBe("fallback");
  });

  it("is what the delete dialog uses", () => {
    const source = readFileSync(join(__dirname, "account-section.tsx"), "utf8");
    expect(source).toContain('accountDeleteRefusal(data, "Could not delete your account. Try again.")');
  });
});

// R27 MM3 (new-customer L2): "Change email" is replaced by its form, and the
// form's Cancel by the button again. Focus goes to the New email field, and
// back to "Change email" (lib/focusAfter).
describe("Settings, Account: focus in Change email", () => {
  const source = readFileSync(join(__dirname, "account-section.tsx"), "utf8");
  const form = source.slice(source.indexOf("export function ChangeEmailForm"), source.indexOf("export function undoLinkSentence"));

  it("Change email hands focus to the New email field", () => {
    expect(form).toMatch(/ref=\{changeEmailRef\}[\s\S]{0,200}focusAfterPress\(event\.currentTarget, \(\) => newEmailRef\.current\);\s+setOpen\(true\);/);
    expect(form).toMatch(/<Input\s+ref=\{newEmailRef\}\s+id="new-email"/);
  });

  it("Cancel hands it back to Change email", () => {
    expect(form).toMatch(/focusAfterPress\(event\.currentTarget, \(\) => changeEmailRef\.current\);\s+setOpen\(false\);/);
  });
});

// R27 MM3 (new-customer L7): Change password said "Try again" with no answer.
// The server signs every device out on a change, so a lost answer may mean the
// password changed: say so, and what to do.
describe("Settings, Account: change password when the answer is lost", () => {
  const source = readFileSync(join(__dirname, "account-section.tsx"), "utf8");
  const form = source.slice(source.indexOf("function ChangePasswordForm"), source.indexOf("function DeleteAccount"));

  it("no answer or an unreadable 5xx: it may have changed; a refusal: the route's own sentence", () => {
    expect(PASSWORD_MAYBE_CHANGED_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so your password may have changed. If your connection dropped, reconnect first. Reload this page: if it asks you to sign in, use your new password.",
    );
    expect(passwordFailureText(502, null)).toBe(PASSWORD_MAYBE_CHANGED_MESSAGE);
    expect(passwordFailureText(400, { error: "Your current password is wrong." })).toBe("Your current password is wrong.");
    expect(passwordFailureText(400, null)).toBe("Could not change your password. Try again.");
  });

  it("sends through fetchOrNoAnswer and words no answer with that sentence", () => {
    expect(form).toMatch(/await fetchOrNoAnswer\("\/api\/auth\/change-password"/);
    expect(form).not.toMatch(/await fetch\(/);
    expect(form).toMatch(/isNoAnswer\(error\) \? PASSWORD_MAYBE_CHANGED_MESSAGE : /);
  });
});

// Lead follow-up (R27 MM3): with no answer the link may have been sent, so
// "your email is unchanged" could be wrong. Same rule as Create workspace.
describe("Settings, Account: change email when the answer is lost", () => {
  const source = readFileSync(join(__dirname, "account-section.tsx"), "utf8");
  const form = source.slice(source.indexOf("export function ChangeEmailForm"), source.indexOf("export function undoLinkSentence"));

  it("no answer or an unreadable 5xx: it may have gone through, and where to check", () => {
    expect(EMAIL_CHANGE_MAYBE_SENT_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the change may have gone through. If your connection dropped, reconnect first. Look in the new address's inbox for the confirmation email, or reload this page to see your current sign-in email.",
    );
    expect(emailChangeFailureText(502, null)).toBe(EMAIL_CHANGE_MAYBE_SENT_MESSAGE);
    expect(emailChangeFailureText(400, { error: "That is your current email." })).toBe("That is your current email.");
    expect(emailChangeFailureText(400, null)).toBe(
      "We couldn't start the change. Your email is unchanged. Please try again in a minute.",
    );
  });

  it("sends through fetchOrNoAnswer and never says unchanged when no answer came", () => {
    expect(form).toMatch(/await fetchOrNoAnswer\("\/api\/auth\/change-email"/);
    expect(form).toMatch(/setError\(emailChangeFailureText\(response\.status, data\)\);/);
    expect(form).toMatch(/isNoAnswer\(error\) \? EMAIL_CHANGE_MAYBE_SENT_MESSAGE : /);
    expect(form).not.toContain("so your email is unchanged");
  });
});

// R28 NN2 (new-customer L2): Delete account can't be undone and its answer can
// be lost after the account is gone; say so, and to reload first.
describe("Settings, Account: delete account when the answer is lost", () => {
  const source = readFileSync(join(__dirname, "account-section.tsx"), "utf8");
  const remove = source.slice(source.indexOf("function DeleteAccount"), source.indexOf("return (", source.indexOf("function DeleteAccount")));

  it("says it may have been deleted, and to reload before trying again", () => {
    expect(ACCOUNT_MAYBE_DELETED_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so your account may have been deleted. If your connection dropped, reconnect first. Reload this page first, and try again only if you're still signed in.",
    );
    expect(accountDeleteFailureText(502, null)).toBe(ACCOUNT_MAYBE_DELETED_MESSAGE);
    expect(accountDeleteFailureText(400, { error: "That password is wrong." })).toBe("That password is wrong.");
    expect(accountDeleteFailureText(400, null)).toBe("Could not delete your account. Try again.");
  });

  it("sends through fetchOrNoAnswer, and a lost answer gets that sentence (offline at the press: nothing sent)", () => {
    expect(remove).toMatch(/await fetchOrNoAnswer\("\/api\/auth\/account"/);
    expect(remove).toMatch(/setError\(accountDeleteFailureText\(response\.status, data\)\)/);
    expect(remove).toMatch(/confirmFailureText\(error, ACCOUNT_MAYBE_DELETED_MESSAGE, onLineAtPress\)/);
    expect(remove.indexOf("navigator.onLine")).toBeLessThan(remove.indexOf("await fetchOrNoAnswer"));
  });
});

// R28 NN2 (new-customer L4, pages L6): a success line that appears already
// filled may not be announced. Each form keeps an empty status region from
// its first render, and the success changes only its text.
describe("Settings, Account: success lines are on the page from the first render", () => {
  const source = readFileSync(join(__dirname, "account-section.tsx"), "utf8");

  it("Change email and Change password render an empty status region before any press", () => {
    const email = renderToStaticMarkup(createElement(ChangeEmailForm, { email: "old@example.com" }));
    expect(email).toMatch(/<div role="status" class="empty:sr-only"><\/div>/);
    const emailOpen = renderToStaticMarkup(createElement(ChangeEmailForm, { email: "old@example.com", startOpen: true }));
    expect(emailOpen).toMatch(/<div role="status" class="empty:sr-only"><\/div>/);
    expect(render(true).match(/<div role="status" class="empty:sr-only"><\/div>/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("the success Alert sits inside that region, not in its own return", () => {
    for (const [start, end, text] of [
      ["export function ChangeEmailForm", "const EMAIL_CHANGE_NOT_STARTED", "emailChangeSentMessage(sentTo, email)"],
      ["function ChangePasswordForm", "function DeleteAccount", "PASSWORD_CHANGED"],
    ]) {
      const form = source.slice(source.indexOf(start), source.indexOf(end));
      const region = form.indexOf('<div role="status" className="empty:sr-only">');
      expect(region, start).toBeGreaterThan(-1);
      expect(form.indexOf(text, region), start).toBeGreaterThan(region);
      expect(form, start).not.toMatch(/if \((sentTo|changed)\) \{\s+return <Alert/);
    }
  });
});

// Lead review (R28 NN2): once the DELETE answered ok the account is gone; a
// failing sign-out must not show an error, and the page leaves as deleted.
describe("Settings, Account: sign-out after a delete", () => {
  const source = readFileSync(join(__dirname, "account-section.tsx"), "utf8");
  const remove = source.slice(source.indexOf("function DeleteAccount"), source.indexOf("return (", source.indexOf("function DeleteAccount")));

  it("signs out in its own try, and leaves for the home page whatever it does", () => {
    expect(remove).toMatch(/try \{\s+await signOut\(\{ callbackUrl: "\/" \}\);\s+\} catch \{[\s\S]*?afterWorkspaceChange\("\/"\);\s+\}/);
    const failure = remove.slice(remove.indexOf("} catch (error) {"), remove.indexOf("return;", remove.indexOf("} catch (error) {")));
    expect(failure).toContain("ACCOUNT_MAYBE_DELETED_MESSAGE");
    expect(failure).not.toContain("signOut");
    expect(remove.indexOf("await signOut")).toBeGreaterThan(remove.indexOf("} catch (error) {"));
  });
});
