import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { META_GRAPH_BASE_URL } from "@/lib/metaGraph";

/**
 * R32 platform-clients M1: GET /me/accounts gives 25 Pages a page unless asked
 * for more, and an agency's client Page (or the one Page with an Instagram
 * account) can be further on. Both Meta connects read the list here, following
 * the `after` cursor while Graph says there is a next page, as the LinkedIn and
 * Pinterest connects follow theirs.
 */
export const META_PAGES_PAGE_SIZE = 100;
export const META_PAGES_MAX_PAGES = 10;
/** Each page's read; one that doesn't answer in time is a failed read. */
export const META_PAGES_TIMEOUT_MS = 10_000;

export type MetaPagesRead<T> =
  /** `cut`: Graph had more after {@link META_PAGES_MAX_PAGES} pages; the rest weren't read. */
  | { ok: true; pages: T[]; cut: boolean }
  /**
   * Any page failed. Never a partial list: one without the person's Page would
   * read as "you don't manage it" or "none has Instagram", which is false.
   */
  | { ok: false };

/**
 * Every Page the user token manages, with `fields`. `logTag` names the connect
 * in the logs ("[FacebookPage OAuth]"); the token is never logged.
 */
export async function listMetaPages<T>(accessToken: string, fields: string, logTag: string): Promise<MetaPagesRead<T>> {
  const pages: T[] = [];
  let after: string | null = null;
  // R32 lead review 2: a cursor Graph already sent would read the same Pages again.
  const seen = new Set<string>();

  for (let page = 0; page < META_PAGES_MAX_PAGES; page += 1) {
    const url = new URL(`${META_GRAPH_BASE_URL}/me/accounts`);
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("fields", fields);
    url.searchParams.set("limit", String(META_PAGES_PAGE_SIZE));
    if (after) url.searchParams.set("after", after);

    let response: Response;
    try {
      // The signal bounds the body too; fetchWithTimeout's own bound ends at the headers.
      response = await fetchWithTimeout(
        url.toString(),
        { signal: AbortSignal.timeout(META_PAGES_TIMEOUT_MS) },
        META_PAGES_TIMEOUT_MS,
      );
    } catch (error) {
      console.error(`${logTag} Failed to fetch pages:`, { page, error: errorKind(error) });
      return { ok: false };
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`${logTag} Failed to fetch pages:`, { status: response.status, page, error: errorText });
      return { ok: false };
    }
    const body = (await response.json().catch(() => null)) as {
      data?: unknown;
      paging?: { next?: unknown; cursors?: { after?: unknown } };
    } | null;
    if (!body || !Array.isArray(body.data)) {
      console.error(`${logTag} Failed to fetch pages: the answer has no list`, { page });
      return { ok: false };
    }
    pages.push(...(body.data as T[]));

    const cursor = body.paging?.cursors?.after;
    if (typeof body.paging?.next !== "string" || typeof cursor !== "string" || cursor === "" || seen.has(cursor)) {
      return { ok: true, pages, cut: false };
    }
    seen.add(cursor);
    after = cursor;
  }

  console.warn(`${logTag} Stopped reading Pages at the page cap`, { pages: pages.length });
  return { ok: true, pages, cut: true };
}

/** The error's code or name only: a message could quote the request URL, which holds the token. */
function errorKind(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown";
}
