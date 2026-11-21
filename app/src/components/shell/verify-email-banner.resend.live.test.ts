import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R55 new-customer L1, pages-a L1: each resend cancels the unused link before
 * it, so the banner's success says only the newest email's link works. The
 * route answers 200 only once the email service took the email (502 when it
 * didn't), so "sent" stays true. Its failure, 429 and no-answer toasts are
 * unchanged.
 */

const { successMock, errorMock } = vi.hoisted(() => ({ successMock: vi.fn(), errorMock: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: successMock, error: errorMock }) }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: "authenticated", data: { user: { email: "someone@example.test" } } }),
}));
vi.mock("next/link", async () => {
  const { createElement: make } = await import("react");
  return {
    default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) =>
      make("a", { href: String(href), className }, children as never),
  };
});

import { VERIFY_RESEND_MAYBE_SENT_MESSAGE } from "@/app/verify-email/verifyOutcome";

import { makeDocument, type FakeNode } from "./fakeDom.testkit";
import { VerifyEmailBanner } from "./verify-email-banner";

let root: Root;
let container: FakeNode;
const fetchMock = vi.fn();

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

async function pressResend() {
  const node = find(container, (n) => n.nodeName === "BUTTON" && (n.textContent as string).includes("Resend email"));
  expect(node).not.toBeNull();
  await act(async () => {
    void props(node as FakeNode).onClick({ currentTarget: node, preventDefault() {} });
  });
  await settle();
}

const status = () => Promise.resolve(Response.json({ emailVerified: false, verificationAvailable: true }));

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  fetchMock.mockReset();
  successMock.mockReset();
  errorMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReturnValueOnce(status());
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(VerifyEmailBanner));
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Verify banner: Resend email", () => {
  it("a sent email says only the newest email's link works", async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve(Response.json({ ok: true })));
    await pressResend();
    expect(successMock).toHaveBeenCalledWith(
      "Verification email sent. If you have more than one, open the newest: only its link works.",
    );
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("a failed send and a 429 show the route's own sentence, as before", async () => {
    fetchMock
      .mockReturnValueOnce(Promise.resolve(Response.json({ error: "We couldn't send it." }, { status: 502 })))
      .mockReturnValueOnce(
        Promise.resolve(Response.json({ error: "Too many tries. Wait a minute, then try again.", retryAfterSeconds: 60 }, { status: 429 })),
      );
    await pressResend();
    await pressResend();
    expect(errorMock.mock.calls).toEqual([["We couldn't send it."], ["Too many tries. Wait a minute, then try again."]]);
    expect(successMock).not.toHaveBeenCalled();
  });

  it("no answer says the link may have been sent, as before", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    await pressResend();
    expect(errorMock).toHaveBeenCalledWith(VERIFY_RESEND_MAYBE_SENT_MESSAGE);
    expect(successMock).not.toHaveBeenCalled();
  });
});
