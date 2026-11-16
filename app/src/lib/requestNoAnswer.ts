/**
 * KK3 follow-up: one narrow rule for "the request never got an answer"
 * (offline, DNS, the connection dropped). Browsers reject fetch with a
 * TypeError whose text differs per browser ("Failed to fetch", "Load failed",
 * "NetworkError ..."), and our own code can throw a TypeError too, so neither
 * the type nor the text says it. Only a rejection of the fetch call itself
 * does: this wrapper marks exactly that.
 *
 * R29 OO1: so does a 5xx the page can't read (a gateway's 502/503/504 page,
 * an unhandled 500 with an empty body). It can come after the request did its
 * work, so every page words it as a lost answer, never "nothing changed". Our
 * routes' own 5xx are JSON and pass through with their sentence.
 */
export class NoAnswerError extends Error {
  /** True when an answer came but was an unreadable 5xx; `cause` is that Response. */
  readonly unreadableAnswer: boolean;

  constructor(cause: unknown, unreadableAnswer = false) {
    super("NO_ANSWER", { cause });
    this.name = "NoAnswerError";
    this.unreadableAnswer = unreadableAnswer;
  }
}

/** A 5xx is ours when it says JSON and its body parses; read from a clone so callers can still read it. */
async function isUnreadableServerError(response: Response): Promise<boolean> {
  if (response.status < 500) return false;
  try {
    if (!/application\/json/i.test(response.headers.get("content-type") ?? "")) return true;
    JSON.parse(await response.clone().text());
    return false;
  } catch {
    return true;
  }
}

/** fetch, with a rejection of the call itself, or an unreadable 5xx, thrown as NoAnswerError. */
export async function fetchOrNoAnswer(
  input: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(input, init);
  } catch (error) {
    throw new NoAnswerError(error);
  }
  if (await isUnreadableServerError(response)) throw new NoAnswerError(response, true);
  return response;
}

export function isNoAnswer(error: unknown): error is NoAnswerError {
  return error instanceof NoAnswerError;
}

/**
 * For a read: true only when the request itself got no answer (offline, the
 * connection dropped), so "check your connection" is true. An unreadable 5xx
 * came over a working connection, and a read says it couldn't load instead.
 */
export function isNoConnection(error: unknown): boolean {
  return isNoAnswer(error) && !error.unreadableAnswer;
}
