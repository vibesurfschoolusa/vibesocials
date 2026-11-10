import type { ComposerGate } from "./composerGate";

/**
 * A file shared to the installed app on Android (manifest `share_target`)
 * arrives as a POST that public/sw.js answers in the browser, because a video
 * is larger than the hosting platform lets a request body be. The worker
 * parks the file in Cache Storage and redirects to Create, which takes it
 * from here.
 *
 * SHARED_FILE_CACHE, SHARED_FILE_KEY and SHARED_FILE_TIME_HEADER are
 * duplicated in public/sw.js (a plain script with no imports): change them in
 * both files together.
 */
export const SHARED_FILE_CACHE = "vs-shared-file";
export const SHARED_FILE_KEY = "/shared-file";
/** When the worker stored the file, in epoch milliseconds. */
export const SHARED_FILE_TIME_HEADER = "X-Shared-At";
/**
 * A share left this long (say the user was signed out and gave up) is stale:
 * attaching it to a post made much later would surprise them. Only this side
 * reads it, so the worker does not repeat it.
 */
export const SHARED_FILE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Create takes the file only once it shows the form. While connections load,
 * fail, or none is connected, taking it would start an upload and an AI
 * caption for a form that never appears, and lose the file; left in the cache
 * with ?shared=1 kept, it is attached when the user comes back.
 */
export function shouldTakeSharedFile(sharedParam: string | null, gate: ComposerGate): boolean {
  return sharedParam === "1" && gate === "form";
}

/** Returns the shared file and removes it, or null when there is none or it is stale. */
export async function takeSharedFile(): Promise<File | null> {
  if (typeof caches === "undefined" || !caches) return null;
  try {
    const cache = await caches.open(SHARED_FILE_CACHE);
    const response = await cache.match(SHARED_FILE_KEY);
    if (!response) return null;
    await cache.delete(SHARED_FILE_KEY);

    const sharedAtHeader = response.headers.get(SHARED_FILE_TIME_HEADER);
    const sharedAt = sharedAtHeader ? Number(sharedAtHeader) : NaN;
    const age = Date.now() - sharedAt;
    if (!Number.isFinite(age) || age < 0 || age > SHARED_FILE_MAX_AGE_MS) return null;

    const blob = await response.blob();
    // A cached Response keeps no file name, so the worker sends it as a header.
    const name = decodeURIComponent(response.headers.get("X-File-Name") ?? "") || "shared-file";
    const type = response.headers.get("Content-Type") ?? blob.type;
    return new File([blob], name, { type });
  } catch {
    return null;
  }
}
