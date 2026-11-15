import type { Platform } from "@prisma/client";

import { platformLabel } from "./platforms";

/**
 * The route answers that name a step only an owner can take (R10-client-journey
 * L1, R11-publishing L1), in one place so the member guard test
 * (app/memberOwnerSteps.guard.test.ts) checks them with the pages. `role` is
 * always the route's workspace context's.
 */
export type AnswerReader = "owner" | "member";

/** "X", "X and YouTube", "X, YouTube and Instagram". */
function platformList(platforms: readonly Platform[]): string {
  const labels = platforms.map(platformLabel);
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** POST /api/posts and Publish now with nothing connected (NO_CONNECTIONS). */
export function noConnectionsMessage(action: "create" | "publish", role: AnswerReader): string {
  if (role === "member") return "The workspace owner can connect a platform for this workspace.";
  return action === "create"
    ? "Connect at least one platform before creating a post."
    : "Connect at least one platform before publishing.";
}

/** Publish now when none of the post's chosen platforms is connected (409). */
export function nothingSentMessage(role: AnswerReader): string {
  return role === "member"
    ? "Nothing was posted: none of this post's platforms is connected. Activity shows what didn't go out; the workspace owner can reconnect it."
    : "Nothing was posted: none of this post's platforms is connected. Activity shows what to reconnect.";
}

/** Retry refused because the platform needs reconnecting first (RECONNECT_REQUIRED). */
export function retryReconnectMessage(platforms: readonly Platform[], role: AnswerReader): string {
  return role === "member"
    ? `The workspace owner can reconnect ${platformList(platforms)}; then retry.`
    : `Reconnect ${platformList(platforms)} in Settings before retrying.`;
}
