import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { movePhoto, removePhoto } from "@/lib/postMedia";

import {
  AddPhotosButton,
  AttachedPhotos,
  patchPhoto,
  PhotoDescriptionField,
  photoSetProgress,
  photoSetReady,
  preparePhotos,
  PreparingPhotosStatus,
  removeAllClearsCaption,
  removeAllTitle,
  PHOTO_DESCRIPTION_FAILED_MESSAGE,
  PHOTO_DESCRIPTION_OFFLINE_MESSAGE,
  requestPhotoDescription,
  uploadPhotosInOrder,
  whereDescriptionGoes,
  withPhotoDescriptions,
  captionAfterMediaChange,
  selectedMediaOf,
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
      createElement(AttachedPhotos, {
        writeDescription: () => Promise.resolve(null),
        photos,
        onRemove: noop,
        onMove: noop,
        onRetry: noop,
        onRemoveAll: noop,
        removeAllClearsCaption: false,
        onDescribe: noop,
      }),
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

// 07d: each photo's description lives on its AttachedPhoto, so the list rules
// (lib/postMedia.ts) carry it wherever the photo goes.
describe("photo descriptions follow their photos", () => {
  const described = () => [
    photo("a", { altText: "A dog." }),
    photo("b", { altText: "A boat." }),
    photo("c", { altText: "" }),
  ];

  it("removing a photo removes its description and keeps the others with theirs", () => {
    const next = removePhoto(described(), "b");
    expect(next.map((p) => [p.key, p.altText])).toEqual([
      ["a", "A dog."],
      ["c", ""],
    ]);
  });

  it("moving a photo moves its description with it", () => {
    const next = movePhoto(described(), "a", 1);
    expect(next.map((p) => [p.key, p.altText])).toEqual([
      ["b", "A boat."],
      ["a", "A dog."],
      ["c", ""],
    ]);
  });

  it("editing one description changes only that photo", () => {
    const next = patchPhoto(described(), "c", { altText: "A red door." });
    expect(next.map((p) => p.altText)).toEqual(["A dog.", "A boat.", "A red door."]);
  });
});

describe("withPhotoDescriptions", () => {
  const single = { blobUrl: "u1", filename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1, baseCaption: "hi" };
  const several = {
    baseCaption: "hi",
    media: [
      { blobUrl: "u1", filename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1 },
      { blobUrl: "u2", filename: "b.jpg", mimeType: "image/jpeg", sizeBytes: 1 },
    ],
  };

  it("adds a single photo's cleaned description beside its fields", () => {
    expect(withPhotoDescriptions(single, ["  A dog\non a beach. "])).toEqual({ ...single, altText: "A dog on a beach." });
  });

  it("adds each description to its own media entry, in order", () => {
    expect(withPhotoDescriptions(several, ["", "A boat."])).toEqual({
      baseCaption: "hi",
      media: [several.media[0], { ...several.media[1], altText: "A boat." }],
    });
  });

  it("leaves the body exactly as it was when no photo has a description", () => {
    expect(withPhotoDescriptions(single, ["  "])).toBe(single);
    expect(withPhotoDescriptions(single, [])).toBe(single);
    expect(withPhotoDescriptions(several, [undefined, ""])).toBe(several);
  });
});

describe("requestPhotoDescription", () => {
  const blob = { url: "https://b.public.blob.vercel-storage.com/a.jpg", filename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1 };

  it("asks the AI caption route for the photo's description and gives it back", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ altText: "A dog on a beach." }), { status: 200 }));

    await expect(requestPhotoDescription(blob, "ws-1", fetchImpl)).resolves.toBe("A dog on a beach.");
    // R31: with the workspace the page was drawn for.
    expect(fetchImpl).toHaveBeenCalledWith("/api/posts/auto-caption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blobUrl: blob.url, mimeType: "image/jpeg", purpose: "altText", workspaceId: "ws-1" }),
    });
  });

  it("rejects with the route's own sentence", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Your workspace has reached today's AI limit. Try again tomorrow." }), {
          status: 429,
        }),
    );

    await expect(requestPhotoDescription(blob, "ws-1", fetchImpl)).rejects.toThrow(
      "Your workspace has reached today's AI limit. Try again tomorrow.",
    );
  });

  // R25 new-customer L3 / publishing-flow L1: offline it showed the browser's
  // own "Failed to fetch". A failed request, an answer that is not JSON and an
  // empty answer each get a sentence, as captionRequest gives them.
  it("a request that never left (Chrome and Safari): our sentence, not the browser's", async () => {
    for (const message of ["Failed to fetch", "Load failed"]) {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError(message);
      });
      await expect(requestPhotoDescription(blob, "ws-1", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
        PHOTO_DESCRIPTION_OFFLINE_MESSAGE,
      );
    }
    // Lead review 3 (R28 NN2): on a lost answer the AI ran; only the answer is missing.
    expect(PHOTO_DESCRIPTION_OFFLINE_MESSAGE).toBe(
      "Vibe Socials' answer didn't reach you, so the description isn't shown. If your connection dropped, reconnect first. Nothing was saved; try again.",
    );
  });

  it("a JSON error with no text: a plain sentence", async () => {
    const fetchImpl = vi.fn(async () => Response.json({}, { status: 500 }));
    await expect(requestPhotoDescription(blob, "ws-1", fetchImpl)).rejects.toThrow(PHOTO_DESCRIPTION_FAILED_MESSAGE);
    expect(PHOTO_DESCRIPTION_FAILED_MESSAGE).toBe(
      "Something went wrong on our side, so no description was written. Please try again in a minute.",
    );
  });

  // R29 OO1: a gateway's page is no answer: the AI may have run, its answer isn't shown.
  it("an error answer that is not JSON (a gateway's page): the lost-answer sentence", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(requestPhotoDescription(blob, "ws-1", fetchImpl)).rejects.toThrow(PHOTO_DESCRIPTION_OFFLINE_MESSAGE);
  });

  it("a success answer that is not JSON: the plain sentence", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    await expect(requestPhotoDescription(blob, "ws-1", fetchImpl)).rejects.toThrow(PHOTO_DESCRIPTION_FAILED_MESSAGE);
  });

  it("a blank description: the empty sentence", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ altText: "   " }));
    await expect(requestPhotoDescription(blob, "ws-1", fetchImpl)).rejects.toThrow(
      "The AI didn't write a description. Try again or write it yourself.",
    );
  });

  it("rejects with a plain sentence when the answer has no description", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    await expect(requestPhotoDescription(blob, "ws-1", fetchImpl)).rejects.toThrow(
      "The AI didn't write a description. Try again or write it yourself.",
    );
  });
});

