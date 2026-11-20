import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const confirmProps: Record<string, unknown>[] = [];
vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    Dialog: pass,
    DialogBody: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    ConfirmDialog: (props: Record<string, unknown>) => {
      confirmProps.push(props);
      return null;
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }), signOut: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { CLIENT_LINKS_NOT_MADE_MESSAGE } from "@/lib/clientLinkWording";
import {
  CLIENT_LINKS_MAYBE_OFF_MESSAGE,
  CLIENT_LINKS_MAYBE_REPLACED_MESSAGE,
  CLIENT_LINKS_REPLACED_EVENT,
  clientLinksButtonShown,
  clientLinksTurnOffShown,
  requestClientLinksReplace,
  requestClientLinksTurnOff,
  watchClientLinks,
  ClientLinksPanel,
  clientLinksReplacedMessage,
  clientLinksTurnedOffMessage,
  demotedMessage,
  demotionOutcome,
  TeamSection,
} from "./team-section";

/**
 * R5-security L1: a former owner's copies of the client links keep working
 * until the remaining owners make new ones, in one press on the Team card.
 */

function team(role: "owner" | "member"): string {
  return renderToStaticMarkup(createElement(TeamSection, { workspaceId: "ws-1", role, workspaceName: "Surf Co" }));
}

const ON = { included: true, on: { upload: true, review: false, connect: false }, connectStopped: false };

function panel(state: Parameters<typeof ClientLinksPanel>[0]["state"]): string {
  confirmProps.length = 0;
  return renderToStaticMarkup(
    createElement(ClientLinksPanel, { state, onReplace: async () => {}, onTurnOff: async () => {} }),
  );
}

