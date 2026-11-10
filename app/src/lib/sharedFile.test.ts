import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SHARED_FILE_CACHE,
  SHARED_FILE_KEY,
  SHARED_FILE_MAX_AGE_MS,
  SHARED_FILE_TIME_HEADER,
  shouldTakeSharedFile,
  takeSharedFile,
} from "./sharedFile";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

function storedShare(sharedAt: string | null) {
  const headers: Record<string, string> = {
    "Content-Type": "image/jpeg",
    "X-File-Name": "wave.jpg",
  };
  if (sharedAt !== null) headers[SHARED_FILE_TIME_HEADER] = sharedAt;
  return new Response("photo", { headers });
}

function fakeCaches(initial?: Response) {
  const entries = new Map<string, Response>();
  if (initial) entries.set(SHARED_FILE_KEY, initial);
  const open = vi.fn(async () => ({
    match: async (key: string) => entries.get(key),
    delete: async (key: string) => entries.delete(key),
  }));
  return { caches: { open }, entries, open };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shouldTakeSharedFile", () => {
  it("takes the file once Create shows the form", () => {
    expect(shouldTakeSharedFile("1", "form")).toBe(true);
  });

  it("leaves it in the cache while connections load, fail, or none is connected", () => {
    expect(shouldTakeSharedFile("1", "loading")).toBe(false);
    expect(shouldTakeSharedFile("1", "error")).toBe(false);
    expect(shouldTakeSharedFile("1", "connect")).toBe(false);
  });

  it("does nothing without ?shared=1", () => {
    expect(shouldTakeSharedFile(null, "form")).toBe(false);
    expect(shouldTakeSharedFile("0", "form")).toBe(false);
  });
});

describe("takeSharedFile", () => {
  it("returns the shared file with its name and type, and deletes it from the cache", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const { caches, entries, open } = fakeCaches(
      new Response("video bytes", {
        headers: {
          "Content-Type": "video/mp4",
          "X-File-Name": encodeURIComponent("surf day 1.mp4"),
          [SHARED_FILE_TIME_HEADER]: String(NOW - 5 * 60_000),
        },
      }),
    );
    vi.stubGlobal("caches", caches);

    const file = await takeSharedFile();

    expect(open).toHaveBeenCalledWith(SHARED_FILE_CACHE);
    expect(file).toBeInstanceOf(File);
    expect(file!.name).toBe("surf day 1.mp4");
    expect(file!.type).toBe("video/mp4");
    expect(await file!.text()).toBe("video bytes");
    expect(entries.size).toBe(0);
  });

  it("drops a share older than 60 minutes", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    expect(SHARED_FILE_MAX_AGE_MS).toBe(60 * 60_000);
    const { caches, entries } = fakeCaches(storedShare(String(NOW - SHARED_FILE_MAX_AGE_MS - 1)));
    vi.stubGlobal("caches", caches);

    expect(await takeSharedFile()).toBeNull();
    expect(entries.size).toBe(0);
  });

  it("still takes a share just inside the 60 minutes", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const { caches } = fakeCaches(storedShare(String(NOW - SHARED_FILE_MAX_AGE_MS + 1000)));
    vi.stubGlobal("caches", caches);

    expect(await takeSharedFile()).toBeInstanceOf(File);
  });

  it("drops a share with no time, or a time it cannot read", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    for (const sharedAt of [null, "", "yesterday"]) {
      const { caches, entries } = fakeCaches(storedShare(sharedAt));
      vi.stubGlobal("caches", caches);

      expect(await takeSharedFile(), String(sharedAt)).toBeNull();
      expect(entries.size, String(sharedAt)).toBe(0);
    }
  });

  it("returns null when nothing was shared", async () => {
    const { caches } = fakeCaches();
    vi.stubGlobal("caches", caches);
    expect(await takeSharedFile()).toBeNull();
  });

  it("returns null when the browser has no Cache Storage", async () => {
    vi.stubGlobal("caches", undefined);
    expect(await takeSharedFile()).toBeNull();
  });
});
