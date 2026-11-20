import { describe, expect, it, vi } from "vitest";

import {
  BlobAccessError,
  BlobFileTooLargeError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobStoreSuspendedError,
  BlobUnknownError,
} from "@vercel/blob";

import {
  explainUploadFailure,
  isStorageRefusal,
  isStorageTooLarge,
  UPLOAD_OFFLINE_MESSAGE,
  UPLOAD_STORAGE_TOO_LARGE_MESSAGE,
  UPLOAD_STORAGE_REFUSED_MESSAGE,
  UPLOAD_REFUSED_MESSAGE,
  UPLOAD_STORAGE_UNREACHABLE_MESSAGE,
  UploadRefusedError,
} from "./uploadFailure";
import {
  MISSING_WORKSPACE_ID_MESSAGE,
  renderedWorkspaceRefusal,
  WORKSPACE_CHANGED_SAVE_MESSAGE,
} from "./workspaceChanged";

const FULL =
  "This workspace's media storage is full (5.0 GB). Delete media you no longer need on the Media page, then upload again.";

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("explainUploadFailure", () => {
  it("turns a refused upload into the storage sentence when the workspace is full", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ storageFull: true, error: FULL, code: "WORKSPACE_STORAGE_FULL" }),
    );

    const explained = await explainUploadFailure(new Error("Vercel Blob: Failed to  retrieve the client token"), "ws-1", fetchMock);

    expect(fetchMock).toHaveBeenCalledWith("/api/upload?workspaceId=ws-1", { method: "GET" });
    expect(explained).toBeInstanceOf(UploadRefusedError);
    expect(explained.message).toBe(FULL);
  });

  it("shows the sentence the route remembered for a refused token (an out-of-date page, the day's bytes)", async () => {
    const sentence = "This page is out of date. Reload it, then try again.";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ refused: true, error: sentence, code: "UPLOAD_PAGE_OUT_OF_DATE" }));

    const explained = await explainUploadFailure(new Error("Vercel Blob: Failed to  retrieve the client token"), "ws-1", fetchMock);

    expect(explained).toBeInstanceOf(UploadRefusedError);
    expect(explained.message).toBe(sentence);
  });

  it("keeps the original error when storage is not full", async () => {
    const original = new Error("network down");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ storageFull: false }));

    await expect(explainUploadFailure(original, "ws-1", fetchMock)).resolves.toBe(original);
  });

  it("keeps the original error when the question itself fails", async () => {
    const original = new Error("network down");
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(explainUploadFailure(original, "ws-1", fetchMock)).resolves.toBe(original);
  });

  it("keeps the original error on a non-ok answer", async () => {
    const original = new Error("x");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "Unauthorized" }, false));

    await expect(explainUploadFailure(original, "ws-1", fetchMock)).resolves.toBe(original);
  });

  it("wraps a non-Error throw so callers always get an Error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ storageFull: false }));

    const explained = await explainUploadFailure("boom", "ws-1", fetchMock);
    expect(explained).toBeInstanceOf(Error);
  });

  it("a refused token with storage not full says to wait (07c: many files at once)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ storageFull: false }));
    for (const libraryMessage of [
      "Vercel Blob: Failed to  retrieve the client token",
      "Vercel Blob: Failed to retrieve the client token",
    ]) {
      const explained = await explainUploadFailure(new Error(libraryMessage), "ws-1", fetchMock);
      expect(explained).toBeInstanceOf(UploadRefusedError);
      expect(explained.message).toBe(
        "The upload was refused. If you are adding many files, wait a few minutes and try again.",
      );
      expect(explained.message).toBe(UPLOAD_REFUSED_MESSAGE);
    }
  });

  it("a refused token says to wait even when the storage question fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    const explained = await explainUploadFailure(new Error("Vercel Blob: Failed to  retrieve the client token"), "ws-1", fetchMock);
    expect(explained.message).toBe(UPLOAD_REFUSED_MESSAGE);
  });

  it("storage full still wins over the refusal sentence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ storageFull: true, error: FULL }));
    const explained = await explainUploadFailure(new Error("Vercel Blob: Failed to  retrieve the client token"), "ws-1", fetchMock);
    expect(explained.message).toBe(FULL);
  });
  // R20 new-customer L2: an upload from a tab whose session ended. The blob
  // client drops the 401's body, and the status question answers 401 too; the
  // person reads the route's signed-out sentence, not "The upload was refused".
  describe("signed out", () => {
    const SIGNED_OUT = "You were signed out. Sign in again.";
    const TOKEN_ERROR = new Error("Vercel Blob: Failed to  retrieve the client token");

    it("a 401 answer shows the route's sentence", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: SIGNED_OUT }, false, 401));
      const explained = await explainUploadFailure(TOKEN_ERROR, "ws-1", fetchMock);
      expect(explained).toBeInstanceOf(UploadRefusedError);
      expect(explained.message).toBe(SIGNED_OUT);
    });

    it("whatever the upload threw (a 401 is about the person, not the file)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: SIGNED_OUT }, false, 401));
      const explained = await explainUploadFailure(new Error("network down"), "ws-1", fetchMock);
      expect(explained).toBeInstanceOf(UploadRefusedError);
      expect(explained.message).toBe(SIGNED_OUT);
    });

    it("a 401 whose body cannot be read still says signed out", async () => {
      const unreadable = { ok: false, status: 401, json: async () => Promise.reject(new SyntaxError("x")) } as unknown as Response;
      const explained = await explainUploadFailure(TOKEN_ERROR, "ws-1", vi.fn().mockResolvedValue(unreadable));
      expect(explained.message).toBe(SIGNED_OUT);
      const empty = jsonResponse({}, false, 401);
      expect((await explainUploadFailure(TOKEN_ERROR, "ws-1", vi.fn().mockResolvedValue(empty))).message).toBe(SIGNED_OUT);
    });

    it("any other refused answer keeps today's text", async () => {
      for (const status of [403, 429, 500, 503]) {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "Something" }, false, status));
        expect((await explainUploadFailure(TOKEN_ERROR, "ws-1", fetchMock)).message, String(status)).toBe(UPLOAD_REFUSED_MESSAGE);
        const original = new Error("network down");
        await expect(explainUploadFailure(original, "ws-1", fetchMock)).resolves.toBe(original);
      }
    });
  });

  // R24 new-customer L3: offline, the blob client throws the browser's own
  // TypeError ("Failed to fetch", "Load failed") from its token request, or its
  // "blob service is currently not available" after a dropped part. Create and
  // Add many show the message, so it is a sentence instead.
  describe("offline", () => {
    const offline = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    it.each(["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."])(
      "the browser's %s with the question failing too: our sentence",
      async (browserText) => {
        const explained = await explainUploadFailure(new TypeError(browserText), "ws-1", offline);
        expect(explained.message).toBe(UPLOAD_OFFLINE_MESSAGE);
        expect(explained.message).toBe(
          "We couldn't reach Vibe Socials, so the file wasn't uploaded. Check your connection and try again.",
        );
      },
    );

    // Lead review: one rule for both kinds of dropped request. "Couldn't reach
    // Vibe Socials" only when our own question fails too; answered, the file
    // storage host is what this network could not reach (a school or office
    // filter), or it was down: either way "try again, or another connection".
    const UNAVAILABLE = "Vercel Blob: The blob service is currently not available. Please try again.";
    const answeredStatuses = [
      ["answered with nothing to say", jsonResponse({ storageFull: false })],
      ["answered 500", jsonResponse({ error: "x" }, false, 500)],
    ] as const;

    it.each(answeredStatuses)("the browser's TypeError, our question %s: the storage sentence", async (_name, answer) => {
      const explained = await explainUploadFailure(new TypeError("Load failed"), "ws-1", vi.fn().mockResolvedValue(answer));
      expect(explained).toBeInstanceOf(UploadRefusedError);
      expect(explained.message).toBe(UPLOAD_STORAGE_UNREACHABLE_MESSAGE);
      expect(UPLOAD_STORAGE_UNREACHABLE_MESSAGE).toBe(
        "The file couldn't be uploaded. Vibe Socials answered, but its file storage couldn't be reached from this network. Try again, or try another connection.",
      );
    });

    it("the blob service unavailable while we cannot be reached: our sentence", async () => {
      expect((await explainUploadFailure(new Error(UNAVAILABLE), "ws-1", offline)).message).toBe(UPLOAD_OFFLINE_MESSAGE);
    });

    it.each(answeredStatuses)("the blob service unavailable, our question %s: the storage sentence", async (_name, answer) => {
      const explained = await explainUploadFailure(new Error(UNAVAILABLE), "ws-1", vi.fn().mockResolvedValue(answer));
      expect(explained).toBeInstanceOf(UploadRefusedError);
      expect(explained.message).toBe(UPLOAD_STORAGE_UNREACHABLE_MESSAGE);
    });

    it("signed out still wins over a dropped request", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "You were signed out. Sign in again." }, false, 401));
      expect((await explainUploadFailure(new TypeError("Failed to fetch"), "ws-1", fetchMock)).message).toBe("You were signed out. Sign in again.");
    });

    it("a reason the route gives still wins", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ storageFull: true, error: FULL }));
      expect((await explainUploadFailure(new TypeError("Failed to fetch"), "ws-1", fetchMock)).message).toBe(FULL);
    });
  });
});