describe("Make new client links", () => {
  it("is shown while a client link is on and the plan includes them, saying why", () => {
    const html = panel(ON);
    expect(html).toContain("Make new client links");
    expect(html).toContain(
      "Someone who stops being an owner can still use the client upload, review and connect links they copied. New links stop the old ones working.",
    );
  });

  // R6 L2: not shown with nothing to replace, or on a plan without client links.
  it("is not shown with no client link on, on a plan without them, or before the state is read", () => {
    expect(clientLinksButtonShown(ON)).toBe(true);
    expect(clientLinksButtonShown({ ...ON, on: { upload: false, review: false, connect: true } })).toBe(true);
    expect(clientLinksButtonShown({ ...ON, on: { upload: false, review: false, connect: false } })).toBe(false);
    expect(clientLinksButtonShown({ ...ON, included: false })).toBe(false);
    expect(clientLinksButtonShown(null)).toBe(false);
    expect(panel({ ...ON, included: false })).not.toContain("Make new client links");
    expect(panel({ ...ON, included: false, on: { upload: false, review: false, connect: false } })).toBe("");
    expect(panel(null)).toBe("");
  });

  it("asks first, as a destructive confirm", () => {
    panel(ON);
    expect(confirmProps).toHaveLength(1);
    expect(confirmProps[0]).toMatchObject({
      destructive: true,
      title: "Make new client links?",
      description:
        "The client links that are on stop working, including any copies a former owner kept. Send your client the new ones afterwards.",
      confirmText: "Make new links",
      open: false,
    });
  });

  // Check 3: the Connections card shows the new connect link without a reload.
  it("after a replace, tells the page so the connect link card reads its new link; a refusal tells nothing", async () => {
    const announce = vi.fn();
    const answer = { uploadLink: null, reviewLink: null, connectLink: { url: "https://app.example.com/c/NEW" } };
    const ok = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
    await expect(requestClientLinksReplace(ok as unknown as typeof fetch, "ws-1", announce)).resolves.toEqual(answer);
    expect(ok).toHaveBeenCalledWith("/api/workspaces/client-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-1" }),
    });
    expect(announce).toHaveBeenCalledTimes(1);

    announce.mockClear();
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "Too many." }), { status: 429 }));
    await expect(requestClientLinksReplace(refused as unknown as typeof fetch, "ws-1", announce)).rejects.toThrow("Too many.");
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    // R28 NN2: the links may be new, so the page reads them again (team-section.answerLost.test.ts).
    await expect(requestClientLinksReplace(offline as unknown as typeof fetch, "ws-1", announce)).rejects.toThrow(
      CLIENT_LINKS_MAYBE_REPLACED_MESSAGE,
    );
    expect(announce).toHaveBeenCalledTimes(1);
    expect(CLIENT_LINKS_REPLACED_EVENT).toBe("vibe:client-links-replaced");
  });

  // R50 pages-a L1: a refusal without a sentence gets the shared one, which
  // makes no claim that the old links still work.
  it("a refusal with no sentence shows the shared not-made sentence", async () => {
    const announce = vi.fn();
    const bare = vi.fn(async () => new Response("", { status: 403 }));
    await expect(requestClientLinksReplace(bare as unknown as typeof fetch, "ws-1", announce)).rejects.toThrow(
      CLIENT_LINKS_NOT_MADE_MESSAGE,
    );
    expect(announce).not.toHaveBeenCalled();
  });

  it("the owners' Team card holds no button before the state is read, and a member's never", () => {
    expect(team("owner")).not.toContain("Make new client links");
    expect(team("member")).not.toContain("Make new client links");
  });

  it("says which links were made and where to copy them", () => {
    const both = { uploadLink: { url: "u" }, reviewLink: { url: "v" } };
    expect(clientLinksReplacedMessage(both)).toBe(
      "New client links are on and the old ones no longer work. Copy the upload link on the Media page and the review link on the Queue page, and send them to your client.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: { url: "u" }, reviewLink: null })).toBe(
      "A new client upload link is on and the old one no longer works. Copy it on the Media page and send it to your client.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: null, reviewLink: { url: "v" } })).toBe(
      "A new client review link is on and the old one no longer works. Copy it on the Queue page and send it to your client.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: null, reviewLink: null })).toBe(
      "No client link was on, so there was nothing to replace.",
    );
  });

  // R6 M2: the connect link is replaced too.
  it("names the connect link when it was made again, or turned off", () => {
    const connect = { url: "c" };
    expect(clientLinksReplacedMessage({ uploadLink: { url: "u" }, reviewLink: { url: "v" }, connectLink: connect })).toBe(
      "New client links are on and the old ones no longer work. Copy the upload link on the Media page, the review link on the Queue page and the connect link under Connections, and send them to your client.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: null, reviewLink: null, connectLink: connect })).toBe(
      "A new client connect link is on and the old one no longer works. Copy it under Connections and send it to your client.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: { url: "u" }, reviewLink: null, connectLinkTurnedOff: true })).toBe(
      "A new client upload link is on and the old one no longer works. Copy it on the Media page and send it to your client. The client connect link is off: none of its platforms can be connected here any more. Make a new one under Connections if you need it.",
    );
    expect(clientLinksReplacedMessage({ uploadLink: null, reviewLink: null, connectLinkTurnedOff: true })).toBe(
      "The client connect link is off: none of its platforms can be connected here any more. Make a new one under Connections if you need it.",
    );
  });

  // Check 4: from the links' state read after the demotion, naming only the links that still work.
  it("after a demotion, names the links that still work and points to the button", () => {
    expect(demotedMessage({ ...ON, on: { upload: true, review: false, connect: true } })).toBe(
      "Role updated. They could copy the client upload and connect links, which still work. Press Make new client links below to replace them.",
    );
    expect(demotedMessage({ ...ON, on: { upload: false, review: true, connect: false } })).toBe(
      "Role updated. They could copy the client review link, which still works. Press Make new client links below to replace it.",
    );
    expect(demotedMessage({ ...ON, on: { upload: false, review: false, connect: false } })).toBe("Role updated.");
    expect(demotedMessage(null)).toBe("Role updated.");
    // A plan without client links: none of them works, and there is no button.
    expect(demotedMessage({ ...ON, included: false })).toBe("Role updated.");
  });

  it("a stopped connect link is not called working; the button gives the client a new one", () => {
    expect(demotedMessage({ ...ON, on: { upload: false, review: false, connect: true }, connectStopped: true })).toBe(
      "Role updated. The client connect link has stopped working, because the owner who made it is no longer an owner. Press Make new client links below to give your client a new one.",
    );
    expect(demotedMessage({ ...ON, on: { upload: true, review: false, connect: true }, connectStopped: true })).toBe(
      "Role updated. They could copy the client upload link, which still works. The client connect link has stopped working, because the owner who made it is no longer an owner. Press Make new client links below to replace them.",
    );
  });

  // R6-client-journey L3: someone who made themself a member no longer has the button.
  it("after demoting yourself, says only that the role changed", () => {
    expect(demotedMessage({ ...ON, on: { upload: true, review: true, connect: true } }, true)).toBe("Role updated.");
  });
});

