import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R55 new-customer-2 L1: "Send the link again" runs issueAccountToken, which
 * deletes the unused verify link before it, so the sign-up email's link stops
 * working. The success says only the newest email's link works, in the verify
 * banner's words. The route answers 200 only once the email service took the
 * email (502 when it didn't), so "sent" stays true. Failure and 429 unchanged.
 */

const { successMock, errorMock } = vi.hoisted(() => ({ successMock: vi.fn(), errorMock: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: successMock, error: errorMock }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("next/link", async () => {
  const { createElement: make } = await import("react");
  return {
    default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) =>
      make("a", { href: String(href), className }, children as never),
  };
});

import { VERIFY_RESEND_MAYBE_SENT_MESSAGE } from "@/app/verify-email/verifyOutcome";

import { makeDocument, type FakeNode } from "./fakeDom.testkit";
import { WorkspacePausedBanner } from "./workspace-paused-banner";

let root: Root;
let container: FakeNode;
const resendAnswers: (() => Promise<Response>)[] = [];

const fetchMock = vi.fn((input: unknown) => {
  const url = String(input);
  if (url.startsWith("/api/auth/resend-verification")) return (resendAnswers.shift() as () => Promise<Response>)();
  if (url.startsWith("/api/workspaces/status")) {
    return Promise.resolve(
      Response.json({ blockedMessage: "Confirm your email address to start posting.", emailUnconfirmed: true }),
    );
  }
  if (url.startsWith("/api/workspaces")) {
    return Promise.resolve(Response.json({ workspaces: [{ id: "ws-1", isActive: true }] }));
  }
  return Promise.resolve(Response.json({}));
});

function find(node: FakeNode, test: (n: FakeNode) => boolean): FakeNode | null {
  if (test(node)) return node;
  for (const child of node.childNodes) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return node[key as string] as Record<string, (arg?: unknown) => unknown>;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function pressSendAgain() {
  const node = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).includes("Send the link again"));
  expect(node).not.toBeNull();
  await act(async () => {
    void props(node as FakeNode).onClick({ currentTarget: node, preventDefault() {} });
  });
  await settle();
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  fetchMock.mockClear();
  successMock.mockReset();
  errorMock.mockReset();
  resendAnswers.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(WorkspacePausedBanner));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Paused banner: Send the link again", () => {
  it("a sent email says only the newest email's link works", async () => {
    resendAnswers.push(() => Promise.resolve(Response.json({ ok: true })));
    await pressSendAgain();
    expect(successMock).toHaveBeenCalledWith(
      "We sent a new link. If you have more than one, open the newest: only its link works.",
    );
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("a failed send and a 429 show the route's own sentence, as before", async () => {
    resendAnswers.push(
      () => Promise.resolve(Response.json({ error: "We couldn't send it." }, { status: 502 })),
      () =>
        Promise.resolve(
          Response.json({ error: "Too many tries. Wait a minute, then try again.", retryAfterSeconds: 60 }, { status: 429 }),
        ),
    );
    await pressSendAgain();
    await pressSendAgain();
    expect(errorMock.mock.calls).toEqual([["We couldn't send it."], ["Too many tries. Wait a minute, then try again."]]);
    expect(successMock).not.toHaveBeenCalled();
  });

  it("no answer says the link may have been sent, as before", async () => {
    resendAnswers.push(() => Promise.reject(new TypeError("Failed to fetch")));
    await pressSendAgain();
    expect(errorMock).toHaveBeenCalledWith(VERIFY_RESEND_MAYBE_SENT_MESSAGE);
    expect(successMock).not.toHaveBeenCalled();
  });
});
