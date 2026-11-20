import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  UPLOAD_LINK_BYTES_LIMIT_MESSAGE,
  UPLOAD_LINK_BYTES_LIMIT_REASON,
  UPLOAD_LINK_DAILY_LIMIT_MESSAGE,
  UPLOAD_LINK_DAILY_LIMIT_REASON,
  UPLOAD_LINK_IP_LIMIT_MESSAGE,
  UPLOAD_LINK_IP_LIMIT_REASON,
  UPLOAD_LINK_STORAGE_FULL_MESSAGE,
} from "@/lib/uploadLink";

import { NoAnswerError } from "@/lib/requestNoAnswer";
import { MAX_MEDIA_BYTES } from "@/lib/mediaInput";
import { HeicConverterNotLoadedError, MAX_UPLOAD_PHOTO_BYTES, PrepareFileError } from "@/lib/prepareUploadFile";

import {
  CLIENT_FILE_MAYBE_ARRIVED_MESSAGE,
  ClientFileError,
  prepareLinkFile,
  sendClientFile,
  type SendFileDeps,
} from "./send-file";

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
        // The prepared (converted) file's real size: the link's day is counted in bytes.
        clientPayload: JSON.stringify({ contentType: "image/jpeg", size: 3 }),
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
    deps.prepare.mockRejectedValue(new PrepareFileError("file", "We couldn't convert this iPhone (HEIC) photo."));
    await expect(sendClientFile(input(), deps)).rejects.toThrow("We couldn't convert");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  // The form decides its summary from the kind, never from the sentence's words.
  describe("the kind of each failure", () => {
    async function failure(): Promise<ClientFileError> {
      const error = await sendClientFile(input(), deps).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ClientFileError);
      return error as ClientFileError;
    }

    it("network when the token request cannot reach the server", async () => {
      deps.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      expect(await failure()).toMatchObject({
        kind: "network",
        message: "The upload didn't finish. Check your connection and try again.",
      });
    });

    it("network when the upload to storage fails", async () => {
      deps.put.mockRejectedValue(new Error("network"));
      expect((await failure()).kind).toBe("network");
    });

    // R29 client-journey L1: the file is in storage by then, so it may have arrived.
    it("maybe when registering got no answer: the file may have arrived", async () => {
      deps.fetch
        .mockResolvedValueOnce(jsonResponse(200, { clientToken: "ct", pathname: "ul/link-1/a.jpg" }))
        .mockRejectedValueOnce(new NoAnswerError(new TypeError("Failed to fetch")));
      expect(await failure()).toMatchObject({ kind: "maybe", message: CLIENT_FILE_MAYBE_ARRIVED_MESSAGE });
    });

    it("maybe when registering got an unreadable 5xx (a gateway page)", async () => {
      deps.fetch
        .mockResolvedValueOnce(jsonResponse(200, { clientToken: "ct", pathname: "ul/link-1/a.jpg" }))
        .mockResolvedValueOnce(new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }));
      expect(await failure()).toMatchObject({ kind: "maybe", message: CLIENT_FILE_MAYBE_ARRIVED_MESSAGE });
    });

    it("refused when registering got our own 5xx sentence", async () => {
      deps.fetch
        .mockResolvedValueOnce(jsonResponse(200, { clientToken: "ct", pathname: "ul/link-1/a.jpg" }))
        .mockResolvedValueOnce(jsonResponse(500, { error: "server sentence" }));
      expect(await failure()).toMatchObject({ kind: "refused", message: "server sentence" });
    });

    // Before the upload nothing can have arrived: never "maybe".
    it("network, not maybe, when the token step got no answer or an unreadable 5xx", async () => {
      deps.fetch.mockRejectedValueOnce(new NoAnswerError(new TypeError("Failed to fetch")));
      expect((await failure()).kind).toBe("network");
      deps.fetch.mockResolvedValueOnce(new Response("", { status: 504 }));
      expect((await failure()).kind).toBe("network");
      expect(deps.put).not.toHaveBeenCalled();
    });

    it("refused, with the server's sentence, when the token is refused", async () => {
      deps.fetch.mockResolvedValueOnce(jsonResponse(403, { error: UPLOAD_LINK_STORAGE_FULL_MESSAGE }));
      expect(await failure()).toMatchObject({ kind: "refused", message: UPLOAD_LINK_STORAGE_FULL_MESSAGE });
    });

    it("refused, with the server's sentence, when registering is refused", async () => {
      deps.fetch
        .mockResolvedValueOnce(jsonResponse(200, { clientToken: "ct", pathname: "ul/link-1/a.jpg" }))
        .mockResolvedValueOnce(jsonResponse(429, { error: "limit sentence" }));
      expect(await failure()).toMatchObject({ kind: "refused", message: "limit sentence" });
    });

    // R47 client-journey L1: sending the same File again is refused the same way,
    // so the file's own refusal has a kind the retry button leaves out.
    it("the file's own kind when the file cannot be prepared", async () => {
      deps.prepare.mockRejectedValue(new PrepareFileError("file", "We couldn't convert this iPhone (HEIC) photo."));
      expect(await failure()).toMatchObject({ kind: "file", message: "We couldn't convert this iPhone (HEIC) photo." });
    });

    // R48 client-journey L1: the browser's own words never reach the client.
    it("a preparation error that isn't ours: a plain sentence, never the browser's words", async () => {
      deps.prepare.mockRejectedValue(new Error("The source image could not be decoded."));
      const error = await failure();
      expect(error.kind).toBe("file");
      expect(error.message).not.toContain("decoded");
      expect(error.message).toContain("press Send more and choose it again");
    });

    it("a converter that didn't download: network, so the retry is offered", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const offline = {
        convertHeicToJpeg: vi.fn(async () => {
          throw new HeicConverterNotLoadedError(new TypeError("Failed to fetch dynamically imported module"));
        }),
        reencodeAsJpeg: vi.fn(),
      };
      deps.prepare.mockImplementation((file: File) => prepareLinkFile(file, offline));
      expect(await failure()).toMatchObject({
        kind: "network",
        message: "We couldn't load the iPhone photo converter. Check your connection and try again.",
      });
      expect(deps.fetch).not.toHaveBeenCalled();
    });

    it("a photo that can't be made smaller: sent as it is when the upload takes it", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const undecodable = {
        convertHeicToJpeg: vi.fn(),
        reencodeAsJpeg: vi.fn(async () => {
          throw new Error("The source image could not be decoded.");
        }),
      };
      deps.prepare.mockImplementation((file: File) => prepareLinkFile(file, undecodable));
      const big = new File([new Uint8Array(MAX_UPLOAD_PHOTO_BYTES + 1)], "big.jpg", { type: "image/jpeg" });
      await sendClientFile(input({ file: big }), deps);
      expect(deps.put).toHaveBeenCalledWith(expect.any(String), big, expect.anything());
    });

    it("a photo that can't be made smaller and is too large to send: the file's own kind, with Send more", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const undecodable = {
        convertHeicToJpeg: vi.fn(),
        reencodeAsJpeg: vi.fn(async () => {
          throw new Error("The source image could not be decoded.");
        }),
      };
      deps.prepare.mockImplementation((file: File) => prepareLinkFile(file, undecodable));
      const huge = new File([new Uint8Array(MAX_UPLOAD_PHOTO_BYTES + 1)], "huge.jpg", { type: "image/jpeg" });
      Object.defineProperty(huge, "size", { value: MAX_MEDIA_BYTES + 1 });
      const error = await sendClientFile(input({ file: huge }), deps).then(
        () => null,
        (caught: ClientFileError) => caught,
      );
      expect(error).toMatchObject({
        kind: "file",
        message: "We couldn't make this photo smaller. Save it as a smaller JPEG, then press Send more and choose it again.",
      });
      expect(deps.fetch).not.toHaveBeenCalled();
    });

    // R47 lead review: a HEIC that won't convert is refused again as it is; on /u the step names Send more.
    it("a HEIC that won't convert: the file's own kind, and the step names Send more", async () => {
      const failing = {
        convertHeicToJpeg: vi.fn(async () => {
          throw new Error("decode failed");
        }),
        reencodeAsJpeg: vi.fn(),
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      deps.prepare.mockImplementation((file: File) => prepareLinkFile(file, failing));
      const error = await sendClientFile(input(), deps).then(
        () => null,
        (caught: ClientFileError) => caught,
      );
      expect(error).toMatchObject({
        kind: "file",
        message: "We couldn't convert this iPhone (HEIC) photo. Export it as a JPEG, then press Send more and choose it again.",
      });
      expect(deps.fetch).not.toHaveBeenCalled();
    });

    it("a typeless IMG_0042: the file's own kind, and the step names Send more", async () => {
      deps.prepare.mockImplementation(prepareLinkFile);
      const error = await sendClientFile(input({ file: new File(["abc"], "IMG_0042", { type: "" }) }), deps).then(
        () => null,
        (caught: ClientFileError) => caught,
      );
      expect(error).toMatchObject({
        kind: "file",
        message:
          "We couldn't tell what kind of file this is. If it's a photo or video, add .jpg or .mp4 to the end of its name, then press Send more and choose it again. Use a JPEG, PNG, GIF or WebP photo, or an MP4, MOV or WebM video.",
      });
      expect(deps.fetch).not.toHaveBeenCalled();
    });
  });
});

