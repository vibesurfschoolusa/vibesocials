import type { ConnectionStatus } from "./connectionsDto";

export type ComposerGate = "loading" | "connect" | "form";

/**
 * Decides what the composer renders while `useConnections` is in flight,
 * resolved, or failed.
 *
 * - `loading`  — first fetch still in flight (no data yet): show a skeleton.
 *   Rendering the full form here lets the user attach a file that a later
 *   zero-connection resolution silently discards (the early-return unmounts
 *   the media input mid-compose).
 * - `connect`  — resolved with zero connected platforms: show the connect CTA.
 * - `form`     — at least one connected platform, OR the fetch failed
 *   (`connections` null with loading false). The failure fallback is
 *   deliberate: gating on resolved data alone parks a skeleton on screen
 *   forever when a fetch fails (see the reviews-view lesson), and the form is
 *   the blind-safe default.
 *
 * Resolved data wins over `loading` so a refetch never blanks content the
 * user is already working with.
 */
export function deriveComposerGate(
  connections: ConnectionStatus[] | null,
  loading: boolean,
): ComposerGate {
  if (connections !== null) {
    return connections.some((c) => c.connected) ? "form" : "connect";
  }
  return loading ? "loading" : "form";
}
