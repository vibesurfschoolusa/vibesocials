import { describe, expect, it } from "vitest";

import {
  COMPOSE_CTA,
  deriveDashboardCta,
  deriveGettingStarted,
  workspaceSetupFrom,
  type WorkspaceSetup,
} from "./gettingStarted";
import type { ConnectionStatus } from "@/lib/connectionsDto";
import type { PostJobDTO } from "@/lib/postsDto";

// Same factory-with-overrides pattern as usePostJobs.test.ts — only the
// fields deriveGettingStarted actually reads (connection.connected,
// jobs.length) vary per test; everything else is a fixed, valid stand-in.
function connection(partial: Partial<ConnectionStatus> = {}): ConnectionStatus {
  return {
    platform: "youtube",
    connected: false,
    needsReconnect: false,
    ...partial,
  };
}

function job(partial: Partial<PostJobDTO> = {}): PostJobDTO {
  return {
    id: "job",
    status: "completed",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    scheduledFor: null,
    caption: "c",
    results: [],
    media: null,
    mediaCount: 1,
    publish: null,
    createdBy: null,
    approvalState: "none" as const,
    platformCaptions: null,
    ...partial,
  };
}

const owner: WorkspaceSetup = { role: "owner", footerSet: false, brandVoiceSet: false, hasClientLink: false };
const member: WorkspaceSetup = { ...owner, role: "member" };
const ownerAllSet: WorkspaceSetup = { ...owner, footerSet: true, brandVoiceSet: true };
const connected = [connection({ connected: true })];

describe("deriveGettingStarted", () => {
  it("is not ready (and hidden) while any source is still null", () => {
    const cases: Array<[ConnectionStatus[] | null, PostJobDTO[] | null, WorkspaceSetup | null]> = [
      [null, null, owner],
      [[], null, owner],
      [null, [], owner],
      [[], [], null],
    ];
    for (const args of cases) {
      expect(deriveGettingStarted(args[0], args[1], args[2])).toMatchObject({
        ready: false,
        show: false,
        showClients: false,
      });
    }
  });

  it("shows all four steps open for a brand-new owner", () => {
    expect(deriveGettingStarted([connection()], [], owner)).toEqual({
      ready: true,
      steps: ["connect", "footer", "voice", "post"],
      connectDone: false,
      footerDone: false,
      voiceDone: false,
      postDone: false,
      complete: false,
      show: true,
      showClients: false,
    });
  });

  it("connected only: the other three stay open", () => {
    const state = deriveGettingStarted(
      [connection(), connection({ platform: "x", connected: true })],
      [],
      owner,
    );
    expect(state).toMatchObject({ connectDone: true, footerDone: false, voiceDone: false, postDone: false, show: true });
  });

  it("a connections list of all-disconnected rows does NOT count as connected", () => {
    const state = deriveGettingStarted([connection(), connection({ platform: "x" })], [], owner);
    expect(state.connectDone).toBe(false);
  });

  it("connected and a website: the footer step is done", () => {
    const setup = workspaceSetupFrom({ companyWebsite: "https://example.com", defaultHashtags: null, brandVoice: null, brandVoiceExamples: null }, "owner", false);
    const state = deriveGettingStarted(connected, [], setup);
    expect(state).toMatchObject({ connectDone: true, footerDone: true, voiceDone: false, show: true });
  });

  it("hashtags alone are enough for the footer step", () => {
    const setup = workspaceSetupFrom({ companyWebsite: null, defaultHashtags: "#surf", brandVoice: null, brandVoiceExamples: null }, "owner", false);
    expect(deriveGettingStarted([], [], setup)).toMatchObject({ footerDone: true, voiceDone: false });
  });

  it("example captions alone are enough for the brand voice step", () => {
    const setup = workspaceSetupFrom({ companyWebsite: null, defaultHashtags: null, brandVoice: null, brandVoiceExamples: "Waves at 7." }, "owner", false);
    expect(deriveGettingStarted([], [], setup)).toMatchObject({ footerDone: false, voiceDone: true });
  });

  it("brand voice notes alone are enough for the brand voice step", () => {
    const setup = workspaceSetupFrom({ companyWebsite: null, defaultHashtags: null, brandVoice: "Friendly, short.", brandVoiceExamples: null }, "owner", false);
    expect(deriveGettingStarted([], [], setup).voiceDone).toBe(true);
  });

  it("marks post done for any job, including a draft that never published", () => {
    const state = deriveGettingStarted([connection()], [job({ status: "draft" })], owner);
    expect(state.postDone).toBe(true);
    expect(state.connectDone).toBe(false);
    expect(state.show).toBe(true);
  });

  // Fix round 1: the block shows only while connect or the first post is open,
  // as before S2, so an established owner never sees it come back.
  // Fix round 2: an established owner gets the clients block whatever the settings say.
  it("connected and posted with no website, hashtags or brand voice: no block, the clients block", () => {
    expect(deriveGettingStarted(connected, [job()], owner)).toMatchObject({
      footerDone: false,
      voiceDone: false,
      complete: true,
      show: false,
      showClients: true,
    });
  });

  it("an owner with nothing done: Get started, no clients block", () => {
    expect(deriveGettingStarted([], [], ownerAllSet)).toMatchObject({ show: true, showClients: false });
  });

  it("connected only: the block lists all four steps with the settings' real state", () => {
    const state = deriveGettingStarted(connected, [], { ...owner, brandVoiceSet: true });
    expect(state).toMatchObject({
      steps: ["connect", "footer", "voice", "post"],
      connectDone: true,
      footerDone: false,
      voiceDone: true,
      show: true,
    });
  });

  it("posted but nothing connected: the block shows, as before", () => {
    expect(deriveGettingStarted([], [job()], ownerAllSet)).toMatchObject({ postDone: true, connectDone: false, show: true });
  });

  it("hides once all four steps are done, and offers the clients block", () => {
    expect(deriveGettingStarted(connected, [job()], ownerAllSet)).toEqual({
      ready: true,
      steps: ["connect", "footer", "voice", "post"],
      connectDone: true,
      footerDone: true,
      voiceDone: true,
      postDone: true,
      complete: true,
      show: false,
      showClients: true,
    });
  });

  it("a member with connections and no posts sees only the post step", () => {
    expect(deriveGettingStarted(connected, [], member)).toMatchObject({
      steps: ["post"],
      complete: false,
      show: true,
      showClients: false,
    });
  });

  it("a member sees nothing while the owner has connected nothing", () => {
    expect(deriveGettingStarted([connection()], [], member)).toMatchObject({ show: false, showClients: false });
  });

  it("a member who has posted sees nothing", () => {
    expect(deriveGettingStarted(connected, [job()], member)).toMatchObject({ complete: true, show: false });
  });

  it("the clients block shows an owner with a client link before the steps are done", () => {
    const state = deriveGettingStarted([], [], { ...owner, hasClientLink: true });
    expect(state).toMatchObject({ show: true, showClients: true });
  });

  it("the clients block never shows a member", () => {
    expect(deriveGettingStarted(connected, [job()], { ...ownerAllSet, role: "member", hasClientLink: true }).showClients).toBe(false);
  });
});

