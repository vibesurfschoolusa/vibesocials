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

import {
  LINKEDIN_LOOKUP_FAILED,
  LINKEDIN_PAGE_NOT_FOUND,
  LinkedInSetupDialog,
  latestTry,
} from "./linkedin-setup-dialog";

const NOT_FOUND_TEXT =
  "LinkedIn didn't find that page. Check the page's URL (it looks like linkedin.com/company/your-page) and try again. If it still isn't found, write to us at hello@vibesocials.wtf.";

const LOOKUP_FAILED_TEXT =
  "We couldn't look up that page on LinkedIn just now. Try again in a few minutes. If it keeps happening, write to us at hello@vibesocials.wtf.";

const KEY = "linkedin-setup-address";

function fakeStorage(stored?: string) {
  const map = new Map<string, string>(stored === undefined ? [] : [[KEY, stored]]);
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const blocked = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("SecurityError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

function rendered(query: string, stored?: string | typeof blocked): string {
  navigation.query = query;
  vi.stubGlobal("window", {
    sessionStorage: typeof stored === "object" ? blocked : fakeStorage(stored),
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

  // R53 fix review L2: Back to an old not_found after a later try connected
  // showed the old reason and address while the row said Connected.
  it("not found with nothing kept (a later try ended the stored copy): no reason, an empty field", () => {
    const html = decoded(rendered("linkedin_setup=not_found"));
    expect(html).not.toContain("didn't find that page");
    expect(html).toMatch(/id="vanity-name"[^>]*value=""/);
  });

  it("blocked storage: no crash, the address's reason, and an empty field", () => {
    const html = decoded(rendered("linkedin_setup=not_found", blocked));
    expect(html).toContain(NOT_FOUND_TEXT);
    expect(html).toMatch(/id="vanity-name"[^>]*value=""/);
  });

  it("closed (no linkedin_setup) and reopened on a first try: no stale reason", () => {
    expect(rendered("")).toBe("");
    expect(decoded(rendered("linkedin_setup=true"))).not.toContain("didn't find that page");
  });
});

// R54 platform-clients L1: a lookup LinkedIn refused or didn't answer is not a
// wrong address; the dialog says LinkedIn failed, and keeps what was typed.
describe("LinkedInSetupDialog: when LinkedIn didn't answer the lookup", () => {
  it("the sentence says what happened, when to try again, and where to write", () => {
    expect(LINKEDIN_LOOKUP_FAILED).toBe(LOOKUP_FAILED_TEXT);
  });

  it("lookup_failed: its own reason, as an alert, with the address kept and no not-found claim", () => {
    const html = decoded(rendered("linkedin_setup=lookup_failed", "linkedin.com/company/acme-surf"));
    expect(html).toContain(LOOKUP_FAILED_TEXT);
    expect(html).toMatch(/role="alert"[^]*couldn't look up that page/);
    expect(html).not.toContain("didn't find that page");
    expect(html).toMatch(/id="vanity-name"[^>]*value="linkedin.com\/company\/acme-surf"/);
  });

  it("not_found is unchanged: its own reason, not the lookup one", () => {
    const html = decoded(rendered("linkedin_setup=not_found", "acme-surff"));
    expect(html).toContain(NOT_FOUND_TEXT);
    expect(html).not.toContain("couldn't look up that page");
  });

  it("lookup_failed with nothing kept (a later try ended the stored copy): no reason, an empty field", () => {
    const html = decoded(rendered("linkedin_setup=lookup_failed"));
    expect(html).not.toContain("couldn't look up that page");
    expect(html).toMatch(/id="vanity-name"[^>]*value=""/);
  });

  it("blocked storage: the address's reason, and an empty field", () => {
    const html = decoded(rendered("linkedin_setup=lookup_failed", blocked));
    expect(html).toContain(LOOKUP_FAILED_TEXT);
    expect(html).toMatch(/id="vanity-name"[^>]*value=""/);
  });

  it("a first try is blank, and so is a reload of a first try after a failed one", () => {
    expect(decoded(rendered("linkedin_setup=true", "acme-surf"))).not.toContain("couldn't look up that page");
    const storage = fakeStorage("acme-surf");
    expect(latestTry("lookup_failed", () => storage)).toEqual({ reason: true, address: "acme-surf" });
    expect(latestTry("true", () => storage)).toEqual({ reason: false, address: "" });
    expect(latestTry("true", () => storage)).toEqual({ reason: false, address: "" });
    expect(latestTry("lookup_failed", () => storage)).toEqual({ reason: false, address: "" });
  });
});

// R53 fix review L2: the reason and the kept address belong to the latest try.
// Every page load the dialog sits on that isn't a not_found return (a success,
// a choice, an error, a first try) ends the stored copy.
describe("latestTry", () => {
  it("not_found then reload: the reason and the address", () => {
    const storage = fakeStorage("acme-surff");
    expect(latestTry("not_found", () => storage)).toEqual({ reason: true, address: "acme-surff" });
    expect(latestTry("not_found", () => storage)).toEqual({ reason: true, address: "acme-surff" });
  });

  it("not_found, a corrected Continue, Back from LinkedIn: that try's address", () => {
    const storage = fakeStorage("acme-surff");
    storage.setItem(KEY, "acme-surf");
    expect(latestTry("not_found", () => storage)).toEqual({ reason: true, address: "acme-surf" });
  });

  it("not_found, then a success, then Back: no reason and no address", () => {
    const storage = fakeStorage("acme-surf");
    expect(latestTry(null, () => storage)).toEqual({ reason: false, address: "" });
    expect(storage.map.has(KEY)).toBe(false);
    expect(latestTry("not_found", () => storage)).toEqual({ reason: false, address: "" });
  });

  it("a first try ends an older copy too", () => {
    const storage = fakeStorage("acme-surff");
    expect(latestTry("true", () => storage)).toEqual({ reason: false, address: "" });
    expect(storage.map.has(KEY)).toBe(false);
  });

  it("blocked storage, or none at all: no crash; not_found keeps the address's reason, with an empty field", () => {
    for (const read of [() => blocked, () => { throw new ReferenceError("window is not defined"); }]) {
      expect(latestTry("not_found", read)).toEqual({ reason: true, address: "" });
      expect(latestTry(null, read)).toEqual({ reason: false, address: "" });
    }
  });
});
