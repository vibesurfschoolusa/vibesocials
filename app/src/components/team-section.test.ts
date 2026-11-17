import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadErrorAsksReload } from "@/components/load-error";
import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";
import { renderedWorkspaceRefusal, WORKSPACE_CHANGED_SAVE_MESSAGE } from "@/lib/workspaceChanged";

import { LEAVE_NOT_MEMBER_MESSAGE, LEAVE_SOLE_OWNER_MESSAGE, soleOwnerLeaveStep } from "@/lib/leaveRefusals";

import {
  answerFailureText,
  INVITE_MAYBE_MADE_MESSAGE,
  LEAVE_MAYBE_LEFT_MESSAGE,
  leaveBlockedText,
  inviteFailureText,
  MAKE_MEMBER_BLOCKED_TITLE,
  makeMemberBlockedTitle,
  MEMBERS_LOAD_FAILED_TEXT,
  MEMBERS_LOAD_OFFLINE_TEXT,
  memberIsGone,
  memberRoleChanged,
  readTeamList,
  soleOwnerKnown,
  teamMemberLines,
} from "./team-section";

// R32 lead follow-up: Team's reads name the workspace the page was drawn for;
// a refusal (another tab switched) says the shared sentence, not the other's people.
describe("readTeamList", () => {
  const asFetch = (fn: () => Promise<Response>) => vi.fn(fn) as unknown as typeof fetch;

  it("asks with the page's id and gives the list", async () => {
    const fetchImpl = asFetch(async () => Response.json({ members: [{ name: "Ana", role: "owner" }] }));
    await expect(readTeamList("/api/workspaces/members/roster", "ws-1", fetchImpl)).resolves.toEqual({
      members: [{ name: "Ana", role: "owner" }],
    });
    expect(String((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0][0])).toBe(
      "/api/workspaces/members/roster?workspaceId=ws-1",
    );
  });

  it("a refusal: the switch sentence", async () => {
    const fetchImpl = asFetch(async () => renderedWorkspaceRefusal("ws-1", "ws-2") as Response);
    await expect(readTeamList("/api/workspaces/members", "ws-1", fetchImpl)).resolves.toEqual({ error: WORKSPACE_CHANGED_SAVE_MESSAGE });
  });

  // R41 review: the same reader and sentences as usePostJobs and useConnections.
  it("a 5xx, HTML or JSON, or an unreadable 200: Try again in a moment", async () => {
    const read = (answer: () => Promise<Response>) => readTeamList("/api/workspaces/members", "ws-1", asFetch(answer));
    await expect(read(async () => new Response("<html></html>", { status: 502, headers: { "content-type": "text/html" } }))).resolves.toEqual({
      error: MEMBERS_LOAD_FAILED_TEXT,
    });
    await expect(read(async () => Response.json({ error: "Internal error" }, { status: 500 }))).resolves.toEqual({ error: MEMBERS_LOAD_FAILED_TEXT });
    await expect(read(async () => new Response("<!doctype html>", { status: 200 }))).resolves.toEqual({ error: MEMBERS_LOAD_FAILED_TEXT });
    expect(MEMBERS_LOAD_FAILED_TEXT).toBe("Couldn't load members. Try again in a moment.");
  });

  it("no answer: the connection sentence", async () => {
    await expect(
      readTeamList("/api/workspaces/members", "ws-1", asFetch(async () => Promise.reject(new TypeError("Failed to fetch")))),
    ).resolves.toEqual({ error: MEMBERS_LOAD_OFFLINE_TEXT });
    expect(MEMBERS_LOAD_OFFLINE_TEXT).toBe("We couldn't reach Vibe Socials to load the members. Check your connection and try again.");
  });

  it("a 401: the signed-out sentence", async () => {
    await expect(
      readTeamList("/api/workspaces/members", "ws-1", asFetch(async () => Response.json({ error: "Unauthorized" }, { status: 401 }))),
    ).resolves.toEqual({ error: SIGNED_OUT_ERROR });
  });

  it("a workspace refusal's step is Reload page", async () => {
    const read = await readTeamList("/api/workspaces/members", "ws-1", asFetch(async () => renderedWorkspaceRefusal("ws-1", "ws-2") as Response));
    expect("error" in read && loadErrorAsksReload(read.error)).toBe(true);
  });

  it("the roster, members and invite reads all send the page's id", () => {
    const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
    expect(source).toContain('readTeamList<RosterEntry>("/api/workspaces/members/roster", workspaceId)');
    expect(source).toContain('readTeamList<Member>("/api/workspaces/members", workspaceId)');
    expect(source).toContain('fetch(withWorkspaceId("/api/workspaces/invites", workspaceId))');
  });
});

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
      "Vibe Socials' answer didn't reach you, so a new invite link may have been made, which turns the old one off. If your connection dropped, reconnect first. Reload this page and check Invite link before you send a link.",
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

