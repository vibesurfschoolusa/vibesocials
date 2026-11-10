import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  findActiveUploadLinkMock,
  notifyOwnersOfClientUploadMock,
  checkRateLimitMock,
  mediaCreateMock,
  linkUpdateMock,
  transactionMock,
  afterMock,
} = vi.hoisted(() => ({
  findActiveUploadLinkMock: vi.fn(),
  notifyOwnersOfClientUploadMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  mediaCreateMock: vi.fn(),
  linkUpdateMock: vi.fn(),
  transactionMock: vi.fn(),
  afterMock: vi.fn(),
}));

vi.mock("@/server/uploadLink", () => ({
  findActiveUploadLink: findActiveUploadLinkMock,
  notifyOwnersOfClientUpload: notifyOwnersOfClientUploadMock,
}));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    mediaItem: { create: mediaCreateMock },
    workspaceUploadLink: { update: linkUpdateMock },
    $transaction: transactionMock,
  },
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: afterMock,
}));

import { BLOB_URL_REJECTED_MESSAGE } from "@/lib/blobUrl";
import { MAX_MEDIA_BYTES } from "@/lib/mediaInput";
import { UPLOAD_LINK_DAILY_LIMIT_MESSAGE, UPLOAD_LINK_INACTIVE_MESSAGE } from "@/lib/uploadLink";

import { POST } from "./route";

const TOKEN = "T".repeat(43);
const LINK = { id: "link-1", workspaceId: "ws-1", createdById: "owner-1", workspaceName: "Surf Co" };
const HOST = "https://store1.public.blob.vercel-storage.com";
const GOOD_URL = `${HOST}/ul/link-1/0123456789abcdef-IMG_1.jpg`;

function goodBody(overrides: Record<string, unknown> = {}) {
  return { blobUrl: GOOD_URL, mimeType: "image/jpeg", sizeBytes: 1234, filename: "IMG_1.jpg", ...overrides };
}

function mediaRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/upload-link/${TOKEN}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function call(request: Request, token = TOKEN) {
  return POST(request, { params: Promise.resolve({ token }) });
}

/** The data the route wrote to the new MediaItem. */
function createdData(): Record<string, unknown> {
  return mediaCreateMock.mock.calls[0][0].data;
}

