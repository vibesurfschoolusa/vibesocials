import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R59 new-customer L1: a failed invite read left the card saying no link
 * exists, and Create then turned off a live link with only "Invite link
 * created.". A failed read now says the link couldn't be read, with Try
 * again, and Create uses the replace wording and toast.
 */

const { toastError, toastSuccess } = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }), signOut: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: toastSuccess, error: toastError }) }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import { makeFocusable, type FocusDoc } from "@/lib/focusDom.testkit";
import { installKeeperOnFakePage } from "@/lib/focusKeeperDom.testkit";

import { ROLE_CHANGED_MESSAGE } from "@/components/load-error";
import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";
import { pageWorkspaceRefusalText, WORKSPACE_CHANGED_CODE } from "@/lib/workspaceChanged";

import { INVITE_UNREAD_TEXT, TeamSection } from "./team-section";

const REPLACED = "New invite link created. The old link no longer works, so send this one instead.";
const FIRST = "Invite link created.";
const KNOWN = { invite: { createdAt: "2026-11-16T10:00:00.000Z", expiresAt: "2026-11-30T10:00:00.000Z" } };

let root: Root;
let container: FakeNode;
let inviteReads: Array<() => Promise<Response>>;
let stopKeeper: () => void;

function all(node: FakeNode, test: (n: FakeNode) => boolean, hits: FakeNode[] = []): FakeNode[] {
  if (test(node)) hits.push(node);
  for (const child of node.childNodes) all(child, test, hits);
  return hits;
}

function button(text: string): FakeNode | undefined {
  return all(container, (n) => n.nodeName === "BUTTON" && String(n.textContent).trim() === text)[0];
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown>;
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function press(node: FakeNode | undefined) {
  expect(node).toBeDefined();
  await act(async () => {
    void props(node!).onClick({ currentTarget: node });
  });
  await settle();
}

const text = () => String(container.textContent);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  makeFocusable(made.doc as unknown as FocusDoc);
  // As on the live page, with its focus keeper.
  stopKeeper = installKeeperOnFakePage(made as never).stop;
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("window", made.doc.defaultView);
  const frames = {
    requestAnimationFrame: (step: () => void) => setTimeout(step, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setTimeout,
    clearTimeout,
  };
  Object.assign(made.doc.defaultView as object, frames);
  vi.stubGlobal("requestAnimationFrame", frames.requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", frames.cancelAnimationFrame);
  toastError.mockReset();
  toastSuccess.mockReset();
  inviteReads = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url.startsWith("/api/workspaces/invites")) {
        if (init?.method === "POST") {
          return Response.json({ url: "https://vibesocials.example/join/abc", expiresAt: "2026-12-05T10:00:00.000Z" });
        }
        const next = inviteReads.shift();
        if (!next) throw new Error("unexpected invite read");
        return next();
      }
      return Response.json({});
    }),
  );
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  stopKeeper();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(createElement(TeamSection, { workspaceId: "ws-1", role: "owner", workspaceName: "Surf Co" }));
  });
  await settle();
}

const FAILED_READS: Array<[string, () => Promise<Response>]> = [
  ["a 5xx", async () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } })],
  ["an unreadable body", async () => new Response("not json", { status: 200 })],
  ["no network", async () => Promise.reject(new TypeError("Failed to fetch"))],
];

describe("Team: an invite link that couldn't be read", () => {
  for (const [what, read] of FAILED_READS) {
    it(`${what}: says the link couldn't be read, with Try again, and Create replaces`, async () => {
      inviteReads.push(read);
      await mount();
      expect(text()).toContain(INVITE_UNREAD_TEXT);
      expect(button("Try again")).toBeDefined();
      expect(button("Create invite link")).toBeUndefined();
      await press(button("Create new invite link"));
      expect(toastSuccess).toHaveBeenCalledWith(REPLACED);
    }, 5_000);
  }

  it("Try again that reads the link: the normal card", async () => {
    inviteReads.push(FAILED_READS[0][1], async () => Response.json(KNOWN));
    await mount();
    await press(button("Try again"));
    expect(text()).not.toContain(INVITE_UNREAD_TEXT);
    expect(text()).toContain("for security it can't be shown again");
    expect(button("Revoke")).toBeDefined();
  }, 5_000);

  it("Try again that finds no link: Create invite link, as a first link", async () => {
    inviteReads.push(FAILED_READS[0][1], async () => Response.json({ invite: null }));
    await mount();
    await press(button("Try again"));
    expect(text()).not.toContain(INVITE_UNREAD_TEXT);
    await press(button("Create invite link"));
    expect(toastSuccess).toHaveBeenCalledWith(FIRST);
  }, 5_000);
});

