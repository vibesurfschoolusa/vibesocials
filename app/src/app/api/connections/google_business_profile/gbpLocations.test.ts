import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F3 review (2026-11-14): the location save checks the chosen location
 * against EVERY location the connected Google login lists, so the listing
 * must page through accounts and locations, and a Google failure must never
 * read as "not one this account manages". Google is a stubbed fetch; the
 * database and the owner gate are stand-ins.
 */

const h = vi.hoisted(() => ({
  requireOwnerContext: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
  refreshGoogle: vi.fn(),
}));
vi.mock("@/lib/workspace", () => ({ requireOwnerContext: h.requireOwnerContext }));
vi.mock("@/lib/db", () => ({ prisma: { socialConnection: { findFirst: h.findFirst, update: h.update } } }));
vi.mock("@/server/platforms/connectionRefresh", () => ({
  refreshConnectionToken: h.refresh,
  CONNECTION_RECONNECT_REQUIRED_CODE: "RECONNECT_REQUIRED",
}));
vi.mock("@/server/platforms/googleTokens", () => ({ refreshGoogleToken: h.refreshGoogle }));

import {
  GBP_RECONNECT_CODE,
  GBP_RECONNECT_MESSAGE,
  GOOGLE_NO_ANSWER_MESSAGE,
  GBP_MAX_PAGES,
  listGbpLocations,
} from "./gbpLocations";
import { POST } from "./location/route";
import { GET } from "./locations/route";

const ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";

type Page = { status?: number; body?: Record<string, unknown>; throws?: boolean };

/**
 * Google, as a map from "<path>|<pageToken or ''>" to the page it answers.
 * Unknown requests fail the test loudly.
 */