describe("workspaceSetupFrom", () => {
  const empty = { companyWebsite: null, defaultHashtags: null, brandVoice: null, brandVoiceExamples: null };

  it("reads nothing set from empty or blank fields", () => {
    expect(workspaceSetupFrom(empty, "owner", false)).toEqual(owner);
    expect(workspaceSetupFrom({ ...empty, companyWebsite: "  ", brandVoice: "" }, "owner", false)).toEqual(owner);
  });

  it("never says a member has a client link", () => {
    expect(workspaceSetupFrom(empty, "member", true).hasClientLink).toBe(false);
  });
});

describe("deriveDashboardCta", () => {
  it("returns null while connections are unresolved", () => {
    // The caller shows a skeleton rather than flashing the wrong label and
    // swapping it once the fetch lands. `null` covers both "in flight" and
    // "failed", so the caller must tell those apart itself — see COMPOSE_CTA.
    expect(deriveDashboardCta(null)).toBeNull();
  });

  // useConnections leaves `connections` null on a failed fetch, so an unwary
  // caller would park a loading skeleton on screen forever. The fallback keeps
  // the header usable: composing is safe to offer blind because the composer
  // shows its own connect CTA when nothing is connected.
  it("exposes a compose fallback for callers whose fetch failed", () => {
    expect(COMPOSE_CTA).toEqual({
      kind: "compose",
      href: "/posts/new",
      label: "Create post",
    });
    expect(deriveDashboardCta([connection({ connected: true })])).toEqual(
      COMPOSE_CTA,
    );
  });

  // Leading with "Create post" when nothing is connected sends the user to a
  // composer that can only tell them to go connect something.
  // 2026-11-09 first-run check: straight to the Connections section, not the
  // top of Settings (caption settings).
  it("leads with connecting when nothing is connected", () => {
    expect(deriveDashboardCta([])).toEqual({
      kind: "connect",
      href: "/settings#connections",
      label: "Connect a platform",
    });
    expect(deriveDashboardCta([connection({ connected: false })])).toMatchObject({
      kind: "connect",
    });
  });

  it("leads with composing once any platform is connected", () => {
    expect(
      deriveDashboardCta([
        connection({ platform: "tiktok", connected: false }),
        connection({ platform: "youtube", connected: true }),
      ]),
    ).toEqual({ kind: "compose", href: "/posts/new", label: "Create post" });
  });

  // A connection that needs reconnecting is still a connection: the composer
  // works, and the ConnectionHealth widget is what flags the problem.
  it("still leads with composing when the only connection needs reconnecting", () => {
    expect(
      deriveDashboardCta([connection({ connected: true, needsReconnect: true })]),
    ).toMatchObject({ kind: "compose" });
  });
});
