import { afterEach, describe, expect, it, vi } from "vitest";

import { latestRequests, loadReviewsFor, REVIEWS_FAILED, type ReviewsOutcome } from "./load-reviews";

type Deferred = { resolve: (r: Response) => void; reject: (e: unknown) => void };

/** fetch answers when the test says so, per location. */
function controlledFetch() {
  const pending = new Map<string, Deferred>();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const location = new URL(url, "http://x").searchParams.get("location") ?? "";
      return new Promise<Response>((resolve, reject) => pending.set(location, { resolve, reject }));
    }),
  );
  return pending;
}

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const review = (reviewId: string) => ({ reviewId, name: `r/${reviewId}` });
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.unstubAllGlobals());

// R27 client-journey L1: pick A, then B; A answers last. B's reviews stay
// under B's name: A's late answer (or error) is dropped.
describe("loadReviewsFor", () => {
  it("drops an answer for a location no longer selected", async () => {
    const pending = controlledFetch();
    const next = latestRequests();
    const shown: ReviewsOutcome[] = [];
    const a = loadReviewsFor("A", next(), (o) => shown.push(o));
    const b = loadReviewsFor("B", next(), (o) => shown.push(o));
    await tick();
    pending.get("B")!.resolve(answer({ reviews: [review("b1")], truncated: false }));
    await b;
    pending.get("A")!.resolve(answer({ reviews: [review("a1")], truncated: true }));
    await a;
    expect(shown).toEqual([{ reviews: [review("b1")], truncated: false }]);
  });

  it("drops a late error too", async () => {
    const pending = controlledFetch();
    const next = latestRequests();
    const shown: ReviewsOutcome[] = [];
    const a = loadReviewsFor("A", next(), (o) => shown.push(o));
    const b = loadReviewsFor("B", next(), (o) => shown.push(o));
    await tick();
    pending.get("B")!.resolve(answer({ reviews: [] }));
    await b;
    pending.get("A")!.resolve(answer({ error: "Google refused A." }, 500));
    await a;
    pending.get("A")?.reject(new TypeError("late"));
    expect(shown).toEqual([{ reviews: [], truncated: false }]);
  });

  it("shows the current location's answer, and its failure as the route words it", async () => {
    const pending = controlledFetch();
    const next = latestRequests();
    const shown: ReviewsOutcome[] = [];
    const a = loadReviewsFor("A", next(), (o) => shown.push(o));
    await tick();
    pending.get("A")!.resolve(answer({ error: "Google refused." }, 500));
    await a;
    expect(shown).toEqual([{ error: { message: "Google refused.", settingsLink: false } }]);

    const again = loadReviewsFor("A", next(), (o) => shown.push(o));
    await tick();
    pending.get("A")!.reject(new TypeError("Failed to fetch"));
    await again;
    expect(shown[1]).toEqual({ error: { message: REVIEWS_FAILED, settingsLink: false } });
  });

  it("asks for the location's reviews by its name", async () => {
    const pending = controlledFetch();
    const done = loadReviewsFor("accounts/1/locations/2", latestRequests()(), () => {});
    await tick();
    expect(fetch).toHaveBeenCalledWith(`/api/reviews?location=${encodeURIComponent("accounts/1/locations/2")}`);
    pending.get("accounts/1/locations/2")!.resolve(answer({ reviews: [] }));
    await done;
  });
});
