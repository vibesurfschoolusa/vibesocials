"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";

/**
 * Fix round 1, F4: emails show times in the recipient's own zone, which only
 * their browser knows. Once signed in, this sends Intl's zone to
 * POST /api/me/time-zone, and only when it differs from the zone this browser
 * last sent for this person, so it is one small request per person, browser
 * and zone. Renders nothing; a failure just leaves emails in UTC.
 */

type ZoneStorage = Pick<Storage, "getItem" | "setItem">;

export function sentTimeZoneKey(userId: string): string {
  return `vs_time_zone_sent:${userId}`;
}

/** The zone to send now, or null when there is none or it was already sent. */
export function timeZoneToSend(current: string | null, lastSent: string | null): string | null {
  if (!current) return null;
  return current === lastSent ? null : current;
}

/** Null when nothing was sent yet or storage is blocked (private window, cleared data). */
export function readSentTimeZone(storage: ZoneStorage, userId: string): string | null {
  try {
    return storage.getItem(sentTimeZoneKey(userId));
  } catch {
    return null;
  }
}

export function writeSentTimeZone(storage: ZoneStorage, userId: string, zone: string): void {
  try {
    storage.setItem(sentTimeZoneKey(userId), zone);
  } catch {
    // Without storage the zone is sent again next visit; the route writes nothing for the same zone.
  }
}

export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function localStorageOrNull(): ZoneStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function TimeZoneSync() {
  const { status, data } = useSession();
  const userId = (data?.user as { id?: string } | undefined)?.id ?? null;

  useEffect(() => {
    if (status !== "authenticated" || !userId) return;
    const storage = localStorageOrNull();
    const zone = timeZoneToSend(browserTimeZone(), storage ? readSentTimeZone(storage, userId) : null);
    if (!zone) return;
    fetch("/api/me/time-zone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeZone: zone }),
    })
      .then((response) => {
        if (response.ok && storage) writeSentTimeZone(storage, userId, zone);
      })
      .catch(() => {});
  }, [status, userId]);

  return null;
}
