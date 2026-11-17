import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";

import { lookupOrganization } from "./linkedinOrganizations";
import type { LinkedInOrganization } from "./saveConnection";

/**
 * LinkedIn Marketing API data storage requirements (2026-11-09, for the
 * Community Management API review):
 * https://learn.microsoft.com/en-us/linkedin/marketing/data-storage-requirements
 *
 * The app keeps, per LinkedIn connection, the connected page's id (an
 * organization ID: no time limit) and its name and vanity name ("Organization
 * Profile Data": at most eight weeks for an organization that authenticated
 * into the app). Posts are created by the app and stored as URNs (no limit).
 *
 * So once a day this re-reads each connected page's name while the member's
 * token works (GET /rest/organizations/{id}), recording when; and it deletes
 * the name and vanity name eight weeks after the last successful read, keeping
 * the id the client posts to. Disconnecting deletes the whole connection.
 */

/** Organization profile data not re-read for this long is deleted: eight weeks. */
export const LINKEDIN_ORG_PROFILE_MAX_AGE_MS = 56 * 24 * 60 * 60 * 1000;

interface LinkedInConnectionMetadata {
  organizations?: LinkedInOrganization[];
  username?: string | null;
  /** When the page's name was last read from LinkedIn (ISO); set by saveLinkedInConnection too. */
  organizationsFetchedAt?: string | null;
  /** When the daily refresh last asked LinkedIn for it (ISO), whatever the answer. */
  organizationsTriedAt?: string | null;
  [key: string]: unknown;
}

function hasProfileData(metadata: LinkedInConnectionMetadata): boolean {
  return (
    Boolean(metadata.username) ||
    (metadata.organizations ?? []).some((org) => Boolean(org.name) || Boolean(org.vanityName))
  );
}

async function saveMetadata(id: string, metadata: LinkedInConnectionMetadata): Promise<void> {
  await prisma.socialConnection.update({
    where: { id },
    data: { metadata: metadata as unknown as Prisma.InputJsonValue },
  });
}

/**
 * R35 platform-clients L1: LinkedIn lookups a run makes at most, and the time
 * after which it makes no more, as backfillGbpLocationTitles, so the sweep step
 * stays far inside Vercel's 300 s. Rows not reached come first the next day.
 */
export const LINKEDIN_ORG_REFRESH_MAX_PER_RUN = 25;
export const LINKEDIN_ORG_REFRESH_BUDGET_MS = 120_000;

/**
 * Lead review (R35): the later of last tried and last read. A lookup that
 * keeps failing records its try, so it goes behind the rows not tried since,
 * instead of taking the whole cap every day. Never tried nor read sorts first.
 */
function lastTouchedAt(metadata: LinkedInConnectionMetadata): number {
  const times = [metadata.organizationsTriedAt, metadata.organizationsFetchedAt]
    .map((value) => Date.parse(value ?? ""))
    .filter((time) => !Number.isNaN(time));
  return times.length > 0 ? Math.max(...times) : Number.NEGATIVE_INFINITY;
}

/** Oldest touched first; ties by id, so the order never depends on the database's. */
function byLastTouched(
  a: { id: string; touchedAt: number },
  b: { id: string; touchedAt: number },
): number {
  if (a.touchedAt !== b.touchedAt) return a.touchedAt < b.touchedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Refreshes or expires the stored LinkedIn page names; answers how many of each. */
export async function refreshLinkedInOrganizationProfiles(
  now: Date = new Date(),
  clock: () => number = Date.now,
): Promise<{ refreshed: number; cleared: number }> {
  const startedAt = clock();
  const found = await prisma.socialConnection.findMany({
    where: { platform: "linkedin" },
    select: { id: true, accessToken: true, expiresAt: true, metadata: true },
  });
  // The times are inside the JSON metadata, so the order is set here.
  const rows = found
    .map((row) => {
      const metadata = (row.metadata ?? {}) as LinkedInConnectionMetadata;
      return { row, metadata, id: row.id, touchedAt: lastTouchedAt(metadata) };
    })
    .sort(byLastTouched);

  let refreshed = 0;
  let cleared = 0;
  let attempted = 0;
  for (const { row, metadata: found } of rows) {
    const organizations = found.organizations ?? [];
    const page = organizations[0];
    if (!page?.id) continue;

    const tokenWorks = !row.expiresAt || row.expiresAt.getTime() > now.getTime();
    // Past the cap or the budget, no LinkedIn call; the eight-week clean-up below still runs.
    const mayLookUp =
      tokenWorks &&
      attempted < LINKEDIN_ORG_REFRESH_MAX_PER_RUN &&
      clock() - startedAt <= LINKEDIN_ORG_REFRESH_BUDGET_MS;
    if (mayLookUp) attempted += 1;
    // A failed or timed-out lookup answers null: only the try is recorded, the
    // name is left; only the eight-week rule below may clear it.
    const details = mayLookUp ? await lookupOrganization(row.accessToken, page.id) : null;
    const metadata: LinkedInConnectionMetadata = mayLookUp
      ? { ...found, organizationsTriedAt: now.toISOString() }
      : found;
    if (details) {
      const fresh: LinkedInOrganization = {
        id: page.id,
        ...(details.name ? { name: details.name } : {}),
        ...(details.vanityName ? { vanityName: details.vanityName } : {}),
      };
      await saveMetadata(row.id, {
        ...metadata,
        organizations: [fresh, ...organizations.slice(1)],
        username: details.name ?? null,
        organizationsFetchedAt: now.toISOString(),
      });
      refreshed += 1;
      continue;
    }

    const readAt = Date.parse(metadata.organizationsFetchedAt ?? "");
    const stale = Number.isNaN(readAt) || now.getTime() - readAt > LINKEDIN_ORG_PROFILE_MAX_AGE_MS;
    if (stale && hasProfileData(metadata)) {
      await saveMetadata(row.id, {
        ...metadata,
        organizations: organizations.map((org) => ({ id: org.id })),
        username: null,
        organizationsFetchedAt: null,
      });
      cleared += 1;
    } else if (mayLookUp) {
      await saveMetadata(row.id, metadata);
    }
  }
  return { refreshed, cleared };
}
