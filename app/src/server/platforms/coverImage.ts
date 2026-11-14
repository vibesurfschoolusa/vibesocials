import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { COVER_IMAGE_MAX_BYTES } from "@/lib/videoCover";

import { budgetedTimeout } from "./publishBudget";

/** A cover image is small (8 MB at most): its download and its upload get this long. */
export const COVER_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Download the post's cover image from the app's storage, or null when it
 * cannot be had in time or is over the limit. Never throws: a cover is never
 * worth failing a post over.
 */
export async function fetchCoverImage(url: string, deadline: number | undefined): Promise<Buffer | null> {
  try {
    const timeoutMs = budgetedTimeout(COVER_REQUEST_TIMEOUT_MS, deadline);
    const response = await fetchWithTimeout(url, { signal: AbortSignal.timeout(timeoutMs) }, timeoutMs);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > COVER_IMAGE_MAX_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}
