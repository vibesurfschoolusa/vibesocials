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
import { JOIN_FAILED_MESSAGE, JOIN_OFFLINE_MESSAGE, JoinView, joinPromise, loadInvite } from "./join-view";

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

  it("tells a network or server failure apart from an invalid link", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(loadInvite(offline, "tok")).resolves.toEqual({ kind: "unreachable" });
    await expect(loadInvite(respond(500), "tok")).resolves.toEqual({ kind: "unreachable" });
    await expect(loadInvite(respond(429), "tok")).resolves.toEqual({ kind: "unreachable" });
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
    inviteFindUniqueMock.mockResolvedValue({ workspace: { requireApproval: true } });
    const element = (await JoinPage({ params: Promise.resolve({ token: "tok" }) })) as {
      type: unknown;
      props: { token: string; requiresApproval: boolean };
    };
    expect(inviteFindUniqueMock).toHaveBeenCalledWith({
      where: { tokenHash: hashInviteToken("tok") },
      select: { workspace: { select: { requireApproval: true } } },
    });
    expect(element.type).toBe(JoinView);
    expect(element.props).toEqual({ token: "tok", requiresApproval: true });
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
