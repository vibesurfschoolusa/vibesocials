/**
 * A request body read with a hard byte limit, shared by the logo upload and
 * the /c Connect form (R45 review L3), so neither holds an oversized body.
 */

export type BoundedBody = { ok: true; bytes: Buffer } | { ok: false; reason: "too_large" | "empty" };

/**
 * The request body, read piece by piece and given up (the stream cancelled) the
 * moment it passes `maxBytes`, so an oversized upload is never held in memory.
 * A declared Content-Length over the limit is refused before any read.
 */
export async function readBodyAtMost(request: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => {});
    return { ok: false, reason: "too_large" };
  }
  if (!request.body) return { ok: false, reason: "empty" };

  const reader = request.body.getReader();
  const pieces: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
    pieces.push(value);
  }
  if (total === 0) return { ok: false, reason: "empty" };
  return { ok: true, bytes: Buffer.concat(pieces, total) };
}