// R31 (lead follow-up): every upload asks for its token with the workspace the
// page was drawn for, so a tab left on another workspace gets no token there.
describe("uploadRouteUrl", () => {
  it("is the upload route with the page's workspace id", async () => {
    const { uploadRouteUrl } = await import("./uploadFailure");
    expect(uploadRouteUrl("ws-1")).toBe("/api/upload?workspaceId=ws-1");
    expect(uploadRouteUrl("a b")).toBe("/api/upload?workspaceId=a%20b");
  });

  it("is the only handleUploadUrl in the app", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(full);
      }
    };
    walk(root);
    const uses = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/handleUploadUrl:\s*([^,\n]+)/g)].map((m) => `${path.relative(root, file)}: ${m[1].trim()}`),
    );
    expect(uses.length).toBeGreaterThanOrEqual(6);
    expect(uses.filter((use) => !/: uploadRouteUrl\(workspaceId\)$/.test(use))).toEqual([]);
  });
});

// R32 lead follow-up: the question names the page's workspace; a page left on
// another one gets the switch sentence, whatever the blob client threw.
describe("explainUploadFailure and the page's workspace", () => {
  it.each([
    ["another workspace", "ws-2", WORKSPACE_CHANGED_SAVE_MESSAGE],
    ["a page that sent no id", undefined, MISSING_WORKSPACE_ID_MESSAGE],
  ])("%s: the refusal's sentence", async (_name, active, text) => {
    const refusal = renderedWorkspaceRefusal(active === undefined ? undefined : "ws-1", active ?? "ws-1") as Response;
    const explained = await explainUploadFailure(new TypeError("Failed to fetch"), "ws-1", vi.fn().mockResolvedValue(refusal));
    expect(explained).toBeInstanceOf(UploadRefusedError);
    expect(explained.message).toBe(text);
  });
});

