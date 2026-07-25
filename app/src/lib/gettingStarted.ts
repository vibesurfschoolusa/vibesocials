import type { ConnectionStatus } from "@/lib/connectionsDto";
import type { PostJobDTO } from "@/lib/postsDto";

/**
 * First-run onboarding state for the dashboard's "Get started" checklist.
 * Derived, never stored: a step is "done" when the underlying data proves it
 * (a connected platform exists / a post job exists), so the checklist
 * disappears on its own once the user has gotten to first value — no
 * dismissed-flag column, no localStorage.
 */
export interface GettingStartedState {
  /**
   * True once BOTH data sources have loaded. While false the checklist
   * renders nothing — a failed or in-flight fetch must never flash the
   * "you have no connections" state at a user who has plenty.
   */
  ready: boolean;
  /** ≥1 platform connected in the active workspace. */
  connectDone: boolean;
  /** ≥1 post job of any status (draft/scheduled/published/failed all count). */
  postDone: boolean;
  /** All steps done — the user has reached first value. */
  complete: boolean;
  /** Render the checklist: ready with at least one step still open. */
  show: boolean;
}

/**
 * The dashboard's single primary call to action. `kind` is a discriminator,
 * not an icon — this module stays free of React so it can be unit-tested.
 */
export interface DashboardCta {
  kind: "connect" | "compose";
  href: string;
  label: string;
}

/**
 * Pick the one primary action the dashboard should lead with.
 *
 * With nothing connected, "Create post" is a dead end — the composer can only
 * offer its own "connect a platform" CTA (see components/create-post-form.tsx)
 * — so a dashboard that leads with it steers people into a locked door.
 * Connecting is the action that actually works, so it takes the primary slot
 * until a platform exists. Composing is never removed, only demoted: the
 * "Get started" checklist and the left nav still reach it.
 *
 * Returns `null` while connections are unresolved so the caller can render
 * nothing rather than flash the wrong label and swap it a moment later.
 */
export function deriveDashboardCta(
  connections: ConnectionStatus[] | null,
): DashboardCta | null {
  if (connections === null) return null;

  const hasConnection = connections.some((connection) => connection.connected);
  return hasConnection
    ? { kind: "compose", href: "/posts/new", label: "Create post" }
    : { kind: "connect", href: "/settings", label: "Connect a platform" };
}

/**
 * Derive the checklist from the dashboard's two existing fetches
 * (`useConnections`, `usePostJobs`) — `null` means that source hasn't
 * loaded (or failed), so the checklist stays hidden rather than guessing.
 */
export function deriveGettingStarted(
  connections: ConnectionStatus[] | null,
  jobs: PostJobDTO[] | null,
): GettingStartedState {
  const ready = connections !== null && jobs !== null;
  const connectDone =
    connections?.some((connection) => connection.connected) ?? false;
  const postDone = (jobs?.length ?? 0) > 0;
  const complete = connectDone && postDone;
  return {
    ready,
    connectDone,
    postDone,
    complete,
    show: ready && !complete,
  };
}