function google(pages: Record<string, Page>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const key = `${url.origin}${url.pathname}|${url.searchParams.get("pageToken") ?? ""}`;
    const page = pages[key];
    if (!page) throw new Error(`unexpected request ${key}`);
    if (page.throws) throw new TypeError("fetch failed");
    return Response.json(page.body ?? {}, { status: page.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const location = (account: number, id: number) => ({ name: `locations/${id}`, title: `Shop ${account}-${id}` });
const CONNECTION = { id: "conn-1", accessToken: "token", metadata: {} };

function save(locationName: string) {
  return POST(
    new Request("http://localhost/api/connections/google_business_profile/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-1", locationName }),
    }),
  );
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.requireOwnerContext.mockResolvedValue({ user: { id: "user-1" }, workspace: { id: "ws-1" }, role: "owner" });
  h.findFirst.mockResolvedValue(CONNECTION);
  h.update.mockImplementation(async (args: { data: { metadata: unknown } }) => ({ id: "conn-1", metadata: args.data.metadata }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listing every page", () => {
  it("25 locations over 3 pages: asks 100 a page, follows nextPageToken, and the 25th saves", async () => {
    const fetchMock = google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/1" }] } },
      [`${INFO}/accounts/1/locations|`]: {
        body: { locations: Array.from({ length: 10 }, (_, i) => location(1, i + 1)), nextPageToken: "p2" },
      },
      [`${INFO}/accounts/1/locations|p2`]: {
        body: { locations: Array.from({ length: 10 }, (_, i) => location(1, i + 11)), nextPageToken: "p3" },
      },
      [`${INFO}/accounts/1/locations|p3`]: { body: { locations: Array.from({ length: 5 }, (_, i) => location(1, i + 21)) } },
    });

    const listed = await listGbpLocations(CONNECTION as never);
    expect(listed).toMatchObject({ ok: true, complete: true });
    expect(listed.ok && listed.locations).toHaveLength(25);
    const locationCalls = fetchMock.mock.calls.map(([u]) => new URL(String(u))).filter((u) => u.pathname.endsWith("/locations"));
    expect(locationCalls.map((u) => u.searchParams.get("pageSize"))).toEqual(["100", "100", "100"]);

    const res = await save("accounts/1/locations/25");
    expect(res.status).toBe(200);
    expect(h.update.mock.calls[0][0].data.metadata.locationName).toBe("accounts/1/locations/25");
  });

  it("25 accounts over 2 pages: the last account's location saves", async () => {
    const accounts = Array.from({ length: 25 }, (_, i) => ({ name: `accounts/${i + 1}` }));
    const pages: Record<string, Page> = {
      [`${ACCOUNTS}|`]: { body: { accounts: accounts.slice(0, 20), nextPageToken: "a2" } },
      [`${ACCOUNTS}|a2`]: { body: { accounts: accounts.slice(20) } },
    };
    for (let i = 1; i <= 25; i += 1) pages[`${INFO}/accounts/${i}/locations|`] = { body: { locations: [location(i, 100 + i)] } };
    google(pages);

    const listed = await listGbpLocations(CONNECTION as never);
    expect(listed.ok && listed.locations).toHaveLength(25);

    const res = await save("accounts/25/locations/125");
    expect(res.status).toBe(200);
  });

  it("a repeating page token stops the listing instead of looping", async () => {
    const fetchMock = google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/1" }] } },
      [`${INFO}/accounts/1/locations|`]: { body: { locations: [location(1, 1)], nextPageToken: "same" } },
      [`${INFO}/accounts/1/locations|same`]: { body: { locations: [location(1, 2)], nextPageToken: "same" } },
    });

    const listed = await listGbpLocations(CONNECTION as never);

    expect(listed.ok && listed.locations.map((l) => l.resourceName)).toEqual([
      "accounts/1/locations/1",
      "accounts/1/locations/2",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it(`stops after ${50} pages of one list and says the list is not complete`, async () => {
    expect(GBP_MAX_PAGES).toBe(50);
    const pages: Record<string, Page> = { [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/1" }] } } };
    for (let i = 0; i <= 60; i += 1) {
      pages[`${INFO}/accounts/1/locations|${i === 0 ? "" : `t${i}`}`] = {
        body: { locations: [location(1, i)], nextPageToken: `t${i + 1}` },
      };
    }
    const fetchMock = google(pages);

    const listed = await listGbpLocations(CONNECTION as never);

    expect(listed).toMatchObject({ ok: true, complete: false });
    expect(fetchMock).toHaveBeenCalledTimes(1 + 50);
  });
});

describe("Google failing is not 'not one this account manages'", () => {
  it.each([
    ["a 429", { status: 429 }],
    ["a 503", { status: 503 }],
    ["a network failure", { throws: true }],
  ])("%s for one account, location not found: 503 with the plain sentence, and nothing is saved", async (_label, failure) => {
    google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/1" }, { name: "accounts/2" }] } },
      [`${INFO}/accounts/1/locations|`]: failure,
      [`${INFO}/accounts/2/locations|`]: { body: { locations: [location(2, 7)] } },
    });

    // It may be on the failed account's list, so this is not a refusal.
    const res = await save("accounts/1/locations/5");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: GOOGLE_NO_ANSWER_MESSAGE });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("one account failing, location found in an account that answered: it saves", async () => {
    google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/1" }, { name: "accounts/2" }] } },
      [`${INFO}/accounts/1/locations|`]: { status: 503 },
      [`${INFO}/accounts/2/locations|`]: { body: { locations: [location(2, 7)] } },
    });

    const res = await save("accounts/2/locations/7");

    expect(res.status).toBe(200);
    expect(h.update.mock.calls[0][0].data.metadata.locationName).toBe("accounts/2/locations/7");
  });

  it.each([
    ["a 429", { status: 429 }],
    ["a 500", { status: 500 }],
    ["a network failure", { throws: true }],
  ])("%s on the accounts list: 503 with the plain sentence, and nothing is saved", async (_label, failure) => {
    google({ [`${ACCOUNTS}|`]: failure });

    const res = await save("accounts/1/locations/5");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: GOOGLE_NO_ANSWER_MESSAGE });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("says it plainly", () => {
    expect(GOOGLE_NO_ANSWER_MESSAGE).toBe("Google didn't answer. Try again in a minute.");
  });

  it("a complete list without the location is still the 400 (isn't one this account manages)", async () => {
    google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/1" }] } },
      [`${INFO}/accounts/1/locations|`]: { body: { locations: [location(1, 1)] } },
    });

    const res = await save("accounts/1/locations/9");

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^That location isn't one this Google account manages\./);
    expect(h.update).not.toHaveBeenCalled();
  });
});

