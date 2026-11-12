import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ConnectionStatus } from "@/lib/connectionsDto";
import type { WorkspaceSetup } from "@/lib/gettingStarted";
import type { PostJobDTO } from "@/lib/postsDto";

import { GettingStarted, WorkingForClients } from "./getting-started";

/** S1 item 1: the first step says which platforms connect right away today. */

const OFFERED = ["tiktok", "youtube", "instagram", "x", "linkedin", "facebook_page", "google_business_profile"] as const;
const OWNER: WorkspaceSetup = { role: "owner", footerSet: false, brandVoiceSet: false, hasClientLink: false };
const CONNECTED: ConnectionStatus[] = [{ platform: "youtube", connected: true, needsReconnect: false }];
const POSTED = [{ id: "j" }] as unknown as PostJobDTO[];

function render(connections: ConnectionStatus[] | null, jobs: PostJobDTO[] | null, setup: WorkspaceSetup | null): string {
  return renderToStaticMarkup(createElement(GettingStarted, { connections, jobs, setup, availablePlatforms: OFFERED }));
}
function renderClients(connections: ConnectionStatus[] | null, jobs: PostJobDTO[] | null, setup: WorkspaceSetup | null): string {
  return renderToStaticMarkup(createElement(WorkingForClients, { connections, jobs, setup }));
}

describe("GettingStarted", () => {
  it("with nothing connected, names the platforms that connect right away and links the guide", () => {
    const html = renderToStaticMarkup(
      createElement(GettingStarted, { connections: [], jobs: [], setup: OWNER, availablePlatforms: OFFERED }),
    );
    expect(html).toContain("YouTube and X connect right away today; the others are explained in the");
    expect(html).toMatch(/<a [^>]*href="\/help"[^>]*>setup guide<\/a>\./);
  });

  it("does not name Pinterest, configured or not (its access is still on trial)", () => {
    for (const available of [OFFERED, [...OFFERED, "pinterest"] as const]) {
      const html = renderToStaticMarkup(createElement(GettingStarted, { connections: [], jobs: [], setup: OWNER, availablePlatforms: available }));
      expect(html).toContain("YouTube and X connect right away today");
      expect(html).not.toContain("Pinterest");
    }
  });

  it("an owner sees four steps in order, the two settings linking to Posts and emails", () => {
    const html = render([], [], OWNER);
    const order = ["Connect a platform", "Set what every post ends with", "Tell the AI how you sound", "Create your first post"];
    const positions = order.map((title) => html.indexOf(title));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain("Your website and hashtags are added to the end of every post.");
    expect(html).toContain("Captions the AI writes follow your notes and examples.");
    expect(html.match(/href="\/settings#post-defaults"/g)).toHaveLength(2);
    expect(html).not.toContain("!");
  });

  it("a done step is struck through and loses its button", () => {
    const html = render(CONNECTED, [], { ...OWNER, footerSet: true });
    expect(html).toContain('Set what every post ends with<span class="sr-only"> (done)</span>');
    expect(html.match(/href="\/settings#post-defaults"/g)).toHaveLength(1);
  });

  it("a member with a connection sees only the post step", () => {
    const html = render(CONNECTED, [], { ...OWNER, role: "member" });
    expect(html).toContain("Create your first post");
    expect(html).not.toContain("Connect a platform");
    expect(html).not.toContain("Set what every post ends with");
    expect(html).not.toContain("Tell the AI how you sound");
  });

  it("renders nothing while loading, after a failed read, or once every step is done", () => {
    expect(render(null, [], OWNER)).toBe("");
    expect(render([], [], null)).toBe("");
    expect(render(CONNECTED, POSTED, { ...OWNER, footerSet: true, brandVoiceSet: true })).toBe("");
    expect(render([], [], { ...OWNER, role: "member" })).toBe("");
  });

  // Fix round 2: "Four steps to your first post" was wrong for an owner who
  // had posted with nothing connected. The words must hold in every state shown.
  it("says something true in every state that shows the block", () => {
    const ownerLine = "Get set up. Steps 2 and 3 are settings that change every post.";
    const states: Array<[ConnectionStatus[], PostJobDTO[], WorkspaceSetup, string]> = [
      [[], [], OWNER, ownerLine],
      [CONNECTED, [], OWNER, ownerLine],
      [[], POSTED, OWNER, ownerLine],
      [[], POSTED, { ...OWNER, footerSet: true, brandVoiceSet: true }, ownerLine],
      [CONNECTED, [], { ...OWNER, role: "member" }, "This workspace has a platform connected, so you can create posts."],
    ];
    for (const [connections, jobs, setup, line] of states) {
      const html = render(connections, jobs, setup);
      expect(html).toContain(line);
      expect(html).not.toContain("first post.");
    }
  });

  it("fix round 1: an owner who connected and posted sees no block, whatever the settings", () => {
    expect(render(CONNECTED, POSTED, OWNER)).toBe("");
  });
});

describe("WorkingForClients", () => {
  const ALL_SET: WorkspaceSetup = { ...OWNER, footerSet: true, brandVoiceSet: true };

  it("shows an owner the three client links once the steps are done", () => {
    const html = renderClients(CONNECTED, POSTED, ALL_SET);
    expect(html).toContain("Working for clients?");
    expect(html).toMatch(/<a [^>]*href="\/settings#connect-link"[^>]*>Send a connect link<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/media"[^>]*>Send an upload link<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/queue"[^>]*>Send a review link<\/a>/);
    expect(html).not.toContain("!");
  });

  it("shows an owner with a client link before the steps are done", () => {
    expect(renderClients([], [], { ...OWNER, hasClientLink: true })).toContain("Working for clients?");
  });

  it("fix round 2: shows an owner who connected and posted, with no settings, and Get started is gone", () => {
    expect(renderClients(CONNECTED, POSTED, OWNER)).toContain("Working for clients?");
    expect(render(CONNECTED, POSTED, OWNER)).toBe("");
  });

  it("stays hidden for an owner with nothing done and no link, for a member, and while loading", () => {
    expect(renderClients([], [], ALL_SET)).toBe("");
    expect(renderClients(CONNECTED, [], OWNER)).toBe("");
    expect(renderClients(CONNECTED, POSTED, { ...ALL_SET, role: "member", hasClientLink: true })).toBe("");
    expect(renderClients(null, POSTED, ALL_SET)).toBe("");
  });
});

// P1: client links are a Growth and Pro feature.
describe("WorkingForClients where the plan pauses client links", () => {
  const PAUSED: WorkspaceSetup = { ...OWNER, footerSet: true, brandVoiceSet: true, clientLinksPaused: true };

  it("shows one line linking to Settings, Plan instead of the three links", () => {
    const html = renderClients(CONNECTED, POSTED, PAUSED);
    expect(html).toContain("Working for clients?");
    expect(html).toContain("Client upload, review and connect links come with the Growth and Pro plans.");
    expect(html).toMatch(/<a [^>]*href="\/settings#plan"[^>]*>Choose a plan in Settings, Plan<\/a>/);
    expect(html).not.toContain("Send a connect link");
    expect(html).not.toContain("Send an upload link");
    expect(html).not.toContain("Send a review link");
  });
});
