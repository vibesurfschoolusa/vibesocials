import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";
import { LINKEDIN_API_VERSION } from "@/lib/linkedinApi";

import { LINKEDIN_URNS_PER_REQUEST, fetchLinkedInShareStatisticsBatch } from "./linkedinMetrics";

const fetchMock = vi.fn();
const ORG = "urn:li:organization:42";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const answer = (elements: unknown[]) => new Response(JSON.stringify({ elements, paging: {} }), { status: 200 });
const stats = (over: Record<string, unknown> = {}) => ({
  impressionCount: 500,
  clickCount: 20,
  likeCount: 9,
  commentCount: 2,
  shareCount: 1,
  engagement: 0.06,
  uniqueImpressionsCount: 300,
  ...over,
});

describe("fetchLinkedInShareStatisticsBatch", () => {
  it("asks nothing for no URNs", async () => {
    const out = await fetchLinkedInShareStatisticsBatch(ORG, [], "t");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.byId.size).toBe(0);
  });

  it("reads one share's lifetime numbers through the finder, with the versioned headers", async () => {
    fetchMock.mockResolvedValueOnce(
      answer([{ organizationalEntity: ORG, share: "urn:li:share:1", totalShareStatistics: stats() }]),
    );
    const out = await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:share:1"], "li-token");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity" +
        "&organizationalEntity=urn%3Ali%3Aorganization%3A42&shares=List(urn%3Ali%3Ashare%3A1)",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer li-token");
    expect(headers["Linkedin-Version"]).toBe(LINKEDIN_API_VERSION);
    expect(headers["X-Restli-Protocol-Version"]).toBe("2.0.0");

    expect(out.byId.get("urn:li:share:1")?.counts).toEqual({
      views: 500,
      likes: 9,
      comments: 2,
      shares: 1,
      clicks: 20,
      saves: null,
    });
    expect(out.byId.get("urn:li:share:1")?.raw).toEqual({
      impressionCount: 500,
      clickCount: 20,
      likeCount: 9,
      commentCount: 2,
      shareCount: 1,
    });
  });

  it("asks for several shares in one request and ugcPosts in a second one", async () => {
    fetchMock
      .mockResolvedValueOnce(
        answer([
          { share: "urn:li:share:1", totalShareStatistics: stats({ likeCount: "4" }) },
          { share: "urn:li:share:2", totalShareStatistics: stats({ commentCount: undefined }) },
        ]),
      )
      .mockResolvedValueOnce(answer([{ ugcPost: "urn:li:ugcPost:3", totalShareStatistics: stats() }]));

    const out = await fetchLinkedInShareStatisticsBatch(
      ORG,
      ["urn:li:share:1", "urn:li:ugcPost:3", "urn:li:share:2"],
      "t",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("&shares=List(urn%3Ali%3Ashare%3A1,urn%3Ali%3Ashare%3A2)");
    expect(fetchMock.mock.calls[1][0]).toContain("&ugcPosts=List(urn%3Ali%3AugcPost%3A3)");
    expect(out.byId.get("urn:li:share:1")?.counts.likes).toBe(4);
    expect(out.byId.get("urn:li:share:2")?.counts.comments).toBeNull();
    expect(out.byId.get("urn:li:ugcPost:3")?.counts.views).toBe(500);
  });

  it("a share LinkedIn leaves out of the answer is not found, never zero", async () => {
    fetchMock.mockResolvedValueOnce(answer([]));
    const out = await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:share:1"], "t");
    expect(out.byId.size).toBe(0);
    expect(out.failed.size).toBe(0);
  });

  it("ignores a URN that is neither a share nor a ugcPost", async () => {
    const out = await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:activity:1"], "t");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.byId.size).toBe(0);
  });

  it("an error answer fails the whole request; a 429 leaves it unchecked; a timeout never throws", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    const failed = await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:share:1"], "t");
    expect([...failed.failed]).toEqual(["urn:li:share:1"]);

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    const limited = await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:share:1", "urn:li:ugcPost:2"], "t");
    expect(limited.rateLimited).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...limited.unchecked].sort()).toEqual(["urn:li:share:1", "urn:li:ugcPost:2"]);

    fetchMock.mockRejectedValueOnce(Object.assign(new Error("slow"), { code: FETCH_TIMEOUT_CODE }));
    const timedOut = await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:share:1"], "t");
    expect([...timedOut.failed]).toEqual(["urn:li:share:1"]);
  });

  it("caps a request at a modest number of URNs", () => {
    expect(LINKEDIN_URNS_PER_REQUEST).toBe(20);
  });
});
