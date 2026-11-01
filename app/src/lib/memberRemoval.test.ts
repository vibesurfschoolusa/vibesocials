import { describe, expect, it } from "vitest";

import { INVITE_RESET_NOTICE, memberRemovalOutcome } from "./memberRemoval";

describe("memberRemovalOutcome", () => {
  it("uses the exact owner-facing copy", () => {
    expect(INVITE_RESET_NOTICE).toBe("Invite link reset — create a new one to invite more people.");
  });

  it.each([
    ["one invite revoked", { ok: true, invitesRevoked: 1 }],
    ["several invites revoked", { ok: true, invitesRevoked: 3 }],
  ])("clears the displayed invite and shows the notice when %s", (_label, body) => {
    expect(memberRemovalOutcome(body)).toEqual({
      clearInvite: true,
      notice: INVITE_RESET_NOTICE,
    });
  });

  it.each([
    ["no invite was active", { ok: true, invitesRevoked: 0 }],
    ["an older API response without the field", { ok: true }],
    ["a non-numeric field", { ok: true, invitesRevoked: "2" }],
    ["a negative count", { ok: true, invitesRevoked: -1 }],
    ["NaN", { ok: true, invitesRevoked: Number.NaN }],
    ["null", null],
    ["undefined (unparseable body)", undefined],
    ["an array", [1]],
    ["a string", "ok"],
  ])("leaves the invite alone and shows no notice when %s", (_label, body) => {
    expect(memberRemovalOutcome(body)).toEqual({ clearInvite: false, notice: null });
  });
});
