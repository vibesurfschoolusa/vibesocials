import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BlobNotFoundError, head } from "@vercel/blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The e2e blob double (e2e/support/mock-blob-server.mjs) must answer the real
 * SDK's head(): POST /api/media and POST /api/posts read a new file's size and
 * type from storage (F5), and CI's e2e post flow runs against this double.
 * Kept under src/ because vitest only collects src/**.
 */

const PORT = 19366;
const BASE = `http://localhost:${PORT}`;
const SERVER = fileURLToPath(new URL("../../e2e/support/mock-blob-server.mjs", import.meta.url));

let child: ChildProcess;
const saved = {
  api: process.env.VERCEL_BLOB_API_URL,
  token: process.env.BLOB_READ_WRITE_TOKEN,
  retries: process.env.VERCEL_BLOB_RETRIES,
};

beforeAll(async () => {
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, E2E_BLOB_PORT: String(PORT) }, stdio: "pipe" });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) resolve();
    });
    child.on("error", reject);
  });
  process.env.VERCEL_BLOB_API_URL = BASE;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_e2eteststore_e2etestsecrettoken0123456789";
  // A wrong answer fails at once instead of being retried ten times.
  process.env.VERCEL_BLOB_RETRIES = "0";
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterAll(() => {
  child?.kill();
  restore("VERCEL_BLOB_API_URL", saved.api);
  restore("BLOB_READ_WRITE_TOKEN", saved.token);
  restore("VERCEL_BLOB_RETRIES", saved.retries);
});

describe("the e2e mock blob server answers head()", () => {
  it("with the stored file's size, type, pathname and address", async () => {
    const pathname = "1731600000000-ab12cd34-cat.png";
    const body = Buffer.alloc(1234, 7);
    const put = await fetch(`${BASE}/?pathname=${pathname}`, {
      method: "PUT",
      headers: { "x-content-type": "image/png" },
      body,
    });
    const { url } = (await put.json()) as { url: string };

    const stored = await head(url);

    expect(stored).toMatchObject({ url, pathname, size: 1234, contentType: "image/png" });
    expect(stored.uploadedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(stored.uploadedAt.getTime())).toBe(false);
  });

  it("with the SDK's not-found error for a file it does not have", async () => {
    await expect(head(`${BASE}/never-uploaded.png`)).rejects.toBeInstanceOf(BlobNotFoundError);
  });
});
