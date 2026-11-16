import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { INVITE_MAYBE_MADE_MESSAGE, inviteFailureText, memberIsGone, memberRoleChanged, teamMemberLines } from "./team-section";

// R5 pages L10: the field that shows a new invite link has a name for screen
// readers. It only renders right after a link is made (client state), so the
// source is checked.
describe("Team section invite link field", () => {
  it("is labelled", () => {
    const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
    expect(source).toMatch(/<Input\s+readOnly\s+value=\{freshUrl\}\s+aria-label="New invite link"/);
  });
});

// R15 (after AA2): the owners' Team card names each person with the one label
// rule, so a blank or spaces-only name never shows as an empty row.
describe("Team card member names", () => {
  it("shows the name with the address under it, else the full address alone", () => {
    expect(teamMemberLines({ name: "Ana Ruiz", email: "ana@surf.example" })).toEqual({
      label: "Ana Ruiz",
      email: "ana@surf.example",
    });
    for (const name of [null, "", "   "]) {
      expect(teamMemberLines({ name, email: "info@surf.example" }), String(name)).toEqual({
        label: "info@surf.example",
        email: null,
      });
    }
  });

  it("the card's rows, toasts and dialogs never fall back with name ?? email", () => {
    const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
    expect(source).not.toMatch(/\.name \?\? /);
  });
});

// R25 new-customer L2: removing or changing someone who already left answered
// "Not found" and kept their row. The route now says they are gone (`gone`),
// and the card drops the row and closes the dialog.
describe("a member who is no longer in the workspace", () => {
  const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");

  it("is read from the route's gone answer only", () => {
    expect(memberIsGone(404, { error: "This person is no longer in the workspace.", gone: true })).toBe(true);
    expect(memberIsGone(404, { error: "Not found" })).toBe(false);
    expect(memberIsGone(400, { gone: true })).toBe(false);
    expect(memberIsGone(404, null)).toBe(false);
  });

  it("Remove, Make owner and Make member drop the row on that answer", () => {
    for (const handler of ["confirmRemove", "confirmPromote", "confirmDemote"]) {
      const body = source.slice(source.indexOf(`const ${handler} = useCallback`));
      const end = body.indexOf("}, [");
      expect(body.slice(0, end), handler).toMatch(/if \(memberIsGone\(response\.status, data\)\) \{\s+dropMember\(\w+\.userId\);\s+return;\s+\}/);
    }
  });
});

// R25 new-customer L1: Team's confirms said nothing when the request never
// left. Their refusals, already toasted, are marked so the dialog doesn't show
// them again; a request that never left is said by the dialog.
describe("Team's confirm handlers", () => {
  const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");

  it("mark what they already toasted", () => {
    for (const code of ["LEAVE_FAILED", "REVOKE_FAILED", "REMOVE_FAILED", "PROMOTE_FAILED", "DEMOTE_FAILED"]) {
      expect(source).toContain(`throw new ConfirmFailureShown("${code}")`);
    }
  });
});

// R25 pages L3: at 375 px a member's row left about 20-30 px for the name. Below
// sm the row wraps, with its badge and buttons on their own line.
describe("the owners' member rows on a phone", () => {
  const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");

  it("stack below sm and sit side by side from sm", () => {
    expect(source).toContain(
      '<li key={member.userId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">',
    );
    expect(source).toContain('<div className="flex flex-wrap items-center gap-2 sm:shrink-0">');
  });
});

// KK3 follow-up: a promote or demote that found the person's role already
// changed (another owner, meanwhile) keeps their row: it is not "gone".
describe("a member whose role changed in the meantime", () => {
  const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");

  it("is read from the route's roleChanged answer only", () => {
    expect(memberRoleChanged(409, { error: "Their role changed in the meantime.", roleChanged: true })).toBe(true);
    expect(memberRoleChanged(409, { error: "Switched workspace." })).toBe(false);
    expect(memberRoleChanged(404, { roleChanged: true })).toBe(false);
    expect(memberRoleChanged(409, null)).toBe(false);
    expect(memberIsGone(409, { roleChanged: true })).toBe(false);
  });

  it("Make owner and Make member keep the row and close on that answer", () => {
    // R26 new-customer L2: Remove too, on someone a co-owner just made owner.
    for (const handler of ["confirmPromote", "confirmDemote", "confirmRemove"]) {
      const body = source.slice(source.indexOf(`const ${handler} = useCallback`));
      const end = body.indexOf("}, [");
      expect(body.slice(0, end), handler).toMatch(/if \(memberRoleChanged\(response\.status, data\)\) return;/);
    }
  });
});

// R27 MM3 (new-customer L2, pages L1): "Create invite link" is replaced by the
// invite block, and the rename Save disables itself after a save. Both hand
// focus on through lib/focusAfter: Copy link, and the name field.
describe("Team card focus after a press", () => {
  const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
  const body = (start: string) => source.slice(source.indexOf(start), source.indexOf("}, [", source.indexOf(start)));

  it("Create invite link: focus goes to the new Copy link button", () => {
    const create = body("const createInvite = useCallback");
    expect(create).toMatch(/const pressed = event\?\.currentTarget \?\? null;/);
    expect(create).toMatch(/focusAfterPress\(pressed, \(\) => copyInviteRef\.current\);\s+setFreshUrl\(data\.url\);/);
    expect(source).toMatch(/ref=\{copyInviteRef\}\s+size="sm"\s+variant="outline"\s+className="shrink-0"\s+onClick=\{copyInviteUrl\}/);
  });

  it("the rename Save: once saved it is disabled, and focus moves on, not to the page", () => {
    const save = body("const handleSaveName = useCallback");
    expect(save).toMatch(/focusAfterPress\(saveNameRef\.current\);\s+setSavedName\(stored\);/);
    expect(source).toMatch(/<Button\s+ref=\{saveNameRef\}/);
  });
});

// R27 MM3 (new-customer L1): the invite route turns the old link off before it
// answers, so a lost answer may mean a new link exists. Never "nothing changed".
describe("Create invite link when the answer is lost", () => {
  const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");

  it("says it may have gone through and where to check", () => {
    expect(INVITE_MAYBE_MADE_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so a new invite link may have been made, which turns the old one off. Reload this page and check Invite link before you send a link.",
    );
    expect(INVITE_MAYBE_MADE_MESSAGE).not.toMatch(/nothing changed/i);
  });

  it("no answer, an unreadable 5xx or a 2xx without the link: that sentence; a refusal: the route's own", () => {
    expect(inviteFailureText(502, null)).toBe(INVITE_MAYBE_MADE_MESSAGE);
    expect(inviteFailureText(500, {})).toBe(INVITE_MAYBE_MADE_MESSAGE);
    expect(inviteFailureText(200, null)).toBe(INVITE_MAYBE_MADE_MESSAGE);
    expect(inviteFailureText(409, { error: "This page was opened for another workspace." })).toBe(
      "This page was opened for another workspace.",
    );
    expect(inviteFailureText(503, { error: "Try again in a minute." })).toBe("Try again in a minute.");
    expect(inviteFailureText(403, null)).toBe("Couldn't create an invite link. Reload the page and try again.");
  });

  it("the request with no answer at all uses the same sentence", () => {
    const create = source.slice(source.indexOf("const createInvite = useCallback"), source.indexOf("}, [", source.indexOf("const createInvite = useCallback")));
    expect(create).toMatch(/toast\.error\(inviteFailureText\(response\.status, data\)\);/);
    expect(create).toMatch(/confirmFailureText\(error, INVITE_MAYBE_MADE_MESSAGE\)/);
  });
});
