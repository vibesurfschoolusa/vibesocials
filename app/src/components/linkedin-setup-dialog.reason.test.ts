import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// R53 new-customer L1: after a page address LinkedIn couldn't find, the dialog
// came back with the same empty text, so every try looped with nothing saying why.

const navigation = vi.hoisted(() => ({ query: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

// Rendered as after hydration, with the dialog's frame as plain markup: what
// matters here is the text the open dialog shows.
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useSyncExternalStore: () => true };
});
vi.mock("@/components/ui/dialog", () => {
  const part = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? createElement("div", { "data-dialog": "open" }, children) : null,
    DialogBody: part,
    DialogDescription: part,
    DialogFooter: part,
    DialogHeader: part,
    DialogTitle: part,
  };
});

import { LINKEDIN_PAGE_NOT_FOUND, LinkedInSetupDialog } from "./linkedin-setup-dialog";

const NOT_FOUND_TEXT =
  "LinkedIn didn't find that page. Check the page's URL (it looks like linkedin.com/company/your-page) and try again. If it still isn't found, write to us at hello@vibesocials.wtf.";

function rendered(query: string, stored?: string): string {
  navigation.query = query;
  const storage = new Map<string, string>(stored === undefined ? [] : [["linkedin-setup-address", stored]]);
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  try {
    return renderToString(createElement(LinkedInSetupDialog, { workspaceId: "ws-1" }));
  } finally {
    vi.unstubAllGlobals();
  }
}

const decoded = (html: string) => html.replace(/&#x27;/g, "'").replace(/<!-- -->/g, "");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LinkedInSetupDialog: why it came back", () => {
  it("the sentence names what happened and the next step", () => {
    expect(LINKEDIN_PAGE_NOT_FOUND).toBe(NOT_FOUND_TEXT);
  });

  it("a first try: the dialog opens as before, with no reason and an empty field", () => {
    const html = decoded(rendered("linkedin_setup=true", "acme-surff"));
    expect(html).toContain("We need your LinkedIn company page URL to complete the connection.");
    expect(html).not.toContain("didn't find that page");
    expect(html).toMatch(/id="vanity-name"[^>]*value=""/);
  });

  it("a page address that found nothing: the reason shows, as an alert, with the address kept in the field", () => {
    const html = decoded(rendered("linkedin_setup=not_found", "linkedin.com/company/acme-surff"));
    expect(html).toContain(NOT_FOUND_TEXT);
    expect(html).toMatch(/role="alert"[^]*didn't find that page/);
    expect(html).toMatch(/id="vanity-name"[^>]*value="linkedin.com\/company\/acme-surff"/);
  });

  it("not found with no address kept (storage cleared or blocked): the reason still shows", () => {
    expect(decoded(rendered("linkedin_setup=not_found"))).toContain(NOT_FOUND_TEXT);
  });

  it("closed (no linkedin_setup) and reopened on a first try: no stale reason", () => {
    expect(rendered("")).toBe("");
    expect(decoded(rendered("linkedin_setup=true"))).not.toContain("didn't find that page");
  });
});
