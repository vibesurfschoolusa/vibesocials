import type { Platform } from "@prisma/client";

import { googleBusinessProfileClient } from "./googleBusinessProfileClient";
import { instagramClient } from "./instagramClient";
import { linkedinClient } from "./linkedinClient";
import { tiktokClient } from "./tiktokClient";
import { xClient } from "./xClient";
import { youtubeClient } from "./youtubeClient";
import { facebookPageClient } from "./facebookPageClient";
import type { PlatformClient } from "./types";

const platformClients: Record<Platform, PlatformClient> = {
  tiktok: tiktokClient,
  youtube: youtubeClient,
  x: xClient,
  linkedin: linkedinClient,
  instagram: instagramClient,
  google_business_profile: googleBusinessProfileClient,
  facebook_page: facebookPageClient,
};

export function getPlatformClient(platform: Platform): PlatformClient | null {
  return platformClients[platform] ?? null;
}
