import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AttachedPhotos,
  patchPhoto,
  photoSetProgress,
  photoSetReady,
  preparePhotos,
  removeAllClearsCaption,
  removeAllTitle,
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
    expect(photoSetReady([photo("a"), photo("b", { status: "preparing", blob: null })])).toBe(false);
  });
});

describe("photoSetProgress", () => {
  it("is null while photos are still being prepared", () => {
    expect(photoSetProgress([photo("a", { status: "preparing", blob: null })])).toBeNull();
  });

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
  // The form's current set, as the queue sees it through isAttached / isCover.
  function fakeSet(keys: string[]) {
    const set = { keys: [...keys] };
    return {
      set,
      isAttached: (key: string) => set.keys.includes(key),
      isCover: (key: string) => set.keys[0] === key,
      remove: (key: string) => {
        set.keys = set.keys.filter((k) => k !== key);
      },
    };
  }

  it("uploads one after another, keeps the ones that succeeded and marks the one that failed", async () => {
    const events: string[] = [];
    let inFlight = 0;
    const current = fakeSet(["a", "b", "c"]);
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
      isAttached: current.isAttached,
      isCover: current.isCover,
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
    const current = fakeSet(["a"]);
    const failed: Partial<AttachedPhoto>[] = [];
    await uploadPhotosInOrder([entry], {
      upload: async () => {
        throw new Error("Your workspace storage is full.");
      },
      isStale: () => false,
      isAttached: current.isAttached,
      isCover: current.isCover,
      onUpdate: (_key, patch) => failed.push(patch),
    });
    expect(failed.at(-1)).toEqual({ status: "failed", error: "Your workspace storage is full.", blob: null });

    const done: Partial<AttachedPhoto>[] = [];
    await uploadPhotosInOrder([entry], {
      upload: async (file) => blobFor(file),
      isStale: () => false,
      isAttached: current.isAttached,
      isCover: current.isCover,
      onUpdate: (_key, patch) => done.push(patch),
    });
    expect(done.at(-1)).toEqual({ status: "uploaded", blob: blobFor(entry.file), error: null });
  });

  it("stops at once when a newer pick replaced the set or the page was left", async () => {
    let stale = false;
    const uploaded: string[] = [];
    const updates: string[] = [];
    const current = fakeSet(["a", "b"]);
    await uploadPhotosInOrder(picks(["a", "b"]), {
      upload: async (file) => {
        uploaded.push(file.name);
        stale = true;
        return blobFor(file);
      },
      isStale: () => stale,
      isAttached: current.isAttached,
      isCover: current.isCover,
      onUpdate: (key, patch) => updates.push(`${key}:${patch.status}`),
    });
    expect(uploaded).toEqual(["a.jpg"]);
    expect(updates).toEqual(["a:uploading"]);
  });

  it("skips a photo removed while it waited in the queue", async () => {
    const current = fakeSet(["a", "b", "c"]);
    const uploaded: string[] = [];
    const updates: string[] = [];
    await uploadPhotosInOrder(picks(["a", "b", "c"]), {
      upload: async (file) => {
        uploaded.push(file.name);
        if (file.name === "a.jpg") current.remove("b");
        return blobFor(file);
      },
      isStale: () => false,
      isAttached: current.isAttached,
      isCover: current.isCover,
      onUpdate: (key, patch) => updates.push(`${key}:${patch.status}`),
    });
    expect(uploaded).toEqual(["a.jpg", "c.jpg"]);
    expect(updates.some((u) => u.startsWith("b:"))).toBe(false);
  });

  it("drops the result of a photo removed while it uploaded, and goes on", async () => {
    const current = fakeSet(["a", "b"]);
    const updates: string[] = [];
    await uploadPhotosInOrder(picks(["a", "b"]), {
      upload: async (file) => {
        if (file.name === "a.jpg") current.remove("a");
        return blobFor(file);
      },
      isStale: () => false,
      isAttached: current.isAttached,
      isCover: current.isCover,
      onUpdate: (key, patch) => updates.push(`${key}:${patch.status}`),
    });
    expect(updates).toEqual(["a:uploading", "b:uploading", "b:uploaded"]);
  });

  it("writes the caption once, from the first photo, when it is still the cover", async () => {
    const current = fakeSet(["a", "b"]);
    const captions: string[] = [];
    const done: boolean[] = [];
    await uploadPhotosInOrder(picks(["a", "b"]), {
      upload: async (file) => blobFor(file),
      isStale: () => false,
      isAttached: current.isAttached,
      isCover: current.isCover,
      onUpdate: () => {},
      onCaption: (key, blob, file) => captions.push(`${key}:${blob.url}:${file.name}`),
      onDone: (captionStarted) => done.push(captionStarted),
    });
    expect(captions).toEqual(["a:u/a.jpg:a.jpg"]);
    expect(done).toEqual([true]);
  });

  it("the cover removed before its upload finishes: the caption comes from the new cover", async () => {
    const current = fakeSet(["a", "b", "c"]);
    const captions: string[] = [];
    await uploadPhotosInOrder(picks(["a", "b", "c"]), {
      upload: async (file) => {
        if (file.name === "a.jpg") current.remove("a");
        return blobFor(file);
      },
      isStale: () => false,
      isAttached: current.isAttached,
      isCover: current.isCover,
      onUpdate: () => {},
      onCaption: (key) => captions.push(key),
    });
    expect(captions).toEqual(["b"]);
  });

  it("no caption when no photo of the pick is the cover once it uploads", async () => {
    // The user moved photo c (already being uploaded later) first? Here the
    // cover is a photo outside this pick, so none of these may write it.
    const current = fakeSet(["x", "a", "b"]);
    const captions: string[] = [];
    const done: boolean[] = [];
    await uploadPhotosInOrder(picks(["a", "b"]), {
      upload: async (file) => blobFor(file),
      isStale: () => false,
      isAttached: current.isAttached,
      isCover: current.isCover,
      onUpdate: () => {},
      onCaption: (key) => captions.push(key),
      onDone: (captionStarted) => done.push(captionStarted),
    });
    expect(captions).toEqual([]);
    expect(done).toEqual([false]);
  });

  it("does not report done when the set was replaced (the newer pick owns the busy state)", async () => {
    const current = fakeSet(["a"]);
    const done: boolean[] = [];
    await uploadPhotosInOrder(picks(["a"]), {
      upload: async (file) => blobFor(file),
      isStale: () => true,
      isAttached: current.isAttached,
      isCover: current.isCover,
      onUpdate: () => {},
      onDone: (captionStarted) => done.push(captionStarted),
    });
    expect(done).toEqual([]);
  });
});