// R33 new-customer L3: the "only owner" line and the disabled Leave only once
// the members list has loaded and shows one owner. While it loads, or after a
// failed read, the card says nothing about owners and Leave stays pressable:
// the leave route refuses the last owner itself.
describe("Team: the only-owner line and Leave", () => {
  const owner = { role: "owner" };
  const member = { role: "member" };

  it("knows the person is the only owner only from a loaded list", () => {
    expect(soleOwnerKnown([owner, member])).toBe(true);
    expect(soleOwnerKnown([owner, owner, member])).toBe(false);
    expect(soleOwnerKnown(null)).toBe(false);
  });

  // R35 client-journey L1: the line is the leave route's own rule
  // (lib/leaveRefusals), counted from the loaded list, without "Reload the page".
  it("other members but no other owner: Make owner", () => {
    expect(leaveBlockedText([owner, member], false)).toBe(soleOwnerLeaveStep("sole_owner"));
    expect(leaveBlockedText([owner, member, member], true)).toBe(soleOwnerLeaveStep("sole_owner"));
    expect(leaveBlockedText([owner, member], false)).not.toMatch(/Reload/);
  });

  it("alone with other workspaces: invite someone, or Delete this workspace", () => {
    expect(leaveBlockedText([owner], false)).toBe(soleOwnerLeaveStep("only_person"));
  });

  it("alone in the only workspace: invite someone, or Delete account under Account in Settings", () => {
    expect(leaveBlockedText([owner], true)).toBe(soleOwnerLeaveStep("only_workspace"));
  });

  it("a co-owner exists: Leave enabled, no line", () => {
    expect(leaveBlockedText([owner, owner], false)).toBeNull();
    expect(leaveBlockedText([owner, owner, member], true)).toBeNull();
  });

  it("list not loaded or failed: Leave enabled, no line (the route answers)", () => {
    expect(leaveBlockedText(null, false)).toBeNull();
    expect(leaveBlockedText(null, true)).toBeNull();
  });

  it("the line and Leave's disabled state both follow it", () => {
    const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
    expect(source).toContain("const leaveBlocked = leaveBlockedText(members, onlyWorkspace);");
    const start = source.indexOf("{/* Leave —");
    const leave = source.slice(start, source.indexOf("</div>", start));
    expect(leave).toContain("disabled={leaveBlocked !== null}");
    expect(leave).toMatch(/\{leaveBlocked \? <p[^>]*>\{leaveBlocked\}<\/p> : null\}/);
    expect(source).not.toContain("promote someone first");
  });

  it("Settings passes the only-workspace flag as a boolean", () => {
    const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
    expect(source).toMatch(/onlyWorkspace\?: boolean;/);
  });
});

// R33 lead review: Leave can now be pressed before the members list loads, so
// the route's refusals reach the toast; each names a control on this card.
describe("Team: Leave's refusals", () => {
  it("shows the route's sentence", () => {
    for (const [status, error] of [[400, LEAVE_SOLE_OWNER_MESSAGE], [404, LEAVE_NOT_MEMBER_MESSAGE]] as const) {
      expect(answerFailureText(status, { error }, LEAVE_MAYBE_LEFT_MESSAGE, "Couldn't leave the workspace.")).toBe(error);
    }
    const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
    expect(source).toContain(`toast.error(answerFailureText(response.status, data, LEAVE_MAYBE_LEFT_MESSAGE, "Couldn't leave the workspace."));`);
    expect(source).toContain("Make owner");
  });

  it("says what to do, with the card's own control", () => {
    expect(LEAVE_SOLE_OWNER_MESSAGE).toBe("You're the only owner. Reload the page, make another member an owner with Make owner, then leave.");
    expect(LEAVE_NOT_MEMBER_MESSAGE).toBe("You're no longer a member of this workspace. Reload the page.");
  });
});

