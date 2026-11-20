import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";
import { instagramPhotoUrl } from "@/server/platforms/instagramPhoto";

import { GET } from "./route";

// The route's read limit (a route file exports only its handlers and config).
const SOURCE_READ_LIMIT_MS = 15_000;

// R48 lead follow-up: Instagram fetches this route while our container call
// (30 s) waits. A stored photo whose body stalls answers a quick 504 within
// the read's limit, instead of holding the function until it is killed.
// A missing bound must be a quick red test, never a hung run.
const STALL_TEST_TIMEOUT_MS = 5_000;
const OWN_BLOB = "https://store123.public.blob.vercel-storage.com/1-abc-photo.jpg";

beforeEach(() => {
  vi.useFakeTimers();
  abortSignalTimeoutOnFakeClock();
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_store123_secretpart");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/instagram-photo: a stored photo whose body never ends", () => {
  it("answers 504 within the read's limit, well inside our 30 s container call", async () => {
    vi.stubGlobal("fetch", vi.fn(bodyNeverEnds));

    const settled = GET(new Request(instagramPhotoUrl("https://vibesocials.wtf", OWN_BLOB))).then(
      (response) => response.status,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(SOURCE_READ_LIMIT_MS);
    const out = await Promise.race([settled, Promise.resolve("still waiting")]);

    expect(out).toBe(504);
  }, STALL_TEST_TIMEOUT_MS);
});
