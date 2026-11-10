// Vibe Socials service worker. Its only job is the Android share target: a
// photo or video shared to the installed app arrives as a multipart POST to
// /share-target. It cannot go to the server (the hosting platform caps request
// bodies at a few megabytes), so it is parked in Cache Storage here and the
// Create page picks it up. Nothing else is intercepted or cached.

// The same two strings as SHARED_FILE_CACHE and SHARED_FILE_KEY in
// src/lib/sharedFile.ts: change them in both files together.
const SHARED_FILE_CACHE = "vs-shared-file";
const SHARED_FILE_KEY = "/shared-file";

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
    const form = await request.formData();
    const file = form.getAll("media").find((value) => typeof value !== "string");
    const cache = await caches.open(SHARED_FILE_CACHE);
    if (file) {
      await cache.put(
        SHARED_FILE_KEY,
        new Response(file, {
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            // A cached Response keeps no file name; header values must be ASCII.
            "X-File-Name": encodeURIComponent(file.name || ""),
          },
        }),
      );
    } else {
      // A share with no file must not attach one left over from an earlier share.
      await cache.delete(SHARED_FILE_KEY);
    }
  } catch {
    // Still land on Create; it simply finds no file.
  }
  return Response.redirect(new URL("/posts/new?shared=1", self.location.origin).href, 303);
}
