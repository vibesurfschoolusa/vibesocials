/**
 * R38 new-customer L1: what a person reads when a fail-closed limit couldn't
 * be checked (its store failed, so the result is marked `unavailable`). The
 * request was refused before anything was done, and a minute is usually
 * enough; it is never the route's "limit reached" sentence, since no limit
 * was reached. In its own file, free of next/server, so client pages can
 * recognise it (R39 new-customer L1).
 */
export const LIMIT_UNCHECKED_MESSAGE = "We couldn't check that just now. Nothing was changed. Try again in a minute.";
