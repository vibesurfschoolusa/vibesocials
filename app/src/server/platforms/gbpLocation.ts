import { assertOk } from "@/lib/assertOk";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

// Server-only: resolves a Google Business Profile location resource name.
//
// Consolidates the store-code resolver duplicated in googleBusinessProfileClient.ts
// and googleReviews.ts. The two copies were logically identical; this version
// keeps the `.code`-tagged errors and fuller "Advanced settings" hint from the
// googleBusinessProfileClient.ts copy (the canonical one). googleReviews.ts is
// migrated to this helper in a later phase.

const ACCOUNT_MANAGEMENT_BASE =
  "https://mybusinessaccountmanagement.googleapis.com/v1";
const BUSINESS_INFO_BASE =
  "https://mybusinessbusinessinformation.googleapis.com/v1";

/**
 * Resolve a Google Business Profile location to its full resource name
 * (`accounts/{accountId}/locations/{locationId}`).
 *
 * Accepts either:
 * - A full resource name already starting with `accounts/` — returned as-is.
 * - A Store code (from Advanced settings) — resolved by listing the caller's
 *   accounts and searching each for a location whose `storeCode` matches.
 *
 * Throws (with `error.code` tags):
 * - `GBP_ACCOUNTS_LIST_FAILED` if the accounts list request fails.
 * - `GBP_STORE_CODE_NOT_FOUND` if no location matches the store code.
 * - `GBP_STORE_CODE_NOT_UNIQUE` if more than one location matches.
 */
export async function resolveGbpLocationName(
  accessToken: string,
  locationNameOrStoreCode: string,
): Promise<string> {
  const trimmed = locationNameOrStoreCode.trim();

  // Already a full resource name — use it as-is.
  if (trimmed.startsWith("accounts/")) {
    return trimmed;
  }

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
  } as const;

  // 1. List all accounts the user has access to.
  const accountsRes = await fetchWithTimeout(
    `${ACCOUNT_MANAGEMENT_BASE}/accounts`,
    { headers: authHeaders },
  );

  await assertOk(accountsRes, {
    code: "GBP_ACCOUNTS_LIST_FAILED",
    prefix:
      "Failed to list Google Business Profile accounts while resolving location",
  });

  const accountsJson = (await accountsRes.json()) as {
    accounts?: { name?: string }[];
  };

  const accounts = accountsJson.accounts ?? [];
  const candidates: string[] = [];

  // 2. For each account, search locations by storeCode.
  for (const account of accounts) {
    const accountName = account.name; // e.g. "accounts/123456789012345678901"
    if (!accountName) continue;

    const url = new URL(`${BUSINESS_INFO_BASE}/${accountName}/locations`);
    url.searchParams.set("readMask", "name,storeCode,title");
    url.searchParams.set("filter", `storeCode="${trimmed}"`);

    const locationsRes = await fetchWithTimeout(url, { headers: authHeaders });

    if (!locationsRes.ok) {
      // Soft failure: skip this account and keep searching the others.
      console.error("[GBP] accounts.locations.list failed for account", {
        accountName,
        status: locationsRes.status,
        statusText: locationsRes.statusText,
      });
      continue;
    }

    const locationsJson = (await locationsRes.json()) as {
      locations?: { name?: string; storeCode?: string }[];
    };

    const locations = locationsJson.locations ?? [];
    for (const loc of locations) {
      if (!loc.name) continue;
      if (loc.storeCode !== trimmed) continue;

      // loc.name is "locations/{locationId}"
      const locationId = loc.name.startsWith("locations/")
        ? loc.name.slice("locations/".length)
        : loc.name;
      const [, accountId] = accountName.split("/");
      if (!accountId) continue;

      candidates.push(`accounts/${accountId}/locations/${locationId}`);
    }
  }

  if (candidates.length === 0) {
    const error = new Error(
      "Could not find a Google Business Profile location for the given store code. Double-check the store code in Advanced settings.",
    ) as Error & { code: string };
    error.code = "GBP_STORE_CODE_NOT_FOUND";
    throw error;
  }

  if (candidates.length > 1) {
    const error = new Error(
      "Store code matched multiple Google Business Profile locations. Please specify a more precise identifier.",
    ) as Error & { code: string };
    error.code = "GBP_STORE_CODE_NOT_UNIQUE";
    throw error;
  }

  return candidates[0];
}