// R36 new-customer L1 + lead review: what Delete account and Delete this
// workspace would refuse is worked out by the Settings server page, so one
// rule: whenever the card's own member list changes (a success, or a "gone"
// answer that drops the row), the server parts refresh (the card keeps its
// state). A failure that leaves the list alone doesn't.
describe("Team: a change to the member list refreshes the delete dialogs' refusals", () => {
  const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
  const handler = (name: string) => {
    const start = source.indexOf(`const ${name} = useCallback`);
    return source.slice(start, source.indexOf("}, [", start));
  };
  // The failure block: from the !response.ok check to its closing brace.
  const failureBlock = (body: string) => {
    const start = body.indexOf("if (!response.ok) {");
    return body.slice(start, body.indexOf("\n    }\n", start));
  };

  it("changeMembers changes the list and refreshes, in one place", () => {
    const change = handler("changeMembers");
    expect(change).toContain("setMembers(update);");
    expect(change).toContain("router.refresh();");
    // Only the first read sets the list otherwise.
    expect(source.match(/setMembers\(/g)).toHaveLength(2);
    expect(source).toContain('if ("members" in read) setMembers(read.members);');
  });

  it('a "gone" answer drops the row through it, so it refreshes too', () => {
    expect(handler("dropMember")).toContain("changeMembers(");
  });

  for (const name of ["confirmRemove", "confirmPromote", "confirmDemote"]) {
    it(`${name}: a success changes the list through it; a failure only drops a gone row`, () => {
      const body = handler(name);
      const failure = failureBlock(body);
      expect(failure.length, name).toBeGreaterThan(0);
      expect(failure, name).not.toContain("changeMembers(");
      expect(failure, name).not.toContain("router.refresh()");
      expect(body.slice(body.indexOf(failure) + failure.length), name).toContain("changeMembers(");
    });
  }

  it("the handlers call router.refresh() only for yourself (the list is not changed then)", () => {
    expect(handler("confirmRemove")).not.toContain("router.refresh()");
    expect(handler("confirmPromote")).not.toContain("router.refresh()");
    expect(handler("confirmDemote").match(/router\.refresh\(\)/g)).toHaveLength(1);
  });
});

// R36 new-customer L2 (pages L1): a sole owner's own greyed Make member named a
// step nobody can take. Its title follows the Leave line's rule.
describe("Team: the owner's own greyed Make member", () => {
  const owner = { role: "owner" };
  const member = { role: "member" };

  it("with other members: names Make owner", () => {
    expect(makeMemberBlockedTitle([owner, member], false)).toBe(MAKE_MEMBER_BLOCKED_TITLE);
    expect(makeMemberBlockedTitle([owner, member], true)).toBe(MAKE_MEMBER_BLOCKED_TITLE);
    expect(MAKE_MEMBER_BLOCKED_TITLE).toContain("Make owner");
  });

  it("alone, or with a co-owner, or before the list loads: no title", () => {
    expect(makeMemberBlockedTitle([owner], false)).toBeUndefined();
    expect(makeMemberBlockedTitle([owner], true)).toBeUndefined();
    expect(makeMemberBlockedTitle([owner, owner], false)).toBeUndefined();
    expect(makeMemberBlockedTitle(null, false)).toBeUndefined();
  });

  it("the button takes its title from that rule", () => {
    const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
    expect(source).toContain("title={makeMemberBlockedTitle(members, onlyWorkspace)}");
  });

  it("no text a person reads on the Team card, or that a Team route sends, says promote", () => {
    // R36 lead review: the routes' refusals are shown word for word (answerFailureText).
    const routes = (readdirSync(join(__dirname, "../app/api/workspaces"), { recursive: true }) as string[])
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => join("../app/api/workspaces", file));
    expect(routes.some((file) => file.includes("[userId]"))).toBe(true);
    for (const file of ["team-section.tsx", "../lib/leaveRefusals.ts", ...routes]) {
      const source = readFileSync(join(__dirname, file), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      // A word a person reads; identifiers such as promoteTarget and PROMOTE_FAILED are code.
      const words = code.match(/(?<![A-Za-z_])promot(?:e|ed|es|ing|ion)?(?![A-Za-z_])/gi) ?? [];
      expect(words, file).toEqual([]);
    }
  });
});