describe("PhotoDescriptionField", () => {
  const render = (value: string, canWrite = true) =>
    renderToStaticMarkup(
      createElement(PhotoDescriptionField, {
        id: "alt-1",
        label: "Describe this photo (alt text)",
        value,
        onChange: () => {},
        onWrite: canWrite ? async () => "x" : null,
      }),
    );

  it("shows the label, a one-line field capped at 1,000 characters, a count and the AI button", () => {
    const html = render("A dog.");
    expect(html).toContain("Describe this photo (alt text)");
    expect(html).toContain('maxLength="1000"');
    expect(html).toContain("6/1000");
    expect(html).toContain("Write it for me");
  });

  it("disables the AI button until the photo has uploaded", () => {
    expect(render("", false)).toMatch(/<button[^>]*disabled=""[^>]*>[^]*Write it for me/);
  });
});

describe("AttachedPhotos - descriptions", () => {
  const noop = () => {};

  it("gives every photo its own description field, numbered like its tile", () => {
    const html = renderToStaticMarkup(
      createElement(AttachedPhotos, {
        writeDescription: () => Promise.resolve(null),
        photos: [photo("a", { altText: "A dog." }), photo("b")],
        onRemove: noop,
        onMove: noop,
        onRetry: noop,
        onRemoveAll: noop,
        removeAllClearsCaption: false,
        onDescribe: noop,
      }),
    );
    expect(html.match(/Photo \d: describe this photo \(alt text\)/g)).toEqual([
      "Photo 1: describe this photo (alt text)",
      "Photo 2: describe this photo (alt text)",
    ]);
    expect(html).toContain('value="A dog."');
    expect(html.match(/Write it for me/g)).toHaveLength(2);
  });
});

// Fix round 1: "Write it for me" answers the photo it was asked for, wherever
// that photo is when the answer comes back.
describe("whereDescriptionGoes", () => {
  const file = new File(["x"], "single.jpg", { type: "image/jpeg" });

  it("to the single field while the photo is still the single photo", () => {
    expect(whereDescriptionGoes(file, { single: file, set: [] })).toEqual({ to: "single" });
  });

  it("to its place in the set once Add photos moved it there", () => {
    const set = [photo("p1", { file }), photo("p2")];
    expect(whereDescriptionGoes(file, { single: null, set })).toEqual({ to: "set", key: "p1" });
  });

  it("nowhere once the photo is gone (replaced, removed or posted)", () => {
    const other = new File(["y"], "other.jpg", { type: "image/jpeg" });
    expect(whereDescriptionGoes(file, { single: other, set: [] })).toBeNull();
    expect(whereDescriptionGoes(file, { single: null, set: [photo("p2")] })).toBeNull();
    expect(whereDescriptionGoes(file, { single: null, set: [] })).toBeNull();
  });
});

// R26 LL3 item 5: a busy "Write it for me" keeps keyboard focus: Button's
// loading ignores the press, so the busy flag stays out of disabled.
describe("Write it for me while busy", () => {
  const source = readFileSync(new URL("./attached-photos.tsx", import.meta.url), "utf8");
  it("is loading, not disabled, while writing", () => {
    expect(source).toContain("loading={writing} disabled={!onWrite}");
  });
});

