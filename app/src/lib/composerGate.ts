import type { ConnectionStatus } from "./connectionsDto";

export type ComposerGate = "loading" | "connect" | "error" | "form";

/**
 * Decides what the composer renders while `useConnections` is in flight,
 * resolved, or failed.
 *
 * - `loading`  — first fetch still in flight (no data yet): show a skeleton.
 *   Rendering the full form here lets the user attach a file that a later
 *   zero-connection resolution silently discards (the early-return unmounts
 *   the media input mid-compose).
 * - `connect`  — resolved with zero connected platforms: show the connect CTA.
 * - `error`    — the fetch failed (`connections` null with loading false).
 *   Gating on resolved data alone parks a skeleton on screen forever when a
 *   fetch fails (see the reviews-view lesson), and — 2026-11-01 audit — the
 *   form is no safe fallback either: with no platforms known it renders empty
 *   and every submit fails "Select at least one platform". The composer shows
 *   an error with a Retry instead. A retry flips this back to `loading`.
 * - `form`     — at least one connected platform.
 *
 * Resolved data wins over `loading` and over a failed refetch, so a refetch
 * never blanks content the user is already working with.
 */
export function deriveComposerGate(
  connections: ConnectionStatus[] | null,
  loading: boolean,
): ComposerGate {
  if (connections !== null) {
    return connections.some((c) => c.connected) ? "form" : "connect";
  }
  return loading ? "loading" : "error";
}
