import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platforms/gbpLocation", () => ({ resolveGbpLocationName: vi.fn(async (_token: string, name: string) => name) }));
vi.mock("./platforms/connectionRefresh", () => ({ refreshConnectionToken: vi.fn() }));
vi.mock("./platforms/googleTokens", () => ({ refreshGoogleToken: vi.fn() }));

import { FETCH_TIMEOUT_CODE } from "@/lib/fetchWithTimeout";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";

import { googleFailureKind } from "./googleFailure";
import { fetchAllReviews, fetchNewReviewUri, fetchReviews } from "./googleReviews";

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
