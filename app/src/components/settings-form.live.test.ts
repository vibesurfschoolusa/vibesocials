import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R43 new-customer L1: Default hashtags and Company website no longer stop a
 * paste at the route's limit. A counter shows the length, and Save shows the
 * route's own sentence for text that is too long.
 */

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: toastSuccess, error: toastError }) }));
// The fake DOM has no <select> options list; the Google button field is not under test here.
vi.mock("@/components/ui/select", () => ({ Select: () => null }));

import { makeDocument, type FakeNode } from "@/components/shell/fakeDom.testkit";
import type { UserSettings } from "@/lib/userSettings";

import { SettingsForm } from "./settings-form";

const SETTINGS: UserSettings = {
  companyWebsite: null,
  defaultHashtags: null,
  notifyOnPostComplete: true,
  notifyDailyDigest: true,
  notifyNewReviews: true,
  notifyMonthlyReport: true,
  requireApproval: false,
  googleButtonType: null,
  googleButtonUrl: null,
  brandVoice: null,
  brandVoiceExamples: null,
  trackWebsiteLinks: false,
};

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

function byId(id: string): FakeNode {
  const hit = find(container, (n) => n.attributes.id === id);
  if (!hit) throw new Error(`no #${id}`);
  return hit;
}

function props(node: FakeNode): Record<string, (arg?: unknown) => unknown> & { value?: unknown } {
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

async function type(id: string, value: string) {
  await act(async () => {
    props(byId(id)).onChange({ target: { value } });
  });
}

async function save() {
  const form = find(container, (n) => n.nodeName === "FORM")!;
  await act(async () => {
    void props(form).onSubmit({ preventDefault() {} });
  });
  await settle();
}

function sentBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

// 1,100 characters of whole tags: "#tag0001 #tag0002 …".
const LONG_HASHTAGS = Array.from({ length: 123 }, (_, i) => `#tag${String(i).padStart(4, "0")}`)
  .join(" ")
  .slice(0, 1100);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const made = makeDocument();
  container = made.container;
  vi.stubGlobal("window", made.doc.defaultView);
  vi.stubGlobal("document", made.doc);
  vi.stubGlobal("navigator", { onLine: true });
  fetchMock.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    root.render(createElement(SettingsForm, { workspaceId: "ws-1", settings: SETTINGS, role: "owner" }));
  });
}

describe("Settings footer fields never cut a paste short", () => {
  it("a 1,100-character hashtag paste stays whole, the counter says so, and Save shows the route's sentence", async () => {
    expect(LONG_HASHTAGS).toHaveLength(1100);
    fetchMock.mockResolvedValue(
      Response.json({ error: "Default hashtags can be up to 1,024 characters." }, { status: 400 }),
    );
    await mount();
    await type("defaultHashtags", LONG_HASHTAGS);

    const box = byId("defaultHashtags");
    expect(props(box).value).toBe(LONG_HASHTAGS);
    expect(box.attributes.maxlength ?? box.attributes.maxLength).toBeUndefined();
    expect(box.attributes["aria-describedby"]).toBe("defaultHashtagsCount");
    const counter = byId("defaultHashtagsCount").textContent as string;
    expect(counter).toContain("1,100 of 1,024 characters");
    expect(counter).toContain("76 over");

    await save();
    expect(sentBody().defaultHashtags).toBe(LONG_HASHTAGS);
    expect(toastError).toHaveBeenCalledWith("Default hashtags can be up to 1,024 characters.");
  });

  it("Company website has no cut-off and a counter against 2,048", async () => {
    await mount();
    const long = `https://example.com/${"a".repeat(2100)}`;
    await type("companyWebsite", long);
    const field = byId("companyWebsite");
    expect(props(field).value).toBe(long);
    expect(field.attributes.maxlength ?? field.attributes.maxLength).toBeUndefined();
    expect(field.attributes["aria-describedby"]).toBe("companyWebsiteCount");
    expect(byId("companyWebsiteCount").textContent).toContain(`${long.length.toLocaleString("en-US")} of 2,048 characters`);
  });

  it("under the limit: the counter only counts, and Save goes through as before", async () => {
    fetchMock.mockResolvedValue(Response.json({}));
    await mount();
    await type("defaultHashtags", "#surf #miami");
    expect(byId("defaultHashtagsCount").textContent).toBe("12 of 1,024 characters");
    await save();
    expect(sentBody().defaultHashtags).toBe("#surf #miami");
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Settings saved successfully!");
  });
});
