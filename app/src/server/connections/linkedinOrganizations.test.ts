import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONNECT_READS_BUDGET_MS } from "@/lib/fetchWithTimeout";
import { LINKEDIN_API_VERSION } from "@/lib/linkedinApi";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds, headersNeverCome } from "@/lib/stallingFetch.testkit";

import {
  findAdministeredOrganizations,
  LINKEDIN_ACL_MAX_PAGES,
  LINKEDIN_LOOKUP_TIMEOUT_MS,
  LINKEDIN_ACL_PAGE_SIZE,
  lookupOrganization,
  lookupOrganizationByVanityName,
  lookupOrganizationByVanityNameOutcome,
  lookupOrganizationOutcome,
  organizationIdsFromAcls,
} from "./linkedinOrganizations";

// No real LinkedIn endpoint is called: `fetch` is stubbed in every test.

const REST = "https://api.linkedin.com/rest";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const acl = (id: number | string, over: Record<string, unknown> = {}) => ({
  role: "ADMINISTRATOR",
  organization: `urn:li:organization:${id}`,
  roleAssignee: "urn:li:person:abCdEf",
  state: "APPROVED",
  ...over,
});
const aclPage = (elements: unknown[], next = false) => ({
  elements,
  paging: {
    count: LINKEDIN_ACL_PAGE_SIZE,
    start: 0,
    links: next
      ? [{ type: "application/json", rel: "next", href: "/rest/organizationAcls?count=10&q=roleAssignee&start=10" }]
      : [],
  },
});
const aclUrl = (start: number) =>
  `${REST}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&start=${start}&count=${LINKEDIN_ACL_PAGE_SIZE}`;

type Route = (url: string) => Response | Promise<Response>;

