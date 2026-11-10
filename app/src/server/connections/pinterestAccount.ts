import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import {
  PINTEREST_API_BASE_URL,
  parsePinterestBoards,
  type PinterestBoard,
} from "@/lib/pinterestApi";

/**
 * Reading a Pinterest account at connect time (2026-11-10): who it is
 * (GET /user_account, scope user_accounts:read) and the boards a Pin can go on
 * (GET /boards, scope boards:read). API description 5.28.0.
 */

/** Boards per request: the API's maximum page size. */
export const PINTEREST_BOARD_PAGE_SIZE = 250;
/** Pages of boards read at connect: 1,000 boards is more than the chooser can use. */
export const PINTEREST_BOARD_MAX_PAGES = 4;
const PINTEREST_CONNECT_TIMEOUT_MS = 15_000;

export interface PinterestAccount {
  id: string;
  username: string;
  /** BUSINESS or PINNER; null when Pinterest didn't say. */
  accountType: string | null;
}

function bearer(accessToken: string): { headers: Record<string, string> } {
  return { headers: { Authorization: `Bearer ${accessToken}` } };
}

/**
 * The account behind `accessToken`, or null when Pinterest answers with an
 * error or without a username (logged, never with the token). A network failure
 * throws.
 */
export async function fetchPinterestAccount(accessToken: string): Promise<PinterestAccount | null> {
  const response = await fetchWithTimeout(
    `${PINTEREST_API_BASE_URL}/user_account`,
    bearer(accessToken),
    PINTEREST_CONNECT_TIMEOUT_MS,
  );
  if (!response.ok) {
    console.error("[Pinterest OAuth] Could not read the account", { status: response.status });
    return null;
  }
  const body = (await response.json().catch(() => null)) as {
    id?: unknown;
    username?: unknown;
    account_type?: unknown;
  } | null;
  if (typeof body?.username !== "string" || body.username.trim() === "") {
    console.error("[Pinterest OAuth] The account answer has no username");
    return null;
  }
  return {
    id: typeof body.id === "string" ? body.id : "",
    username: body.username.trim(),
    accountType: typeof body.account_type === "string" ? body.account_type : null,
  };
}

/**
 * The account's boards (its own, and group boards it collaborates on), in
 * Pinterest's order, following the bookmark for up to
 * {@link PINTEREST_BOARD_MAX_PAGES} pages. Null when Pinterest refuses the first
 * page; a later page that fails ends the list with what was read.
 */
export async function listPinterestBoards(accessToken: string): Promise<PinterestBoard[] | null> {
  const boards: PinterestBoard[] = [];
  const seen = new Set<string>();
  let bookmark: string | null = null;

  for (let page = 0; page < PINTEREST_BOARD_MAX_PAGES; page++) {
    const url = new URL(`${PINTEREST_API_BASE_URL}/boards`);
    url.searchParams.set("page_size", String(PINTEREST_BOARD_PAGE_SIZE));
    if (bookmark) url.searchParams.set("bookmark", bookmark);

    const response = await fetchWithTimeout(url.toString(), bearer(accessToken), PINTEREST_CONNECT_TIMEOUT_MS);
    if (!response.ok) {
      console.error("[Pinterest OAuth] Could not list boards", { status: response.status, page });
      return page === 0 ? null : boards;
    }
    const parsed = parsePinterestBoards(await response.json().catch(() => null));
    for (const board of parsed.boards) {
      if (seen.has(board.id)) continue;
      seen.add(board.id);
      boards.push(board);
    }
    if (!parsed.bookmark) break;
    bookmark = parsed.bookmark;
  }
  return boards;
}
