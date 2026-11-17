import { fetchOrNoAnswer, isNoConnection } from "@/lib/requestNoAnswer";
import { SIGNED_OUT_ERROR } from "@/lib/signedOutMessage";
import { pageWorkspaceRefusalText, WORKSPACE_CHANGED_SAVE_MESSAGE } from "@/lib/workspaceChanged";

/**
 * R42 pages-b L1: how an owner's client-link card (the Queue's review link,
 * Settings' connect link) reads its link, by the rule the upload-link card
 * has followed since R41 L6. A failed read hid the card without a word, so an
 * owner sent to it found nothing. Now:
 * - "failed": what happened, and Retry (no connection, a 5xx, a 429, an
 *   unreadable answer; a 401 is the signed-out sentence);
 * - "changed": another tab switched workspace (409) or the page has no id;
 *   asking again gets the same answer, so the step is Reload page;
 * - "forbidden": a 403, the viewer is no longer an owner. The caller decides,
 *   since only it knows whether a member may see the card.
 */
export type ClientLinkCardRead<T> =
  | { kind: "ready"; data: T }
  | { kind: "changed"; message: string }
  | { kind: "forbidden" }
  | { kind: "failed"; message: string };

export interface ClientLinkLoadTexts {
  offline: string;
  failed: string;
}

/** The two failure sentences for a card, by its name ("client review link"). */
export function clientLinkLoadTexts(name: string): ClientLinkLoadTexts {
  return {
    offline: `We couldn't reach Vibe Socials to load the ${name}. Check your connection and try again.`,
    failed: `We couldn't load the ${name}. Try again in a moment.`,
  };
}

/** Reads a card's link; `isReady` says whether the body is one the card can show. */
export async function readClientLinkCard<T>(
  url: string,
  texts: ClientLinkLoadTexts,
  isReady: (data: unknown) => data is T,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientLinkCardRead<T>> {
  try {
    const response = await fetchOrNoAnswer(url, undefined, fetchImpl);
    const data = (await response.json().catch(() => null)) as unknown;
    const code = (data as { code?: unknown } | null)?.code;
    if (response.status === 409) {
      return { kind: "changed", message: pageWorkspaceRefusalText(code) ?? WORKSPACE_CHANGED_SAVE_MESSAGE };
    }
    const refusal = response.status === 400 ? pageWorkspaceRefusalText(code) : null;
    if (refusal) return { kind: "changed", message: refusal };
    if (response.status === 403) return { kind: "forbidden" };
    if (response.status === 401) return { kind: "failed", message: SIGNED_OUT_ERROR };
    if (!response.ok || !isReady(data)) return { kind: "failed", message: texts.failed };
    return { kind: "ready", data };
  } catch (error) {
    return { kind: "failed", message: isNoConnection(error) ? texts.offline : texts.failed };
  }
}