function stubFetch(route: Route) {
  const fetchMock = vi.fn(async (input: string | URL) => route(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));
  const headersOf = (index: number) =>
    ((fetchMock.mock.calls[index] as unknown as [string, RequestInit])[1]?.headers ?? {}) as Record<string, string>;
  return { fetchMock, urls, headersOf };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("organizationIdsFromAcls", () => {
  it("reads the page URN from `organization` and from `organizationTarget` (the page's samples use both)", () => {
    expect(
      organizationIdsFromAcls({
        elements: [
          acl(2414183),
          { state: "APPROVED", role: "ADMINISTRATOR", roleAssignee: "urn:li:person:A8", organizationTarget: "urn:li:organization:79988552" },
        ],
      }),
    ).toEqual(["2414183", "79988552"]);
  });

  it("takes an organizationBrand URN as the organization it maps to", () => {
    expect(organizationIdsFromAcls({ elements: [acl(1, { organization: "urn:li:organizationBrand:89758488" })] })).toEqual([
      "89758488",
    ]);
  });

  it("skips roles that are not approved administrators, entries without a page URN, and repeats", () => {
    expect(
      organizationIdsFromAcls({
        elements: [
          acl(1),
          acl(2, { state: "REQUESTED" }),
          acl(3, { role: "DIRECT_SPONSORED_CONTENT_POSTER" }),
          acl(4, { organization: "urn:li:person:4" }),
          acl(5, { organization: undefined }),
          { organization: "urn:li:organization:6" },
          "garbage",
          null,
          acl(1),
        ],
      }),
    ).toEqual(["1", "6"]);
  });

  it("reads nothing from an answer that has no elements", () => {
    expect(organizationIdsFromAcls(null)).toEqual([]);
    expect(organizationIdsFromAcls({})).toEqual([]);
    expect(organizationIdsFromAcls({ elements: "x" })).toEqual([]);
  });
});

describe("findAdministeredOrganizations", () => {
  it("asks organizationAcls for approved ADMINISTRATOR roles, versioned, then each page's name one GET at a time", async () => {
    const li = stubFetch((url) => {
      if (url.startsWith(`${REST}/organizationAcls`)) return json(aclPage([acl(111), acl(222)]));
      if (url === `${REST}/organizations/111`) return json({ id: 111, localizedName: "My Surf School", vanityName: "my-surf-school" });
      if (url === `${REST}/organizations/222`) return json({ id: 222, localizedName: "Client Cafe", name: { localized: { en_US: "Client Cafe" } } });
      throw new Error(`unexpected ${url}`);
    });

    const organizations = await findAdministeredOrganizations("li-access");

    expect(organizations).toEqual([
      { id: "111", name: "My Surf School", vanityName: "my-surf-school" },
      { id: "222", name: "Client Cafe" },
    ]);
    expect(li.urls()).toEqual([aclUrl(0), `${REST}/organizations/111`, `${REST}/organizations/222`]);
    for (let i = 0; i < li.urls().length; i += 1) {
      expect(li.headersOf(i)).toEqual({
        Authorization: "Bearer li-access",
        "Linkedin-Version": LINKEDIN_API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      });
    }
    // Never the batch form (a Development-tier app may not BATCH_GET).
    expect(li.urls().some((u) => u.includes("ids=List("))).toBe(false);
  });

  it("follows the next page while LinkedIn links one", async () => {
    const li = stubFetch((url) => {
      if (url === aclUrl(0)) return json(aclPage(Array.from({ length: 10 }, (_, i) => acl(i + 1)), true));
      if (url === aclUrl(10)) return json(aclPage([acl(11), acl(12)]));
      const id = /\/organizations\/(\d+)$/.exec(url)?.[1];
      if (id) return json({ id: Number(id), localizedName: `Page ${id}` });
      throw new Error(`unexpected ${url}`);
    });

    const organizations = await findAdministeredOrganizations("li-access");

    expect(organizations?.map((o) => o.id)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
    expect(li.urls().filter((u) => u.includes("organizationAcls"))).toEqual([aclUrl(0), aclUrl(10)]);
  });

  it("stops after the last page it may read, even when LinkedIn links another", async () => {
    let start = 0;
    const li = stubFetch((url) => {
      if (url.includes("organizationAcls")) {
        const page = Array.from({ length: 10 }, (_, i) => acl(start + i + 1));
        start += 10;
        return json(aclPage(page, true));
      }
      return json({ message: "Not enough permissions" }, 403);
    });

    const organizations = await findAdministeredOrganizations("li-access");

    expect(li.urls().filter((u) => u.includes("organizationAcls"))).toHaveLength(LINKEDIN_ACL_MAX_PAGES);
    expect(organizations).toHaveLength(LINKEDIN_ACL_MAX_PAGES * 10);
  });

  it("keeps a page whose name lookup is refused, with its id only (the member administers it)", async () => {
    stubFetch((url) => {
      if (url.includes("organizationAcls")) return json(aclPage([acl(333)]));
      return json({ message: "Not enough permissions to access: organizations.GET" }, 403);
    });

    expect(await findAdministeredOrganizations("li-access")).toEqual([{ id: "333" }]);
  });

  it("answers an empty list when the member administers no page", async () => {
    const li = stubFetch(() => json(aclPage([])));

    expect(await findAdministeredOrganizations("li-access")).toEqual([]);
    expect(li.urls()).toEqual([aclUrl(0)]);
  });

  it("answers null when organizationAcls is refused or unreachable, so the callback tries its fallbacks", async () => {
    stubFetch(() => json({ status: 403, message: "Not enough permissions" }, 403));
    expect(await findAdministeredOrganizations("li-access")).toBeNull();

    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await findAdministeredOrganizations("li-access")).toBeNull();

    stubFetch(() => new Response("<html>oops</html>", { status: 200 }));
    expect(await findAdministeredOrganizations("li-access")).toBeNull();
  });

  it("keeps the pages it found when a later page fails", async () => {
    stubFetch((url) => {
      if (url === aclUrl(0)) return json(aclPage([acl(1)], true));
      if (url.includes("organizationAcls")) return json({}, 500);
      return json({ id: 1, localizedName: "One" });
    });

    expect(await findAdministeredOrganizations("li-access")).toEqual([{ id: "1", name: "One" }]);
  });

  it("logs statuses only, never the token", async () => {
    stubFetch(() => json({}, 403));

    await findAdministeredOrganizations("li-secret-token");

    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("li-secret-token");
  });
});

describe("lookupOrganization", () => {
  it("reads the id (a number in LinkedIn's answer) as text, with the localized name and vanity name", async () => {
    const li = stubFetch(() => json({ id: 79988552, localizedName: "FirstDemoCompany", vanityName: "firstdemocompany" }));

    expect(await lookupOrganization("tok", "79988552")).toEqual({
      id: "79988552",
      name: "FirstDemoCompany",
      vanityName: "firstdemocompany",
    });
    expect(li.urls()).toEqual([`${REST}/organizations/79988552`]);
    expect(li.headersOf(0)["Linkedin-Version"]).toBe(LINKEDIN_API_VERSION);
  });

  it("is null when LinkedIn refuses it or the call fails", async () => {
    stubFetch(() => json({ message: "Viewer don't have permission" }, 403));
    expect(await lookupOrganization("tok", "1")).toBeNull();

    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await lookupOrganization("tok", "1")).toBeNull();
  });
});

