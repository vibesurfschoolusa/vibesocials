import { textUnits, truncateUnits, type TextLink, type TextUnit } from "@/lib/truncate";

/**
 * X's own count of a post's length (fix round 1, M5), as its twitter-text
 * library counts it, without the library: X refused or cut posts that the old
 * character count said fit.
 *
 * - A code point in X's light ranges weighs 1, any other weighs 2.
 * - An emoji weighs 2, however many code points its sequence has.
 * - A link weighs 23 (X shortens every link to a t.co link), however long:
 *   http(s):// always, a bare domain when it starts with www. or its ending looks like a real one
 *   (lower case, and two letters or a broad list of generic endings: see isLinkEnding).
 */

/** X's limit on a post's weight. */
export const X_MAX_WEIGHT = 280;
/** The weight of every link: the length of X's t.co link. */
export const X_LINK_WEIGHT = 23;

const LIGHT_RANGES: readonly (readonly [number, number])[] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
// A keycap (digit, # or * + U+FE0F + U+20E3) is one emoji with no
// Extended_Pictographic code point (review fix).
const KEYCAP = /^[0-9#*]\uFE0F\u20E3$/u;

// A bare domain (no http(s)://, no www.) counts as a link when its ending looks
// like one X accepts (G1, R2 L4: X counts every valid ending, and one the old
// short list missed, like "fiu.edu", weighed less than X counts, so X refused
// the post). The rule: a letters-only ending that is either two letters (the
// shape of every country code) or in this broad list of generic endings. Other
// dotted words ("Mr.Smith", "notes.txt") are counted as characters. Counting a
// rare non-link as 23 only cuts a little early; missing a link gets the post
// refused, so the list leans wide.
const GENERIC_TLDS = new Set([
  // The original generic endings.
  "com", "net", "org", "edu", "gov", "mil", "int", "info", "biz", "name", "aero", "coop",
  "museum", "mobi", "asia", "tel", "travel", "jobs", "cat", "post",
  // Common newer ones.
  "app", "dev", "wtf", "shop", "store", "online", "site", "xyz", "club", "live", "life", "world",
  "today", "news", "media", "agency", "studio", "design", "art", "photo", "photos", "photography",
  "pics", "gallery", "video", "music", "radio", "events", "email", "link", "click", "space",
  "website", "page", "fun", "top", "vip", "one", "icu", "buzz", "lol", "cool", "rocks", "ninja",
  "guru", "expert", "team", "group", "company", "business", "services", "solutions", "consulting",
  "digital", "network", "systems", "cloud", "host", "hosting", "software", "tools", "zone",
  "center", "city", "town", "place", "land", "house", "homes", "estate", "realty", "properties",
  "rentals", "tours", "holiday", "vacations", "beach", "surf", "yoga", "fitness", "health",
  "care", "clinic", "dental", "doctor", "fit", "golf", "boats", "fish", "fishing", "camp",
  "school", "academy", "college", "university", "education", "training", "courses", "institute",
  "eco", "green", "bio", "organic", "farm", "garden", "kitchen", "recipes", "restaurant", "cafe",
  "bar", "pub", "pizza", "wine", "beer", "coffee", "menu", "food", "delivery", "market", "sale",
  "deals", "discount", "coupons", "gift", "gifts", "shopping", "fashion", "style", "clothing",
  "shoes", "jewelry", "beauty", "hair", "salon", "spa", "tattoo", "pet", "pets", "dog", "vet",
  "love", "dating", "wedding", "family", "kids", "baby", "church", "charity", "foundation", "ngo",
  "community", "social", "chat", "forum", "wiki", "help", "support", "guide", "tips", "how",
  "reviews", "press", "report", "capital", "finance", "money", "bank", "insurance", "loans",
  "credit", "tax", "law", "legal", "attorney", "lawyer", "work", "works", "careers", "sport",
  "sports", "football", "soccer", "tennis", "bike", "games", "game", "casino", "bet", "poker",
  "win", "pink", "red", "blue", "black", "gold", "plus", "best", "new", "now", "watch", "stream",
  "film", "movie", "show", "theater", "tickets", "party", "fans", "global", "earth", "africa",
  "tech", "blog", "boutique", "ltd", "inc", "llc", "llp", "gmbh",
  // Cities and regions.
  "miami", "nyc", "london", "paris", "berlin", "tokyo", "vegas", "boston", "austin", "capetown",
  "durban", "joburg", "florida", "amsterdam", "barcelona", "madrid", "quebec", "sydney",
  "melbourne",
]);

function isLinkEnding(tld: string): boolean {
  return /^[a-z]+$/.test(tld) && (tld.length === 2 || GENERIC_TLDS.has(tld));
}

function codePointWeight(codePoint: number): number {
  return LIGHT_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to) ? 1 : 2;
}

function charactersWeight(text: string): number {
  let weight = 0;
  for (const char of text) weight += codePointWeight(char.codePointAt(0)!);
  return weight;
}

/**
 * The host's last label as typed. `TextLink.tld` is lower-cased, but the case
 * matters here: real addresses are typed in lower case, while "session.So" or
 * "beach.It" is a sentence run together (G1 review), so a bare domain counts
 * only with a lower-case ending.
 */
function typedEnding(text: string): string {
  const host = text.replace(/^https?:\/\//i, "").split(/[/?#:]/, 1)[0];
  return host.slice(host.lastIndexOf(".") + 1);
}

function countsAsLink(link: TextLink, text: string): boolean {
  if (link.hasScheme || link.hasWww) return true;
  const ending = typedEnding(text);
  return ending === ending.toLowerCase() && isLinkEnding(link.tld);
}

function unitWeight(unit: TextUnit): number {
  if (unit.link) {
    return countsAsLink(unit.link, unit.text) ? X_LINK_WEIGHT : charactersWeight(unit.text);
  }
  return EMOJI.test(unit.text) || KEYCAP.test(unit.text) ? 2 : charactersWeight(unit.text);
}

/** The weight X gives `text`. */
export function xWeightedLength(text: string): number {
  return textUnits(text).reduce((sum, unit) => sum + unitWeight(unit), 0);
}

/**
 * Cut `text` to at most `max` by X's weight, with `ellipsis` when it is cut.
 * Never splits an emoji, any other character, or a link.
 */
export function truncateXWeighted(text: string, max: number, ellipsis = ""): string {
  return truncateUnits(text, max, unitWeight, ellipsis);
}
