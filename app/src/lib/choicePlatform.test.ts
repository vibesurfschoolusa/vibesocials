import { afterEach, describe, expect, it, vi } from "vitest";

import { choiceAddress, choiceFirstSeen, rememberChoicePlatform, rememberedChoicePlatform } from "./choicePlatform";

afterEach(() => {
  vi.unstubAllGlobals();
});

// R29: the platform a waiting choice was for, kept for the tab, so a gone
// choice can be asked about with it (/c and the Settings dialog).
describe("choicePlatform", () => {
  it("adds the platform to the address once known", () => {
    expect(choiceAddress("/api/x/pending/p", null)).toBe("/api/x/pending/p");
    expect(choiceAddress("/api/x/pending/p", "facebook_page")).toBe("/api/x/pending/p?platform=facebook_page");
  });

  it("remembers per choice id in the tab's storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    rememberChoicePlatform("p1", "instagram");
    expect(rememberedChoicePlatform("p1")).toBe("instagram");
    expect(rememberedChoicePlatform("p2")).toBeNull();
  });

  it("works without storage: nothing remembered, nothing thrown", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(() => rememberChoicePlatform("p1", "instagram")).not.toThrow();
    expect(rememberedChoicePlatform("p1")).toBeNull();
  });
});

// R40 review: the first time this tab saw a choice, so a 429's wait can be
// compared with the life it has left (it was made no later than that).
describe("choiceFirstSeen", () => {
  it("keeps the first time for each choice", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    expect(choiceFirstSeen("p1", 1000)).toBe(1000);
    expect(choiceFirstSeen("p1", 5000)).toBe(1000);
    expect(choiceFirstSeen("p2", 5000)).toBe(5000);
  });

  it("without storage: null, nothing thrown", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(choiceFirstSeen("p1", 1000)).toBeNull();
  });
});
