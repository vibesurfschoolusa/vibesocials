import { beforeEach, describe, expect, it, vi } from "vitest";

import { UPLOAD_LINK_STORAGE_FULL_MESSAGE } from "@/lib/uploadLink";

import { sendClientFile, type SendFileDeps } from "./send-file";

const TOKEN = "T".repeat(43);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let deps: SendFileDeps & {
  prepare: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  deps = {
    prepare: vi.fn(async (file: File) => new File([file], "IMG_1.jpg", { type: "image/jpeg" })),
    put: vi.fn(async () => ({ url: "https://s.public.blob.vercel-storage.com/ul/link-1/r-IMG_1.jpg" })),
    fetch: vi.fn(async (url: string) =>
      url.endsWith("/upload")
        ? jsonResponse(200, { type: "blob.generate-client-token", clientToken: "ct", pathname: "ul/link-1/r-IMG_1.jpg" })
        : jsonResponse(201, { ok: true }),
    ),
  };
});

function input(overrides: Partial<Parameters<typeof sendClientFile>[0]> = {}) {
  return {
    token: TOKEN,
    file: new File(["abc"], "IMG_1.HEIC", { type: "image/heic" }),
    senderName: "Ana",
    note: "Hi",
    onProgress: vi.fn(),
    ...overrides,
  };
}

describe("sendClientFile", () => {
  it("prepares the file, gets a token, uploads to the path the server signed, then registers it", async () => {
    const args = input();
    await sendClientFile(args, deps);

    expect(deps.prepare).toHaveBeenCalledWith(args.file);

    const [tokenUrl, tokenInit] = deps.fetch.mock.calls[0];
    expect(tokenUrl).toBe(`/api/upload-link/${TOKEN}/upload`);
    expect(JSON.parse(tokenInit.body)).toEqual({
      type: "blob.generate-client-token",
      payload: {
        pathname: "IMG_1.jpg",
        clientPayload: JSON.stringify({ contentType: "image/jpeg" }),
        multipart: false,
      },
    });

    const [pathname, body, options] = deps.put.mock.calls[0];
    expect(pathname).toBe("ul/link-1/r-IMG_1.jpg");
    expect((body as File).name).toBe("IMG_1.jpg");
    expect(options).toMatchObject({ access: "public", token: "ct", contentType: "image/jpeg" });
    options.onUploadProgress({ loaded: 1, total: 2, percentage: 50 });
    expect(args.onProgress).toHaveBeenCalledWith(50);

    const [mediaUrl, mediaInit] = deps.fetch.mock.calls[1];
    expect(mediaUrl).toBe(`/api/upload-link/${TOKEN}/media`);
    expect(JSON.parse(mediaInit.body)).toEqual({
      blobUrl: "https://s.public.blob.vercel-storage.com/ul/link-1/r-IMG_1.jpg",
      filename: "IMG_1.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 3,
      senderName: "Ana",
      note: "Hi",
    });
  });

  it("shows the server's sentence when the token is refused, and uploads nothing", async () => {
    deps.fetch.mockResolvedValueOnce(jsonResponse(403, { error: UPLOAD_LINK_STORAGE_FULL_MESSAGE }));

    await expect(sendClientFile(input(), deps)).rejects.toThrow(UPLOAD_LINK_STORAGE_FULL_MESSAGE);
    expect(deps.put).not.toHaveBeenCalled();
  });

  it("gives a plain sentence when the upload itself fails", async () => {
    deps.put.mockRejectedValue(new Error("network"));
    await expect(sendClientFile(input(), deps)).rejects.toThrow(
      "The upload didn't finish. Check your connection and try again.",
    );
  });

  it("shows the server's sentence when registering fails", async () => {
    deps.fetch
      .mockResolvedValueOnce(jsonResponse(200, { clientToken: "ct", pathname: "ul/link-1/a.jpg" }))
      .mockResolvedValueOnce(jsonResponse(429, { error: "limit sentence" }));
    await expect(sendClientFile(input(), deps)).rejects.toThrow("limit sentence");
  });

  it("passes on the message when the file cannot be prepared", async () => {
    deps.prepare.mockRejectedValue(new Error("We couldn't convert this iPhone (HEIC) photo."));
    await expect(sendClientFile(input(), deps)).rejects.toThrow("We couldn't convert");
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});
