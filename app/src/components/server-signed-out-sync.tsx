"use client";

import { useRouter } from "next/navigation";

import { useFollowSignedOutServer } from "./signed-in-swap";

/**
 * R19 new-customer L1: placed beside a page the server rendered for nobody
 * signed in ("/"'s Landing). A tab whose cached session still names someone
 * (read before a password change elsewhere) follows the server: it signs out,
 * or refreshes once if the server's page only saw a blip. Renders nothing, so
 * the signed-out HTML is unchanged.
 */
export function ServerSignedOutSync() {
  const router = useRouter();
  useFollowSignedOutServer(router.refresh);
  return null;
}
