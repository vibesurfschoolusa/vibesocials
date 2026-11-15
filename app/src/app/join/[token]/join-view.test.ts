import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { getCurrentUserMock, inviteFindUniqueMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  inviteFindUniqueMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/db", () => ({ prisma: { workspaceInvite: { findUnique: inviteFindUniqueMock } } }));

import { hashInviteToken } from "@/lib/inviteToken";

import JoinPage, { metadata } from "./page";
import {
  acceptInvite,
  INVALID_INVITE_DESCRIPTION,
  invalidInviteDescription,
  JOIN_FAILED_MESSAGE,
  JOIN_OFFLINE_MESSAGE,
  JOIN_SIGNED_OUT_MESSAGE,
  JoinDeadLink,
  JoinSignedOut,
  JoinUnreachable,
  JoinView,
  joinPromise,
  loadInvite,
} from "./join-view";

function respond(status: number, body: unknown = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("join page", () => {
  // R5 pages L11.
  it("names the tab", () => {
    expect(metadata.title).toBe("Join a workspace | Vibe Socials");
  });
});

// R5 pages L7: a network failure is not an invalid invite.
describe("loadInvite", () => {
  it("reads the preview", async () => {
    await expect(loadInvite(respond(200, { workspaceName: "Acme", alreadyMember: false }), "tok")).resolves.toEqual({
      kind: "ok",
      preview: { workspaceName: "Acme", alreadyMember: false },
    });
  });

  it("calls a 404 an invalid link", async () => {
    await expect(loadInvite(respond(404), "tok")).resolves.toEqual({ kind: "invalid" });
  });

  // R10-pages L3: the server says why (a link whose maker is no longer an owner).
  it("keeps the 404's sentence when there is one", async () => {
    const why = "This invite link is no longer active. Ask an owner for a new one.";
    await expect(loadInvite(respond(404, { error: why }), "tok")).resolves.toEqual({ kind: "invalid", message: why });
    const notJson = vi.fn(async () => new Response("Not found", { status: 404 })) as unknown as typeof fetch;
    await expect(loadInvite(notJson, "tok")).resolves.toEqual({ kind: "invalid" });
  });

  it("tells a network or server failure apart from an invalid link", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(loadInvite(offline, "tok")).resolves.toEqual({ kind: "unreachable" });
    await expect(loadInvite(respond(500), "tok")).resolves.toEqual({ kind: "unreachable" });
    await expect(loadInvite(respond(429), "tok")).resolves.toEqual({ kind: "unreachable" });
  });

  // R11 review: signed out in another tab before the preview loaded; the same state as Join's 401.
  it("a 401 is signed out, not a network failure", async () => {
    await expect(loadInvite(respond(401, { error: "Unauthorized" }), "tok")).resolves.toEqual({ kind: "signedOut" });
  });
});

// R10-pages L3: Join's 404 shows the same state, with the server's sentence.
describe("acceptInvite", () => {
  it("joined", async () => {
    await expect(acceptInvite(respond(200, { ok: true }), "tok")).resolves.toEqual({ kind: "joined" });
  });

  it("a 404: the dead-link state with its sentence, or without one", async () => {
    const why = "This invite link is no longer active. Ask an owner for a new one.";
    await expect(acceptInvite(respond(404, { error: why }), "tok")).resolves.toEqual({ kind: "invalid", message: why });
    await expect(acceptInvite(respond(404), "tok")).resolves.toEqual({ kind: "invalid" });
  });

  it("another refusal: its sentence, else the try-again one; no network: the offline one", async () => {
    await expect(acceptInvite(respond(429, { error: "Too many requests. Please slow down." }), "tok")).resolves.toEqual({
      kind: "failed",
      message: "Too many requests. Please slow down.",
    });
    await expect(acceptInvite(respond(500), "tok")).resolves.toEqual({ kind: "failed", message: JOIN_FAILED_MESSAGE });
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(acceptInvite(offline, "tok")).resolves.toEqual({ kind: "failed", message: JOIN_OFFLINE_MESSAGE });
  });

  // R11-client-journey L3: a server's own failure text ("Failed to join
  // workspace") has no next step, so any 5xx says the try-again sentence.
  it("any 5xx: the try-again sentence, whatever the body says", async () => {
    for (const status of [500, 502, 503]) {
      await expect(acceptInvite(respond(status, { error: "Failed to join workspace" }), "tok")).resolves.toEqual({
        kind: "failed",
        message: JOIN_FAILED_MESSAGE,
      });
    }
  });

  // R11-client-journey L3: signed out in another tab between opening the link and Join.
  it("a 401: signed out, not the server's bare word", async () => {
    await expect(acceptInvite(respond(401, { error: "Unauthorized" }), "tok")).resolves.toEqual({ kind: "signedOut" });
    expect(JOIN_SIGNED_OUT_MESSAGE).toBe("You were signed out. Sign in again, then open this invite link again.");
  });

  it("the dead-link page says the server's sentence, else the generic one", () => {
    expect(invalidInviteDescription("This invite link is no longer active. Ask an owner for a new one.")).toBe(
      "This invite link is no longer active. Ask an owner for a new one.",
    );
    expect(invalidInviteDescription(undefined)).toBe(INVALID_INVITE_DESCRIPTION);
    // The generic 404 body says what the title already says, so the next step stays.
    expect(invalidInviteDescription("This invite link is invalid or has expired.")).toBe(INVALID_INVITE_DESCRIPTION);
    expect(INVALID_INVITE_DESCRIPTION).toBe("Ask the workspace owner for a new link.");
  });
});

describe("join failure sentences", () => {
  it("say what happened and what to do", () => {
    expect(JOIN_FAILED_MESSAGE).toBe("You weren't added to the workspace. Please press Join workspace again in a minute.");
    expect(JOIN_OFFLINE_MESSAGE).toBe(
      "We couldn't reach Vibe Socials, so you weren't added. Check your internet connection and press Join workspace again.",
    );
  });
});

// R6-pages L4: the page doesn't promise publishing when an owner must approve posts first.
describe("what joining lets a member do", () => {
  it("says posts need an owner's approval when the workspace asks for it", () => {
    expect(joinPromise(true)).toBe(
      "You'll be able to create posts for this workspace's connected accounts. An owner approves each post before it goes out.",
    );
  });

  it("says posts publish when it doesn't", () => {
    expect(joinPromise(false)).toBe("You'll be able to publish to this workspace's connected accounts.");
  });

  it("the page reads whether the invite's workspace asks for approval", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-1" });
    inviteFindUniqueMock.mockResolvedValue({ workspace: { requireApproval: true, members: [] } });
    const element = (await JoinPage({ params: Promise.resolve({ token: "tok" }) })) as {
      type: unknown;
      props: { token: string; requiresApproval: boolean };
    };
    expect(inviteFindUniqueMock).toHaveBeenCalledWith({
      where: { tokenHash: hashInviteToken("tok") },
      select: {
        workspace: {
          select: { requireApproval: true, members: { where: { userId: "user-1" }, select: { role: true } } },
        },
      },
    });
    expect(element.type).toBe(JoinView);
    expect(element.props).toEqual({ token: "tok", requiresApproval: true });
  });

  // R6 review: approval holds a member's posts, never an owner's.
  it("doesn't speak of approval to someone who is already an owner there", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-1" });
    inviteFindUniqueMock.mockResolvedValue({ workspace: { requireApproval: true, members: [{ role: "owner" }] } });
    const element = (await JoinPage({ params: Promise.resolve({ token: "tok" }) })) as {
      props: { requiresApproval: boolean };
    };
    expect(element.props.requiresApproval).toBe(false);
  });

  it("does to someone who is already a member there", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-1" });
    inviteFindUniqueMock.mockResolvedValue({ workspace: { requireApproval: true, members: [{ role: "member" }] } });
    const element = (await JoinPage({ params: Promise.resolve({ token: "tok" }) })) as {
      props: { requiresApproval: boolean };
    };
    expect(element.props.requiresApproval).toBe(true);
  });

  it("promises publishing when the invite can't be read (the view then says the link is dead)", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "user-1" });
    for (const outcome of [() => inviteFindUniqueMock.mockResolvedValue(null), () => inviteFindUniqueMock.mockRejectedValue(new Error("db"))]) {
      outcome();
      const element = (await JoinPage({ params: Promise.resolve({ token: "tok" }) })) as {
        props: { requiresApproval: boolean };
      };
      expect(element.props.requiresApproval).toBe(false);
    }
  });
});

