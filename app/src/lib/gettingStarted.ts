import type { Workspace, WorkspaceRole } from "@prisma/client";

import type { ConnectionStatus } from "@/lib/connectionsDto";
import type { PostJobDTO } from "@/lib/postsDto";
import { SETTINGS_CONNECTIONS_HREF } from "@/lib/platforms";

/**
 * First-run onboarding state for the dashboard's "Get started" checklist.
 * Derived, never stored: a step is "done" when the underlying data proves it
 * (a connected platform, a footer or brand voice saved, a post job), so the
 * checklist disappears on its own once it is all done — no dismissed-flag
 * column, no localStorage.
 */
export type GettingStartedStep = "connect" | "footer" | "voice" | "post";

/**
 * What the dashboard's server load reads from the active workspace: booleans
 * only, so the footer and brand voice text never reach the client from here.
 */
export interface WorkspaceSetup {
  role: WorkspaceRole;
  /** A company website or default hashtags, added to the end of every post. */
  footerSet: boolean;
  /** Brand voice notes or at least one example caption, read by the AI caption prompts. */
  brandVoiceSet: boolean;
  /** An upload, review or connect link not turned off. Always false for a member. */
  hasClientLink: boolean;
}

export interface GettingStartedState {
  /**
   * True once all three sources have loaded. While false nothing renders — a
   * failed or in-flight fetch must never flash the "you have no connections"
   * state at a user who has plenty.
   */
  ready: boolean;
  /**
   * The steps this person can do, in order. Connecting and the two settings
   * are owner-only (Settings shows them read-only to members), so a member
   * sees only the post step.
   */
  steps: GettingStartedStep[];
  /** ≥1 platform connected in the active workspace. */
  connectDone: boolean;
  footerDone: boolean;
  voiceDone: boolean;
  /** ≥1 post job of any status (draft/scheduled/published/failed all count). */
  postDone: boolean;
  /** Every step this person can do is done (a member also needs a connection). */
  complete: boolean;
  /** Render the checklist. */
  show: boolean;
  /** Render "Working for clients?": owners only, after the steps or once they made a client link. */
  showClients: boolean;
}

/** Stored values are already trimmed to null when empty; the trim here is belt and braces. */
const isSet = (value: string | null) => Boolean(value?.trim());

export function workspaceSetupFrom(
  workspace: Pick<Workspace, "companyWebsite" | "defaultHashtags" | "brandVoice" | "brandVoiceExamples">,
  role: WorkspaceRole,
  hasClientLink: boolean,
): WorkspaceSetup {
  return {
    role,
    footerSet: isSet(workspace.companyWebsite) || isSet(workspace.defaultHashtags),
    brandVoiceSet: isSet(workspace.brandVoice) || isSet(workspace.brandVoiceExamples),
    hasClientLink: role === "owner" && hasClientLink,
  };
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
 * The steady-state action, and the fallback when connections can't be read at
 * all: composing is safe to offer blind because the composer answers with its
 * own connect CTA if it turns out nothing is connected.
 */
export const COMPOSE_CTA: DashboardCta = {
  kind: "compose",
  href: "/posts/new",
  label: "Create post",
};

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
 * Returns `null` when connections are unresolved — either still in flight or
 * failed. The caller distinguishes those two (a skeleton while loading, the
 * COMPOSE_CTA fallback once a fetch has actually failed), because a `null`
 * that never resolves must not leave a skeleton on screen forever.
 */
export function deriveDashboardCta(
  connections: ConnectionStatus[] | null,
): DashboardCta | null {
  if (connections === null) return null;

  const hasConnection = connections.some((connection) => connection.connected);
  return hasConnection
    ? { kind: "compose", href: "/posts/new", label: "Create post" }
    : { kind: "connect", href: SETTINGS_CONNECTIONS_HREF, label: "Connect a platform" };
}

/**
 * Derive the checklist from the dashboard's two existing fetches
 * (`useConnections`, `usePostJobs`) and the page's server load of the
 * workspace (`setup`) — `null` means that source hasn't loaded (or failed),
 * so the checklist stays hidden rather than guessing.
 */
export function deriveGettingStarted(
  connections: ConnectionStatus[] | null,
  jobs: PostJobDTO[] | null,
  setup: WorkspaceSetup | null,
): GettingStartedState {
  const ready = connections !== null && jobs !== null && setup !== null;
  const isOwner = setup?.role === "owner";
  const connectDone =
    connections?.some((connection) => connection.connected) ?? false;
  const footerDone = setup?.footerSet ?? false;
  const voiceDone = setup?.brandVoiceSet ?? false;
  const postDone = (jobs?.length ?? 0) > 0;
  const steps: GettingStartedStep[] = isOwner ? ["connect", "footer", "voice", "post"] : ["post"];
  const done: Record<GettingStartedStep, boolean> = {
    connect: connectDone,
    footer: footerDone,
    voice: voiceDone,
    post: postDone,
  };
  // A member cannot connect, so with nothing connected the post step is a
  // dead end for them: the block waits until the owner has connected something.
  const complete = connectDone && steps.every((step) => done[step]);
  const show = ready && !complete && (isOwner || connectDone);
  return {
    ready,
    steps,
    connectDone,
    footerDone,
    voiceDone,
    postDone,
    complete,
    show,
    showClients: ready && isOwner && (complete || (setup?.hasClientLink ?? false)),
  };
}
