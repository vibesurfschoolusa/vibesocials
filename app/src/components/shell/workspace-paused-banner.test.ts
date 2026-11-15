import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "loading" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { readWorkspaceStatus, watchWorkspaceStatus, WorkspaceStatusAlert } from "./workspace-paused-banner";
import { announceWorkspaceChange } from "@/lib/workspaceChangeEvent";

/** 23: the banner's line for an unconfirmed address, with its resend button, and only for it. */

const SENTENCE = "Confirm your email address to start posting. We sent a link to new@example.com.";

function render(data: unknown): string {
  return renderToStaticMarkup(
    createElement(WorkspaceStatusAlert, { status: readWorkspaceStatus(data), sending: false, onResend: () => {} }),
  );
}

describe("readWorkspaceStatus", () => {
  it("reads the three fields, and takes emailUnconfirmed only with a message", () => {
    expect(readWorkspaceStatus({ blockedMessage: SENTENCE, emailUnconfirmed: true })).toEqual({
      message: SENTENCE,
      notice: null,
      emailUnconfirmed: true,
      daysLeft: null,
      planLink: false,
    });
    expect(readWorkspaceStatus({ blockedMessage: null, emailUnconfirmed: true }).emailUnconfirmed).toBe(false);
    expect(readWorkspaceStatus({ blockedMessage: "Paused.", emailUnconfirmed: "yes" }).emailUnconfirmed).toBe(false);
    expect(readWorkspaceStatus(null)).toEqual({ message: null, notice: null, emailUnconfirmed: false, daysLeft: null, planLink: false });
  });
});

describe("WorkspaceStatusAlert", () => {
  it("shows the sentence and a button to send the link again for an unconfirmed address", () => {
    const html = render({ blockedMessage: SENTENCE, emailUnconfirmed: true });
    expect(html).toContain(SENTENCE);
    expect(html).toMatch(/<button[^>]*>.*Send the link again.*<\/button>/);
  });

  // R6-new-customer L4: a mistyped address can only be fixed in Settings.
  it("says where to fix a wrong address, with a link to Settings, Account", () => {
    const html = render({ blockedMessage: SENTENCE, emailUnconfirmed: true });
    expect(html).toMatch(/Wrong address\? <a [^>]*href="\/settings#account"[^>]*>Change it in Settings, Account<\/a>\./);
  });

  it("shows a pause or an ended plan without the button", () => {
    const html = render({ blockedMessage: "This workspace is paused. Contact us." });
    expect(html).toContain("This workspace is paused. Contact us.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Wrong address?");
  });

  it("shows the trial notice without the button, and nothing when there is nothing to say", () => {
    const html = render({ blockedMessage: null, trialNotice: "Your free trial ends on 12 December." });
    expect(html).toContain("Your free trial ends on 12 December.");
    expect(html).not.toContain("<button");
    expect(render({ blockedMessage: null })).toBe("");
  });
});

describe("WorkspaceStatusAlert links to Settings, Plan (S1 item 7)", () => {
  const PLAN_LINK = /<a [^>]*href="\/settings#plan"[^>]*>Choose a plan<\/a>/;

  it("shows owners a quiet line with the days left and the link for the whole trial", () => {
    const html = render({ blockedMessage: null, trialDaysLeft: "Free trial: 10 days left." });
    expect(html).toContain("Free trial: 10 days left.");
    expect(html).toMatch(PLAN_LINK);
    expect(html).not.toContain('role="alert"');
  });

  it("keeps the louder line in the last 3 days, now with the link", () => {
    const html = render({ blockedMessage: null, trialNotice: "Your free trial ends on 12 December. Choose a plan in Settings." });
    expect(html).toContain("Your free trial ends on 12 December. Choose a plan in Settings.");
    expect(html).toMatch(PLAN_LINK);
  });

  it("links the plan-ended banner for owners only", () => {
    expect(render({ blockedMessage: "Your free trial has ended.", planLink: true })).toMatch(PLAN_LINK);
    expect(render({ blockedMessage: "Your free trial has ended." })).not.toContain("<a ");
  });
});

// R16-publishing L2 = security L2 = client-journey L2/L3: an owner who makes
// themselves a member stays on the page; the banner reads its status again on
// the announce, so the owner-only "Free trial: 9 days left. Choose a plan" goes.
describe("watchWorkspaceStatus", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answer = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  it("reads the status again on each announce, until it stops", async () => {
    const fetchImpl = vi.fn(() => answer({ blockedMessage: null }));
    const onStatus = vi.fn();
    const stop = watchWorkspaceStatus(onStatus, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();

    announceWorkspaceChange();
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledWith("/api/workspaces/status", { cache: "no-store" });

    stop();
    announceWorkspaceChange();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("self-demotion: the member's answer replaces the owner's trial line", async () => {
    const owner = readWorkspaceStatus({ blockedMessage: null, trialDaysLeft: "Free trial: 9 days left." });
    expect(render({ blockedMessage: null, trialDaysLeft: "Free trial: 9 days left." })).toContain("Choose a plan");
    let shown = owner;
    watchWorkspaceStatus(
      (status) => {
        shown = status;
      },
      (() => answer({ blockedMessage: null })) as unknown as typeof fetch,
    );
    announceWorkspaceChange();
    await vi.waitFor(() => expect(shown).not.toBe(owner));
    expect(renderToStaticMarkup(createElement(WorkspaceStatusAlert, { status: shown, sending: false, onResend: () => {} }))).toBe("");
  });

  it("an answer that comes after it stopped, or a failed read, changes nothing", async () => {
    let release: (value: Response) => void = () => {};
    const onStatus = vi.fn();
    const stop = watchWorkspaceStatus(onStatus, (() => new Promise<Response>((resolve) => (release = resolve))) as unknown as typeof fetch);
    announceWorkspaceChange();
    stop();
    release(new Response(JSON.stringify({ blockedMessage: "Paused." }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onStatus).not.toHaveBeenCalled();

    watchWorkspaceStatus(onStatus, (() => Promise.resolve(new Response("", { status: 500 }))) as unknown as typeof fetch);
    announceWorkspaceChange();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onStatus).not.toHaveBeenCalled();
  });
});
