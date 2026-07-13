/**
 * Health track H3 — E2E blob-store double (Task F / PR-3).
 *
 * A tiny, dependency-free Node http server that stands in for the Vercel Blob
 * storage HTTP API during the `schedule a post` E2E flow. It exists ONLY to
 * back the browser-side upload the composer performs via `@vercel/blob/client`'s
 * `upload()` (see src/components/create-post-form.tsx). Nothing here touches
 * the app's source; the redirect is env-only (see below).
 *
 * ── Why this is a faithful double, not a fake ────────────────────────────────
 * `@vercel/blob@2` reads its API base URL from an env var at call time:
 *
 *   node_modules/@vercel/blob/dist/chunk-UVSKRCEW.js
 *     function getApiUrl(pathname = "") {
 *       let baseUrl = process.env.VERCEL_BLOB_API_URL
 *                  || process.env.NEXT_PUBLIC_VERCEL_BLOB_API_URL;
 *       return `${baseUrl || defaultVercelBlobApiUrl}${pathname}`;
 *     }
 *
 * The real `upload()` runs unchanged: the browser POSTs `/api/upload` (the app's
 * real route, whose `handleUpload()` signs a client token locally from
 * BLOB_READ_WRITE_TOKEN — no network), then PUTs the file bytes to
 * `${NEXT_PUBLIC_VERCEL_BLOB_API_URL}/?pathname=<key>`. Because `upload()`
 * executes in the BROWSER, only the build-time-inlined `NEXT_PUBLIC_*` form of
 * the override reaches it — that is what playwright.config.ts threads through.
 * This server implements exactly the endpoint the SDK's `requestApi` PUT hits
 * and returns the exact JSON shape `createPutMethod` reads back
 * ({ url, downloadUrl, pathname, contentType, contentDisposition, etag }). The
 * upload genuinely succeeds and the bytes are genuinely stored and re-served on
 * GET, so nothing about the flow is faked — only the storage backend is local.
 *
 * Deliberately NOT covered: the platform-publish clients. The compose/schedule
 * flows never call them synchronously (publishing is an async Inngest function
 * that no worker runs in this harness), so there is nothing faithful to double
 * there — see e2e/README.md.
 *
 * Usage (standalone): `node e2e/support/mock-blob-server.mjs`
 * Port: E2E_BLOB_PORT (default 9366). CI starts it as a background step before
 * `npx playwright test`; see .github/workflows/ci.yml.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.E2E_BLOB_PORT ?? 9366);

/** pathname -> { body: Buffer, contentType: string } for GET re-serving. */
const blobs = new Map();

/** Permissive CORS: the browser PUTs cross-origin (app is :3000, this is :9366),
 *  and the SDK sends custom `x-api-*` / `authorization` headers, so the PUT is a
 *  "non-simple" request that triggers a preflight. Echo the requested headers so
 *  `authorization` (not covered by a bare `*`) is always allowed. */
function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, PUT, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ?? "*",
  );
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

const server = createServer(async (req, res) => {
  try {
    applyCors(req, res);
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Upload: PUT ${base}/?pathname=<key> (see SDK createPutMethod → requestApi).
    if (req.method === "PUT") {
      const pathname = url.searchParams.get("pathname") ?? url.pathname.replace(/^\/+/, "");
      const body = await readBody(req);
      const contentType =
        req.headers["x-content-type"] ||
        req.headers["content-type"] ||
        "application/octet-stream";
      blobs.set(pathname, { body, contentType });

      const publicUrl = `http://localhost:${PORT}/${encodeURI(pathname)}`;
      const payload = {
        url: publicUrl,
        downloadUrl: `${publicUrl}?download=1`,
        pathname,
        contentType,
        contentDisposition: `inline; filename="${pathname}"`,
        // The SDK reads `etag` off the response but the composer doesn't use it.
        etag: `"${Buffer.byteLength(body)}-mock"`,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    // Re-serve stored bytes so the Queue thumbnail (<img src={blob.url}>) resolves.
    if (req.method === "GET" || req.method === "HEAD") {
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

// No host arg → dual-stack bind so `localhost` (127.0.0.1 or ::1) always resolves.
server.listen(PORT, () => {
  console.log(`[mock-blob-server] listening on http://localhost:${PORT}`);
});

// Clean shutdown when the CI step / globalTeardown signals it.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