// R35 platform-clients L1: the daily sweep calls this once per connection; a
// LinkedIn call that never answers must not hold the step for Node's 300 s.
describe("lookupOrganization when LinkedIn does not answer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up after 15 seconds and answers null", async () => {
    expect(LINKEDIN_LOOKUP_TIMEOUT_MS).toBe(15_000);
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const answer = lookupOrganization("tok", "101");
    await vi.advanceTimersByTimeAsync(LINKEDIN_LOOKUP_TIMEOUT_MS);

    await expect(answer).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).toContain("FETCH_TIMEOUT");
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("tok");
  });
});

describe("lookupOrganizationByVanityName", () => {
  it("finds the first page with that vanity name, versioned", async () => {
    const li = stubFetch(() =>
      json({ paging: { start: 0, count: 10, total: 1 }, elements: [{ id: 11832, localizedName: "Boise State University", vanityName: "boisestate" }] }),
    );

    expect(await lookupOrganizationByVanityName("tok", "boise state")).toEqual({
      id: "11832",
      name: "Boise State University",
      vanityName: "boisestate",
    });
    expect(li.urls()).toEqual([`${REST}/organizations?q=vanityName&vanityName=boise%20state`]);
    expect(li.headersOf(0)["X-Restli-Protocol-Version"]).toBe("2.0.0");
  });

  it("is null when nothing is found or LinkedIn refuses", async () => {
    stubFetch(() => json({ elements: [] }));
    expect(await lookupOrganizationByVanityName("tok", "nobody")).toBeNull();

    stubFetch(() => json({}, 404));
    expect(await lookupOrganizationByVanityName("tok", "nobody")).toBeNull();
  });
});

// R54 platform-clients L1, new-customer L3, pages-a L1: the setup hint's
// lookup runs only after organizationAcls failed, when LinkedIn is most likely
// to refuse, rate-limit or time out. A null for all of those told the owner to
// check an address that was right; the outcome tells them apart.
describe("lookupOrganizationByVanityNameOutcome", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("found: the page", async () => {
    stubFetch(() => json({ elements: [{ id: 888, localizedName: "Acme Surf", vanityName: "acme-surf" }] }));
    expect(await lookupOrganizationByVanityNameOutcome("tok", "acme-surf")).toEqual({
      outcome: "found",
      organization: { id: "888", name: "Acme Surf", vanityName: "acme-surf" },
    });
  });

  it("not found: a 200 with no elements, or a 404", async () => {
    stubFetch(() => json({ paging: { start: 0, count: 10, total: 0 }, elements: [] }));
    expect(await lookupOrganizationByVanityNameOutcome("tok", "nobody")).toEqual({ outcome: "not_found" });

    stubFetch(() => json({}, 404));
    expect(await lookupOrganizationByVanityNameOutcome("tok", "nobody")).toEqual({ outcome: "not_found" });
  });

  it.each([403, 429, 500])("failed: a %i", async (status) => {
    stubFetch(() => json({ message: "no" }, status));
    expect(await lookupOrganizationByVanityNameOutcome("tok", "acme-surf")).toEqual({ outcome: "failed" });
  });

  it("failed: an unreadable body, or a call that throws", async () => {
    stubFetch(() => new Response("<html>oops</html>", { status: 200 }));
    expect(await lookupOrganizationByVanityNameOutcome("tok", "acme-surf")).toEqual({ outcome: "failed" });

    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await lookupOrganizationByVanityNameOutcome("tok", "acme-surf")).toEqual({ outcome: "failed" });
  });

  it("failed: no answer within 15 seconds", async () => {
    vi.useFakeTimers();
    abortSignalTimeoutOnFakeClock();
    vi.stubGlobal("fetch", vi.fn(headersNeverCome));

    const answer = lookupOrganizationByVanityNameOutcome("tok", "acme-surf");
    await vi.advanceTimersByTimeAsync(LINKEDIN_LOOKUP_TIMEOUT_MS);

    await expect(answer).resolves.toEqual({ outcome: "failed" });
  }, 5_000);
});

