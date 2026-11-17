import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { CONNECT_CALL_TIMEOUT_MS } from "@/lib/fetchWithTimeout";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds, headersNeverCome } from "@/lib/stallingFetch.testkit";

import { fetchInstagramAccountDetails } from "./saveConnection";

/**
 * R36 platform-clients L1: the Instagram account read runs in the callback and
 * in the Settings or /c choice. A Graph that stalls throws within 15 s, as a
 * network failure does, so each caller's existing failure path runs.
 */
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchInstagramAccountDetails when Graph stalls", () => {
  for (const stall of [
    { kind: "no headers", fetch: headersNeverCome },
    { kind: "a body that never ends", fetch: bodyNeverEnds },
  ]) {
    it(`throws after 15 seconds of ${stall.kind}`, async () => {
      vi.useFakeTimers();
      abortSignalTimeoutOnFakeClock();
      const fetchMock = vi.fn(stall.fetch);
      vi.stubGlobal("fetch", fetchMock);

      const answer = fetchInstagramAccountDetails("ig-1", "page-token");
      const settled = expect(answer).rejects.toBeDefined();
      await vi.advanceTimersByTimeAsync(CONNECT_CALL_TIMEOUT_MS);
      await settled;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it("still reads an account that answers in time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ username: "brand", profile_picture_url: "https://x.test/p.jpg" })));
    await expect(fetchInstagramAccountDetails("ig-1", "page-token")).resolves.toEqual({
      username: "brand",
      profilePicture: "https://x.test/p.jpg",
    });
  });
});
