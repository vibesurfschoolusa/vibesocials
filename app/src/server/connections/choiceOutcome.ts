import { signInEndsSoon } from "@/lib/connectionExpiry";
import { prisma } from "@/lib/db";
import { connectedAmongCandidates } from "@/lib/differentAccount";

import { listPendingCandidates, type LoadedPendingConnection } from "./pendingConnection";
import { connectionAccountKey } from "./saveConnection";

/**
 * What the two choice routes (api/connections/pending for owners, the connect
 * link's for clients) tell after a choice from a list, kept in one place so
 * Settings and /c say the same.
 */

/**
 * R7 review 3: was the connected account one of this list's candidates? Read
 * only for a refused choice; a failed read counts as not offered.
 */
export async function connectedWasOffered(pending: LoadedPendingConnection, workspaceId: string): Promise<boolean> {
  try {
    const connected = await prisma.socialConnection.findUnique({
      where: { workspaceId_platform: { workspaceId, platform: pending.platform } },
      select: { platform: true, accountIdentifier: true, metadata: true },
    });
    return connected
      ? connectedAmongCandidates(listPendingCandidates(pending.payload), connectionAccountKey(connected))
      : false;
  } catch {
    return false;
  }
}

/**
 * R7 review 4: a LinkedIn choice whose saved sign-in still ends within the
 * warning window. The dialogs then add same_end to the success address, as
 * the LinkedIn callback does for a lone page.
 */
export function pendingSignInEndsSoon(pending: LoadedPendingConnection): boolean {
  const { payload } = pending;
  return payload.platform === "linkedin" && signInEndsSoon("linkedin", payload.token.expiresAt, payload.token.refreshToken);
}
