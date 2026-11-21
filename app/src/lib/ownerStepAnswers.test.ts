import { describe, expect, it } from "vitest";

import {
  connectionsSectionIntro,
  noConnectionsMessage,
  nothingSentMessage,
  retryConnectMessage,
  retryReconnectMessage,
} from "./ownerStepAnswers";

// R12 L3: the Connections section's intro, for whoever reads it.
describe("connectionsSectionIntro", () => {
  it("the owner: as before", () => {
    expect(connectionsSectionIntro(false)).toBe("Connect your social accounts so Vibe Socials can publish on your behalf.");
  });

  it("a member: who connects them", () => {
    expect(connectionsSectionIntro(true)).toBe(
      "The accounts Vibe Socials publishes to for this workspace. The workspace owner connects and reconnects them.",
    );
  });
});

// R52 pages-a L4: Publish now's NO_CONNECTIONS also covers a platform that is
// connected but flagged needsReconnect (posting.ts gives it a failed
// RECONNECT_REQUIRED row, so no row is pending). Settings shows that one as
// connected, with Reconnect, so the sentence names both cases. R59 pages-a L1:
// the step is worded from the failed rows' codes; a platform with no
// connection is connected, not reconnected.
describe("nothingSentMessage", () => {
  const LEAD = "Nothing was posted: each of this post's platforms is either not connected or needs reconnecting.";

  it("all flagged: Activity's reconnect step, as before", () => {
    expect(nothingSentMessage("owner", ["reconnect", "reconnect"])).toBe(`${LEAD} Activity shows what to reconnect.`);
    expect(nothingSentMessage("member", ["reconnect"])).toBe(
      `${LEAD} Activity shows what didn't go out; the workspace owner can reconnect it.`,
    );
  });

  it("all gone: connect", () => {
    expect(nothingSentMessage("owner", ["connect"])).toBe(`${LEAD} Activity shows what to connect.`);
    expect(nothingSentMessage("member", ["connect", "connect"])).toBe(
      `${LEAD} Activity shows what didn't go out; the workspace owner can connect it.`,
    );
  });

  it("mixed, or the codes not known: connect or reconnect", () => {
    expect(nothingSentMessage("owner", ["connect", "reconnect"])).toBe(`${LEAD} Activity shows what to connect or reconnect.`);
    expect(nothingSentMessage("owner")).toBe(`${LEAD} Activity shows what to connect or reconnect.`);
    expect(nothingSentMessage("member", ["reconnect", "connect"])).toBe(
      `${LEAD} Activity shows what didn't go out; the workspace owner can connect or reconnect it.`,
    );
    expect(nothingSentMessage("member")).toBe(
      `${LEAD} Activity shows what didn't go out; the workspace owner can connect or reconnect it.`,
    );
  });

  it("never says the platforms aren't connected, which is false for one that needs reconnecting", () => {
    for (const role of ["owner", "member"] as const) {
      expect(nothingSentMessage(role)).not.toContain("is connected");
      expect(nothingSentMessage(role)).toContain("needs reconnecting");
    }
  });
});

// Nothing in the workspace is connected there, so "Connect" stays true.
describe("noConnectionsMessage (unchanged)", () => {
  it("keeps its sentences", () => {
    expect(noConnectionsMessage("create", "owner")).toBe("Connect at least one platform before creating a post.");
    expect(noConnectionsMessage("publish", "owner")).toBe("Connect at least one platform before publishing.");
    expect(noConnectionsMessage("publish", "member")).toBe("The workspace owner can connect a platform for this workspace.");
  });
});

// R58 pages-a-4 L1: a platform with no connection is connected, not reconnected.
describe("retryConnectMessage and retryReconnectMessage", () => {
  it("no connection: Connect for an owner, the owner's step for a member", () => {
    expect(retryConnectMessage(["instagram"], "owner")).toBe("Connect Instagram in Settings, then retry.");
    expect(retryConnectMessage(["instagram"], "member")).toBe("The workspace owner can connect Instagram; then retry.");
  });

  it("a flagged connection keeps the Reconnect wording", () => {
    expect(retryReconnectMessage(["instagram"], "owner")).toBe("Reconnect Instagram in Settings before retrying.");
    expect(retryReconnectMessage(["instagram"], "member")).toBe("The workspace owner can reconnect Instagram; then retry.");
  });
});
