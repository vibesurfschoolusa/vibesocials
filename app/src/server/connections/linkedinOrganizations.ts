import { LINKEDIN_REST_BASE_URL, linkedinRestHeaders } from "@/lib/linkedinApi";

import type { LinkedInOrganization } from "./saveConnection";

/**
 * The company pages a LinkedIn member administers, read through LinkedIn's
 * versioned REST APIs (lib/linkedinApi.ts sets the version) for the OAuth
 * callback (app/api/auth/linkedin/callback/route.ts).
 *
 * - Which pages: `GET /rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`,
 *   paged with `start`/`count` as the page's pagination sample shows
 *   (https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role).
 *   The page's samples name the page's URN `organization` in one answer and
 *   `organizationTarget` in another, so both are read.
 * - Their names: `GET /rest/organizations/{id}`, one page at a time, and
 *   `GET /rest/organizations?q=vanityName&vanityName=...` for the setup hint
 *   (https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api).
 *   Never the batch `ids=List(...)` form: a Development-tier app may not
 *   BATCH_GET. The page documents no projection that would put the names on the
 *   access-control answer itself.
 *
 * Every function here answers null (or what it found so far) instead of
 * throwing: the callback falls back to its next strategy, as it always has.
 * Logs carry statuses and ids only, never the token.
 */

/** Entries per organizationAcls page: the count of the page's pagination sample. */
export const LINKEDIN_ACL_PAGE_SIZE = 10;

/** Pages of organizationAcls read at most: 100 company pages, at one call per page. */
export const LINKEDIN_ACL_MAX_PAGES = 10;

/**
 * `urn:li:organization:{id}`; `urn:li:organizationBrand:{id}` is "mapped to
 * urn:li:organization" by LinkedIn (organization-lookup-api), so it counts too.
 */
const ORGANIZATION_URN = /^urn:li:organization(?:Brand)?:(\d+)$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The numeric ids of the pages in one organizationAcls answer, in order and
 * without repeats. An entry is skipped when it names no organization URN, or
 * when its `role` / `state` is present and is not ADMINISTRATOR / APPROVED (the
 * query asks for exactly those; this only guards against an answer that ignored
 * the filter).
 */
export function organizationIdsFromAcls(body: unknown): string[] {
  const elements = asRecord(body)?.elements;
  if (!Array.isArray(elements)) return [];
  const ids: string[] = [];
  for (const raw of elements) {
    const element = asRecord(raw);
    if (!element) continue;
    if (element.role !== undefined && element.role !== "ADMINISTRATOR") continue;
    if (element.state !== undefined && element.state !== "APPROVED") continue;
    const urn = nonEmptyString(element.organization) ?? nonEmptyString(element.organizationTarget);
    const id = urn ? ORGANIZATION_URN.exec(urn)?.[1] : undefined;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Does this organizationAcls answer link a next page (`paging.links[].rel === "next"`)? */
function hasNextPage(body: unknown): boolean {
  const links = asRecord(asRecord(body)?.paging)?.links;
  return Array.isArray(links) && links.some((link) => asRecord(link)?.rel === "next");
}

/** What the lookups read of an organization: its id, and its name and vanity name when it has them. */
export interface LinkedInOrganizationDetails {
  id: string;
  name?: string;
  vanityName?: string;
}

function readOrganization(raw: unknown, fallbackId?: string): LinkedInOrganizationDetails | null {
  const org = asRecord(raw);
  if (!org) return null;
  const rawId = org.id;
  const id =
    typeof rawId === "number" && Number.isSafeInteger(rawId)
      ? String(rawId)
      : (nonEmptyString(rawId) ?? fallbackId);
  if (!id) return null;
  // `localizedName` is the name as a string; `name` is a MultiLocaleString object.
  const name = nonEmptyString(org.localizedName);
  const vanityName = nonEmptyString(org.vanityName);
  return { id, ...(name ? { name } : {}), ...(vanityName ? { vanityName } : {}) };
}

/** What is logged of an error: its name and code only (a JSON parse error quotes the text it choked on). */
function errorKind(error: unknown): { name?: string; code?: unknown } {
  return { name: (error as Error | null)?.name, code: (error as { code?: unknown } | null)?.code };
}

/** `GET /rest/organizations/{id}`: the page's details, or null when LinkedIn refuses or the call fails. */
export async function lookupOrganization(
  accessToken: string,
  id: string,
): Promise<LinkedInOrganizationDetails | null> {
  try {
    const response = await fetch(`${LINKEDIN_REST_BASE_URL}/organizations/${encodeURIComponent(id)}`, {
      headers: linkedinRestHeaders(accessToken),
    });
    if (!response.ok) {
      console.log("[LinkedIn OAuth] Organization lookup failed", { orgId: id, status: response.status });
      return null;
    }
    return readOrganization(await response.json(), id);
  } catch (error) {
    console.log("[LinkedIn OAuth] Organization lookup error", { orgId: id, ...errorKind(error) });
    return null;
  }
}

/** `GET /rest/organizations?q=vanityName&vanityName=...`: the first page it finds, or null. */
export async function lookupOrganizationByVanityName(
  accessToken: string,
  vanityName: string,
): Promise<LinkedInOrganizationDetails | null> {
  try {
    const response = await fetch(
      `${LINKEDIN_REST_BASE_URL}/organizations?q=vanityName&vanityName=${encodeURIComponent(vanityName)}`,
      { headers: linkedinRestHeaders(accessToken) },
    );
    if (!response.ok) {
      console.log("[LinkedIn OAuth] Vanity name lookup failed", { status: response.status });
      return null;
    }
    const elements = asRecord(await response.json())?.elements;
    return Array.isArray(elements) ? readOrganization(elements[0]) : null;
  } catch (error) {
    console.log("[LinkedIn OAuth] Vanity name lookup error", errorKind(error));
    return null;
  }
}

/**
 * The pages the member is an approved ADMINISTRATOR of, each with its name and
 * vanity name when `GET /rest/organizations/{id}` gives them (a page whose
 * lookup fails is kept with its id only: the access-control answer already
 * says the member administers it). Null when the very first organizationAcls
 * call fails; a later page that fails ends the list there.
 */
export async function findAdministeredOrganizations(accessToken: string): Promise<LinkedInOrganization[] | null> {
  const ids: string[] = [];
  let start = 0;
  try {
    for (let page = 0; page < LINKEDIN_ACL_MAX_PAGES; page += 1) {
      const response = await fetch(
        `${LINKEDIN_REST_BASE_URL}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED` +
          `&start=${start}&count=${LINKEDIN_ACL_PAGE_SIZE}`,
        { headers: linkedinRestHeaders(accessToken) },
      );
      if (!response.ok) {
        console.log("[LinkedIn OAuth] organizationAcls failed", { status: response.status, page });
        if (page === 0) return null;
        break;
      }
      const body: unknown = await response.json();
      for (const id of organizationIdsFromAcls(body)) if (!ids.includes(id)) ids.push(id);
      const elements = asRecord(body)?.elements;
      const count = Array.isArray(elements) ? elements.length : 0;
      if (count === 0 || !hasNextPage(body)) break;
      start += count;
    }
  } catch (error) {
    console.log("[LinkedIn OAuth] organizationAcls error", errorKind(error));
    if (ids.length === 0) return null;
  }

  const organizations: LinkedInOrganization[] = [];
  for (const id of ids) {
    const details = await lookupOrganization(accessToken, id);
    organizations.push({
      id,
      ...(details?.name ? { name: details.name } : {}),
      ...(details?.vanityName ? { vanityName: details.vanityName } : {}),
    });
  }
  return organizations;
}
