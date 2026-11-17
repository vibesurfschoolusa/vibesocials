import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { CONNECT_CALL_TIMEOUT_MS } from "@/lib/fetchWithTimeout";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds, headersNeverCome } from "@/lib/stallingFetch.testkit";

import { fetchInstagramAccountDetails } from "./saveConnection";

/**
 * R36 platform-clients L1 and review low 2: the Instagram account read runs in
 * the callback and in the Settings or /c choice, before anything is saved. A
 * Graph that stalls, or no answer at all, answers null within 15 s, as a Graph
 * error does: "couldn't load that account, try again", with the choice kept.
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
    it(`answers null after 15 seconds of ${stall.kind}`, async () => {
      vi.useFakeTimers();
      abortSignalTimeoutOnFakeClock();
      const fetchMock = vi.fn(stall.fetch);
      vi.stubGlobal("fetch", fetchMock);

      const answer = fetchInstagramAccountDetails("ig-1", "page-token");
      await vi.advanceTimersByTimeAsync(CONNECT_CALL_TIMEOUT_MS);
      await expect(answer).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it("answers null when there is no answer at all, never logging the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(fetchInstagramAccountDetails("ig-1", "page-token")).resolves.toBeNull();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("page-token");
  });

  it("still reads an account that answers in time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ username: "brand", profile_picture_url: "https://x.test/p.jpg" })));
    await expect(fetchInstagramAccountDetails("ig-1", "page-token")).resolves.toEqual({
      username: "brand",
      profilePicture: "https://x.test/p.jpg",
    });
  });
});