// R11-pages L5: each state the page can end on has the page's h1; R11-client-journey L3: the
// signed-out state links to sign-in and back to this invite.
describe("join states", () => {
  const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

  it("the dead link has its title as the page's h1", () => {
    const page = html(createElement(JoinDeadLink, { message: undefined }));
    expect(page).toMatch(/<h1[^>]*>This invite link isn&#x27;t valid anymore\.<\/h1>/);
    expect(page).toContain(INVALID_INVITE_DESCRIPTION);
    expect(page).not.toContain("<h3");
  });

  it("the unreachable invite has its title as the page's h1", () => {
    const page = html(createElement(JoinUnreachable, { onRetry: () => {} }));
    expect(page).toMatch(/<h1[^>]*>We couldn&#x27;t load this invite\.<\/h1>/);
    expect(page).toContain("Try again");
  });

  it("signed out: says so, with an h1 and a sign-in link back to this invite", () => {
    const page = html(createElement(JoinSignedOut, { token: "tok" }));
    expect(page).toMatch(/<h1[^>]*>You weren&#x27;t added to the workspace\.<\/h1>/);
    expect(page).toContain("You were signed out. Sign in again, then open this invite link again.");
    expect(page).toContain(`href="/login?callbackUrl=${encodeURIComponent("/join/tok")}"`);
    expect(page).toContain(">Sign in<");
  });
});