// R6 review low 2: the button follows the connect link card on the same page.
describe("Make new client links follows the client links on the page", () => {
  const OFF = { included: true, on: { upload: false, review: false, connect: false }, connectStopped: false };
  const CONNECT_ON = { ...OFF, on: { ...OFF.on, connect: true } };

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("first connect link turned on: the state is read again and the button appears; last link off: it hides", async () => {
    const answers = [CONNECT_ON, OFF];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(answers.shift()), { status: 200 }));
    const states: unknown[] = [];
    const stop = watchClientLinks("ws-1", (state) => states.push(state), fetchImpl as unknown as typeof fetch);

    announce("connect-link");
    await vi.waitFor(() => expect(states).toHaveLength(1));
    expect(fetchImpl).toHaveBeenCalledWith("/api/workspaces/client-links?workspaceId=ws-1");
    expect(clientLinksButtonShown(states[0] as typeof OFF)).toBe(true);

    announce("connect-link");
    await vi.waitFor(() => expect(states).toHaveLength(2));
    expect(clientLinksButtonShown(states[1] as typeof OFF)).toBe(false);

    stop();
    announce("connect-link");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("its own replace is not read again (the card already has the answer)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(OFF), { status: 200 }));
    watchClientLinks("ws-1", () => {}, fetchImpl as unknown as typeof fetch);
    announce("team");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function announce(source: "team" | "connect-link") {
  window.dispatchEvent(new CustomEvent(CLIENT_LINKS_REPLACED_EVENT, { detail: { source } }));
}

// R7-pages L3 / client-journey L2: on a plan without client links they are
// paused; the owners are offered "Turn off client links" instead of a
// replace the plan refuses.
describe("Turn off client links", () => {
  const PAUSED = { ...ON, included: false };

  it("is offered on a plan without client links while one is on, saying they are paused", () => {
    expect(clientLinksTurnOffShown(PAUSED)).toBe(true);
    expect(clientLinksTurnOffShown(ON)).toBe(false);
    expect(clientLinksTurnOffShown({ ...PAUSED, on: { upload: false, review: false, connect: false } })).toBe(false);
    expect(clientLinksTurnOffShown(null)).toBe(false);
    const html = panel(PAUSED);
    expect(html).toContain("Turn off client links");
    expect(html).toContain(
      "Client links are paused, because this workspace&#x27;s plan doesn&#x27;t include them. Copies kept by someone who stopped being an owner would work again if the plan changes to one with client links. Turning them off stops that.",
    );
    expect(html).not.toContain("Make new client links");
  });

  it("asks first, as a destructive confirm", () => {
    panel(PAUSED);
    expect(confirmProps).toHaveLength(1);
    expect(confirmProps[0]).toMatchObject({
      destructive: true,
      title: "Turn off client links?",
      description:
        "The client upload, review and connect links stop working for good, including any copies a former owner kept. You can make new ones on a plan with client links.",
      confirmText: "Turn off",
      open: false,
    });
  });

  it("sends DELETE for the rendered workspace and tells the page; a refusal throws its sentence and tells nothing", async () => {
    const announce = vi.fn();
    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await requestClientLinksTurnOff(ok as unknown as typeof fetch, "ws-1", announce);
    expect(ok).toHaveBeenCalledWith("/api/workspaces/client-links", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-1" }),
    });
    expect(announce).toHaveBeenCalledTimes(1);

    announce.mockClear();
    const refused = vi.fn(async () => Response.json({ error: "Nope." }, { status: 500 }));
    await expect(requestClientLinksTurnOff(refused as unknown as typeof fetch, "ws-1", announce)).rejects.toThrow("Nope.");
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(requestClientLinksTurnOff(offline as unknown as typeof fetch, "ws-1", announce)).rejects.toThrow(
      CLIENT_LINKS_MAYBE_OFF_MESSAGE,
    );
    expect(announce).toHaveBeenCalledTimes(1);
  });
});

// R9-client-journey L1: a demotion that turned off the invite link the card shows.
// R22 client-journey L1 / security L1: while the workspace is blocked every
// client link answers "not active", and new ones can't be made.
describe("while the workspace is blocked", () => {
  const BLOCKED_SENTENCE = "Client links don't work right now. This workspace is paused. Contact help@example.com.";
  const BLOCKED = { ...ON, workspaceBlocked: BLOCKED_SENTENCE, workspaceBlockedBy: "pause" as const };

  it("offers Turn off client links only, with the panel's sentence", () => {
    expect(clientLinksButtonShown(BLOCKED)).toBe(false);
    expect(clientLinksTurnOffShown(BLOCKED)).toBe(true);
    expect(clientLinksTurnOffShown({ ...BLOCKED, on: { upload: false, review: false, connect: false } })).toBe(false);
    const html = panel(BLOCKED);
    expect(html).toContain("Turn off client links");
    expect(html).not.toContain("Make new client links");
    expect(html).toContain(
      "Client links don&#x27;t work right now. This workspace is paused. Contact help@example.com. Copies kept by someone who stopped being an owner will work again once the workspace is active again. Turning them off stops that.",
    );
    expect(confirmProps[0]).toMatchObject({
      title: "Turn off client links?",
      description:
        "The client upload, review and connect links stop working for good, including any copies a former owner kept. You can make new ones once client links work again.",
    });
  });

  // HH1 review: blocked AND on a plan without client links, the plan's wording
  // (the lasting reason) wins: the copies won't work again when the block ends.
  it("blocked on a plan without client links: the panel and the toast use the plan's wording", () => {
    const both = { ...BLOCKED, included: false };
    expect(panel(both)).toContain("because this workspace&apos;s plan doesn&apos;t include them".replace(/&apos;/g, "&#x27;"));
    expect(panel(both)).not.toContain("work again once the workspace is active again");
    expect(demotedMessage({ ...both, on: { upload: true, review: true, connect: false } })).not.toContain(
      "work again once the workspace is active again",
    );
  });

  it("the demotion toast says the links work again once the block ends, and points to Turn off", () => {
    expect(demotedMessage({ ...BLOCKED, on: { upload: true, review: true, connect: false } })).toBe(
      `Role updated. They could copy the client upload and review links. ${BLOCKED_SENTENCE} The copies they kept will work again once the workspace is active again. Press Turn off client links below to stop that.`,
    );
    expect(demotedMessage({ ...BLOCKED, on: { upload: false, review: true, connect: false } })).toBe(
      `Role updated. They could copy the client review link. ${BLOCKED_SENTENCE} The copy they kept will work again once the workspace is active again. Press Turn off client links below to stop that.`,
    );
    // A stopped connect link alone: nothing to turn off, nothing to make while blocked.
    expect(demotedMessage({ ...BLOCKED, on: { upload: false, review: false, connect: true }, connectStopped: true })).toBe(
      "Role updated.",
    );
    expect(demotedMessage({ ...BLOCKED, on: { upload: true, review: true, connect: true } }, true)).toBe("Role updated.");
  });

  it("active, and a plan without client links: as before", () => {
    expect(demotedMessage({ ...ON, on: { upload: false, review: true, connect: false } })).toContain("Press Make new client links");
    expect(demotedMessage({ ...ON, included: false })).toBe("Role updated.");
  });
});

// R23 security L1 / client-journey L2: with billing on, the GET answers an
// ended trial or Growth plan as included (the plan has client links; it has
// ended), and an ended Starter plan as not. The card and the toast follow.
describe("an ended trial or plan, as the GET answers it", () => {
  const AGAIN = "Choose Growth or Pro in Settings and your client links work again, or contact help@example.com.";
  const states = {
    trial: { ...ON, workspaceBlocked: `Client links don't work right now. Your free trial has ended. ${AGAIN}`, workspaceBlockedBy: "plan" as const },
    growth: { ...ON, workspaceBlocked: `Client links don't work right now. Your plan has ended. ${AGAIN}`, workspaceBlockedBy: "plan" as const },
    starter: {
      ...ON,
      included: false,
      workspaceBlocked: `Client links don't work right now. Your Starter plan has ended, and Starter doesn't include client links. ${AGAIN}`,
      workspaceBlockedBy: "plan" as const,
    },
  };
  const both = { upload: true, review: true, connect: false };

  for (const name of ["trial", "growth"] as const) {
    // II1 review: "once the workspace is active again" was untrue after picking Starter.
    it(`an ended ${name}: the card and the demotion toast give the block's sentence, and the copies work again on Growth or Pro`, () => {
      const state = states[name];
      const html = panel(state);
      expect(html).toContain(
        `${state.workspaceBlocked.replace(/'/g, "&#x27;")} Copies kept by someone who stopped being an owner will work again once the workspace is on Growth or Pro. Turning them off stops that.`,
      );
      expect(html).not.toContain("active again");
      expect(html).not.toContain("plan doesn&#x27;t include them");
      expect(demotedMessage({ ...state, on: both })).toBe(
        `Role updated. They could copy the client upload and review links. ${state.workspaceBlocked} The copies they kept will work again once the workspace is on Growth or Pro. Press Turn off client links below to stop that.`,
      );
      expect(demotedMessage({ ...state, on: { upload: false, review: true, connect: false } })).toContain(
        "The copy they kept will work again once the workspace is on Growth or Pro.",
      );
    });
  }

  it("an ended Starter plan: the card gives the plan's wording, the toast only the role", () => {
    const html = panel(states.starter);
    expect(html).toContain("because this workspace&#x27;s plan doesn&#x27;t include them");
    expect(html).not.toContain("work again once the workspace is active again");
    expect(demotedMessage({ ...states.starter, on: both })).toBe("Role updated.");
  });
});

// R23 new-customer L1 / client-journey L5: while blocked, the plan isn't the reason.
describe("the Turn off toast", () => {
  const BLOCKED_SENTENCE = "Client links don't work right now. This workspace is paused. Contact help@example.com.";

  it("while blocked on a plan with client links: the copies stay off even once the workspace is active again", () => {
    expect(clientLinksTurnedOffMessage({ ...ON, workspaceBlocked: BLOCKED_SENTENCE })).toBe(
      "Client links are off. Nobody can use the old ones, even once the workspace is active again.",
    );
  });

  it("otherwise: today's text", () => {
    const TODAY = "Client links are off. Nobody can use the old ones, even if the plan changes.";
    expect(clientLinksTurnedOffMessage({ ...ON, included: false })).toBe(TODAY);
    expect(clientLinksTurnedOffMessage({ ...ON, included: false, workspaceBlocked: BLOCKED_SENTENCE })).toBe(TODAY);
    expect(clientLinksTurnedOffMessage(null)).toBe(TODAY);
  });
});

// R32 client-journey L5: a demoted owner's connect link stops working, and the
// connect link card reads its link only when it mounts, so the demotion is
// announced as a Team change and the card (RemountOnClientLinksReplaced) reads again.
describe("confirmDemote and the connect link card", () => {
  it("announces a Team change after another owner's demotion, before the links are read", () => {
    const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
    const demote = source.slice(source.indexOf("const confirmDemote"), source.indexOf("const replaceClientLinks"));
    const self = demote.indexOf("if (demoteTarget.userId === currentUserId)");
    const announced = demote.indexOf('announceClientLinksReplaced("team");');
    expect(announced).toBeGreaterThan(self);
    expect(announced).toBeLessThan(demote.indexOf("await fetchClientLinks(workspaceId)"));
  });
});

describe("demotionOutcome", () => {
  it("clears the invite link and says so when the demotion turned links off", () => {
    expect(demotionOutcome({ ok: true, role: "member", joinLinksRevoked: 1 })).toEqual({
      clearInvite: true,
      notice: "Invite link reset — create a new one to invite more people.",
    });
  });

  it("keeps it when none was turned off, or the answer doesn't say", () => {
    const keep = { clearInvite: false, notice: null };
    expect(demotionOutcome({ ok: true, role: "member", joinLinksRevoked: 0 })).toEqual(keep);
    expect(demotionOutcome({ ok: true, role: "member" })).toEqual(keep);
    expect(demotionOutcome(null)).toEqual(keep);
  });

  it("is what confirmDemote acts on", () => {
    const source = readFileSync(join(__dirname, "team-section.tsx"), "utf8");
    const demote = source.slice(source.indexOf("const confirmDemote"), source.indexOf("const replaceClientLinks"));
    expect(demote).toContain("demotionOutcome(");
    expect(demote).toContain("setInvite(null)");
  });
});
