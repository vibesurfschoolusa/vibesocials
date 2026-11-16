import { describe, expect, it, vi } from "vitest";

import { fetchOrNoAnswer, isNoAnswer, NoAnswerError } from "./requestNoAnswer";

/**
 * KK3 follow-up: one narrow rule for "the request never got an answer". Only
 * a rejection of the fetch call itself counts (offline, DNS, the connection
 * dropped), whatever the browser's text; a TypeError thrown by our own code
 * afterwards is not one.
 */
describe("fetchOrNoAnswer / isNoAnswer", () => {
  it("a fetch that rejects (Chrome, Safari, Firefox) is a request that got no answer", async () => {
    for (const message of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError(message);
      });
      const error = await fetchOrNoAnswer("/api/x", { method: "POST" }, fetchImpl as unknown as typeof fetch).catch(
        (e: unknown) => e,
      );
      expect(error, message).toBeInstanceOf(NoAnswerError);
      expect(isNoAnswer(error)).toBe(true);
    }
  });

  it("an answer, any status, is returned as it is", async () => {
    const answer = new Response("{}", { status: 500 });
    const fetchImpl = vi.fn(async () => answer);
    await expect(fetchOrNoAnswer("/api/x", undefined, fetchImpl as unknown as typeof fetch)).resolves.toBe(answer);
    expect(fetchImpl).toHaveBeenCalledWith("/api/x", undefined);
  });

  it("a coding TypeError is not a request that got no answer", () => {
    let coding: unknown;
    try {
      (undefined as unknown as { x: () => void }).x();
    } catch (error) {
      coding = error;
    }
    expect(coding).toBeInstanceOf(TypeError);
    expect(isNoAnswer(coding)).toBe(false);
    expect(isNoAnswer(new TypeError("Failed to fetch"))).toBe(false);
    expect(isNoAnswer(new Error("x"))).toBe(false);
    expect(isNoAnswer(null)).toBe(false);
  });
});
