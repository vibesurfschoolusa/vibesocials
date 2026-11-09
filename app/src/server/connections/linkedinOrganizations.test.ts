import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LINKEDIN_API_VERSION } from "@/lib/linkedinApi";

import {
  findAdministeredOrganizations,
  LINKEDIN_ACL_MAX_PAGES,
  LINKEDIN_ACL_PAGE_SIZE,
  lookupOrganization,
  lookupOrganizationByVanityName,
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
