/**
 * Test-only: the string redaction as main had it before round 46 (a723e17),
 * so a comparison test can assert that nothing main redacted reaches the
 * output now. Not used by the app.
 */

const LINK_TOKEN_PATH =
  /(^|\s|\/\/[^/\s?#]+)(\/(?:c|u|v|join|api\/(?:connect-link|review-link|upload-link|invites))\/)[^/?#\s]+/g;
const URL_FRAGMENT = /((?:https?:\/\/|\/)[^\s#]*)#\S*/gi;
const QUERY_VALUE = /([?&][^=&#\s]+=)([^&#\s]*)/g;
const DECODED_QUERY_VALUE = /([?&][^=&#\s]+=)([^&#]*)/g;
const TOKEN_SEGMENT = /(\["token",")[^"]*"/g;
const BARE_QUERY = /^[^\s/?#=&]+=[^\s#]*$/;

function linkPaths(text: string): string {
  return text
    .replace(LINK_TOKEN_PATH, (_match, before: string, prefix: string) => `${before}${prefix}[token]`)
    .replace(TOKEN_SEGMENT, `$1[token]"`);
}

function queryValues(text: string, pattern: RegExp = QUERY_VALUE): string {
  return text.replace(pattern, (match, name: string, value: string) => (value === "" ? match : `${name}[Filtered]`));
}

function linkTokens(text: string, pattern: RegExp = QUERY_VALUE): string {
  return linkPaths(queryValues(text.replace(URL_FRAGMENT, "$1"), pattern));
}

/** main's redactString. */
export function mainRedactString(text: string): string {
  if (BARE_QUERY.test(text)) return queryValues(`?${text}`).slice(1);
  const redacted = linkTokens(text);
  if (!redacted.includes("%")) return redacted;
  let decoded: string;
  try {
    decoded = decodeURIComponent(redacted);
  } catch {
    return redacted;
  }
  if (decoded === redacted) return redacted;
  const decodedRedacted = linkTokens(decoded, DECODED_QUERY_VALUE);
  return decodedRedacted === decoded ? redacted : decodedRedacted;
}
