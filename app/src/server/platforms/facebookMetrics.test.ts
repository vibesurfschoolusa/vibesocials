import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";
import { META_GRAPH_BASE_URL } from "@/lib/metaGraph";

import {
  FACEBOOK_METRICS_ITEMS_PER_BATCH,
  countOf,
  fetchFacebookPostMetricsBatch,
} from "./facebookMetrics";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A Graph batch answer: one entry per request, each body a JSON string. */
function batchAnswer(entries: Array<{ code: number; body: unknown } | null>): Response {
  return new Response(
    JSON.stringify(entries.map((entry) => (entry ? { code: entry.code, body: JSON.stringify(entry.body) } : null))),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** The batch requests a call sent: [{ method, relative_url }] per POST. */
function sentBatches(): Array<Array<{ method: string; relative_url: string }>> {
  return fetchMock.mock.calls.map((call) => {
    const body = new URLSearchParams(String((call[1] as RequestInit).body));
    return JSON.parse(body.get("batch") ?? "[]");
  });
}

const POST_FIELDS = "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)";
const VIDEO_FIELDS = "likes.summary(total_count).limit(0),comments.summary(total_count).limit(0)";

const postBody = (reactions: unknown, comments: unknown, shares?: unknown) => ({
  id: "x",
  reactions: { data: [], summary: { total_count: reactions } },
  comments: { data: [], summary: { total_count: comments, order: "ranked" } },
  ...(shares === undefined ? {} : { shares: { count: shares } }),
});

describe("countOf", () => {
  it("reads whole non-negative counts, from a number or a string, and nothing else", () => {
    expect(countOf(12)).toBe(12);
    expect(countOf("34")).toBe(34);
    expect(countOf(0)).toBe(0);
    expect(countOf(undefined)).toBeNull();
    expect(countOf("")).toBeNull();
    expect(countOf("12a")).toBeNull();
    expect(countOf(-3)).toBeNull();
    expect(countOf(1.5)).toBeNull();
    expect(countOf(2_147_483_648)).toBeNull();
  });
});

describe("fetchFacebookPostMetricsBatch", () => {
  it("asks nothing for no posts", async () => {
    const out = await fetchFacebookPostMetricsBatch([], "page-token");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.byId.size).toBe(0);
  });

  it("reads one feed post's reactions, comments and shares in one batch POST, the token in the body", async () => {
    fetchMock.mockResolvedValueOnce(batchAnswer([{ code: 200, body: postBody(7, "3", 2) }]));

    const out = await fetchFacebookPostMetricsBatch([{ id: "111_222", kind: "post" }], "page-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${META_GRAPH_BASE_URL}/`);
    expect(init.method).toBe("POST");
    expect(url).not.toContain("page-token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("access_token")).toBe("page-token");
    expect(body.get("include_headers")).toBe("false");
    expect(sentBatches()[0]).toEqual([{ method: "GET", relative_url: `111_222?fields=${POST_FIELDS}` }]);

    expect(out.byId.get("111_222")?.counts).toEqual({
      views: null,
      likes: 7,
      comments: 3,
      shares: 2,
      clicks: null,
      saves: null,
    });
    expect(out.byId.get("111_222")?.raw).toEqual({ reactions: 7, comments: 3, shares: 2 });
    expect(out.failed.size).toBe(0);
    expect(out.rateLimited).toBe(false);
  });

  it("leaves shares null when Facebook sends no shares field", async () => {
    fetchMock.mockResolvedValueOnce(batchAnswer([{ code: 200, body: postBody(1, 0) }]));
    const out = await fetchFacebookPostMetricsBatch([{ id: "1_2", kind: "post" }], "t");
    expect(out.byId.get("1_2")?.counts.shares).toBeNull();
  });

  it("finds a single photo's post through page_story_id, then reads that post, keyed by the photo id", async () => {
    fetchMock
      .mockResolvedValueOnce(
        batchAnswer([
          { code: 200, body: { id: "p1", page_story_id: "9_100" } },
          { code: 200, body: { id: "p2", page_story_id: "9_200" } },
        ]),
      )
      .mockResolvedValueOnce(
        batchAnswer([
          { code: 200, body: postBody(5, 1, 0) },
          { code: 200, body: postBody(6, 2, 1) },
          { code: 200, body: { id: "v1", likes: { summary: { total_count: 4 } }, comments: { summary: { total_count: "8" } } } },
        ]),
      );

    const out = await fetchFacebookPostMetricsBatch(
      [
        { id: "p1", kind: "photo" },
        { id: "p2", kind: "photo" },
        { id: "v1", kind: "video" },
      ],
      "t",
    );

    expect(sentBatches()).toEqual([
      [
        { method: "GET", relative_url: "p1?fields=page_story_id" },
        { method: "GET", relative_url: "p2?fields=page_story_id" },
      ],
      [
        { method: "GET", relative_url: `9_100?fields=${POST_FIELDS}` },
        { method: "GET", relative_url: `9_200?fields=${POST_FIELDS}` },
        { method: "GET", relative_url: `v1?fields=${VIDEO_FIELDS}` },
      ],
    ]);
    expect(out.byId.get("p1")?.counts.likes).toBe(5);
    expect(out.byId.get("p2")?.counts.shares).toBe(1);
    expect(out.byId.get("v1")?.counts).toEqual({
      views: null,
      likes: 4,
      comments: 8,
      shares: null,
      clicks: null,
      saves: null,
    });
  });

  it("treats a deleted post (code 100) as not found and another item error as failed, keeping the rest", async () => {
    fetchMock.mockResolvedValueOnce(
      batchAnswer([
        { code: 400, body: { error: { code: 100, error_subcode: 33, message: "does not exist" } } },
        { code: 500, body: { error: { code: 2, message: "unknown" } } },
        null,
        { code: 200, body: postBody(1, 1, 1) },
      ]),
    );
    const out = await fetchFacebookPostMetricsBatch(
      ["1_a", "1_b", "1_c", "1_d"].map((id) => ({ id, kind: "post" as const })),
      "t",
    );
    expect(out.byId.has("1_a")).toBe(false);
    expect(out.failed.has("1_a")).toBe(false);
    expect([...out.failed].sort()).toEqual(["1_b", "1_c"]);
    expect(out.byId.get("1_d")?.counts.likes).toBe(1);
  });

  it("a photo without a page_story_id is not found", async () => {
    fetchMock.mockResolvedValueOnce(batchAnswer([{ code: 200, body: { id: "p1" } }]));
    const out = await fetchFacebookPostMetricsBatch([{ id: "p1", kind: "photo" }], "t");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.byId.size).toBe(0);
    expect(out.failed.size).toBe(0);
  });

  it("an item throttled by Meta marks the batch rate limited and leaves that item unchecked", async () => {
    fetchMock.mockResolvedValueOnce(
      batchAnswer([
        { code: 200, body: postBody(1, 1, 1) },
        { code: 400, body: { error: { code: 32, message: "Page request limit reached" } } },
      ]),
    );
    const out = await fetchFacebookPostMetricsBatch(
      [
        { id: "1_a", kind: "post" },
        { id: "1_b", kind: "post" },
      ],
      "t",
    );
    expect(out.rateLimited).toBe(true);
    expect(out.byId.has("1_a")).toBe(true);
    expect(out.unchecked.has("1_b")).toBe(true);
  });

  it("an error answer for the whole batch fails every item; a 429 leaves them all unchecked", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 190, message: "token" } }), { status: 400 }),
    );
    const failed = await fetchFacebookPostMetricsBatch([{ id: "1_a", kind: "post" }], "t");
    expect([...failed.failed]).toEqual(["1_a"]);
    expect(failed.rateLimited).toBe(false);

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    const limited = await fetchFacebookPostMetricsBatch([{ id: "1_a", kind: "post" }], "t");
    expect(limited.rateLimited).toBe(true);
    expect([...limited.unchecked]).toEqual(["1_a"]);
    expect(limited.failed.size).toBe(0);
  });

  it("a timeout fails the items and never throws", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: FETCH_TIMEOUT_CODE }));
    const out = await fetchFacebookPostMetricsBatch([{ id: "1_a", kind: "post" }], "t");
    expect([...out.failed]).toEqual(["1_a"]);
  });

  it("never logs the token", async () => {
    const error = vi.spyOn(console, "error");
    fetchMock.mockResolvedValueOnce(new Response("bad page-token-secret", { status: 500 }));
    await fetchFacebookPostMetricsBatch([{ id: "1_a", kind: "post" }], "page-token-secret");
    expect(JSON.stringify(error.mock.calls)).not.toContain("page-token-secret");
  });

  it("counts the refusals per error code, with no post id in them", async () => {
    fetchMock.mockResolvedValueOnce(
      batchAnswer([
        { code: 500, body: { error: { code: 2, message: "unknown" } } },
        { code: 500, body: { error: { code: 2, message: "unknown" } } },
        { code: 400, body: { error: { code: 100, error_subcode: 33 } } },
        null,
        { code: 400, body: "not json" },
      ]),
    );
    const out = await fetchFacebookPostMetricsBatch(
      ["1_a", "1_b", "1_c", "1_d", "1_e"].map((id) => ({ id, kind: "post" as const })),
      "t",
    );
    expect(out.refusals).toEqual({ "2": 2, no_answer: 1, unreadable: 1 });
    expect(JSON.stringify(out.refusals)).not.toContain("1_");
  });

  it("a whole-batch refusal is counted under its status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const out = await fetchFacebookPostMetricsBatch(
      [
        { id: "1_a", kind: "post" },
        { id: "1_b", kind: "post" },
      ],
      "t",
    );
    expect(out.refusals).toEqual({ http_500: 2 });
  });

  it("a permission refusal is read once more without the comment totals: likes and shares kept, comments null", async () => {
    fetchMock
      .mockResolvedValueOnce(
        batchAnswer([
          { code: 403, body: { error: { code: 10, message: "requires pages_read_user_content" } } },
          { code: 200, body: postBody(4, 2, 1) },
          { code: 400, body: { error: { code: 283, message: "extended permission" } } },
        ]),
      )
      .mockResolvedValueOnce(
        batchAnswer([
          { code: 200, body: { id: "x", reactions: { summary: { total_count: 7 } }, shares: { count: 3 } } },
          { code: 200, body: { id: "v", likes: { summary: { total_count: 5 } } } },
        ]),
      );

    const out = await fetchFacebookPostMetricsBatch(
      [
        { id: "1_a", kind: "post" },
        { id: "1_b", kind: "post" },
        { id: "v1", kind: "video" },
      ],
      "t",
    );

    expect(sentBatches()[1]).toEqual([
      { method: "GET", relative_url: "1_a?fields=shares,reactions.summary(total_count).limit(0)" },
      { method: "GET", relative_url: "v1?fields=likes.summary(total_count).limit(0)" },
    ]);
    expect(out.byId.get("1_a")?.counts).toMatchObject({ likes: 7, shares: 3, comments: null });
    expect(out.byId.get("1_b")?.counts).toMatchObject({ likes: 4, comments: 2 });
    expect(out.byId.get("v1")?.counts).toMatchObject({ likes: 5, comments: null });
    expect(out.commentsRefused).toBe(true);
    expect(out.refusals).toEqual({ "10": 1, "283": 1 });
    expect(out.failed.size).toBe(0);
  });

  it("asks without the comment totals from the start when told to, and retries nothing", async () => {
    fetchMock.mockResolvedValueOnce(
      batchAnswer([{ code: 403, body: { error: { code: 10 } } }]),
    );
    const out = await fetchFacebookPostMetricsBatch([{ id: "1_a", kind: "post" }], "t", { withComments: false });
    expect(sentBatches()).toEqual([
      [{ method: "GET", relative_url: "1_a?fields=shares,reactions.summary(total_count).limit(0)" }],
    ]);
    expect([...out.failed]).toEqual(["1_a"]);
    expect(out.commentsRefused).toBe(false);
  });

  it("a post refused again on the second read is failed", async () => {
    fetchMock
      .mockResolvedValueOnce(batchAnswer([{ code: 403, body: { error: { code: 10 } } }]))
      .mockResolvedValueOnce(batchAnswer([{ code: 403, body: { error: { code: 200 } } }]));
    const out = await fetchFacebookPostMetricsBatch([{ id: "1_a", kind: "post" }], "t");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...out.failed]).toEqual(["1_a"]);
    expect(out.commentsRefused).toBe(false);
    expect(out.refusals).toEqual({ "10": 1, "200": 1 });
  });

  it("a rate limit during the photo lookup asks nothing more and leaves every post unchecked", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    const out = await fetchFacebookPostMetricsBatch(
      [
        { id: "p1", kind: "photo" },
        { id: "1_a", kind: "post" },
        { id: "v1", kind: "video" },
      ],
      "t",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.rateLimited).toBe(true);
    expect([...out.unchecked].sort()).toEqual(["1_a", "p1", "v1"]);
    expect(out.byId.size + out.failed.size).toBe(0);
  });

  it("an item throttled in the photo lookup leaves the rest unchecked too", async () => {
    fetchMock.mockResolvedValueOnce(
      batchAnswer([
        { code: 200, body: { id: "p1", page_story_id: "9_1" } },
        { code: 400, body: { error: { code: 32 } } },
      ]),
    );
    const out = await fetchFacebookPostMetricsBatch(
      [
        { id: "p1", kind: "photo" },
        { id: "p2", kind: "photo" },
        { id: "1_a", kind: "post" },
      ],
      "t",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...out.unchecked].sort()).toEqual(["1_a", "p1", "p2"]);
  });

  it("caps a batch at 50 requests, as Meta's batch page states", () => {
    expect(FACEBOOK_METRICS_ITEMS_PER_BATCH).toBe(50);
  });
});
