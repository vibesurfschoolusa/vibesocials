// Vibe Socials service worker. Its only job is the Android share target: a
// photo or video shared to the installed app arrives as a multipart POST to
// /share-target. It cannot go to the server (the hosting platform caps request
// bodies at a few megabytes), so it is parked in Cache Storage here and the
// Create page picks it up. Nothing else is intercepted or cached.

// The same strings as SHARED_FILE_CACHE, SHARED_FILE_KEY and
// SHARED_FILE_TIME_HEADER in src/lib/sharedFile.ts: change them in both files
// together. (The 60-minute limit lives only there; this side just stamps the time.)
const SHARED_FILE_CACHE = "vs-shared-file";
const SHARED_FILE_KEY = "/shared-file";
const SHARED_FILE_TIME_HEADER = "X-Shared-At";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "POST") return;
  if (new URL(request.url).pathname !== "/share-target") return;
  event.respondWith(receiveShare(request));
});

async function receiveShare(request) {
  try {
    // Cleared first, so a share that fails below can never deliver the
    // previous one, and a share with no file attaches nothing.
    const cache = await caches.open(SHARED_FILE_CACHE);
    await cache.delete(SHARED_FILE_KEY);
    const form = await request.formData();
    const file = form.getAll("media").find((value) => typeof value !== "string");
    if (file) {
      await cache.put(
        SHARED_FILE_KEY,
        new Response(file, {
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            // A cached Response keeps no file name; header values must be ASCII.
            "X-File-Name": encodeURIComponent(file.name || ""),
            [SHARED_FILE_TIME_HEADER]: String(Date.now()),
          },
        }),
      );
    }
  } catch {
    // Still land on Create; it simply finds no file.
  }
  return Response.redirect(new URL("/posts/new?shared=1", self.location.origin).href, 303);
}
