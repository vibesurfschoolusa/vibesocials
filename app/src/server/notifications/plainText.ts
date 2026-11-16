/**
 * The plain-text part of a notification email, made from its HTML (fix round
 * 1, F4): some mail apps show only text, and spam filters score HTML-only mail
 * lower. The builders write a small, known set of tags, so a few rules cover
 * them: block ends become blank lines, list items get "- ", a link becomes
 * "text: address", table cells are joined by " | " with one row per line
 * (R24 pages L5), everything else is dropped and entities are decoded.
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity);
}

export function htmlToPlainText(html: string): string {
  const text = html
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, inner: string) => {
      const label = inner.replace(/<[^>]*>/g, "").trim();
      const address = decode(href);
      return label && decode(label) !== address ? `${label}: ${href}` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/t[dh]>\s*(?=<t[dh]\b)/gi, " | ")
    .replace(/<\/tr>\s*/gi, "\n")
    .replace(/<\/(p|h[1-6]|div|blockquote|ul|ol|table)>/gi, "\n\n")
    .replace(/<\/li>/gi, "")
    .replace(/<[^>]*>/g, "");

  return decode(text)
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
