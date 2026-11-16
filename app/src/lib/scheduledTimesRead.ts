import type { PostingSlot } from "./postingSlots";
import { readWorkspaceRefusalText, withWorkspaceId } from "./workspaceChanged";

/** The posting times and the times already taken, as "Next free slot" uses them. */
export type ScheduledTimes = { slots: PostingSlot[]; taken: Date[] };

/**
 * GET /api/posts/scheduled-times for the workspace the page was drawn for
 * (Create's "Next free slot", Add many's "Use my posting times"). R32
 * new-customer L3: a tab left on it after another tab switched gets
 * `{ refused }` with the shared sentence, never the other workspace's times;
 * any other failure is "error", which hides the button as before.
 */
export async function readScheduledTimes(
  workspaceId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ScheduledTimes | { refused: string } | "error"> {
  try {
    const response = await fetchImpl(withWorkspaceId("/api/posts/scheduled-times", workspaceId));
    const refused = await readWorkspaceRefusalText(response);
    if (refused) return { refused };
    if (!response.ok) return "error";
    const body = (await response.json()) as { times?: string[]; slots?: PostingSlot[] };
    return { slots: body.slots ?? [], taken: (body.times ?? []).map((time) => new Date(time)) };
  } catch {
    return "error";
  }
}
