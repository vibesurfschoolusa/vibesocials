/**
 * A file shared to the installed app on Android (manifest `share_target`)
 * arrives as a POST that public/sw.js answers in the browser, because a video
 * is larger than the hosting platform lets a request body be. The worker
 * parks the file in Cache Storage and redirects to Create, which takes it
 * from here.
 *
 * These two strings are duplicated in public/sw.js (a plain script with no
 * imports): change them in both files together.
 */
export const SHARED_FILE_CACHE = "vs-shared-file";
export const SHARED_FILE_KEY = "/shared-file";

/** Returns the shared file and removes it, or null when there is none. */
export async function takeSharedFile(): Promise<File | null> {
  if (typeof caches === "undefined" || !caches) return null;
  try {
    const cache = await caches.open(SHARED_FILE_CACHE);
    const response = await cache.match(SHARED_FILE_KEY);
    if (!response) return null;
    await cache.delete(SHARED_FILE_KEY);
    const blob = await response.blob();
    // A cached Response keeps no file name, so the worker sends it as a header.
    const name = decodeURIComponent(response.headers.get("X-File-Name") ?? "") || "shared-file";
    const type = response.headers.get("Content-Type") ?? blob.type;
    return new File([blob], name, { type });
  } catch {
    return null;
  }
}