// R53 pages-a L3: the blob client's own errors ("Vercel Blob: This store has
// been suspended.", "...please visit https://vercel.com/help.") reached Add
// many's and Create's rows as they were. One plain sentence instead.
describe("a storage refusal", () => {
  const answered = () => vi.fn().mockResolvedValue(jsonResponse({ storageFull: false }));

  it("the sentence is plain and names no vendor", () => {
    expect(UPLOAD_STORAGE_REFUSED_MESSAGE).toBe("File storage didn't take the upload. Try again in a few minutes.");
  });

  it("isStorageRefusal: the blob client's own refusals, never a dropped request or a plain error", () => {
    expect(isStorageRefusal(new BlobStoreSuspendedError())).toBe(true);
    expect(isStorageRefusal(new BlobAccessError())).toBe(true);
    expect(isStorageRefusal(new BlobUnknownError())).toBe(true);
    expect(isStorageRefusal(new BlobServiceRateLimited(30))).toBe(true);
    // A copy of the text, as a bundle may throw without the class.
    expect(isStorageRefusal(new Error("Vercel Blob: This store has been suspended."))).toBe(true);
    expect(isStorageRefusal(new TypeError("Failed to fetch"))).toBe(false);
    expect(isStorageRefusal(new Error("network down"))).toBe(false);
    // These keep their own sentences.
    expect(isStorageRefusal(new BlobServiceNotAvailable())).toBe(false);
    expect(isStorageRefusal(new Error("Vercel Blob: Failed to  retrieve the client token"))).toBe(false);
    expect(isStorageRefusal("Vercel Blob: x")).toBe(false);
  });

  it.each([
    ["suspended", new BlobStoreSuspendedError()],
    ["access denied", new BlobAccessError()],
    ["unknown", new BlobUnknownError()],
    ["a rate limit", new BlobServiceRateLimited(30)],
  ])("explainUploadFailure: %s gives the plain sentence", async (_name, error) => {
    const explained = await explainUploadFailure(error, "ws-1", answered());
    expect(explained).toBeInstanceOf(UploadRefusedError);
    expect(explained.message).toBe(UPLOAD_STORAGE_REFUSED_MESSAGE);
    expect(explained.message).not.toMatch(/Vercel|vercel\.com/);
  });

  it("the same when our own question fails or answers non-ok", async () => {
    expect((await explainUploadFailure(new BlobStoreSuspendedError(), "ws-1", vi.fn().mockRejectedValue(new TypeError("x")))).message).toBe(
      UPLOAD_STORAGE_REFUSED_MESSAGE,
    );
    expect(
      (await explainUploadFailure(new BlobUnknownError(), "ws-1", vi.fn().mockResolvedValue(jsonResponse({}, false)))).message,
    ).toBe(UPLOAD_STORAGE_REFUSED_MESSAGE);
  });

  it("a full workspace still wins: its own sentence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ storageFull: true, error: FULL }));
    expect((await explainUploadFailure(new BlobStoreSuspendedError(), "ws-1", fetchMock)).message).toBe(FULL);
  });

  it("unchanged: a TypeError, a plain error, not available and a refused token", async () => {
    expect((await explainUploadFailure(new TypeError("Failed to fetch"), "ws-1", answered())).message).toBe(UPLOAD_STORAGE_UNREACHABLE_MESSAGE);
    const plain = new Error("network down");
    await expect(explainUploadFailure(plain, "ws-1", answered())).resolves.toBe(plain);
    expect((await explainUploadFailure(new BlobServiceNotAvailable(), "ws-1", answered())).message).toBe(UPLOAD_STORAGE_UNREACHABLE_MESSAGE);
    expect(
      (await explainUploadFailure(new Error("Vercel Blob: Failed to  retrieve the client token"), "ws-1", answered())).message,
    ).toBe(UPLOAD_REFUSED_MESSAGE);
  });

  // Add many's row shows the explained error's message
  // (app/posts/bulk/bulk-posts-form.tsx errorMessage), so for a suspended store
  // that is the plain sentence.
  it("Add many's row text for a suspended store is the plain sentence", async () => {
    const rowText = (error: unknown) => (error instanceof Error && error.message ? error.message : "The upload failed. Retry it or remove it.");
    expect(rowText(await explainUploadFailure(new BlobStoreSuspendedError(), "ws-1", answered()))).toBe(
      "File storage didn't take the upload. Try again in a few minutes.",
    );
  });
});