// R27 MM4 item 8: moving a photo to an end disables the pressed arrow; focus
// goes to the same photo's other arrow, never the page body.
describe("Move photo earlier or later at an end", () => {
  const source = readFileSync(new URL("./attached-photos.tsx", import.meta.url), "utf8");

  it("each arrow hands focus to its partner", () => {
    expect(source).toMatch(/ref=\{earlierRef\}\s+type="button"\s+className=\{ICON_BUTTON\}\s+onClick=\{\(event\) => \{\s*(\/\/.*\s*)?focusAfterPress\(event\.currentTarget, \(\) => laterRef\.current\);\s*onMove\(-1\);/);
    expect(source).toMatch(/ref=\{laterRef\}\s+type="button"\s+className=\{ICON_BUTTON\}\s+onClick=\{\(event\) => \{\s*focusAfterPress\(event\.currentTarget, \(\) => earlierRef\.current\);\s*onMove\(1\);/);
  });
});

// R28 new-customer addendum L9: the set and its line appear together, so the
// line lives in the page around it, on the page before any photo is picked,
// and only its text changes.
describe("PreparingPhotosStatus", () => {
  const html = (photos: AttachedPhoto[]) => renderToStaticMarkup(createElement(PreparingPhotosStatus, { photos }));

  it("is an empty status line with no photos or none preparing, and says so while some are", () => {
    expect(html([])).toBe('<p class="text-xs text-muted-foreground empty:sr-only" role="status"></p>');
    expect(html([photo("a")])).toBe('<p class="text-xs text-muted-foreground empty:sr-only" role="status"></p>');
    expect(html([photo("a"), photo("b", { status: "preparing", blob: null })])).toBe(
      '<p class="text-xs text-muted-foreground empty:sr-only" role="status">Preparing photos…</p>',
    );
  });

  it("Create draws it outside the attached set, so it is there before the first pick", () => {
    const form = readFileSync(new URL("../create-post-form.tsx", import.meta.url), "utf8");
    expect(form).toMatch(/\{photoSet\.length > 0 && \(\s*<AttachedPhotos[^]*?\/>\s*\)\}\s*<PreparingPhotosStatus photos=\{photoSet\} \/>/);
    const own = readFileSync(new URL("./attached-photos.tsx", import.meta.url), "utf8");
    expect(own).not.toMatch(/\{preparing && \(/);
  });
});

// R28 new-customer addendum L8: the file input inside "Add photos" is hidden,
// so the label shows the ring while it has keyboard focus.
describe("AddPhotosButton", () => {
  it("rings the label when its input has keyboard focus", () => {
    const html = renderToStaticMarkup(createElement(AddPhotosButton, { onPick: () => {} }));
    expect(html).toMatch(/<label class="[^"]*has-\[:focus-visible\]:ring-2 has-\[:focus-visible\]:ring-ring has-\[:focus-visible\]:ring-offset-2[^"]*"/);
  });
});

describe("requestPhotoDescription: another workspace", () => {
  it("rejects with the shared sentence, and the typed description is the field's to keep", async () => {
    const blob = { url: "https://b.public.blob.vercel-storage.com/a.jpg", filename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1 };
    const fetchImpl = vi.fn(async () => Response.json({ error: "You switched workspace in another tab. Reload this page, then try again.", code: "WORKSPACE_CHANGED" }, { status: 409 }));
    await expect(requestPhotoDescription(blob, "ws-1", fetchImpl)).rejects.toThrow("You switched workspace in another tab. Reload this page, then try again.");
  });
});

// R37 new-customer L1: the one "the media changed" rule, for every path that
// replaces or drops the selected media.
describe("captionAfterMediaChange", () => {
  const ai = "Sunrise lesson at Dania Beach.";

  it("an unedited AI caption goes, and lastAiCaption with it", () => {
    expect(captionAfterMediaChange(ai, ai)).toEqual({ caption: "", lastAiCaption: null });
  });

  it("an edited or typed caption stays, as it was", () => {
    expect(captionAfterMediaChange(`${ai} Book now!`, ai)).toEqual({ caption: `${ai} Book now!`, lastAiCaption: ai });
    expect(captionAfterMediaChange("My own words", null)).toEqual({ caption: "My own words", lastAiCaption: null });
    expect(captionAfterMediaChange("", ai)).toEqual({ caption: "", lastAiCaption: ai });
  });
});

// R37 publishing L1: what a caption is asked about. "Add photos" moves the
// single File into the set as its cover; that is still the same media.
describe("selectedMediaOf", () => {
  const file = new File(["x"], "single.jpg", { type: "image/jpeg" });

  it("the single File, then the set whose cover is that File: the same media", () => {
    const before = selectedMediaOf({ single: file, set: [] });
    const after = selectedMediaOf({ single: null, set: [photo("p1", { file }), photo("p2")] });
    expect(after).toBe(before);
  });

  it("a set whose cover is another File, or nothing selected: other media", () => {
    expect(selectedMediaOf({ single: null, set: [photo("p2"), photo("p1", { file })] })).not.toBe(file);
    expect(selectedMediaOf({ single: null, set: [] })).toBeNull();
  });

  it("a reused item is itself", () => {
    const item = { id: "m1" };
    expect(selectedMediaOf({ single: item, set: [] })).toBe(item);
  });
});
