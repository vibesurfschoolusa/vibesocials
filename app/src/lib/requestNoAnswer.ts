/**
 * KK3 follow-up: one narrow rule for "the request never got an answer"
 * (offline, DNS, the connection dropped). Browsers reject fetch with a
 * TypeError whose text differs per browser ("Failed to fetch", "Load failed",
 * "NetworkError ..."), and our own code can throw a TypeError too, so neither
 * the type nor the text says it. Only a rejection of the fetch call itself
 * does: this wrapper marks exactly that.
 */
export class NoAnswerError extends Error {
  constructor(cause: unknown) {
    super("NO_ANSWER", { cause });
    this.name = "NoAnswerError";
  }
}

/** fetch, with a rejection of the call itself thrown as NoAnswerError. */
export async function fetchOrNoAnswer(
  input: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (error) {
    throw new NoAnswerError(error);
  }
}

export function isNoAnswer(error: unknown): error is NoAnswerError {
  return error instanceof NoAnswerError;
}
