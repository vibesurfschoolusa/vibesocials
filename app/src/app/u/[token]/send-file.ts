import { put } from "@vercel/blob/client";

import { prepareUploadFile } from "@/lib/prepareUploadFile";

/**
 * One file through a client upload link, in the browser (2026-11-10): prepared
 * as on Create (iPhone photos converted, big photos shrunk), uploaded straight
 * to file storage at the path the server signed, then registered.
 *
 * The token is fetched here and the file sent with `put()`, not `upload()`:
 * `upload()` drops the body of a refused token request, and the client needs
 * the server's sentence (storage full, today's limit, link not active).
 */

export interface SendFileDeps {
  prepare: (file: File) => Promise<File>;
  put: (
    pathname: string,
    body: File,
    options: {
      access: "public";
      token: string;
      contentType: string;
      onUploadProgress: (event: { percentage: number }) => void;
    },
  ) => Promise<{ url: string }>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

const browserDeps: SendFileDeps = {
  prepare: (file) => prepareUploadFile(file),
  put: (pathname, body, options) => put(pathname, body, options),
  fetch: (url, init) => fetch(url, init),
};

const UPLOAD_FAILED_MESSAGE = "The upload didn't finish. Check your connection and try again.";

async function errorOf(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error ? body.error : fallback;
}

function postJson(deps: SendFileDeps, url: string, body: unknown): Promise<Response> {
  return deps.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Resolves once the file is in the library; throws an Error whose message is the sentence to show. */
export async function sendClientFile(
  input: {
    token: string;
    file: File;
    senderName: string;
    note: string;
    onProgress: (percentage: number) => void;
  },
  deps: SendFileDeps = browserDeps,
): Promise<void> {
  const prepared = await deps.prepare(input.file);
  const base = `/api/upload-link/${encodeURIComponent(input.token)}`;

  const tokenResponse = await postJson(deps, `${base}/upload`, {
    type: "blob.generate-client-token",
    payload: {
      pathname: prepared.name,
      clientPayload: JSON.stringify({ contentType: prepared.type }),
      multipart: false,
    },
  });
  if (!tokenResponse.ok) {
    throw new Error(await errorOf(tokenResponse, UPLOAD_FAILED_MESSAGE));
  }
  const issued = (await tokenResponse.json().catch(() => null)) as
    | { clientToken?: unknown; pathname?: unknown }
    | null;
  if (typeof issued?.clientToken !== "string" || typeof issued.pathname !== "string") {
    throw new Error(UPLOAD_FAILED_MESSAGE);
  }

  let blob: { url: string };
  try {
    blob = await deps.put(issued.pathname, prepared, {
      access: "public",
      token: issued.clientToken,
      contentType: prepared.type,
      onUploadProgress: (event) => input.onProgress(event.percentage),
    });
  } catch {
    throw new Error(UPLOAD_FAILED_MESSAGE);
  }

  const mediaResponse = await postJson(deps, `${base}/media`, {
    blobUrl: blob.url,
    filename: prepared.name,
    mimeType: prepared.type,
    sizeBytes: prepared.size,
    senderName: input.senderName,
    note: input.note,
  });
  if (!mediaResponse.ok) {
    throw new Error(await errorOf(mediaResponse, "Couldn't save the file. Try again."));
  }
}
