import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";
import { LINKEDIN_API_VERSION } from "@/lib/linkedinApi";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";

import { SOCIAL_METRICS_TIMEOUT_MS } from "./facebookMetrics";
import { LINKEDIN_URNS_PER_REQUEST, fetchLinkedInShareStatisticsBatch } from "./linkedinMetrics";

const fetchMock = vi.fn();
const ORG = "urn:li:organization:42";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
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
    expect(out.byId.get("urn:li:share:1")?.asked).toEqual(["views", "clicks", "likes", "comments", "shares"]);
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

  // R42 platform L1: both kinds in the Rest.li 2.0 List(...) form the
  // X-Restli-Protocol-Version 2.0.0 header asks for (share-statistics page,
  // li-lms-2026-10: the indexed ugcPosts[0]= form is its "Restli 1.0").
  it("sends the exact URL for each kind", async () => {
    fetchMock.mockResolvedValueOnce(answer([])).mockResolvedValueOnce(answer([]));
    await fetchLinkedInShareStatisticsBatch(
      ORG,
      ["urn:li:share:1", "urn:li:share:2", "urn:li:ugcPost:3", "urn:li:ugcPost:4"],
      "t",
    );
    const base =
      "https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity" +
      "&organizationalEntity=urn%3Ali%3Aorganization%3A42";
    expect(fetchMock.mock.calls[0][0]).toBe(`${base}&shares=List(urn%3Ali%3Ashare%3A1,urn%3Ali%3Ashare%3A2)`);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${base}&ugcPosts=List(urn%3Ali%3AugcPost%3A3,urn%3Ali%3AugcPost%3A4)`,
    );
  });

  describe("an answer without per-post rows", () => {
    it("an aggregate element with no ugcPost field: one warn with counts only, and no post is counted as no activity", async () => {
      fetchMock.mockResolvedValueOnce(
        answer([{ organizationalEntity: ORG, totalShareStatistics: stats() }]),
      );
      const out = await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:ugcPost:3", "urn:li:ugcPost:4"], "t");

      expect(out.byId.size).toBe(0);
      expect([...out.failed].sort()).toEqual(["urn:li:ugcPost:3", "urn:li:ugcPost:4"]);
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.warn).toHaveBeenCalledWith("[PostMetrics] LinkedIn share statistics answered without per-post rows", {
        param: "ugcPosts",
        urnCount: 2,
        elementsWithoutUrn: 1,
      });
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("urn:li:");
    });

    it("a post that came back with its own row keeps its numbers", async () => {
      fetchMock.mockResolvedValueOnce(
        answer([
          { ugcPost: "urn:li:ugcPost:3", totalShareStatistics: stats() },
          { organizationalEntity: ORG, totalShareStatistics: stats() },
        ]),
      );
      const out = await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:ugcPost:3", "urn:li:ugcPost:4"], "t");
      expect(out.byId.get("urn:li:ugcPost:3")?.counts.views).toBe(500);
      expect([...out.failed]).toEqual(["urn:li:ugcPost:4"]);
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it("a normal answer logs no warning, and a post missing from it is still no activity", async () => {
      fetchMock.mockResolvedValueOnce(answer([{ ugcPost: "urn:li:ugcPost:3", totalShareStatistics: stats() }]));
      const out = await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:ugcPost:3", "urn:li:ugcPost:4"], "t");
      expect(out.byId.has("urn:li:ugcPost:3")).toBe(true);
      expect(out.byId.has("urn:li:ugcPost:4")).toBe(false);
      expect(out.failed.size).toBe(0);
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe("a refusal's log line", () => {
    const refusal = (status: number) =>
      new Response(
        JSON.stringify({
          status,
          serviceErrorCode: 100,
          code: "ILLEGAL_ARGUMENT",
          message: "Invalid param urn:li:ugcPost:3 for the page",
          errorDetailType: "com.linkedin.common.error.BadRequest",
          errorDetails: {
            inputErrors: [
              {
                description: "Invalid value urn:li:ugcPost:3",
                input: { inputPath: { fieldPath: "ugcPosts[0]" } },
                code: "INVALID_VALUE",
              },
            ],
          },
        }),
        { status },
      );

    it("a 400 is a warning naming the request, the URN count and LinkedIn's codes, with no message or URN", async () => {
      fetchMock.mockResolvedValueOnce(refusal(400));
      const out = await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:ugcPost:3", "urn:li:ugcPost:4"], "t");
      expect([...out.failed].sort()).toEqual(["urn:li:ugcPost:3", "urn:li:ugcPost:4"]);
      expect(console.error).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledTimes(1);
      const [line, fields] = vi.mocked(console.warn).mock.calls[0];
      expect(line).toBe("[PostMetrics] LinkedIn share statistics refused");
      expect(fields).toEqual({
        param: "ugcPosts",
        urnCount: 2,
        status: 400,
        serviceErrorCode: 100,
        code: "ILLEGAL_ARGUMENT",
        inputErrors: [{ code: "INVALID_VALUE", fieldPath: "ugcPosts[0]" }],
      });
      expect(JSON.stringify(fields)).not.toContain("urn:");
      expect(JSON.stringify(fields)).not.toContain("Invalid");
    });

    it("a 5xx is an error; a body that isn't LinkedIn's JSON logs no codes", async () => {
      fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
      await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:share:1"], "t");
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith("[PostMetrics] LinkedIn share statistics refused", {
        param: "shares",
        urnCount: 1,
        status: 502,
        serviceErrorCode: null,
        code: null,
        inputErrors: [],
      });
    });

    // R41 lead review: LinkedIn's field paths can be slash paths.
    it("a slash field path such as /ugcPosts/0 is logged", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errorDetails: {
              inputErrors: [
                { code: "INVALID_VALUE", input: { inputPath: { fieldPath: "/ugcPosts/0" } } },
                { code: "INVALID_VALUE", input: { inputPath: { fieldPath: "/ugcPosts/urn:li:ugcPost:3" } } },
                { code: "INVALID_VALUE", input: { inputPath: { fieldPath: "/ugcPosts/0 is not a post" } } },
              ],
            },
          }),
          { status: 400 },
        ),
      );
      await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:ugcPost:3"], "t");
      expect(vi.mocked(console.warn).mock.calls[0][1]).toMatchObject({
        inputErrors: [
          { code: "INVALID_VALUE", fieldPath: "/ugcPosts/0" },
          { code: "INVALID_VALUE", fieldPath: null },
          { code: "INVALID_VALUE", fieldPath: null },
        ],
      });
    });

    it("a code or path that names a URN or carries text is left out", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "has spaces in it",
            errorDetails: { inputErrors: [{ code: "urn:li:share:1", input: { inputPath: { fieldPath: "urn:li:share:1" } } }] },
          }),
          { status: 404 },
        ),
      );
      await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:share:1"], "t");
      expect(vi.mocked(console.warn).mock.calls[0][1]).toEqual({
        param: "shares",
        urnCount: 1,
        status: 404,
        serviceErrorCode: null,
        code: null,
        inputErrors: [{ code: null, fieldPath: null }],
      });
    });

    // R41 lead review: the time limit covers the body too (fetchWithinLimit).
    it("a stalled error body ends within the limit and logs a warning with no codes", async () => {
      vi.useFakeTimers();
      abortSignalTimeoutOnFakeClock();
      fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"status":400,'));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        });
        return Promise.resolve(new Response(body, { status: 400 }));
      });
      const settled = fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:ugcPost:3"], "t");
      await vi.advanceTimersByTimeAsync(SOCIAL_METRICS_TIMEOUT_MS);
      const out = await settled;
      expect([...out.failed]).toEqual(["urn:li:ugcPost:3"]);
      expect(console.error).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith("[PostMetrics] LinkedIn share statistics refused", {
        param: "ugcPosts",
        urnCount: 1,
        status: 400,
        body: "unreadable",
      });
    });

    it("a stalled success body ends within the limit as no answer", async () => {
      vi.useFakeTimers();
      abortSignalTimeoutOnFakeClock();
      fetchMock.mockImplementationOnce(bodyNeverEnds);
      const settled = fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:share:1"], "t");
      await vi.advanceTimersByTimeAsync(SOCIAL_METRICS_TIMEOUT_MS);
      const out = await settled;
      expect([...out.failed]).toEqual(["urn:li:share:1"]);
      expect(console.error).toHaveBeenCalledWith(
        "[PostMetrics] LinkedIn share statistics failed",
        expect.objectContaining({ param: "shares", code: FETCH_TIMEOUT_CODE }),
      );
    });

    it("no answer is an error naming the request and the URN count", async () => {
      fetchMock.mockRejectedValueOnce(Object.assign(new Error("slow"), { code: FETCH_TIMEOUT_CODE }));
      await fetchLinkedInShareStatisticsBatch(ORG, ["urn:li:ugcPost:3"], "t");
      expect(console.error).toHaveBeenCalledWith("[PostMetrics] LinkedIn share statistics failed", {
        param: "ugcPosts",
        urnCount: 1,
        error: "Error",
        code: FETCH_TIMEOUT_CODE,
      });
    });
  });

  it("caps a request at a modest number of URNs", () => {
    expect(LINKEDIN_URNS_PER_REQUEST).toBe(20);
  });
});