describe("Team: an invite link that was read", () => {
  it("no link: Create invite link, and the first-link toast, as before", async () => {
    inviteReads.push(async () => Response.json({ invite: null }));
    await mount();
    expect(text()).not.toContain(INVITE_UNREAD_TEXT);
    await press(button("Create invite link"));
    expect(toastSuccess).toHaveBeenCalledWith(FIRST);
  }, 5_000);

  it("a known link: Create new invite link, and the replace toast, as before", async () => {
    inviteReads.push(async () => Response.json(KNOWN));
    await mount();
    expect(text()).not.toContain(INVITE_UNREAD_TEXT);
    await press(button("Create new invite link"));
    expect(toastSuccess).toHaveBeenCalledWith(REPLACED);
  }, 5_000);
});

// R59 fix review L2: a refusal that asking again can't change (another tab's
// workspace, signed out, the role changed) says the members list's sentence,
// with Reload page where that sentence offers it, and no Try again. The link
// is still unknown, so Create still says the old one is off.
describe("Team: an invite read that was refused", () => {
  const REFUSALS: Array<[string, () => Promise<Response>, string, string | null]> = [
    [
      "a 409 workspace refusal",
      async () => Response.json({ error: "Workspace changed.", code: WORKSPACE_CHANGED_CODE }, { status: 409 }),
      pageWorkspaceRefusalText(WORKSPACE_CHANGED_CODE) as string,
      "Reload page",
    ],
    ["a 401", async () => Response.json({ error: "Unauthorized" }, { status: 401 }), SIGNED_OUT_ERROR, null],
    ["a 403", async () => Response.json({ error: "Forbidden" }, { status: 403 }), ROLE_CHANGED_MESSAGE, "Reload page"],
  ];

  for (const [what, read, sentence, step] of REFUSALS) {
    it(`${what}: its own sentence, no Try again, and Create replaces`, async () => {
      inviteReads.push(read);
      await mount();
      expect(text()).toContain(sentence);
      expect(text()).not.toContain(INVITE_UNREAD_TEXT);
      expect(button("Try again")).toBeUndefined();
      if (step) expect(button(step)).toBeDefined();
      else expect(button("Reload page")).toBeUndefined();
      expect(button("Create invite link")).toBeUndefined();
      await press(button("Create new invite link"));
      expect(toastSuccess).toHaveBeenCalledWith(REPLACED);
    }, 5_000);
  }
});

// R59 second look L1: Try again swapped the Alert's parent for the Skeleton, so
// the focus watch (focusThroughRetry) waited on a removed element and focus
// fell to the top of the page. One holder now keeps either, and focus goes to
// what took the Alert's place.
describe("Team: focus after Try again on the unread invite card", () => {
  const active = () => (globalThis.document as unknown as { activeElement: FakeNode | null }).activeElement;

  async function tryAgain() {
    const retry = button("Try again");
    expect(retry).toBeDefined();
    (retry!.focus as () => void)();
    await act(async () => {
      void props(retry!).onClick({ currentTarget: retry });
    });
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await settle();
  }

  it("Try again that reads the link: focus lands on the link card", async () => {
    inviteReads.push(FAILED_READS[0][1], async () => Response.json(KNOWN));
    await mount();
    await tryAgain();
    expect(String(active()?.textContent)).toContain("for security it can't be shown again");
  }, 5_000);

  it("Try again that fails again: focus lands on Try again", async () => {
    inviteReads.push(FAILED_READS[0][1], FAILED_READS[0][1]);
    await mount();
    await tryAgain();
    expect(active()).toBe(button("Try again"));
  }, 5_000);
});
