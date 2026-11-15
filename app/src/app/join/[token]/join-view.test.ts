import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn() }));

import { metadata } from "./page";
import { JOIN_FAILED_MESSAGE, JOIN_OFFLINE_MESSAGE, loadInvite } from "./join-view";

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