// R24 platform-clients L1: a grant Google has revoked gave the picker "Failed to
// list Google Business Profile accounts" and no next step. Both routes now say
// to reconnect, with a code the form tells apart, as the Reviews routes do.
describe("a revoked grant: reconnect, from the picker and the save", () => {
  const RECONNECT_BODY = { error: GBP_RECONNECT_MESSAGE, code: GBP_RECONNECT_CODE };
  const invalidGrant = () =>
    Object.assign(new Error("Google token refresh failed"), {
      code: "GOOGLE_TOKEN_REFRESH_FAILED",
      status: 400,
      oauthError: "invalid_grant",
    });

  /** Google answering one request after another, in order. */
  function googleInTurn(...answers: Page[]) {
    const fetchMock = vi.fn(async () => {
      const page = answers.shift();
      if (!page) throw new Error("unexpected request");
      if (page.throws) throw new TypeError("fetch failed");
      return Response.json(page.body ?? {}, { status: page.status ?? 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const routes: Array<[string, () => Promise<Response>]> = [
    ["GET .../locations", () => GET()],
    ["POST .../location", () => save("accounts/1/locations/1")],
  ];

  it("says it plainly", () => {
    expect(GBP_RECONNECT_MESSAGE).toBe("Reconnect Google Business Profile in Settings, then try again.");
    expect(GBP_RECONNECT_CODE).toBe("RECONNECT_REQUIRED");
  });

  it.each(routes)("%s: a flagged row says reconnect without asking Google", async (_label, call) => {
    h.findFirst.mockResolvedValue({ ...CONNECTION, needsReconnect: true });
    const fetchMock = googleInTurn();

    const res = await call();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual(RECONNECT_BODY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each(routes)("%s: a 401 whose refresh Google refuses (invalid_grant) says reconnect", async (_label, call) => {
    googleInTurn({ status: 401 });
    h.refresh.mockImplementation(async (connection: unknown, refresher: (c: unknown) => Promise<unknown>) =>
      refresher(connection),
    );
    // The shared refresh flags the row on a terminal refusal (googleTokens.test.ts).
    h.refreshGoogle.mockRejectedValue(invalidGrant());

    const res = await call();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual(RECONNECT_BODY);
    expect(h.refreshGoogle).toHaveBeenCalledWith(expect.objectContaining({ id: "conn-1" }));
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each(routes)("%s: a 401 on a row flagged meanwhile says reconnect", async (_label, call) => {
    googleInTurn({ status: 401 });
    h.refresh.mockRejectedValue(Object.assign(new Error("Reconnect"), { code: "RECONNECT_REQUIRED" }));

    const res = await call();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual(RECONNECT_BODY);
  });

  it.each(routes)("%s: a 401 with a refresh that works is retried and listed", async (_label, call) => {
    const fetchMock = googleInTurn(
      { status: 401 },
      { body: { accounts: [{ name: "accounts/1" }] } },
      { body: { locations: [location(1, 1)] } },
    );
    h.refresh.mockResolvedValue({ ...CONNECTION, accessToken: "fresh" });

    const res = await call();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const lastHeaders = (fetchMock.mock.calls[2] as unknown as [string, { headers: Record<string, string> }])[1].headers;
    expect(lastHeaders.Authorization).toBe("Bearer fresh");
  });

  it.each(routes)("%s: a 401 whose refresh fails on Google's side keeps today's answer", async (_label, call) => {
    googleInTurn({ status: 401 });
    h.refresh.mockRejectedValue(
      Object.assign(new Error("Google token refresh failed"), { code: "GOOGLE_TOKEN_REFRESH_FAILED", status: 503 }),
    );

    const res = await call();

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "Failed to list Google Business Profile accounts" });
  });

  it.each([
    ["a 503", { status: 503 }],
    ["no answer", { throws: true }],
  ] as Array<[string, Page]>)("%s keeps today's text on both routes", async (_label, failure) => {
    for (const [, call] of routes) {
      googleInTurn(failure);
      const res = await call();
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({ error: GOOGLE_NO_ANSWER_MESSAGE });
    }
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("the picker lists as before for a healthy row", async () => {
    google({
      [`${ACCOUNTS}|`]: { body: { accounts: [{ name: "accounts/1" }] } },
      [`${INFO}/accounts/1/locations|`]: { body: { locations: [location(1, 1)] } },
    });

    const res = await GET();

    expect(res.status).toBe(200);
    expect((await res.json()).locations).toHaveLength(1);
  });
});
