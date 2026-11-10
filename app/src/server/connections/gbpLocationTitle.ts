import type { Prisma, SocialConnection } from "@prisma/client";

import { prisma } from "@/lib/db";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { logger } from "@/lib/logger";
import { refreshConnectionToken } from "@/server/platforms/connectionRefresh";
import { resolveGbpLocationName } from "@/server/platforms/gbpLocation";
import { refreshGoogleToken } from "@/server/platforms/googleTokens";

/**
 * Naming a Business Profile connection whose location has no title (2026-11-10).
 *
 * Settings shows a Business Profile connection by its location's title
 * (lib/connectionSummary.ts), which is saved when the location is picked
 * (app/api/connections/google_business_profile/location/route.ts, 2026-11-09).
 * A location picked before that, or pasted as a resource name or store code,
 * has `metadata.locationName` but no `metadata.locationTitle`, and Settings read
 * "choose the Maps location" although one was chosen.
 *
 * Once a day (the connection-health sweep) the missing title is read from Google
 * (GET locations/{id}?readMask=title, scope business.manage, which the
 * connection already has) and saved. A row that gets its title is never read
 * again; one Google won't describe is retried the next day.
 *
 * Three guards, because this runs unattended against live connections:
 * - the title is written only if the row still names the SAME location and still
 *   has no title (the owner may pick another location while this runs);
 * - a refresh here can find the Google grant dead and flag the connection
 *   (googleTokens.ts). The owners are emailed by whoever observes that flip, so
 *   the flagged ids are returned and the sweep emails them
 *   (inngest-functions.ts), as `refresh-connection` does for its own;
 * - the work is bounded by a count and by a time budget, well inside one step.
 */

const BUSINESS_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
const GBP_TITLE_TIMEOUT_MS = 15_000;
/** Connections tried per run: the rest wait for the next day's run. */
export const GBP_TITLE_BACKFILL_MAX_PER_RUN = 25;
/** No new connection is started after this long: the step stays far inside Vercel's 300 s. */
export const GBP_TITLE_BACKFILL_BUDGET_MS = 120_000;
/** The same cap the location route applies to a title. */
const MAX_LOCATION_TITLE_LENGTH = 200;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function metadataOf(row: { metadata: unknown }): Record<string, unknown> {
  return row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : {};
}

/** The location id of `accounts/{a}/locations/{l}` or `locations/{l}`, or null. */
function locationIdOf(resourceName: string): string | null {
  const match = /(?:^|\/)locations\/([^/]+)$/.exec(resourceName);
  return match ? match[1] : null;
}

async function readLocationTitle(
  connection: SocialConnection,
  locationName: string,
  now: Date,
): Promise<string | null> {
  let current = connection;
  if (current.expiresAt && new Date(current.expiresAt).getTime() <= now.getTime()) {
    current = await refreshConnectionToken(current, (stored) => refreshGoogleToken(stored));
  }

  // A store code is resolved to its resource name first (one or more requests).
  const resourceName = await resolveGbpLocationName(current.accessToken, locationName);
  const locationId = locationIdOf(resourceName);
  if (!locationId) return null;

  const response = await fetchWithTimeout(
    `${BUSINESS_INFO_BASE}/locations/${encodeURIComponent(locationId)}?readMask=title`,
    { headers: { Authorization: `Bearer ${current.accessToken}` } },
    GBP_TITLE_TIMEOUT_MS,
  );
  if (!response.ok) {
    logger.warn("[GBP] Could not read a location's title", {
      connectionId: connection.id,
      status: response.status,
    });
    return null;
  }
  const body = (await response.json().catch(() => null)) as { title?: unknown } | null;
  return nonEmptyString(body?.title)?.slice(0, MAX_LOCATION_TITLE_LENGTH) ?? null;
}

/**
 * Saves `title` on the row, unless the row changed since it was read: another
 * location was picked, a title arrived, or the connection is gone. Merged onto
 * the metadata as it is NOW, so nothing else written meanwhile is lost.
 */
async function saveTitleIfUnchanged(id: string, locationName: string, title: string): Promise<boolean> {
  const fresh = await prisma.socialConnection.findUnique({
    where: { id },
    select: { metadata: true },
  });
  if (!fresh) return false;
  const metadata = metadataOf(fresh);
  if (nonEmptyString(metadata.locationName) !== locationName) return false;
  if (nonEmptyString(metadata.locationTitle)) return false;

  await prisma.socialConnection.update({
    where: { id },
    data: { metadata: { ...metadata, locationTitle: title } as Prisma.InputJsonValue },
  });
  return true;
}

/** Did the connection end up flagged for reconnect (by the refresh this run just tried)? */
async function isNowFlagged(id: string): Promise<boolean> {
  try {
    const row = await prisma.socialConnection.findUnique({
      where: { id },
      select: { needsReconnect: true },
    });
    return row?.needsReconnect === true;
  } catch {
    return false;
  }
}

export interface GbpTitleBackfillResult {
  /** Connections that got their location's title. */
  named: number;
  /** Connections tried without a title to show for it (retried tomorrow). */
  failed: number;
  /** Ids of connections this run found flagged for reconnect: their owners are to be emailed. */
  flagged: string[];
}

/** Saves the missing location titles. `clock` is the real clock, for the time budget. */
export async function backfillGbpLocationTitles(
  now: Date = new Date(),
  clock: () => number = Date.now,
): Promise<GbpTitleBackfillResult> {
  const startedAt = clock();
  const rows = await prisma.socialConnection.findMany({
    where: { platform: "google_business_profile", needsReconnect: false },
    // Oldest first: a row that keeps failing does not always go before the rest.
    orderBy: { updatedAt: "asc" },
  });

  let named = 0;
  let failed = 0;
  let attempted = 0;
  const flagged: string[] = [];

  for (const row of rows) {
    const metadata = metadataOf(row);
    const locationName = nonEmptyString(metadata.locationName);
    if (!locationName || nonEmptyString(metadata.locationTitle)) continue;
    if (attempted >= GBP_TITLE_BACKFILL_MAX_PER_RUN) break;
    if (clock() - startedAt > GBP_TITLE_BACKFILL_BUDGET_MS) break;
    attempted += 1;

    try {
      const title = await readLocationTitle(row, locationName, now);
      if (title && (await saveTitleIfUnchanged(row.id, locationName, title))) {
        named += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      // Best effort: the error kind only (a message could quote a URL or token).
      failed += 1;
      logger.warn("[GBP] Location title backfill failed for a connection", {
        connectionId: row.id,
        error: error instanceof Error ? error.name : "unknown",
        code: (error as { code?: unknown } | null)?.code,
      });
      // The row was not flagged when it was read: a flag now is this run's news.
      if (await isNowFlagged(row.id)) flagged.push(row.id);
    }
  }

  return { named, failed, flagged };
}