// R53 fix review: storage refusing a file for its size is refused on every
// try, so it never says to try again; it says what the upload route says.
describe("storage refusing a file for its size", () => {
  const answered = () => vi.fn().mockResolvedValue(jsonResponse({ storageFull: false }));

  it("is the upload route's own sentence for an over-limit file", async () => {
    const { UPLOAD_TOO_LARGE_MESSAGE } = await import("@/app/api/upload/uploadBudget");
    expect(UPLOAD_STORAGE_TOO_LARGE_MESSAGE).toBe(UPLOAD_TOO_LARGE_MESSAGE);
    expect(UPLOAD_STORAGE_TOO_LARGE_MESSAGE).not.toMatch(/try again/i);
  });

  it("isStorageTooLarge: only the size refusal", () => {
    expect(isStorageTooLarge(new BlobFileTooLargeError("max 512 MB"))).toBe(true);
    expect(isStorageTooLarge(new BlobStoreSuspendedError())).toBe(false);
    expect(isStorageTooLarge(new BlobServiceRateLimited(30))).toBe(false);
    expect(isStorageTooLarge(new Error("File is too large, but not from storage."))).toBe(false);
  });

  it("explainUploadFailure: a too-large refusal gives the size sentence", async () => {
    const explained = await explainUploadFailure(new BlobFileTooLargeError("max 512 MB"), "ws-1", answered());
    expect(explained).toBeInstanceOf(UploadRefusedError);
    expect(explained.message).toBe("File is too large (max 512 MB).");
  });

  it("a rate limit and the other storage refusals keep the try-again sentence", async () => {
    for (const error of [new BlobServiceRateLimited(30), new BlobStoreSuspendedError(), new BlobAccessError(), new BlobUnknownError()]) {
      expect((await explainUploadFailure(error, "ws-1", answered())).message).toBe(UPLOAD_STORAGE_REFUSED_MESSAGE);
    }
  });
});
