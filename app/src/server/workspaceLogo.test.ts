import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { LOGO_MAX_BYTES } from "@/lib/workspaceLogo";

import { LogoRejectedError, logoBlobPath, normalizeLogo, readBodyAtMost } from "./workspaceLogo";

/** A stream that hands out `chunk`-byte pieces without end, counting how many were pulled. */
function endlessBody(chunk = 64 * 1024) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += 1;
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function streamRequest(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/workspaces/logo", {
    method: "POST",
    body: stream,
    headers,
    duplex: "half",
  } as RequestInit);
}

async function picture(width: number, height: number, format: "png" | "jpeg" = "png") {
  const image = sharp({ create: { width, height, channels: 3, background: "#e11d48" } });
  return format === "png" ? image.png().toBuffer() : image.jpeg().toBuffer();
}

describe("readBodyAtMost", () => {
  it("reads a body up to the limit", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const request = new Request("http://localhost/x", { method: "POST", body: bytes });
    const result = await readBodyAtMost(request, 3);
    expect(result).toEqual({ ok: true, bytes: Buffer.from(bytes) });
  });

  it("refuses a declared length over the limit without reading anything", async () => {
    const { stream, state } = endlessBody();
    const result = await readBodyAtMost(streamRequest(stream, { "content-length": String(LOGO_MAX_BYTES + 1) }), LOGO_MAX_BYTES);
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(state.pulled).toBe(0);
  });

  it("stops reading a body with no length as soon as it passes the limit, and cancels it", async () => {
    const { stream, state } = endlessBody(64 * 1024);
    const result = await readBodyAtMost(streamRequest(stream), LOGO_MAX_BYTES);
    expect(result).toEqual({ ok: false, reason: "too_large" });
    // 1 MB is 16 pieces of 64 KB: the 17th takes it over. The stream may pull one ahead.
    expect(state.pulled).toBeLessThanOrEqual(18);
    expect(state.cancelled).toBe(true);
  });

  it("calls an empty body empty", async () => {
    const request = new Request("http://localhost/x", { method: "POST" });
    expect(await readBodyAtMost(request, 10)).toEqual({ ok: false, reason: "empty" });
  });
});

describe("normalizeLogo", () => {
  it("fits a large picture inside 600 by 300 and re-encodes it as PNG", async () => {
    const input = await picture(1200, 900, "jpeg");
    const output = await normalizeLogo(input);
    const meta = await sharp(output).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
    expect(output.equals(input)).toBe(false);
  });

  it("never enlarges a small picture, and still re-encodes it", async () => {
    const input = await picture(120, 40);
    const output = await normalizeLogo(input);
    const meta = await sharp(output).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 120, 40]);
  });

  it("turns a picture upright from its orientation tag", async () => {
    // Orientation 6: stored 200 x 100, shown a quarter turn round, so 100 x 200
    // (which already fits inside 600 by 300).
    const input = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#000" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const meta = await sharp(await normalizeLogo(input)).metadata();
    expect([meta.width, meta.height]).toEqual([100, 200]);
  });

  it("refuses something that is not a picture", async () => {
    await expect(normalizeLogo(Buffer.from("hello, not a picture"))).rejects.toBeInstanceOf(LogoRejectedError);
  });

  it("refuses an SVG, though it could draw one", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    await expect(normalizeLogo(svg)).rejects.toThrow(/SVG/);
  });

  it("refuses a truncated PNG and a truncated JPEG", async () => {
    const png = await picture(800, 600);
    const jpeg = await picture(800, 600, "jpeg");
    await expect(normalizeLogo(png.subarray(0, Math.floor(png.length / 2)))).rejects.toBeInstanceOf(LogoRejectedError);
    await expect(normalizeLogo(jpeg.subarray(0, Math.floor(jpeg.length / 2)))).rejects.toBeInstanceOf(LogoRejectedError);
  });
});

describe("logoBlobPath", () => {
  it("is logos/<workspaceId>/<16 random hex>.png, new each time", () => {
    const a = logoBlobPath("ws-1");
    const b = logoBlobPath("ws-1");
    expect(a).toMatch(/^logos\/ws-1\/[0-9a-f]{16}\.png$/);
    expect(a).not.toBe(b);
  });
});