describe("lookupOrganizationOutcome", () => {
  it("found: the page", async () => {
    stubFetch(() => json({ id: 777, localizedName: "Hinted Page" }));
    expect(await lookupOrganizationOutcome("tok", "777")).toEqual({
      outcome: "found",
      organization: { id: "777", name: "Hinted Page" },
    });
  });

  it("not found: a 404", async () => {
    stubFetch(() => json({ message: "Not found" }, 404));
    expect(await lookupOrganizationOutcome("tok", "777")).toEqual({ outcome: "not_found" });
  });

  it.each([403, 500])("failed: a %i", async (status) => {
    stubFetch(() => json({ message: "no" }, status));
    expect(await lookupOrganizationOutcome("tok", "777")).toEqual({ outcome: "failed" });
  });

  it("failed: a call that throws", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await lookupOrganizationOutcome("tok", "777")).toEqual({ outcome: "failed" });
  });
});

// R54 fix review L1: only LinkedIn's own "no such page" is not_found. An
// answer we can't read says nothing about the address; a 400 says the address
// (the only part of the request that varies) is wrong.
const vanityAnswers: [string, () => Response, "not_found" | "failed"][] = [
  ["a 200 with no elements", () => json({}), "failed"],
  ["a 200 whose elements isn't an array", () => json({ elements: { id: 888 } }), "failed"],
  ["a 200 whose first element is null", () => json({ elements: [null] }), "failed"],
  ["a 200 whose first element has no id", () => json({ elements: [{ localizedName: "Acme" }] }), "failed"],
  ["a 200 with empty elements", () => json({ elements: [] }), "not_found"],
  ["a 400", () => json({ message: "Bad request" }, 400), "not_found"],
];
const idAnswers: [string, () => Response, "not_found" | "failed"][] = [
  ["a 200 whose body is null", () => json(null), "failed"],
  ["a 200 whose body is an array", () => json([]), "failed"],
  ["a 400", () => json({ message: "Bad request" }, 400), "not_found"],
];

describe("an answer the lookups can't read", () => {
  it.each(vanityAnswers)("vanity name, %s", async (_kind, answer, outcome) => {
    stubFetch(answer);
    expect(await lookupOrganizationByVanityNameOutcome("tok", "acme-surf")).toEqual({ outcome });
  });

  it.each(idAnswers)("numeric id, %s", async (_kind, answer, outcome) => {
    stubFetch(answer);
    expect(await lookupOrganizationOutcome("tok", "777")).toEqual({ outcome });
  });

  it("the null-returning lookups answer null for every one of them", async () => {
    for (const [kind, answer] of vanityAnswers) {
      stubFetch(answer);
      expect(await lookupOrganizationByVanityName("tok", "acme-surf"), kind).toBeNull();
    }
    for (const [kind, answer] of idAnswers) {
      stubFetch(answer);
      expect(await lookupOrganization("tok", "777"), kind).toBeNull();
    }
  });
});

