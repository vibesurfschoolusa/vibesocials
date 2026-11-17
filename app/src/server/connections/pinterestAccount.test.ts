import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONNECT_CALL_TIMEOUT_MS } from "@/lib/fetchWithTimeout";
import { abortSignalTimeoutOnFakeClock, bodyNeverEnds } from "@/lib/stallingFetch.testkit";

import { fetchPinterestAccount, listPinterestBoards } from "./pinterestAccount";

/**
 * R36 review: the Pinterest reads in the callback are bounded headers AND
 * body at 15 s; a body that never ends lands in the existing failure path
 * (null: "account unavailable"), never "no boards" or a hang.
 */
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  abortSignalTimeoutOnFakeClock();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function after15s<T>(answer: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(CONNECT_CALL_TIMEOUT_MS);
  return answer;
}

describe("Pinterest reads whose body never ends", () => {
  it("the account read answers null", async () => {
    vi.stubGlobal("fetch", vi.fn(bodyNeverEnds));
    await expect(after15s(fetchPinterestAccount("pin-token"))).resolves.toBeNull();
  });

  it("the first boards page answers null (a failed read), not an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(bodyNeverEnds));
    await expect(after15s(listPinterestBoards("pin-token"))).resolves.toBeNull();
  });

  it("a later boards page ends the list with what was read", async () => {
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) =>
      new URL(String(input)).searchParams.get("bookmark")
        ? bodyNeverEnds(input, init)
        : Promise.resolve(Response.json({ items: [{ id: "b1", name: "Board", privacy: "PUBLIC" }], bookmark: "next" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(after15s(listPinterestBoards("pin-token"))).resolves.toEqual([
      { id: "b1", name: "Board", privacy: "PUBLIC" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