beforeEach(() => {
  for (const mock of [
    findActiveUploadLinkMock,
    notifyOwnersOfClientUploadMock,
    checkRateLimitMock,
    mediaCreateMock,
    linkUpdateMock,
    transactionMock,
    afterMock,
  ]) {
    mock.mockReset();
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;

  findActiveUploadLinkMock.mockResolvedValue(LINK);
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  mediaCreateMock.mockImplementation((args: unknown) => ({ op: "create", args }));
  linkUpdateMock.mockImplementation((args: unknown) => ({ op: "update", args }));
  transactionMock.mockResolvedValue([{ id: "media-1" }, { id: "link-1" }]);
  notifyOwnersOfClientUploadMock.mockResolvedValue(undefined);
});

describe("an inactive link", () => {
  it("answers unknown and revoked with the same 404, and writes nothing", async () => {
    findActiveUploadLinkMock.mockResolvedValue(null);

    const unknown = await call(mediaRequest(goodBody()), "unknown");
    const revoked = await call(mediaRequest(goodBody()));

    expect(unknown.status).toBe(404);
    expect(revoked.status).toBe(404);
    const body = await unknown.json();
    expect(body).toEqual({ error: UPLOAD_LINK_INACTIVE_MESSAGE });
    expect(await revoked.json()).toEqual(body);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe("the blob checks POST /api/media applies", () => {
  it("needs a JSON body", async () => {
    const wrongType = await call(mediaRequest(goodBody(), { "Content-Type": "text/plain" }));
    expect(wrongType.status).toBe(400);
    expect((await call(mediaRequest("{"))).status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("needs a blob URL on an allowed host, in its canonical form", async () => {
    for (const blobUrl of [
      undefined,
      "",
      "https://evil.example/ul/link-1/a.jpg",
      `${GOOD_URL}?x=1`,
      "http://store1.public.blob.vercel-storage.com/ul/link-1/a.jpg",
      `${HOST}/ul/link-1/${"a".repeat(2100)}.jpg`,
    ]) {
      const response = await call(mediaRequest(goodBody({ blobUrl })));
      expect(response.status, String(blobUrl).slice(0, 60)).toBe(400);
    }
    const rejected = await call(mediaRequest(goodBody({ blobUrl: "https://evil.example/ul/link-1/a.jpg" })));
    await expect(rejected.json()).resolves.toEqual({ error: BLOB_URL_REJECTED_MESSAGE });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("needs an image or video type", async () => {
    for (const mimeType of ["application/pdf", "text/html", undefined, 7]) {
      expect((await call(mediaRequest(goodBody({ mimeType })))).status).toBe(400);
    }
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("needs a size above 0 and at most the shared limit", async () => {
    for (const sizeBytes of [0, -1, MAX_MEDIA_BYTES + 1, "100", undefined, Number.NaN]) {
      expect((await call(mediaRequest(goodBody({ sizeBytes })))).status, String(sizeBytes)).toBe(400);
    }
    expect((await call(mediaRequest(goodBody({ sizeBytes: MAX_MEDIA_BYTES })))).status).toBe(201);
  });
});

describe("the link's own prefix", () => {
  it("refuses a file on an allowed host but outside ul/<link id>/", async () => {
    const response = await call(mediaRequest(goodBody({ blobUrl: `${HOST}/1700000000-abc-IMG_1.jpg` })));
    expect(response.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("refuses a file under another link's prefix", async () => {
    for (const blobUrl of [
      `${HOST}/ul/link-2/abc-IMG_1.jpg`,
      `${HOST}/ul/link-10/abc-IMG_1.jpg`,
      `${HOST}/ul/link-1/../link-2/abc-IMG_1.jpg`,
    ]) {
      expect((await call(mediaRequest(goodBody({ blobUrl })))).status, blobUrl).toBe(400);
    }
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe("the row", () => {
  it("goes to the link's workspace, owned by the link's creator, with the link's metadata", async () => {
    const response = await call(
      mediaRequest(goodBody({ senderName: "  Ana  ", note: "  For Friday  " })),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(createdData()).toEqual({
      workspaceId: "ws-1",
      userId: "owner-1",
      storageLocation: GOOD_URL,
      originalFilename: "IMG_1.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      baseCaption: "",
      metadata: { source: "upload_link", linkId: "link-1", senderName: "Ana", note: "For Friday" },
    });
  });

  it("leaves out a name and a note that were not given", async () => {
    await call(mediaRequest(goodBody({ senderName: "   ", note: 12 })));
    expect(createdData().metadata).toEqual({ source: "upload_link", linkId: "link-1" });
  });

  it("caps the name and the note at 200 characters, and puts the name on one line", async () => {
    await call(mediaRequest(goodBody({ senderName: `Ana\n${"n".repeat(300)}`, note: "x".repeat(500) })));
    const metadata = createdData().metadata as { senderName: string; note: string };
    expect(metadata.senderName).toBe(`Ana ${"n".repeat(196)}`);
    expect(metadata.note).toBe("x".repeat(200));
  });

  it("lets nothing in the request choose the workspace, the owner, the link or the caption", async () => {
    await call(
      mediaRequest(
        goodBody({
          workspaceId: "ws-evil",
          userId: "user-evil",
          linkId: "link-2",
          baseCaption: "spam",
          metadata: { source: "other" },
          storageLocation: "https://evil.example/x.jpg",
        }),
      ),
    );

    expect(createdData()).toMatchObject({
      workspaceId: "ws-1",
      userId: "owner-1",
      baseCaption: "",
      storageLocation: GOOD_URL,
      metadata: { source: "upload_link", linkId: "link-1" },
    });
  });

  it("caps an over-long file name and falls back to 'upload'", async () => {
    await call(mediaRequest(goodBody({ filename: "f".repeat(400) })));
    expect((createdData().originalFilename as string).length).toBe(255);

    mediaCreateMock.mockClear();
    await call(mediaRequest(goodBody({ filename: "  " })));
    expect(createdData().originalFilename).toBe("upload");
  });

  it("marks the link used and counts the file, in the same transaction", async () => {
    await call(mediaRequest(goodBody()));

    expect(linkUpdateMock).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: { lastUsedAt: expect.any(Date), uploadCount: { increment: 1 } },
    });
    const ops = transactionMock.mock.calls[0][0] as Array<{ op: string }>;
    expect(ops.map((op) => op.op)).toEqual(["create", "update"]);
  });
});

describe("limits", () => {
  it("allows 60 registrations an hour per IP, failing closed, before the lookup", async () => {
    await call(mediaRequest(goodBody()));
    expect(checkRateLimitMock).toHaveBeenNthCalledWith(1, {
      userId: "ip:203.0.113.9",
      route: "upload-link/media",
      limit: 60,
      windowMs: 60 * 60 * 1000,
      failClosed: true,
    });

    checkRateLimitMock.mockReset();
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 99 });
    findActiveUploadLinkMock.mockClear();
    transactionMock.mockClear();
    const response = await call(mediaRequest(goodBody()));
    expect(response.status).toBe(429);
    expect(findActiveUploadLinkMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("allows 200 files a day per link, failing closed, with the sentence", async () => {
    await call(mediaRequest(goodBody()));
    expect(checkRateLimitMock).toHaveBeenNthCalledWith(2, {
      userId: "upload-link:link-1",
      route: "upload-link/media-day",
      limit: 200,
      windowMs: 24 * 60 * 60 * 1000,
      failClosed: true,
    });

    checkRateLimitMock.mockReset();
    checkRateLimitMock
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 3600 });
    transactionMock.mockClear();
    const response = await call(mediaRequest(goodBody()));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: UPLOAD_LINK_DAILY_LIMIT_MESSAGE });
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe("the owners' email", () => {
  it("runs after the response, with the link's workspace and the sender's name", async () => {
    const response = await call(mediaRequest(goodBody({ senderName: "Ana" })));

    expect(response.status).toBe(201);
    expect(notifyOwnersOfClientUploadMock).not.toHaveBeenCalled();
    expect(afterMock).toHaveBeenCalledTimes(1);

    await afterMock.mock.calls[0][0]();
    expect(notifyOwnersOfClientUploadMock).toHaveBeenCalledWith({
      linkId: "link-1",
      workspaceId: "ws-1",
      workspaceName: "Surf Co",
      senderName: "Ana",
      now: expect.any(Date),
    });
  });

  it("does not fail the response when sending fails", async () => {
    notifyOwnersOfClientUploadMock.mockRejectedValue(new Error("resend down"));

    const response = await call(mediaRequest(goodBody()));

    expect(response.status).toBe(201);
    await expect(afterMock.mock.calls[0][0]()).resolves.toBeUndefined();
  });

  it("is not scheduled when nothing was written", async () => {
    transactionMock.mockRejectedValue(new Error("db down"));
    const response = await call(mediaRequest(goodBody()));
    expect(response.status).toBe(500);
    expect(afterMock).not.toHaveBeenCalled();
  });
});
