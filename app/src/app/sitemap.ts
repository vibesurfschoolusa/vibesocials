import type { MetadataRoute } from "next";

import { paymentsConfigured } from "@/lib/billing";
import { siteOrigin } from "@/lib/siteOrigin";

// Read the environment per request: /pricing is listed only while payments are
// configured, and a build-time snapshot would go stale when that changes.
export const dynamic = "force-dynamic";

/**
 * Served at /sitemap.xml: the pages a signed-out visitor can open. No
 * lastModified: the pages have no real edit date, and a build date would claim
 * a change on every release.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  const paths = ["/", "/about", "/help", "/privacy", "/terms", "/data-deletion", "/register", "/login"];
  // With payments off /pricing redirects to sign-in, so it must not be listed.
  if (paymentsConfigured()) paths.push("/pricing");
  return paths.map((path) => ({ url: `${origin}${path}` }));
}
