/**
 * R29 (client-journey L3 and the lead's follow-up): a waiting account choice
 * is deleted once used, so afterwards only the page knows which platform it
 * was for. The page keeps it for this tab and sends it as `?platform=`, so
 * the choice routes can say the platform is connected, or name the button
 * its row shows, instead of "Connect again". A convenience only: without
 * storage the routes answer a sentence that names no button.
 */

function key(pendingId: string): string {
  return `vs-connect-choice:${pendingId}`;
}

export function rememberedChoicePlatform(pendingId: string): string | null {
  try {
    return window.sessionStorage.getItem(key(pendingId));
  } catch {
    return null;
  }
}

export function rememberChoicePlatform(pendingId: string, platform: string): void {
  try {
    window.sessionStorage.setItem(key(pendingId), platform);
  } catch {
    // Private mode or blocked storage: the routes' neutral sentence still reads true.
  }
}

/** The choice's address, with the platform it was for once known. */
export function choiceAddress(base: string, platform: string | null): string {
  return platform ? `${base}?platform=${encodeURIComponent(platform)}` : base;
}
