import { describe, expect, it, vi } from "vitest";

import { explainUploadFailure, UPLOAD_REFUSED_MESSAGE, UploadRefusedError } from "./uploadFailure";

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

    const explained = await explainUploadFailure(new Error("Vercel Blob: Failed to  retrieve the client token"), fetchMock);

    expect(fetchMock).toHaveBeenCalledWith("/api/upload", { method: "GET" });
    expect(explained).toBeInstanceOf(UploadRefusedError);
    expect(explained.message).toBe(FULL);
  });

  it("shows the sentence the route remembered for a refused token (an out-of-date page, the day's bytes)", async () => {
    const sentence = "This page is out of date. Reload it, then try again.";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ refused: true, error: sentence, code: "UPLOAD_PAGE_OUT_OF_DATE" }));

    const explained = await explainUploadFailure(new Error("Vercel Blob: Failed to  retrieve the client token"), fetchMock);

    expect(explained).toBeInstanceOf(UploadRefusedError);
    expect(explained.message).toBe(sentence);
  });

  it("keeps the original error when storage is not full", async () => {
    const original = new Error("network down");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ storageFull: false }));

    await expect(explainUploadFailure(original, fetchMock)).resolves.toBe(original);
  });

  it("keeps the original error when the question itself fails", async () => {
    const original = new Error("network down");
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(explainUploadFailure(original, fetchMock)).resolves.toBe(original);
  });

  it("keeps the original error on a non-ok answer", async () => {
    const original = new Error("x");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "Unauthorized" }, false));

    await expect(explainUploadFailure(original, fetchMock)).resolves.toBe(original);
  });

  it("wraps a non-Error throw so callers always get an Error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ storageFull: false }));

    const explained = await explainUploadFailure("boom", fetchMock);
    expect(explained).toBeInstanceOf(Error);
  });

  it("a refused token with storage not full says to wait (07c: many files at once)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ storageFull: false }));
    for (const libraryMessage of [
      "Vercel Blob: Failed to  retrieve the client token",
      "Vercel Blob: Failed to retrieve the client token",
    ]) {
      const explained = await explainUploadFailure(new Error(libraryMessage), fetchMock);
      expect(explained).toBeInstanceOf(UploadRefusedError);
      expect(explained.message).toBe(
        "The upload was refused. If you are adding many files, wait a few minutes and try again.",
      );
      expect(explained.message).toBe(UPLOAD_REFUSED_MESSAGE);
    }
  });

  it("a refused token says to wait even when the storage question fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    const explained = await explainUploadFailure(new Error("Vercel Blob: Failed to  retrieve the client token"), fetchMock);
    expect(explained.message).toBe(UPLOAD_REFUSED_MESSAGE);
  });

  it("storage full still wins over the refusal sentence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ storageFull: true, error: FULL }));
    const explained = await explainUploadFailure(new Error("Vercel Blob: Failed to  retrieve the client token"), fetchMock);
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
      const explained = await explainUploadFailure(TOKEN_ERROR, fetchMock);
      expect(explained).toBeInstanceOf(UploadRefusedError);
      expect(explained.message).toBe(SIGNED_OUT);
    });

    it("whatever the upload threw (a 401 is about the person, not the file)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: SIGNED_OUT }, false, 401));
      const explained = await explainUploadFailure(new Error("network down"), fetchMock);
      expect(explained).toBeInstanceOf(UploadRefusedError);
      expect(explained.message).toBe(SIGNED_OUT);
    });

    it("a 401 whose body cannot be read still says signed out", async () => {
      const unreadable = { ok: false, status: 401, json: async () => Promise.reject(new SyntaxError("x")) } as unknown as Response;
      const explained = await explainUploadFailure(TOKEN_ERROR, vi.fn().mockResolvedValue(unreadable));
      expect(explained.message).toBe(SIGNED_OUT);
      const empty = jsonResponse({}, false, 401);
      expect((await explainUploadFailure(TOKEN_ERROR, vi.fn().mockResolvedValue(empty))).message).toBe(SIGNED_OUT);
    });

    it("any other refused answer keeps today's text", async () => {
      for (const status of [403, 429, 500, 503]) {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "Something" }, false, status));
        expect((await explainUploadFailure(TOKEN_ERROR, fetchMock)).message, String(status)).toBe(UPLOAD_REFUSED_MESSAGE);
        const original = new Error("network down");
        await expect(explainUploadFailure(original, fetchMock)).resolves.toBe(original);
      }
    });
  });
});