// R45 pages-a L6, lead review: /u's limit refusals said "Try again tomorrow"
// or "later" and never the wait the answer carries. They name the wait, then
// the retry button's step, which keeps the files, the name and the note (a
// reload would empty them).
describe("sendClientFile: a refused try names its wait", () => {
  async function refusal(answer: Response): Promise<ClientFileError> {
    deps.fetch.mockImplementation(async (url: string) =>
      url.endsWith("/upload") ? answer : jsonResponse(201, { ok: true }),
    );
    return sendClientFile(input(), deps).then(
      () => {
        throw new Error("sent");
      },
      (error: ClientFileError) => error,
    );
  }
  const limited = (error: string, retryAfterSeconds?: number, header?: string) =>
    new Response(JSON.stringify({ error, retryAfterSeconds }), {
      status: 429,
      headers: { "Content-Type": "application/json", ...(header ? { "Retry-After": header } : {}) },
    });

  it("the network's hour: its reason, then the wait in minutes and the retry step", async () => {
    const error = await refusal(limited(UPLOAD_LINK_IP_LIMIT_MESSAGE, 12 * 60 - 5));
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(
      `${UPLOAD_LINK_IP_LIMIT_REASON} Wait 12 minutes, then try the files that didn't send.`,
    );
  });

  it("the link's day: the wait in hours, from the Retry-After header when the body has none", async () => {
    const error = await refusal(limited(UPLOAD_LINK_DAILY_LIMIT_MESSAGE, undefined, String(7 * 3600 - 100)));
    expect(error.message).toBe(`${UPLOAD_LINK_DAILY_LIMIT_REASON} Wait 7 hours, then try the files that didn't send.`);
  });

  it("the day's 20 GB: its own reason with the wait", async () => {
    const error = await refusal(limited(UPLOAD_LINK_BYTES_LIMIT_MESSAGE, 30 * 60));
    expect(error.message).toBe(`${UPLOAD_LINK_BYTES_LIMIT_REASON} Wait 30 minutes, then try the files that didn't send.`);
  });

  it("no wait in the answer: a true sentence with no reload step", async () => {
    for (const [message, reason] of [
      [UPLOAD_LINK_DAILY_LIMIT_MESSAGE, UPLOAD_LINK_DAILY_LIMIT_REASON],
      [UPLOAD_LINK_IP_LIMIT_MESSAGE, UPLOAD_LINK_IP_LIMIT_REASON],
      [UPLOAD_LINK_BYTES_LIMIT_MESSAGE, UPLOAD_LINK_BYTES_LIMIT_REASON],
    ] as const) {
      const error = await refusal(limited(message));
      expect(error.message).toBe(`${reason} Try the files that didn't send again later.`);
      expect(error.message).not.toMatch(/reload|tomorrow/i);
    }
  });

  it("each message starts with its reason", () => {
    expect(UPLOAD_LINK_IP_LIMIT_MESSAGE.startsWith(UPLOAD_LINK_IP_LIMIT_REASON)).toBe(true);
    expect(UPLOAD_LINK_DAILY_LIMIT_MESSAGE.startsWith(UPLOAD_LINK_DAILY_LIMIT_REASON)).toBe(true);
    expect(UPLOAD_LINK_BYTES_LIMIT_MESSAGE.startsWith(UPLOAD_LINK_BYTES_LIMIT_REASON)).toBe(true);
  });
});
