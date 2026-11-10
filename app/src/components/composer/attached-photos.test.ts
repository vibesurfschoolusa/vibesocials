import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AttachedPhotos,
  patchPhoto,
  photoSetProgress,
  photoSetReady,
  uploadPhotosInOrder,
  type AttachedPhoto,
} from "./attached-photos";

function photo(key: string, patch: Partial<AttachedPhoto> = {}): AttachedPhoto {
  return {
    key,
    file: new File(["x"], `${key}.jpg`, { type: "image/jpeg" }),
    status: "uploaded",
    progress: 0,
    blob: {
      url: `https://b.public.blob.vercel-storage.com/${key}.jpg`,
      filename: `${key}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 1,
    },
    error: null,
    ...patch,
  };
}

const blobFor = (file: File) => ({
  url: `u/${file.name}`,
  filename: file.name,
  mimeType: file.type,
  sizeBytes: file.size,
});

const picks = (keys: string[]) =>
  keys.map((key) => ({ key, file: new File(["x"], `${key}.jpg`, { type: "image/jpeg" }) }));

describe("patchPhoto", () => {
  it("changes only the photo with that key, and nothing for a removed one", () => {
    const list = [photo("a"), photo("b")];
    const next = patchPhoto(list, "b", { status: "failed", error: "No." });
    expect(next[1]).toMatchObject({ key: "b", status: "failed", error: "No." });
    expect(next[0]).toBe(list[0]);
    expect(patchPhoto(list, "gone", { status: "failed" })).toBe(list);
  });
});

describe("photoSetReady", () => {
  it("is ready only when every attached photo has uploaded", () => {
    expect(photoSetReady([])).toBe(false);
    expect(photoSetReady([photo("a"), photo("b")])).toBe(true);
    expect(photoSetReady([photo("a"), photo("b", { status: "uploading", blob: null })])).toBe(false);
    expect(photoSetReady([photo("a"), photo("b", { status: "failed", blob: null })])).toBe(false);
    expect(photoSetReady([photo("a", { status: "waiting", blob: null })])).toBe(false);
  });
});

describe("photoSetProgress", () => {
  it("is null when nothing is waiting or uploading", () => {
    expect(photoSetProgress([photo("a"), photo("b", { status: "failed", blob: null })])).toBeNull();
  });

  it("counts the set: done photos plus the one in flight", () => {
    expect(
      photoSetProgress([
        photo("a"),
        photo("b", { status: "uploading", progress: 50, blob: null }),
        photo("c", { status: "waiting", blob: null }),
        photo("d", { status: "waiting", blob: null }),
      ]),
    ).toEqual({ done: 1, total: 4, percent: 38 });
  });
});

describe("uploadPhotosInOrder", () => {
  it("uploads one after another, keeps the ones that succeeded and marks the one that failed", async () => {
    const events: string[] = [];
    let inFlight = 0;
    await uploadPhotosInOrder(picks(["a", "b", "c"]), {
      upload: async (file, onProgress) => {
        inFlight += 1;
        expect(inFlight).toBe(1);
        onProgress(50);
        await Promise.resolve();
        inFlight -= 1;
        if (file.name === "b.jpg") throw new Error("Your workspace storage is full.");
        return blobFor(file);
      },
      isStale: () => false,
      onUpdate: (key, patch) => events.push(`${key}:${patch.status ?? `p${patch.progress}`}`),
    });
    expect(events).toEqual([
      "a:uploading",
      "a:p50",
      "a:uploaded",
      "b:uploading",
      "b:p50",
      "b:failed",
      "c:uploading",
      "c:p50",
      "c:uploaded",
    ]);
  });

  it("passes the upload's own sentence as the error, and the blob on success", async () => {
    const [entry] = picks(["a"]);
    const failed: Partial<AttachedPhoto>[] = [];
    await uploadPhotosInOrder([entry], {
      upload: async () => {
        throw new Error("Your workspace storage is full.");
      },
      isStale: () => false,
      onUpdate: (_key, patch) => failed.push(patch),
    });
    expect(failed.at(-1)).toEqual({ status: "failed", error: "Your workspace storage is full.", blob: null });

    const done: Partial<AttachedPhoto>[] = [];
    const uploaded: string[] = [];
    await uploadPhotosInOrder([entry], {
      upload: async (file) => blobFor(file),
      isStale: () => false,
      onUpdate: (_key, patch) => done.push(patch),
      onUploaded: (key) => uploaded.push(key),
    });
    expect(done.at(-1)).toEqual({ status: "uploaded", blob: blobFor(entry.file), error: null });
    expect(uploaded).toEqual(["a"]);
  });

  it("stops at once when a newer pick replaced the set", async () => {
    let stale = false;
    const uploaded: string[] = [];
    const updates: string[] = [];
    await uploadPhotosInOrder(picks(["a", "b"]), {
      upload: async (file) => {
        uploaded.push(file.name);
        stale = true;
        return blobFor(file);
      },
      isStale: () => stale,
      onUpdate: (key, patch) => updates.push(`${key}:${patch.status}`),
    });
    expect(uploaded).toEqual(["a.jpg"]);
    expect(updates).toEqual(["a:uploading"]);
  });
});

describe("AttachedPhotos", () => {
  const noop = () => {};
  const render = (photos: AttachedPhoto[]) =>
    renderToStaticMarkup(createElement(AttachedPhotos, { photos, onRemove: noop, onMove: noop, onRetry: noop }));

  it("marks the first photo Cover and gives each photo remove and move buttons", () => {
    const html = render([photo("a"), photo("b"), photo("c")]);
    expect(html.match(/>Cover</g)).toHaveLength(1);
    expect(html.match(/aria-label="Remove photo \d"/g)).toHaveLength(3);
    expect(html.match(/aria-label="Move photo \d earlier"/g)).toHaveLength(3);
    expect(html.match(/aria-label="Move photo \d later"/g)).toHaveLength(3);
  });

  it("shows which upload failed with a Retry button, and the set's progress", () => {
    const html = render([
      photo("a"),
      photo("b", { status: "failed", blob: null, error: "Your workspace storage is full." }),
      photo("c", { status: "uploading", progress: 20, blob: null }),
    ]);
    expect(html).toContain("Your workspace storage is full.");
    expect(html).toContain(">Retry<");
    expect(html).toContain("Uploading photos");
    expect(html).toContain("1 of 3");
  });
});
