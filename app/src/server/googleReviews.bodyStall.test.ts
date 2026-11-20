import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platforms/gbpLocation", () => ({ resolveGbpLocationName: vi.fn(async (_token: string, name: string) => name) }));
vi.mock("./platforms/connectionRefresh", () => ({ refreshConnectionToken: vi.fn() }));
vi.mock("./platforms/googleTokens", () => ({ refreshGoogleToken: vi.fn() }));

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";

import { googleFailureKind } from "./googleFailure";
import {
  GBP_REPLY_UNCONFIRMED_CODE,
  REPLY_MAY_BE_POSTED_MESSAGE,
  fetchAllReviews,
  fetchNewReviewUri,
  fetchReviews,
  replyToReview,
} from "./googleReviews";

/**
 * R37 lead follow-up: the Reviews reads are bounded headers AND body at 15 s
 * (fetchWithinLimit), so a Google answer that stalls ends as "try again"
 * instead of holding the request until the function's time limit.
 */
const LOCATION = "accounts/1/locations/22";
const stalled = (status: number) => (input: string | URL, init?: RequestInit) =>
  bodyNeverEnds(input, init).then((res) => new Response(res.body, { status }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  abortSignalTimeoutOnFakeClock();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function after15s(run: Promise<unknown>): Promise<unknown> {
  const settled = run.then(
    () => "resolved",
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(15_000);
  return settled;
}

describe("Reviews reads when Google's body stalls", () => {
  it.each([
    ["the Reviews page's list", () => fetchAllReviews("tok", LOCATION)],
    ["the new-review email's list", () => fetchReviews("tok", LOCATION, { newestFirst: true })],
    ["the review link", () => fetchNewReviewUri("tok", LOCATION)],
  ])("%s: a 403 whose body stalls is try again after 15 s, never access", async (_label, read) => {
    vi.stubGlobal("fetch", vi.fn(stalled(403)));

    const error = await after15s(read());

    expect(error).toMatchObject({ status: 403, googleBodyUnreadable: true });
    expect(googleFailureKind(error)).toBe("tryLater");
  });

  it.each([
    ["the Reviews page's list", () => fetchAllReviews("tok", LOCATION)],
    ["the new-review email's list", () => fetchReviews("tok", LOCATION, { newestFirst: true })],
  ])("%s: a 200 whose body stalls is our timeout, try again", async (_label, read) => {
    vi.stubGlobal("fetch", vi.fn(stalled(200)));

    const error = await after15s(read());

    expect((error as { code?: unknown }).code).toBe(FETCH_TIMEOUT_CODE);
    expect(googleFailureKind(error)).toBe("tryLater");
  });

  it("a readable answer is unchanged", async () => {
    vi.useRealTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ reviews: [{ name: `${LOCATION}/reviews/r1`, starRating: "FIVE" }] })),
    );

    const { reviews, truncated } = await fetchAllReviews("tok", LOCATION);

    expect(truncated).toBe(false);
    expect(reviews.map((review) => review.reviewId)).toEqual(["r1"]);
  });
});

// R48 platform (outside its angle): the reply's answer is bounded too. The PUT
// was sent, so a stall after it may have saved the reply: it says so, and that
// posting again replaces it, instead of "try again later".
const REVIEW = `${LOCATION}/reviews/r1`;
// A missing bound must be a quick red test, never a hung run.
const STALL_TEST_TIMEOUT_MS = 5_000;
// True for a lost answer and for a 5xx alike (R48 review low 1).
const UNCERTAIN_REPLY_SENTENCE =
  "We couldn't tell whether Google saved your reply. It may already be posted; pressing Post reply again replaces it.";

async function after(ms: number, run: Promise<unknown>): Promise<unknown> {
  const settled = run.then(
    () => "resolved",
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(ms);
  return Promise.race([settled, Promise.resolve("still waiting")]);
}

describe("replyToReview when Google's answer stalls", () => {
  it("a 200 whose body never ends is GBP_REPLY_UNCONFIRMED within 30 s, with the may-be-posted sentence", async () => {
    vi.stubGlobal("fetch", vi.fn(stalled(200)));

    const error = await after(30_000, replyToReview("tok", REVIEW, "Thanks"));

    expect(error).toMatchObject({ code: GBP_REPLY_UNCONFIRMED_CODE, message: REPLY_MAY_BE_POSTED_MESSAGE });
    expect(REPLY_MAY_BE_POSTED_MESSAGE).toBe(
      UNCERTAIN_REPLY_SENTENCE,
    );
  }, STALL_TEST_TIMEOUT_MS);

  it("headers that never come after the PUT was sent are unconfirmed too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );

    const error = await after(30_000, replyToReview("tok", REVIEW, "Thanks"));

    expect(error).toMatchObject({ code: GBP_REPLY_UNCONFIRMED_CODE });
  }, STALL_TEST_TIMEOUT_MS);

  it("a connection that was never made is unchanged: nothing was sent, try again later", async () => {
    const neverConnected = new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(neverConnected)));

    const error = await after(0, replyToReview("tok", REVIEW, "Thanks"));

    expect(error).toBe(neverConnected);
    expect(googleFailureKind(error)).toBe("tryLater");
  }, STALL_TEST_TIMEOUT_MS);

  // R48 lead follow-up: one rule for every outcome where the PUT may have
  // landed. A 5xx after sending is one of them; a 4xx is a certain refusal.
  it.each([500, 503])("a %s after the PUT is unconfirmed, with the may-be-posted sentence", async (status) => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"code":500}}', { status })));

    const error = await replyToReview("tok", REVIEW, "Thanks").catch((e: unknown) => e);

    expect(error).toMatchObject({ code: GBP_REPLY_UNCONFIRMED_CODE, message: UNCERTAIN_REPLY_SENTENCE });
  });

  it.each([400, 403, 404, 429])("a %s is a certain refusal and keeps its own failure", async (status) => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));

    const error = await replyToReview("tok", REVIEW, "Thanks").catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "GBP_REVIEWS_REPLY_FAILED", status });
  });

  it("a readable answer is unchanged", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ comment: "Thanks", updateTime: "2026-11-14T00:00:00Z" })));

    await expect(replyToReview("tok", REVIEW, "Thanks")).resolves.toEqual({
      comment: "Thanks",
      updateTime: "2026-11-14T00:00:00Z",
    });
  });
});