// The daily sweep, the admin pages listing and the callback's previous-page
// check still read null for anything but a page, exactly as before.
describe("the null-returning lookups answer as before", () => {
  it("lookupOrganization: the page, then null for a 404 and a 500", async () => {
    stubFetch(() => json({ id: 777, localizedName: "Hinted Page" }));
    expect(await lookupOrganization("tok", "777")).toEqual({ id: "777", name: "Hinted Page" });
    for (const status of [404, 500]) {
      stubFetch(() => json({ message: "no" }, status));
      expect(await lookupOrganization("tok", "777"), String(status)).toBeNull();
    }
  });

  it("lookupOrganizationByVanityName: the page, then null for a 404 and a 500", async () => {
    stubFetch(() => json({ elements: [{ id: 888, localizedName: "Acme Surf", vanityName: "acme-surf" }] }));
    expect(await lookupOrganizationByVanityName("tok", "acme-surf")).toEqual({
      id: "888",
      name: "Acme Surf",
      vanityName: "acme-surf",
    });
    for (const status of [404, 500]) {
      stubFetch(() => json({ message: "no" }, status));
      expect(await lookupOrganizationByVanityName("tok", "acme-surf"), String(status)).toBeNull();
    }
  });
});

// R36 platform-clients L1: the vanity lookup and organizationAcls run while
// someone waits on Connect; a LinkedIn that stalls (no headers, or a body that
// never ends) answers null within 15 s, the callback's existing failure path.
describe("connect reads when LinkedIn stalls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const reads = [
    { name: "lookupOrganizationByVanityName", run: () => lookupOrganizationByVanityName("tok", "acme") },
    { name: "findAdministeredOrganizations", run: () => findAdministeredOrganizations("tok") },
  ];
  const stalls = [
    { kind: "no headers", fetch: headersNeverCome },
    { kind: "a body that never ends", fetch: bodyNeverEnds },
  ];

  for (const read of reads) {
    for (const stall of stalls) {
      it(`${read.name} answers null after 15 seconds of ${stall.kind}`, async () => {
        vi.useFakeTimers();
        abortSignalTimeoutOnFakeClock();
        const fetchMock = vi.fn(stall.fetch);
        vi.stubGlobal("fetch", fetchMock);

        const answer = read.run();
        await vi.advanceTimersByTimeAsync(LINKEDIN_LOOKUP_TIMEOUT_MS);

        await expect(answer).resolves.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("tok");
      });
    }
  }
});

// R37 platform-clients L2: up to 100 name reads, one after another at up to
// 15 s each, could pass the callback's 300 s limit. They share one budget
// with Instagram's account reads; a page not read in time keeps its id only.
describe("findAdministeredOrganizations on a slow LinkedIn", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops reading names at the 60-second budget and still lists every page by id", async () => {
    expect(CONNECT_READS_BUDGET_MS).toBe(60_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    abortSignalTimeoutOnFakeClock();
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const page = /start=(\d+)/.exec(url);
      if (url.startsWith(`${REST}/organizationAcls`)) {
        const start = Number(page?.[1] ?? 0);
        return Promise.resolve(json(aclPage(ids.slice(start, start + 10).map((id) => acl(id)), start + 10 < ids.length)));
      }
      const id = /organizations\/(\d+)$/.exec(url)?.[1];
      // Each name answers in 14 s, inside its own 15-second limit.
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(json({ id: Number(id), localizedName: `Page ${id}` })), 14_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    let settled: unknown = undefined;
    const answer = findAdministeredOrganizations("li-access").then((orgs) => (settled = orgs));
    await vi.advanceTimersByTimeAsync(CONNECT_READS_BUDGET_MS);
    await answer;

    const organizations = settled as Array<{ id: string; name?: string }>;
    expect(organizations.map((o) => o.id)).toEqual(ids.map(String));
    // 14, 28, 42 and 56 s fit; the fifth ends at the budget and none starts after it.
    expect(organizations.filter((o) => o.name)).toHaveLength(4);
    expect(organizations[99]).toEqual({ id: "100" });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/organizations/"))).toHaveLength(5);
  });
});
