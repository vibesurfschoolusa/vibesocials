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

  it("a later boards page that never ends answers null, never a partial list (R65 L1)", async () => {
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) =>
      new URL(String(input)).searchParams.get("bookmark")
        ? bodyNeverEnds(input, init)
        : Promise.resolve(Response.json({ items: [{ id: "b1", name: "Board", privacy: "PUBLIC" }], bookmark: "next" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(after15s(listPinterestBoards("pin-token"))).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/** R65 L1: like Meta's and LinkedIn's lists, a later page that fails fails the whole list. */
describe("Pinterest boards: never a partial list", () => {
  const page1 = { items: [{ id: "b1", name: "Board", privacy: "PUBLIC" }], bookmark: "next" };
  const page2 = { items: [{ id: "b2", name: "Group", privacy: "PUBLIC" }], bookmark: null };

  it("page 2 answers 503: null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) =>
        Promise.resolve(
          new URL(String(input)).searchParams.get("bookmark")
            ? new Response("busy", { status: 503 })
            : Response.json(page1),
        ),
      ),
    );
    await expect(listPinterestBoards("pin-token")).resolves.toBeNull();
  });

  it("page 2 throws: null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) =>
        new URL(String(input)).searchParams.get("bookmark")
          ? Promise.reject(new TypeError("fetch failed"))
          : Promise.resolve(Response.json(page1)),
      ),
    );
    await expect(listPinterestBoards("pin-token")).resolves.toBeNull();
  });

  it("every page succeeds: the full list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) =>
        Promise.resolve(Response.json(new URL(String(input)).searchParams.get("bookmark") ? page2 : page1)),
      ),
    );
    await expect(listPinterestBoards("pin-token")).resolves.toEqual([...page1.items, ...page2.items]);
  });
});
