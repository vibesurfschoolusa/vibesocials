/**
 * UI audit: a file store double for the screenshot run (never merged).
 *
 * Same idea as e2e/support/mock-blob-server.mjs, plus the two things the audit
 * needs that it lacks:
 *
 * - `head()`: @vercel/blob's head() asks `GET <api>/?url=<blob url>`. The
 *   client upload link (/u/<token>) checks every file this way before it
 *   registers it, so without this no upload through a link can finish.
 * - Client upload link files get the address the real store would give them
 *   (`https://<store>.public.blob.vercel-storage.com/ul/...`), because the
 *   app accepts only its own store's host for those (lib/uploadLink.ts). The
 *   browser in the audit is pointed back here for that host (see camera.ts);
 *   nothing is sent to the real store.
 *
 * Everything else is served from http://localhost:<port>/<pathname>, like the
 * e2e double. The spec also PUTs its generated photos and video here before it
 * seeds the rows that point at them.
 *
 * Port: E2E_BLOB_PORT (default 9366). Store id: the 4th part of
 * BLOB_READ_WRITE_TOKEN, as the app reads it (lib/blobUrl.ts).
 */

import { createServer } from "node:http";

const PORT = Number(process.env.E2E_BLOB_PORT ?? 9366);
const STORE_ID = (process.env.BLOB_READ_WRITE_TOKEN ?? "").split("_")[3]?.toLowerCase() || "e2eteststore";
const STORE_HOST = `${STORE_ID}.public.blob.vercel-storage.com`;

/** pathname -> { body, contentType, uploadedAt } */
const blobs = new Map();

function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function publicUrlFor(pathname) {
  // Upload link files live under ul/<link id>/ and must carry the store's own host.
  if (pathname.startsWith("ul/")) return `https://${STORE_HOST}/${encodeURI(pathname)}`;
  return `http://localhost:${PORT}/${encodeURI(pathname)}`;
}

function describe(pathname, stored) {
  const url = publicUrlFor(pathname);
  return {
    url,
    downloadUrl: `${url}?download=1`,
    pathname,
    size: stored.body.byteLength,
    contentType: stored.contentType,
    contentDisposition: `inline; filename="${pathname.split("/").pop()}"`,
    cacheControl: "public, max-age=31536000",
    uploadedAt: stored.uploadedAt,
    etag: `"${stored.body.byteLength}-mock"`,
  };
}

function pathnameOfBlobUrl(raw) {
  try {
    return decodeURIComponent(new URL(raw).pathname.replace(/^\/+/, ""));
  } catch {
    return raw.replace(/^\/+/, "");
  }
}

const server = createServer(async (req, res) => {
  try {
    applyCors(req, res);
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "PUT") {
      const pathname = url.searchParams.get("pathname") ?? url.pathname.replace(/^\/+/, "");
      const body = await readBody(req);
      const contentType = req.headers["x-content-type"] || req.headers["content-type"] || "application/octet-stream";
      const stored = { body, contentType: String(contentType), uploadedAt: new Date().toISOString() };
      blobs.set(pathname, stored);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(describe(pathname, stored)));
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      // head(): GET /?url=<blob url>
      const asked = url.pathname === "/" ? url.searchParams.get("url") : null;
      if (asked !== null) {
        const pathname = pathnameOfBlobUrl(asked);
        const stored = blobs.get(pathname);
        if (!stored) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "not_found", message: "The requested blob does not exist" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(describe(pathname, stored)));
        return;
      }
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      const stored = blobs.get(key);
      if (!stored) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": stored.contentType,
        "Content-Length": String(stored.body.byteLength),
        "Accept-Ranges": "none",
      });
      res.end(req.method === "HEAD" ? undefined : stored.body);
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method not allowed");
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Mock blob server error: ${error?.message ?? error}`);
  }
});

server.listen(PORT, () => {
  console.log(`[ui-audit mock-blob-server] listening on http://localhost:${PORT} (store host ${STORE_HOST})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
