import { describe, expect, it } from "vitest";

import { appendJobsPage, dedupeJobsById, mergePolledPageOne } from "./postsPagination";
import type { PostJobDTO } from "./postsDto";

/**
 * Pure unit tests for the client-side "Load more" pagination helpers (Task C2).
 * These carry no React/DB machinery — merging a polled page 1 over the loaded
 * list, and appending an older page with id-dedup, are pure list transforms.
 *
 * Same factory-with-overrides pattern as usePostJobs.test.ts — only `id` and
 * `status` (used to prove WHICH copy of a shared id survives a merge/dedup)
 * vary per test; every other field is a fixed, valid stand-in.
 */
function job(id: string, partial: Partial<PostJobDTO> = {}): PostJobDTO {
  return {
    id,
    status: "completed",
    createdAt: "2026-07-10T00:00:00.000Z",
    scheduledFor: null,
    caption: "c",
    results: [],
    media: null,
    publish: null,
    createdBy: null,
    ...partial,
  };
}

const ids = (jobs: PostJobDTO[]): string[] => jobs.map((j) => j.id);

describe("dedupeJobsById", () => {
  it("drops later duplicates, keeping the FIRST occurrence of each id", () => {
    const first = job("a", { status: "in_progress" });
    const dup = job("a", { status: "completed" });
    const out = dedupeJobsById([first, job("b"), dup, job("c")]);

    expect(ids(out)).toEqual(["a", "b", "c"]);
    // The first copy wins — its object identity is preserved.
    expect(out[0]).toBe(first);
    expect(out[0].status).toBe("in_progress");
  });

  it("is a no-op (same order) when every id is unique", () => {
    expect(ids(dedupeJobsById([job("a"), job("b"), job("c")]))).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for empty input", () => {
    expect(dedupeJobsById([])).toEqual([]);
  });
});

describe("appendJobsPage", () => {
  it("appends the new (older) page after the rows already on screen", () => {
    const existing = [job("a"), job("b")];
    const page = [job("c"), job("d")];
    expect(ids(appendJobsPage(existing, page))).toEqual(["a", "b", "c", "d"]);
  });

  it("drops a page row whose id a poll already prepended, keeping the on-screen copy", () => {
    // Poll surfaced job "b" at the top; the older page also carries it. The
    // rendered list must never end up with two "b" keys — the FIRST (on-screen)
    // copy is kept and the page's stale copy is dropped.
    const onScreen = job("b", { status: "in_progress" });
    const stale = job("b", { status: "completed" });
    const out = appendJobsPage([onScreen, job("a")], [stale, job("c")]);

    expect(ids(out)).toEqual(["b", "a", "c"]);
    expect(out[0]).toBe(onScreen);
    expect(out[0].status).toBe("in_progress");
  });

  it("returns the page when nothing is on screen yet", () => {
    expect(ids(appendJobsPage([], [job("a"), job("b")]))).toEqual(["a", "b"]);
  });

  it("returns the existing rows (deduped) when the page is empty", () => {
    expect(ids(appendJobsPage([job("a"), job("b")], []))).toEqual(["a", "b"]);
  });
});

describe("mergePolledPageOne", () => {
  it("puts the fresh page 1 first, then every previously-loaded tail row not in page 1", () => {
    // Loaded two pages: [1..3] then appended tail [4,5]. Poll re-fetches page 1.
    const prev = [job("1"), job("2"), job("3"), job("4"), job("5")];
    const pageOne = [job("1"), job("2"), job("3")];
    expect(ids(mergePolledPageOne(pageOne, prev))).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("keeps the FRESH page-1 copy of a shared row and never duplicates it into the tail", () => {
    const prev = [
      job("1", { status: "in_progress" }),
      job("2"),
      job("3", { status: "in_progress" }), // deep-tail row loaded via Load more
    ];
    // Page 1 now reports job 1 settled; job 3 is NOT on page 1 (it's tail).
    const pageOne = [job("1", { status: "completed" }), job("2")];
    const out = mergePolledPageOne(pageOne, prev);

    expect(ids(out)).toEqual(["1", "2", "3"]);
    // Shared row 1 shows the fresh (page-1) status, and appears exactly once.
    expect(out[0].status).toBe("completed");
    // Deep-tail row 3 is preserved as-is (documented staleness — poll doesn't refetch it).
    expect(out[2].status).toBe("in_progress");
  });

  it("prepends brand-new page-1 rows while preserving the loaded tail", () => {
    const prev = [job("1"), job("2"), job("3")];
    // A new post appeared at the top; page size pushed job 3 off page 1.
    const pageOne = [job("new"), job("1"), job("2")];
    expect(ids(mergePolledPageOne(pageOne, prev))).toEqual(["new", "1", "2", "3"]);
  });

  it("equals page 1 exactly when no tail has been loaded (page-1 refresh is unchanged)", () => {
    // The critical invariant: a caller who never clicked Load more sees the
    // poll behave identically to a plain replace-with-fresh-page-1.
    const prev = [job("1", { status: "in_progress" }), job("2")];
    const pageOne = [job("1", { status: "completed" }), job("2")];
    expect(ids(mergePolledPageOne(pageOne, prev))).toEqual(["1", "2"]);
    expect(mergePolledPageOne(pageOne, prev)).toEqual(pageOne);
  });

  it("returns page 1 when there was nothing loaded before", () => {
    const pageOne = [job("1"), job("2")];
    expect(ids(mergePolledPageOne(pageOne, []))).toEqual(["1", "2"]);
  });

  it("never yields a duplicate id even if prev somehow repeats a page-1 row", () => {
    const prev = [job("1"), job("2"), job("1")];
    const pageOne = [job("1"), job("2")];
    const out = mergePolledPageOne(pageOne, prev);
    expect(ids(out)).toEqual(["1", "2"]);
    expect(new Set(ids(out)).size).toBe(out.length);
  });
});
