import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { memberIsGone, memberRoleChanged, teamMemberLines } from "./team-section";

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
    for (const handler of ["confirmPromote", "confirmDemote"]) {
      const body = source.slice(source.indexOf(`const ${handler} = useCallback`));
      const end = body.indexOf("}, [");
      expect(body.slice(0, end), handler).toMatch(/if \(memberRoleChanged\(response\.status, data\)\) return;/);
    }
  });
});
