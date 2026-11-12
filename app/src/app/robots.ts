import type { MetadataRoute } from "next";

import { siteOrigin } from "@/lib/siteOrigin";

/**
 * Served at /robots.txt. The signed-in app and the API are not for search.
 * /u/, /v/ and /c/ (client links) stay crawlable on purpose: each page sends
 * `robots: { index: false }`, which a crawler only sees if it may fetch it.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/settings",
        "/posts",
        "/queue",
        "/activity",
        "/reports",
        "/media",
        "/reviews",
        "/workspaces",
        "/admin",
        "/connections",
        "/join",
      ],
    },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
