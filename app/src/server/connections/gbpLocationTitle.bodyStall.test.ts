import type { SocialConnection } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { socialConnection: { findMany: h.findMany, findUnique: h.findUnique, update: h.update } },
}));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { CONNECT_CALL_TIMEOUT_MS } from "@/lib/fetchWithTimeout";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";

import { backfillGbpLocationTitles } from "./gbpLocationTitle";

/**
 * R36 review: the title read is bounded headers AND body at 15 s, so a body
 * that never ends counts as a failed title (retried tomorrow) instead of
 * holding the sweep's step.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  abortSignalTimeoutOnFakeClock();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("backfillGbpLocationTitles when Google's body never ends", () => {
  it("counts the connection as failed and saves nothing", async () => {
    const row = {
      id: "conn-1",
      platform: "google_business_profile",
      accessToken: "gbp-access",
      refreshToken: "gbp-refresh",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      needsReconnect: false,
      metadata: { locationName: "accounts/1/locations/22" },
    } as unknown as SocialConnection;
    h.findMany.mockResolvedValue([row]);
    h.findUnique.mockResolvedValue({ metadata: row.metadata, needsReconnect: false });
    vi.stubGlobal("fetch", vi.fn(bodyNeverEnds));

    const run = backfillGbpLocationTitles();
    await vi.advanceTimersByTimeAsync(CONNECT_CALL_TIMEOUT_MS);

    await expect(run).resolves.toEqual({ named: 0, failed: 1, flagged: [] });
    expect(h.update).not.toHaveBeenCalled();
  });
});
