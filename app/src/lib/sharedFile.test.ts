import { afterEach, describe, expect, it, vi } from "vitest";

import { SHARED_FILE_CACHE, SHARED_FILE_KEY, takeSharedFile } from "./sharedFile";

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
});

describe("takeSharedFile", () => {
  it("returns the shared file with its name and type, and deletes it from the cache", async () => {
    const { caches, entries, open } = fakeCaches(
      new Response("video bytes", {
        headers: {
          "Content-Type": "video/mp4",
          "X-File-Name": encodeURIComponent("surf day 1.mp4"),
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
