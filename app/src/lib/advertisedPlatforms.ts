import type { Platform } from "@prisma/client";

import { pinterestConfig } from "@/lib/pinterestApi";
import { PLATFORM_ORDER } from "@/lib/platforms";

/**
 * The platforms the public pages name (landing, About) and Settings offers to
 * connect: every platform a person can connect on this deployment, in the app's
 * display order. Pinterest joins once its app credentials are set
 * (lib/pinterestApi.ts): its code shipped on 2026-11-10, before Pinterest
 * approved the app. Server-side only: it reads the environment.
 */
export function advertisedPlatforms(
  env: Record<string, string | undefined> = process.env,
): readonly Platform[] {
  return pinterestConfig(env)
    ? PLATFORM_ORDER
    : PLATFORM_ORDER.filter((platform) => platform !== "pinterest");
}
