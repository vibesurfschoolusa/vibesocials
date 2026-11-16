import { NextResponse } from "next/server";
import type { Platform } from "@prisma/client";

import { providerErrorSuffix } from "@/lib/oauthResult";

/**
 * R30 (platform-clients L1, lead review): the one way an OAuth start or
 * callback route sends the browser to Settings with an ?error= code. Settings
 * words the row's button from the platform the code names
 * (lib/oauthResult.ts), so the code always starts with it, and only a short,
 * plain code is passed on (a provider's own value included). The guard
 * app/api/auth/oauthErrorCodes.test.ts fails on a route that builds the query
 * any other way.
 */
export function oauthErrorRedirect(platform: Platform, code: string, base: string | URL | undefined): NextResponse {
  const url = new URL("/settings", base);
  url.searchParams.set("error", `${platform}_${providerErrorSuffix(code)}`);
  return NextResponse.redirect(url);
}
