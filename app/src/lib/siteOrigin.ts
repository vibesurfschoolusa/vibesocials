/**
 * The site's canonical origin for absolute links outside a request (robots.txt,
 * sitemap.xml). NEXTAUTH_URL is the origin the app already uses for every link
 * it emails or redirects to. The fallback only keeps a build without it from
 * emitting relative addresses, which crawlers reject.
 */
export function siteOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = env.NEXTAUTH_URL?.trim();
  return (raw ? raw : "https://vibesocials.wtf").replace(/\/+$/, "");
}
