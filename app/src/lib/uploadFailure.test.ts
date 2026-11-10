import { describe, expect, it, vi } from "vitest";

import { explainUploadFailure, UploadRefusedError } from "./uploadFailure";

const FULL =
  "This workspace's media storage is full (5.0 GB). Delete media you no longer need on the Media page, then upload again.";

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
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
});
