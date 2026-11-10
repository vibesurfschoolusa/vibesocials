import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { SHARED_FILE_CACHE, SHARED_FILE_KEY, SHARED_FILE_TIME_HEADER } from "./sharedFile";

// public/sw.js is plain browser JavaScript with no build step, so the test
// runs its source against fake `self`, `caches` and events.
const swSource = readFileSync(
  fileURLToPath(new URL("../../public/sw.js", import.meta.url)),
  "utf8",
);

const ORIGIN = "https://vibesocials.test";

function loadWorker() {
  const listeners: Record<string, (event: unknown) => void> = {};
  const store = new Map<string, Map<string, Response>>();
  const caches = {
    open: vi.fn(async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const entries = store.get(name)!;
      return {
        put: async (key: string, response: Response) => {
          entries.set(key, response);
        },
        delete: async (key: string) => entries.delete(key),
      };
    }),
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners[type] = handler;
    },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  new Function("self", "caches", swSource)(self, caches);
  return { listeners, store, caches, self };
}

function fetchEvent(request: Request) {
  const respondWith = vi.fn();
  return { event: { request, respondWith }, respondWith };
}

function sharePost(form: FormData, path = "/share-target") {
  return new Request(`${ORIGIN}${path}`, { method: "POST", body: form });
}

describe("public/sw.js", () => {
  it("takes control on first install", async () => {
    const { listeners, self } = loadWorker();
    const waits: Promise<unknown>[] = [];
    const lifecycle = { waitUntil: (p: Promise<unknown>) => waits.push(p) };

    listeners.install(lifecycle);
    listeners.activate(lifecycle);
    await Promise.all(waits);

    expect(self.skipWaiting).toHaveBeenCalled();
    expect(self.clients.claim).toHaveBeenCalled();
  });

  it("stores a shared file under the fixed key and redirects to Create with 303", async () => {
    const { listeners, store } = loadWorker();
    const form = new FormData();
    form.append("media", new File(["first"], "wave 1.jpg", { type: "image/jpeg" }));
    form.append("media", new File(["second"], "wave2.jpg", { type: "image/jpeg" }));
    const { event, respondWith } = fetchEvent(sharePost(form));

    listeners.fetch(event);

    expect(respondWith).toHaveBeenCalledTimes(1);
    const response = (await respondWith.mock.calls[0][0]) as Response;
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/posts/new?shared=1`);

    const entries = store.get(SHARED_FILE_CACHE);
    expect([...(entries?.keys() ?? [])]).toEqual([SHARED_FILE_KEY]);
    const stored = entries!.get(SHARED_FILE_KEY)!;
    expect(await stored.text()).toBe("first");
    expect(stored.headers.get("Content-Type")).toBe("image/jpeg");
    expect(decodeURIComponent(stored.headers.get("X-File-Name") ?? "")).toBe("wave 1.jpg");
  });

  it("stamps the stored file with the time it was shared", async () => {
    const { listeners, store } = loadWorker();
    const form = new FormData();
    form.append("media", new File(["x"], "a.jpg", { type: "image/jpeg" }));
    const { event, respondWith } = fetchEvent(sharePost(form));
    const before = Date.now();

    listeners.fetch(event);
    await respondWith.mock.calls[0][0];

    const stored = store.get(SHARED_FILE_CACHE)!.get(SHARED_FILE_KEY)!;
    const sharedAt = Number(stored.headers.get(SHARED_FILE_TIME_HEADER));
    expect(sharedAt).toBeGreaterThanOrEqual(before);
    expect(sharedAt).toBeLessThanOrEqual(Date.now());
  });

  it("never leaves an earlier file behind when a share cannot be read", async () => {
    const { listeners, store } = loadWorker();
    store.set(SHARED_FILE_CACHE, new Map([[SHARED_FILE_KEY, new Response("old")]]));
    const broken = {
      method: "POST",
      url: `${ORIGIN}/share-target`,
      formData: async () => {
        throw new TypeError("Could not parse content as FormData.");
      },
    } as unknown as Request;
    const { event, respondWith } = fetchEvent(broken);

    listeners.fetch(event);

    const response = (await respondWith.mock.calls[0][0]) as Response;
    expect(response.status).toBe(303);
    expect(store.get(SHARED_FILE_CACHE)!.size).toBe(0);
  });

  it("replaces an earlier shared file", async () => {
    const { listeners, store } = loadWorker();
    for (const body of ["old", "new"]) {
      const form = new FormData();
      form.append("media", new File([body], `${body}.mp4`, { type: "video/mp4" }));
      const { event, respondWith } = fetchEvent(sharePost(form));
      listeners.fetch(event);
      await respondWith.mock.calls[0][0];
    }
    const entries = store.get(SHARED_FILE_CACHE)!;
    expect(entries.size).toBe(1);
    expect(await entries.get(SHARED_FILE_KEY)!.text()).toBe("new");
  });

  it("still redirects when the share carries no file", async () => {
    const { listeners } = loadWorker();
    const form = new FormData();
    form.append("title", "just text");
    const { event, respondWith } = fetchEvent(sharePost(form));

    listeners.fetch(event);

    const response = (await respondWith.mock.calls[0][0]) as Response;
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/posts/new?shared=1`);
  });

  it("leaves every other request alone", () => {
    const { listeners, caches } = loadWorker();
    const others = [
      new Request(`${ORIGIN}/share-target`),
      new Request(`${ORIGIN}/posts/new`),
      new Request(`${ORIGIN}/_next/static/chunk.js`),
      sharePost(new FormData(), "/api/upload"),
      sharePost(new FormData(), "/share-target/x"),
    ];
    for (const request of others) {
      const { event, respondWith } = fetchEvent(request);
      listeners.fetch(event);
      expect(respondWith, `${request.method} ${request.url}`).not.toHaveBeenCalled();
    }
    expect(caches.open).not.toHaveBeenCalled();
  });
});