describe("AttachedPhotos", () => {
  const noop = () => {};
  const render = (photos: AttachedPhoto[]) =>
    renderToStaticMarkup(
      createElement(AttachedPhotos, { photos, onRemove: noop, onMove: noop, onRetry: noop, onRemoveAll: noop, removeAllClearsCaption: false }),
    );

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

  it("marks photos still being prepared, and shows no upload bar for them", () => {
    const html = render([photo("a", { status: "preparing", blob: null }), photo("b", { status: "preparing", blob: null })]);
    expect(html.match(/>Preparing</g)).toHaveLength(2);
    expect(html).toContain("Preparing photos");
    expect(html).not.toContain("Uploading photos");
  });

  it("offers Remove all from two photos up", () => {
    expect(render([photo("a"), photo("b")])).toContain(">Remove all<");
    expect(render([photo("a")])).not.toContain("Remove all");
  });
});

describe("removeAllTitle", () => {
  it("names the number of photos and says what happens to the caption", () => {
    expect(removeAllTitle(3, true)).toBe("Remove all 3 photos? The caption written for them will be cleared too.");
    expect(removeAllTitle(6, false)).toBe("Remove all 6 photos? Your caption stays.");
  });
});

describe("removeAllClearsCaption", () => {
  const ai = "Sunset paddle-out at Cocoa Beach.";

  it("clears the AI's text when it is still unedited", () => {
    expect(removeAllClearsCaption(ai, ai)).toBe(true);
  });

  it("keeps AI text the user edited", () => {
    expect(removeAllClearsCaption(`${ai} Book now!`, ai)).toBe(false);
    expect(removeAllClearsCaption(`${ai} `, ai)).toBe(false);
  });

  it("keeps a typed caption when the AI wrote nothing", () => {
    expect(removeAllClearsCaption("My own words", null)).toBe(false);
  });

  it("an empty caption stays empty: nothing to clear", () => {
    expect(removeAllClearsCaption("", null)).toBe(false);
    expect(removeAllClearsCaption("", ai)).toBe(false);
    expect(removeAllClearsCaption("", "")).toBe(false);
  });
});

describe("preparePhotos", () => {
  it("prepares the attached photos one after another, in order", async () => {
    const order: string[] = [];
    const result = await preparePhotos(picks(["a", "b"]), {
      prepare: async (file) => {
        order.push(file.name);
        return new File(["y"], `ready-${file.name}`, { type: "image/jpeg" });
      },
      isStale: () => false,
      isAttached: () => true,
    });
    expect(order).toEqual(["a.jpg", "b.jpg"]);
    expect(result?.map((r) => `${r.key}:${r.file.name}`)).toEqual(["a:ready-a.jpg", "b:ready-b.jpg"]);
  });

  it("skips a placeholder removed meanwhile", async () => {
    const result = await preparePhotos(picks(["a", "b"]), {
      prepare: async (file) => file,
      isStale: () => false,
      isAttached: (key) => key !== "a",
    });
    expect(result?.map((r) => r.key)).toEqual(["b"]);
  });

  it("gives null once a newer pick or leaving the page made it stale", async () => {
    let stale = false;
    const prepared: string[] = [];
    const result = await preparePhotos(picks(["a", "b"]), {
      prepare: async (file) => {
        prepared.push(file.name);
        stale = true;
        return file;
      },
      isStale: () => stale,
      isAttached: () => true,
    });
    expect(result).toBeNull();
    expect(prepared).toEqual(["a.jpg"]);
  });

  it("rejects with the preparation's own sentence", async () => {
    await expect(
      preparePhotos(picks(["a"]), {
        prepare: async () => {
          throw new Error("We couldn't convert this iPhone (HEIC) photo.");
        },
        isStale: () => false,
        isAttached: () => true,
      }),
    ).rejects.toThrow("We couldn't convert this iPhone (HEIC) photo.");
  });
});
