import type { NextRequest } from "next/server";

import { GET as countForPlatform } from "../../[platform]/scheduled-count/route";

/**
 * GET /api/connections/google_business_profile/scheduled-count?workspaceId=...
 *
 * The static google_business_profile folder shadows [platform] here, and the
 * app router does not fall back from a static segment, so this path needs a
 * route of its own. It is the dynamic route with the platform fixed.
 */
export function GET(request: NextRequest) {
  return countForPlatform(request, { params: { platform: "google_business_profile" } });
}
