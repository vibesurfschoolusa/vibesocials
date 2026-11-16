import { describe, expect, it, vi } from "vitest";

import { fetchOrNoAnswer, isNoAnswer, isNoConnection, NoAnswerError } from "./requestNoAnswer";

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

  it("an answer the page can read, any status, is returned as it is", async () => {
    const answer = Response.json({}, { status: 500 });
    const fetchImpl = vi.fn(async () => answer);
    await expect(fetchOrNoAnswer("/api/x", undefined, fetchImpl as unknown as typeof fetch)).resolves.toBe(answer);
    expect(fetchImpl).toHaveBeenCalledWith("/api/x", undefined);
  });

  /**
   * R29 OO1: a 5xx whose body is not our JSON (a gateway's 502/503/504 page,
   * an unhandled 500 with an empty body) may come after the request did its
   * work, so it is no answer, like a dropped connection. Our routes' own 5xx
   * are JSON and pass through with their sentence.
   */
  const answerOf = async (response: Response) =>
    fetchOrNoAnswer("/api/x", { method: "POST" }, (async () => response) as unknown as typeof fetch).catch((e: unknown) => e);

  it("a gateway 504 with an HTML page is no answer, and keeps the answer as its cause", async () => {
    const response = new Response("<html><body>Gateway Timeout</body></html>", {
      status: 504,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    const error = await answerOf(response);
    expect(error).toBeInstanceOf(NoAnswerError);
    expect(isNoAnswer(error)).toBe(true);
    expect((error as NoAnswerError).unreadableAnswer).toBe(true);
    expect((error as NoAnswerError).cause).toBe(response);
    // Read from a clone: the body is still there for anyone holding the answer.
    await expect(response.text()).resolves.toContain("Gateway Timeout");
  });

  it("a 500 with an empty body is no answer", async () => {
    const error = await answerOf(new Response(null, { status: 500 }));
    expect(isNoAnswer(error)).toBe(true);
  });

  it("a 502 that says JSON but can't be parsed is no answer", async () => {
    const error = await answerOf(new Response("Bad gateway", { status: 502, headers: { "content-type": "application/json" } }));
    expect(isNoAnswer(error)).toBe(true);
  });

  it("a 503 with JSON text but no JSON content type is no answer", async () => {
    const error = await answerOf(new Response(JSON.stringify({ error: "x" }), { status: 503 }));
    expect(isNoAnswer(error)).toBe(true);
  });

  it("our JSON 503 passes through with its sentence readable", async () => {
    const response = Response.json({ error: "Try again in a minute." }, { status: 503 });
    const answer = await answerOf(response);
    expect(answer).toBe(response);
    await expect(response.json()).resolves.toEqual({ error: "Try again in a minute." });
  });

  it("a JSON 500 with an error code passes through", async () => {
    const response = Response.json({ error: "Couldn't save.", code: "SAVE_FAILED" }, { status: 500 });
    await expect(answerOf(response)).resolves.toBe(response);
  });

  it("a 200 with HTML passes through: not a 5xx", async () => {
    const response = new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    await expect(answerOf(response)).resolves.toBe(response);
  });

  it("a 4xx with a plain-text body passes through", async () => {
    const response = new Response("Not found", { status: 404 });
    await expect(answerOf(response)).resolves.toBe(response);
  });

  it("a rejected fetch is no answer but not an unreadable one", async () => {
    const error = await fetchOrNoAnswer("/api/x", undefined, (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch).catch((e: unknown) => e);
    expect((error as NoAnswerError).unreadableAnswer).toBe(false);
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

  it("isNoConnection: a dropped request is, an unreadable 5xx is not (a read then says it couldn't load)", async () => {
    const dropped = await fetchOrNoAnswer("/api/x", undefined, (async () => {
      throw new TypeError("Load failed");
    }) as unknown as typeof fetch).catch((e: unknown) => e);
    const gateway = await answerOf(new Response("<html></html>", { status: 504, headers: { "content-type": "text/html" } }));
    expect(isNoConnection(dropped)).toBe(true);
    expect(isNoConnection(gateway)).toBe(false);
    expect(isNoConnection(new TypeError("Failed to fetch"))).toBe(false);
  });
});
