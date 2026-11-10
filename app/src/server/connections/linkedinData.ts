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

/** Refreshes or expires the stored LinkedIn page names; answers how many of each. */
export async function refreshLinkedInOrganizationProfiles(
  now: Date = new Date(),
): Promise<{ refreshed: number; cleared: number }> {
  const rows = await prisma.socialConnection.findMany({
    where: { platform: "linkedin" },
    select: { id: true, accessToken: true, expiresAt: true, metadata: true },
  });

  let refreshed = 0;
  let cleared = 0;
  for (const row of rows) {
    const metadata = (row.metadata ?? {}) as LinkedInConnectionMetadata;
    const organizations = metadata.organizations ?? [];
    const page = organizations[0];
    if (!page?.id) continue;

    const tokenWorks = !row.expiresAt || row.expiresAt.getTime() > now.getTime();
    const details = tokenWorks ? await lookupOrganization(row.accessToken, page.id) : null;
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
    }
  }
  return { refreshed, cleared };
}
